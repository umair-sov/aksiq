# Email-to-Task Triage Agent (Agent 1)

An automated pipeline that reads a Gmail inbox, classifies each email using
the Anthropic API, syncs actionable items to Google Calendar/Tasks, applies
Gmail labels, and posts a digest to Discord. A companion Discord bot exposes
the same triage on demand plus ad hoc inbox Q&A and reply drafting. This
codebase is also the version deployed on the VPS at `devmair.com`.

> **Note:** `applyLabels.js`, `syncToGoogle.js`, and `googleAuth.js` are
> referenced throughout the pipeline and by other scripts but weren't
> available to verify directly while writing this — the descriptions below
> are inferred from how the rest of the codebase calls and depends on them.
> Check these sections against the actual files.

## What it does

**Automated pipeline** (`npm run triage`): fetches unread, untriaged Gmail
messages, classifies each into a category and priority, creates Calendar
events or Google Tasks for actionable items, labels the source emails in
Gmail, and posts a formatted digest to a Discord channel via webhook.

**Discord bot** (`npm run bot`): a long-running bot restricted to an
allowlist of Discord user IDs, exposing three slash commands:
- `/triage` — runs the full pipeline on demand and replies with a summary
- `/ask` — answers free-text questions about the recently triaged inbox
- `/draft` — generates and creates a Gmail draft reply to a cached email

## Architecture

### Pipeline (`npm run triage`)

```
fetchEmails.js  →  emailPriority.js  →  syncToGoogle.js  →  applyLabels.js  →  postDigest.js
```

Each step reads the previous step's output file and, where relevant, writes
its own:

| Stage | Script | Reads | Writes |
|---|---|---|---|
| Fetch | `fetchEmails.js` | Gmail API (OAuth2) | `emails.json` |
| Classify | `emailPriority.js` | `emails.json` | `task_list.json` |
| Sync | `syncToGoogle.js` | `task_list.json` | Google Calendar/Tasks *(inferred — not verified)* |
| Label | `applyLabels.js` | `task_list.json` | Gmail labels *(inferred — not verified)* |
| Digest | `postDigest.js` | `task_list.json`, `emails.json` (via `formatDigest.js`) | Discord webhook post |

`previewDigest.js` (`npm run preview-digest`) runs the same digest-building
logic as `postDigest.js` but prints to the console instead of posting to
Discord — a dry run.

### Discord bot layer (`npm run bot`)

`discordBot.js` is a separate long-running process, independent of the
`triage` script. It listens for slash commands (registered once via
`registerCommand.js`) and only responds to Discord user IDs listed in
`DISCORD_ALLOWED_USER_ID`, since every command can read or act on the
private inbox:

| Command | Handler | What it does |
|---|---|---|
| `/triage` | shells out to `npm run triage`, then reads `task_list.json` | Runs the full pipeline, replies with the top 10 tasks |
| `/ask` | `askInbox.js` | Answers a question using cached `emails.json` + `task_list.json` as context |
| `/draft` | `draftReply.js` (+ `emailLookup.js`) | Finds a cached email by search term, generates a reply via Claude, creates it as a Gmail draft (not sent) |

Auth for both the pipeline and the bot's Gmail-writing commands is
centralized in `googleAuth.js`, which caches an OAuth token in `token.json`
so browser consent is only needed once. *(Inferred from usage in
`fetchEmails.js` and `draftReply.js` — not verified directly.)*

## Prerequisites

- Node.js (v18 or later recommended — uses top-level `await` and ESM
  throughout)
- npm
- A Google account with Gmail, Calendar, and Tasks
- An Anthropic API key
- A Discord bot application and a Discord webhook, if using the bot/digest
  features

## Setup (from a clean machine)

### 1. Clone and install

```bash
git clone <repo-url>
cd <repo-folder>
npm install
```

### 2. Create the Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (this deployment uses one named
   `Agent 1 Email Client`, kept separate from any other Google-integrated
   project).
2. Under **APIs & Services → Library**, enable:
   - Gmail API
   - Google Calendar API
   - Google Tasks API
3. Under **APIs & Services → OAuth consent screen**, configure an external
   (or internal, if using Workspace) consent screen with your account as a
   test user.
4. Under **APIs & Services → Credentials**, create an **OAuth client ID**
   of type "Desktop app" and download the credentials JSON.
5. Save it in the project root as expected by `googleAuth.js`
   (**confirm the exact filename your code reads** — commonly
   `credentials.json`).

### 3. Create the Discord bot and webhook

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create a new application, then add a Bot user to it. Copy the **bot
   token** and the application's **client ID**.
2. Invite the bot to your server with the `applications.commands` and `bot`
   scopes.
3. Copy the target server's **guild ID** (enable Developer Mode in Discord,
   right-click the server icon → Copy Server ID).
4. In the target channel for the digest (e.g. `#gmail-digest`), create a
   **webhook** (Channel Settings → Integrations → Webhooks) and copy its URL.

### 4. Configure environment variables

Create a `.env` file (`fetchEmails.js`/`emailPriority.js` and friends look
for `.env` first, then fall back to `../.env` — so this works whether the
file lives in the project root or one level up, e.g. on the VPS deploy
layout):

```
ANTHROPIC_API_KEY=your-api-key-here
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-application-client-id
DISCORD_GUILD_ID=your-server-id
DISCORD_ALLOWED_USER_ID=your-discord-user-id[,another-id,...]
DISCORD_WEBHOOK_URL=your-webhook-url-here
```

`DISCORD_ALLOWED_USER_ID` accepts a single ID or a comma-separated list.

> **Note:** confirm whether any Google client ID/secret values are read
> from `.env` directly or only from the downloaded credentials file.

### 5. First run — authorize Google access

```bash
node fetchEmails.js
```

On first run this opens a browser window for Google OAuth consent. Once
approved, a token is cached (commonly `token.json`) so future runs skip
this step.

### 6. Register Discord slash commands (one-time, bot only)

```bash
node registerCommand.js
```

Registers `/triage`, `/ask`, and `/draft` to the guild in
`DISCORD_GUILD_ID`. Re-run this only if the command definitions change.

### 7. Run it

```bash
npm run triage          # full pipeline: fetch → classify → sync → label → digest
npm run preview-digest  # build the digest and print it, without posting
npm run bot             # start the long-running Discord bot
```

Individual pipeline stages can also be run directly, e.g. `node
fetchEmails.js`, `node emailPriority.js`.

## Fetch behavior

`fetchEmails.js` does not simply pull the N most recent emails — it queries
Gmail for **unread messages that don't already carry one of the pipeline's
own Gmail labels** (`Triage/Action-Required`, `Triage/FYI`,
`Triage/Newsletter`, `Triage/Meeting`, `Triage/Personal`,
`Triage/Unknown`), capped at 25 per run. This excludes anything already
labeled by a previous `applyLabels.js` run, so repeat runs only pick up new
mail. Both plain-text and HTML-only bodies are supported (`html-to-text`
handles the HTML case); non-multipart messages fall back to the top-level
body.

## Output schema

Each entry in `task_list.json`:

| Field | Type | Description |
|---|---|---|
| `source_email_id` | string | Traces the task back to its source email |
| `category` | enum | `action_required`, `fyi`, `newsletter`, `meeting`, `personal`, `unknown` |
| `priority` | enum | `high`, `medium`, `low` |
| `suggested_task` | string \| null | Short action string, or `null` if none is needed |
| `event_datetime` | string \| null | ISO 8601 datetime with an explicit `Asia/Karachi` offset if the email states a specific meeting/deadline time, resolved from relative references (e.g. "Tuesday") against the email's own Sent timestamp; `null` if no specific time is stated |
| `truncated` | boolean | `true` if the email body was cut at the 20,000-character cap before classification |

Note: a `rank` (numeric priority order) is computed to sort the list before
writing, but is not itself persisted in the output — it exists only
in-memory during the sort.

## Known limitations

- **Non-deterministic classification.** The same ambiguous email can
  receive different category/priority combinations across separate runs
  with no code changes — there is no caching or pinning of prior
  classifications.
- **`action_required` is over-broad.** Both direct requests and
  broadcast "action required" messages (e.g. company-wide HR notices)
  currently land in the same category.
- **Truncation risk.** Email bodies are capped at 20,000 characters
  before classification; a `truncated` flag is set when this happens, but
  very long emails with the actionable content near the end could still
  be misclassified.
- **No thread deduplication.** Multiple emails from the same thread are
  each triaged independently and can produce duplicate tasks.
- **Skip-on-malformed-JSON.** If a classification response fails to
  parse, that email is skipped and logged rather than retried — chosen
  deliberately for v1 simplicity, at the cost of silently dropping a
  small number of emails per run.
- **Digest chunking is newline-boundary only.** `postDigest.js` splits
  long digests at line breaks to stay under Discord's ~2000-character
  webhook limit; a single section with an unusually long line could still
  overflow one chunk.
- **`/draft` never sends automatically.** Replies are created as Gmail
  drafts only — a human must review and send them.

## Design decisions log

- **Skip vs. retry on malformed JSON:** skip-and-log chosen for v1 to
  keep the pipeline simple and avoid unbounded retry loops; revisit if
  drop rate becomes significant.
- **Model output validated, not trusted blindly:** `emailPriority.js`
  checks the returned `category`/`priority` against known enums and
  coerces unexpected values (to `unknown` / `low`) rather than letting an
  unrecognized value silently corrupt sorting or digest bucketing
  downstream.
- **Query-based fetch instead of a fixed recent-N pull:** filtering by
  unread + not-already-labeled (rather than "last N emails") means repeat
  runs naturally only pick up new mail, using Gmail's own labels as the
  dedup mechanism.
- **Direct Gmail API calls instead of the `googleapis` wrapper:** the
  wrapper's `google.gmail()` helper returned 401/CREDENTIALS_MISSING
  errors despite a valid token; calling `auth.request()` directly against
  Gmail API endpoints worked around this.
- **`html-to-text` for body extraction:** regex-based HTML tag stripping
  proved unreliable on real email HTML; `html-to-text` plus a
  whitespace-normalization pass is used instead, with plain-text parts
  preferred over HTML when both exist.
- **Digest confirmations mirror sync logic exactly:** `formatDigest.js`
  deliberately recomputes whether an item "Added to Calendar" or "Added
  to Task" using the same branching `syncToGoogle.js` uses, rather than
  assuming — so the digest reflects what actually happened during sync,
  not what should have happened.
- **Discord bot is allowlist-gated:** every slash command can read or act
  on the private inbox, so `DISCORD_ALLOWED_USER_ID` is checked before any
  command logic runs, rejecting all other users up front.
- **`/draft` creates rather than sends:** replies are staged as Gmail
  drafts so a human reviews before anything goes out.
