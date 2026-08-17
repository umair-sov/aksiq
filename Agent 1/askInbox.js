/**
 * askInbox.js
 *
 * Answers a free-text question about the user's recently triaged inbox by
 * handing the model a condensed summary of every cached email plus its
 * classification. Reached when messageRouter.js classifies a message in the
 * #gmail channel as intent "ask" — this used to back the /ask slash command,
 * which no longer exists.
 *
 * Depends on:
 * - emails.json (from fetchEmails.js) and task_list.json (from
 *   emailPriority.js) — read-only.
 * - `llmClient/index.js` (callLLM) to answer the question via whichever
 *   provider LLM_PROVIDER names.
 *
 * Where it fits in the pipeline: not part of `npm run triage`; called by
 * discordBot.js when the router reads a message as a question about the
 * inbox, after triage has already populated emails.json and task_list.json.
 */
import fs from 'fs';
import { callLLM } from './llmClient/index.js';

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
 * as typed into the #gmail Discord channel; recentConversation (string|null,
 * optional) — a rendered transcript of recent channel messages, supplied only
 * when messageRouter.js judged this question to be a follow-up that depends
 * on them, and omitted entirely otherwise.
 * Output: Promise<string> — the model's answer, or a fixed message if no
 * cached emails exist yet.
 * What it does: the main export of this module — answers a question about
 * the user's recently triaged inbox using only the cached email data as
 * context.
 * How it does it: serializes the condensed context from `loadContext` as
 * JSON directly into the prompt and instructs the model to answer only from
 * that data (and to say so plainly if the answer isn't there) rather than
 * inventing information. The transcript, when present, is included purely so
 * a question like "who was the second one from?" has an antecedent to
 * resolve; the answer itself is still grounded in the email data alone,
 * which is why the closing instruction says "the emails above" rather than
 * "the information above".
 */
export async function askInbox(question, recentConversation) {
  const context = loadContext();
  if (context.length === 0) {
    return "I don't have any triaged emails cached yet — ask me to check your email first.";
  }

  // Left out completely rather than included as an empty heading when there's
  // no history: a labeled-but-empty section invites the model to treat the
  // absence as meaningful, and this prompt already carries a large JSON blob
  // competing for attention.
  const conversationSection = recentConversation
    ? `\nRecent conversation in this channel, oldest first. The question may refer back to it — use it to work out what the user means, not as a source of facts about their email:\n${recentConversation}\n`
    : '';

  const prompt = `You are answering questions about the user's recently triaged inbox. Here is the data:

${JSON.stringify(context, null, 2)}
${conversationSection}
Question: ${question}

Answer directly and concisely, based only on the emails above. If the answer isn't in this data, say so plainly rather than guessing.`;

  const answer = await callLLM('', prompt, {
    jsonMode: false,
    logLabel: '[askInbox]',
  });
  return answer.trim();
}