/**
 * formatDigest.js
 *
 * Builds the human-readable inbox digest message shared by postDigest.js and
 * previewDigest.js. Not run directly and not part of `npm run triage` itself —
 * it's a library module that reads the artifacts triage already produced
 * (task_list.json, emails.json) and formats them into a Discord-ready message,
 * closing with a short Claude-generated summary line.
 *
 * Depends on:
 * - task_list.json (from emailPriority.js) and emails.json (from
 *   fetchEmails.js) — read-only, no writes.
 * - `@anthropic-ai/sdk` for the closing summary line.
 *
 * Where it fits in the pipeline: called by postDigest.js (last step of
 * `npm run triage`, posts to Discord) and previewDigest.js (`npm run
 * preview-digest`, prints to the console instead).
 */
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Inputs: none.
 * Output: Object — a map of email id -> full email record, built from
 * emails.json.
 * What it does: loads cached emails indexed by id for O(1) lookup by
 * source_email_id while building digest sections.
 */
function loadEmailsById() {
  const emails = JSON.parse(fs.readFileSync('emails.json', 'utf-8'));
  const map = {};
  for (const email of emails) map[email.id] = email;
  return map;
}

/**
 * Inputs: isoString (string) — an ISO 8601 datetime, e.g. from
 * task.event_datetime.
 * Output: string — a short human-readable date like "Jul 28".
 * What it does: formats a deadline/event datetime for display in the digest.
 */
function formatDeadlineDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Inputs: taskList (Array<Object>) — entries from task_list.json (category,
 * priority, suggested_task, event_datetime, source_email_id); emailsById
 * (Object) — id-keyed email lookup from `loadEmailsById`.
 * Output: { deadlines: Array<Object>, high: Array<{label: string, taskAdded:
 * boolean}>, medium: Array<{label: string, taskAdded: boolean}>, low:
 * Array<string> } — tasks bucketed for digest display. `deadlines` entries
 * are the original task object plus a computed `label`; `high`/`medium`
 * entries are now `{ label, taskAdded }` objects (see below); `low` stays a
 * plain array of display strings.
 * What it does: sorts every classified task into exactly one digest section —
 * upcoming deadlines/meetings, or by priority otherwise.
 * How it does it: any task with an event_datetime is treated as a deadline
 * first (regardless of its priority) since it already has a concrete date to
 * show; everything else falls through to high/medium/low priority buckets.
 * The display label prefers "sender – suggested task" when the source email
 * is still in the cache, falling back to the task's own fields if the email
 * was pruned from emails.json since triage ran. For high/medium items,
 * `taskAdded` is `Boolean(task.suggested_task)` — this deliberately mirrors
 * the `else if (task.suggested_task)` check syncToGoogle.js uses to decide
 * whether it actually created a Google Task for that item (syncToGoogle.js
 * only creates a task when `suggested_task` is truthy), so the digest's
 * "Added to Task" confirmation reflects what really happened during sync
 * rather than guessing independently.
 */
function buildSections(taskList, emailsById) {
  const deadlines = [], high = [], medium = [], low = [];

  for (const task of taskList) {
    const email = emailsById[task.source_email_id];
    const label = email
      ? `${email.from.name || email.from.email} – ${task.suggested_task || email.subject}`
      : (task.suggested_task || task.category);

    if (task.event_datetime) {
      deadlines.push({ ...task, label });
      continue;
    }
    const taskAdded = Boolean(task.suggested_task);
    if (task.priority === 'high') high.push({ label, taskAdded });
    else if (task.priority === 'medium') medium.push({ label, taskAdded });
    else low.push(email ? (email.from.name || email.from.email) : task.source_email_id);
  }
  return { deadlines, high, medium, low };
}

/**
 * Inputs: deadlines (Array<Object>) — the `deadlines` bucket from
 * `buildSections`, each with `label` and `event_datetime`; highCount (number)
 * — count of high-priority, non-deadline items.
 * Output: Promise<string> — a one-to-two sentence plain-language summary.
 * What it does: asks Claude to write the digest's closing summary line,
 * highlighting the most urgent deadline and whether anything needs attention.
 * How it does it: pre-formats the deadline list into a compact string (or
 * 'none') so the model gets concrete facts to summarize rather than raw JSON.
 */
async function generateSummaryLine(deadlines, highCount) {
  const client = new Anthropic();
  const deadlineSummary = deadlines
    .map((d) => `${d.label} (${formatDeadlineDate(d.event_datetime)})`)
    .join(', ') || 'none';

  const prompt = `Write ONE short plain-language summary (max 2 sentences) for an email digest, given: ${highCount} high-priority items not tied to a deadline, and these deadlines added to calendar: ${deadlineSummary}. Mention the most urgent deadline if any exist, and whether anything urgent needs attention. Respond with ONLY the summary text.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text.trim();
}

/**
 * Inputs: none.
 * Output: Promise<string> — the complete, formatted digest message (with
 * emoji section headers, ready to post as-is to Discord or print to a
 * console).
 * What it does: the main export of this module — assembles the full digest
 * text from task_list.json and emails.json.
 * How it does it: loads and buckets every task via `buildSections`, then
 * appends each non-empty section (deadlines, high, medium, low) as its own
 * block, and finally appends a Claude-generated summary line from
 * `generateSummaryLine`. The low-priority section is capped to showing the
 * first 10 names to keep the message from becoming unreadably long when
 * there's a lot of newsletter/promo mail.
 */
export async function buildDigestMessage() {
  const taskList = JSON.parse(fs.readFileSync('task_list.json', 'utf-8'));
  const emailsById = loadEmailsById();
  const { deadlines, high, medium, low } = buildSections(taskList, emailsById);

  let message = `📋 INBOX DIGEST\n\n`;

  if (deadlines.length) {
    message += `📅 DEADLINES DETECTED\n`;
    for (const d of deadlines) message += `• ${formatDeadlineDate(d.event_datetime)} – ${d.label} – ✅ Added to Calendar\n`;
    message += `\n`;
  }
  if (high.length) {
    message += `🟠 HIGH\n`;
    // Mirrors the deadlines section's "– ✅ Added to Calendar" suffix above:
    // append "– ✅ Added to Task" whenever syncToGoogle.js would actually have
    // created a Google Task for this item (h.taskAdded), so the confirmation
    // shown here matches what really happened during sync.
    for (const h of high) message += `• ${h.label}${h.taskAdded ? ' – ✅ Added to Task' : ''}\n`;
    message += `\n`;
  }
  if (medium.length) {
    message += `🟡 MEDIUM\n`;
    // Same pattern as the HIGH section above.
    for (const m of medium) message += `• ${m.label}${m.taskAdded ? ' – ✅ Added to Task' : ''}\n`;
    message += `\n`;
  }
  if (low.length) {
    message += `🟢 LOW – ${low.length} emails (marketing, promotions, newsletters)\n`;
    message += `Includes: ${low.slice(0, 10).join(', ')}${low.length > 10 ? ', and others' : ''}\n\n`;
  }

  const summary = await generateSummaryLine(deadlines, high.length);
  message += `Summary: ${summary}`;
  return message;
}