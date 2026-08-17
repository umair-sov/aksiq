/**
 * discordBot.js
 *
 * Long-running Discord bot process (`npm run bot`). Reads plain-English
 * messages posted in the #gmail channel, works out what each one wants, and
 * acts on it.
 *
 * THERE ARE NO SLASH COMMANDS. /triage, /ask and /draft are gone, along with
 * the interactionCreate handler that served them; everything they did is now
 * reachable by typing normally. The functionality behind them is unchanged —
 * the same triage pipeline, the same askInbox, the same draftReplyTo — only
 * the way a request arrives is different.
 *
 * Depends on:
 * - `discord.js` for the gateway connection and message handling. Requires
 *   THREE intents (see the client construction below); MessageContent is
 *   privileged and must additionally be enabled by hand in the Discord
 *   Developer Portal, or every message arrives with empty content.
 * - messageRouter.js to classify each message and to answer chat messages.
 * - runTriage.js, askInbox.js, draftReply.js — the three things a classified
 *   message can actually do.
 * - `dotenv` for DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USER_ID.
 * - `DISCORD_ALLOWED_USER_ID` env var — a comma-separated list of Discord
 *   user IDs (a single ID is also valid) allowed to talk to this bot. Every
 *   path here can read or act on the private inbox, so this isn't optional.
 *
 * Where it fits in the pipeline: the interactive front-end to the whole
 * project — it triggers the same triage pipeline the npm scripts run
 * directly, plus ad hoc inbox Q&A and reply drafting. The cron-driven triage
 * runs do not involve this file at all.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env', '../.env'] });
import { Client, Events, GatewayIntentBits } from 'discord.js';
import process from 'node:process';
import { classifyMessage, chatReply } from './messageRouter.js';
import { runTriagePipeline } from './runTriage.js';
import { askInbox } from './askInbox.js';
import { draftReplyTo } from './draftReply.js';

// All three are required, and it is worth being precise about why, because
// the failure modes are silent and look identical from the outside:
// - Guilds: discord.js resolves a message's channel from its cache before
//   emitting messageCreate, and returns early without emitting if it misses
//   (client/actions/MessageCreate.js). Guild channels only enter that cache
//   via GUILD_CREATE, which this intent gates. Without it the handler below
//   never runs.
// - GuildMessages: what makes the gateway dispatch MESSAGE_CREATE at all.
// - MessageContent: PRIVILEGED. Without it every message.content arrives as
//   an empty string, so the bot connects, sees traffic, and does nothing.
//   Must be toggled on in the Developer Portal under Bot -> Privileged
//   Gateway Intents; there is no way to set it from code.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Only these Discord user IDs may talk to the bot — every path here can read
// or act on the private inbox (full recent-inbox context on a question, draft
// creation, and a triage run that writes to Calendar, Tasks and Gmail).
// DISCORD_ALLOWED_USER_ID holds one ID, or several separated by commas.
//
// Read at module scope is safe HERE specifically: this file is the entry
// point, so dotenv.config() above has already run by the time this line
// executes. The same read inside an imported module would not be — see the
// ENV READ TIMING note in llmClient/index.js.
const ALLOWED_USER_IDS = (process.env.DISCORD_ALLOWED_USER_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// The bot answers here and nowhere else. Matched on channel NAME rather than
// ID because no channel-ID env var exists in this project — DISCORD_WEBHOOK_URL
// is a webhook endpoint, not a channel reference, and postDigest.js posts
// through it without ever resolving a channel. Names are user-editable and
// not unique across a guild, so if this bot ever needs to be more robust than
// "one personal server, one channel", switch to comparing message.channelId
// against a configured ID.
const CHANNEL_NAME = 'gmail';

// How many previous messages are pulled in as context on each message. The
// router decides whether they're relevant; this only decides how far back it
// can see. Kept small deliberately — this is re-sent on every single message,
// so it is the one knob here that costs money continuously.
const HISTORY_LIMIT = 10;

// Per-message cap when rendering the transcript. Discord allows up to 2000
// characters per message, so ten unbounded messages could add ~20k characters
// to every router call for no benefit — intent is legible from the opening
// line of a message, not its tail.
const HISTORY_CHARS_PER_MESSAGE = 500;

// Discord rejects any message over 2000 characters outright, with a 400
// (code 50035) rather than a truncation — and discord.js does NOT check this
// client-side, so an over-long reply throws at send time instead of being
// caught locally. 1900 leaves the same safety margin postDigest.js uses.
const DISCORD_CHAR_LIMIT = 1900;

// Ceiling on how many messages one reply may be split across, so a runaway
// model response can't flood the channel. Anything beyond this is dropped
// with a visible marker rather than silently.
const MAX_REPLY_CHUNKS = 5;

// Discord's typing indicator lasts about ten seconds and does not repeat, so
// it has to be re-sent while a slow call is in flight. Comfortably under that.
const TYPING_REFRESH_MS = 8000;

// Set once, so a misconfigured privileged intent is reported clearly the
// first time it bites instead of on every message forever.
let warnedAboutEmptyContent = false;

/**
 * Inputs: text (string) — arbitrary message text; maxLength (number) — the
 * per-chunk ceiling.
 * Output: Array<string> — one or more pieces, each under maxLength.
 * What it does: splits text into Discord-safe pieces.
 * How it does it: breaks at existing newline boundaries where possible so a
 * bullet or code line is never cut in half. A single line longer than
 * maxLength (a model returning one huge paragraph, or an exec error carrying
 * a whole stderr dump) has no newline to break at, so it is hard-sliced —
 * without that fallback the "chunks" would still be over the limit and every
 * send would fail.
 */
function chunkForDiscord(text, maxLength = DISCORD_CHAR_LIMIT) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    let remaining = line;
    while (remaining.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    if (current && (current + '\n' + remaining).length > maxLength) {
      chunks.push(current);
      current = remaining;
    } else {
      current = current ? current + '\n' + remaining : remaining;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Inputs: channel (Discord channel) — where to post; text (string) — the full
 * reply.
 * Output: Promise<void>.
 * What it does: posts a reply of any length without tripping Discord's
 * message-size limit.
 * How it does it: chunks, then sends sequentially rather than in parallel so
 * the pieces arrive in reading order. Sends channel.send() rather than
 * message.reply() — reply() throws if the message being replied to has since
 * been deleted, which is a pointless way for a long-running bot to lose an
 * answer it already paid a model to produce. An empty or whitespace-only
 * text gets a visible placeholder instead of Discord's 400 on empty content.
 */
async function sendReply(channel, text) {
  const content = (text ?? '').trim();
  if (!content) {
    await channel.send('(No content came back — nothing to show.)');
    return;
  }

  const chunks = chunkForDiscord(content);
  for (const chunk of chunks.slice(0, MAX_REPLY_CHUNKS)) {
    await channel.send(chunk);
  }
  if (chunks.length > MAX_REPLY_CHUNKS) {
    await channel.send(`...[truncated — ${chunks.length - MAX_REPLY_CHUNKS} more message(s) not shown]`);
  }
}

/**
 * Inputs: channel (Discord channel); prefix (string) — a human explanation of
 * what failed; err (Error) — the underlying error.
 * Output: Promise<void>.
 * What it does: reports a failure to the channel without the report itself
 * failing.
 * How it does it: hard-truncates to a single message rather than chunking.
 * Error text is the most likely thing in this file to be enormous — an exec
 * error carries the child process's whole stderr — and an unguarded send of
 * it is exactly how a bot ends up throwing while trying to report a throw,
 * leaving the user with no message at all. One truncated message always
 * arrives. Any failure to send even that is swallowed after logging, because
 * there is nowhere left to report it to.
 */
async function sendError(channel, prefix, err) {
  const detail = err?.message ?? String(err);
  const full = `${prefix}: ${detail}`;
  const body = full.length > DISCORD_CHAR_LIMIT ? full.slice(0, DISCORD_CHAR_LIMIT - 3) + '...' : full;
  try {
    await channel.send(body);
  } catch (sendErr) {
    console.error('Failed to report an error to Discord:', sendErr);
  }
}

/**
 * Inputs: channel (Discord channel); triggerMessageId (string) — the id of
 * the message being handled right now.
 * Output: Promise<string|null> — a rendered transcript, oldest first, or null
 * if there is no usable history.
 * What it does: gathers the recent channel conversation for the router and
 * the handlers to reason over.
 * How it does it: fetches with `before` set to the triggering message so the
 * new message never appears twice (it is passed to the model separately as
 * "the newest message"). Sorts explicitly by timestamp rather than trusting
 * the fetch order, which discord.js does not sort or document. Bot messages
 * are KEPT — the posted digests are the most useful context in the channel,
 * and a follow-up like "what was the second one?" usually refers to one — but
 * they are labeled so the model can tell who said what. Returns null rather
 * than throwing if the fetch fails: history is an enhancement, and losing it
 * should degrade the reply, not kill the request.
 */
async function fetchTranscript(channel, triggerMessageId) {
  try {
    const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT, before: triggerMessageId });

    const lines = [...fetched.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => {
        const text = (m.content || '').trim();
        if (!text) return null;
        const speaker = m.author.bot ? 'bot' : 'user';
        const truncated =
          text.length > HISTORY_CHARS_PER_MESSAGE
            ? text.slice(0, HISTORY_CHARS_PER_MESSAGE) + '...[truncated]'
            : text;
        return `${speaker}: ${truncated}`;
      })
      .filter(Boolean);

    return lines.length ? lines.join('\n') : null;
  } catch (err) {
    console.error('Could not read channel history; continuing without it:', err.message);
    return null;
  }
}

/**
 * Inputs: channel (Discord channel); work (function) — an async function to
 * run.
 * Output: Promise<any> — whatever `work` resolves to.
 * What it does: keeps the "bot is typing" indicator alive for the duration of
 * a slow call.
 * How it does it: Discord's indicator expires after roughly ten seconds and
 * does not repeat, while a triage run can take minutes, so it is re-sent on
 * an interval. The interval is cleared in a `finally` so a thrown error can
 * never leave a timer running for the life of the process. Refresh failures
 * are swallowed deliberately — a dropped typing indicator must not be able to
 * fail the actual request.
 */
async function withTyping(channel, work) {
  await channel.sendTyping().catch(() => {});
  const timer = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, TYPING_REFRESH_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Inputs: route (Object) — the router's classification; content (string) —
 * the user's message text; transcript (string|null) — recent channel history.
 * Output: Promise<string> — the reply text to post.
 * What it does: performs whatever the router decided the message was asking
 * for.
 * How it does it: passes the transcript down to the handler only when the
 * router set use_context, so a self-contained request is answered from a
 * clean prompt rather than one carrying unrelated chatter. Triage fires
 * immediately with no confirmation step — deliberately, matching what the old
 * /triage command did, even though the run writes real Calendar events,
 * Google Tasks and Gmail labels. The unknown-intent branch is unreachable
 * (classifyMessage validates against the same four values and throws
 * otherwise) and exists so that adding an intent to the router without adding
 * it here fails loudly instead of silently doing nothing.
 */
async function dispatch(route, content, transcript) {
  const context = route.use_context ? transcript : null;

  switch (route.intent) {
    case 'triage':
      return runTriagePipeline();

    case 'ask':
      return askInbox(content, context);

    case 'draft': {
      // Falls back to the raw message when the router returned no explicit
      // instructions — draftReplyTo cannot do anything useful with null, and
      // the user's own words are a better guess than an empty string.
      const instructions = route.draft_instructions || content;
      const result = await draftReplyTo(route.draft_target, instructions, context);
      if (!result.success) return result.error;
      return `Draft created in Gmail.\n**To:** ${result.to}\n**Subject:** ${result.subject}\n\n${result.body}`;
    }

    case 'chat':
      return chatReply(content, context);

    default:
      throw new Error(`Router returned an intent this handler doesn't implement: ${route.intent}`);
  }
}

client.on(Events.MessageCreate, async (message) => {
  // Ordered cheapest-first, and the bot check comes first on purpose: without
  // it the bot answers its own replies and loops forever. This also filters
  // the webhook-posted digests, which is correct for TRIGGERING — they are
  // still read as history by fetchTranscript.
  if (message.author.bot) return;
  if (!message.inGuild()) return;
  if (message.channel.isThread?.()) return;
  if (message.channel.name !== CHANNEL_NAME) return;
  if (message.channel.isSendable?.() === false) return;

  if (!ALLOWED_USER_IDS.includes(message.author.id)) {
    // Ignored silently rather than answered. A slash command could reject
    // with an ephemeral reply only the sender saw; a normal message has no
    // ephemeral equivalent, so any refusal would be posted publicly in the
    // channel — noise at best, and an invitation to make the bot talk at
    // worst. The rejection is logged where the operator will see it instead.
    console.log(`Ignored message from non-allowlisted user ${message.author.id}.`);
    return;
  }

  const content = message.content.trim();
  if (!content) {
    // Almost always one specific misconfiguration rather than an actually
    // empty message: without the privileged MessageContent intent enabled in
    // the Developer Portal, Discord delivers every message with its content
    // stripped. The bot connects, the handler runs, and nothing happens —
    // a failure with no symptom unless it is called out.
    if (!warnedAboutEmptyContent) {
      warnedAboutEmptyContent = true;
      console.warn(
        `Received a message in #${CHANNEL_NAME} with empty content. If this happens for every message, the ` +
        `MESSAGE CONTENT INTENT is not enabled — turn it on at Discord Developer Portal -> your application -> ` +
        `Bot -> Privileged Gateway Intents, then restart the bot.`
      );
    }
    return;
  }

  try {
    await withTyping(message.channel, async () => {
      const transcript = await fetchTranscript(message.channel, message.id);
      const route = await classifyMessage(content, transcript);
      console.log(`[router] intent=${route.intent} use_context=${route.use_context}`);

      const reply = await dispatch(route, content, transcript);
      await sendReply(message.channel, reply);
    });
  } catch (err) {
    // One catch for the whole request. Every await above can throw — the
    // router on a malformed classification, askInbox/draftReplyTo on a
    // provider failure, sendReply on a Discord rejection — and none of them
    // should take the process down or leave the user staring at a typing
    // indicator that stopped meaning anything.
    console.error('Failed to handle message:', err);
    await sendError(message.channel, 'Sorry, something went wrong handling that', err);
  }
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}. Listening for messages in #${CHANNEL_NAME}.`);
  if (ALLOWED_USER_IDS.length === 0) {
    console.warn('DISCORD_ALLOWED_USER_ID is empty — every message will be ignored. Set it in .env.');
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
