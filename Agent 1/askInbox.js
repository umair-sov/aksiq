/**
 * askInbox.js
 *
 * Implements the /ask Discord command: answers a free-text question about the
 * user's recently triaged inbox by handing Claude a condensed summary of
 * every cached email plus its classification.
 *
 * Depends on:
 * - emails.json (from fetchEmails.js) and task_list.json (from
 *   emailPriority.js) — read-only.
 * - `@anthropic-ai/sdk` to answer the question.
 *
 * Where it fits in the pipeline: not part of `npm run triage`; called by
 * discordBot.js in response to the /ask slash command, after triage has
 * already populated emails.json and task_list.json.
 */
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Inputs: none.
 * Output: Array<{from: string, subject: string, snippet: string, category:
 * string|undefined, priority: string|undefined}> — one condensed entry per
 * cached email, or [] if emails.json doesn't exist yet.
 * What it does: builds a compact, per-email context object for the model to
 * answer questions from, joining each email with its triage classification.
 * How it does it: looks up each email's matching task_list.json entry by
 * source_email_id and merges in its category/priority (left undefined if the
 * email was never classified); truncates each body to a 500-character
 * snippet to keep the overall prompt size reasonable across many emails.
 */
function loadContext() {
  const emails = fs.existsSync('emails.json') ? JSON.parse(fs.readFileSync('emails.json', 'utf-8')) : [];
  const taskList = fs.existsSync('task_list.json') ? JSON.parse(fs.readFileSync('task_list.json', 'utf-8')) : [];

  return emails.map((email) => {
    const task = taskList.find((t) => t.source_email_id === email.id);
    return {
      from: email.from.name || email.from.email,
      subject: email.subject,
      snippet: email.body.slice(0, 500),
      category: task?.category,
      priority: task?.priority,
    };
  });
}

/**
 * Inputs: question (string) — a free-text question about the user's inbox,
 * as typed into the /ask Discord command.
 * Output: Promise<string> — Claude's answer, or a fixed message if no cached
 * emails exist yet.
 * What it does: the main export of this module — answers a question about
 * the user's recently triaged inbox using only the cached email data as
 * context.
 * How it does it: serializes the condensed context from `loadContext` as
 * JSON directly into the prompt and instructs the model to answer only from
 * that data (and to say so plainly if the answer isn't there) rather than
 * inventing information.
 */
export async function askInbox(question) {
  const context = loadContext();
  if (context.length === 0) {
    return "I don't have any triaged emails cached yet — run /triage first.";
  }

  const client = new Anthropic();
  const prompt = `You are answering questions about the user's recently triaged inbox. Here is the data:

${JSON.stringify(context, null, 2)}

Question: ${question}

Answer directly and concisely, based only on the emails above. If the answer isn't in this data, say so plainly rather than guessing.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text.trim();
}