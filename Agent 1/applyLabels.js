/**
 * applyLabels.js
 *
 * Fourth step of the `npm run triage` pipeline. Reads the classified emails
 * in task_list.json and applies a corresponding Gmail label (e.g.
 * "Triage/Meeting") to each source message, creating the label in Gmail first
 * if it doesn't already exist.
 *
 * Depends on:
 * - googleAuth.js for an authorized Gmail API client.
 * - task_list.json, produced by emailPriority.js.
 * - The Gmail labels these emails get here are what fetchEmails.js's QUERY
 *   later excludes, which is how already-triaged emails are skipped on
 *   future runs.
 *
 * Where it fits in the pipeline: runs fourth in `npm run triage`, after
 * syncToGoogle.js and before postDigest.js.
 */
import fs from 'fs';
import { getAuthorizedClient } from './googleAuth.js';

// Maps each classifier category to the Gmail label name it should map to.
// Any category not listed here (or an unrecognized one) falls back to
// CATEGORY_LABELS.unknown below.
const CATEGORY_LABELS = {
  action_required: 'Triage/Action-Required',
  fyi: 'Triage/FYI',
  newsletter: 'Triage/Newsletter',
  meeting: 'Triage/Meeting',
  personal: 'Triage/Personal',
  unknown: 'Triage/Unknown',
};

/**
 * Inputs: auth (Object) — authorized Gmail API client; labelName (string) —
 * the Gmail label name to find or create, e.g. "Triage/Meeting";
 * existingLabels (Array<{id: string, name: string}>) — the user's current
 * Gmail labels, fetched once up front by the caller.
 * Output: Promise<string> — the Gmail label id for `labelName`.
 * What it does: resolves a label name to its Gmail label id, creating the
 * label in Gmail if it doesn't exist yet.
 * How it does it: Gmail's modify endpoint needs a label id, not a name, so
 * this looks up `labelName` in the already-fetched `existingLabels` list
 * first to avoid an extra API call, and only calls the labels.create endpoint
 * on a miss.
 */
async function getOrCreateLabelId(auth, labelName, existingLabels) {
  const existing = existingLabels.find((l) => l.name === labelName);
  if (existing) return existing.id;
  const created = await auth.request({
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    method: 'POST',
    data: { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  console.log(`Created label: ${labelName}`);
  return created.data.id;
}

/**
 * Inputs: none.
 * Output: Promise<void> — applies Gmail labels as a side effect.
 * What it does: the main entry point for this script — labels every
 * classified email in Gmail according to its category.
 * How it does it: fetches the user's existing labels once, then for each task
 * resolves (and caches in `labelIdCache`, keyed by label name) the label id
 * via `getOrCreateLabelId` so repeated categories across the task list don't
 * trigger redundant lookups or creation calls, then calls the Gmail
 * messages.modify endpoint to add that label id to the source message.
 */
async function applyLabels() {
  const auth = await getAuthorizedClient();
  const taskList = JSON.parse(fs.readFileSync('task_list.json', 'utf-8'));

  const labelsResult = await auth.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels' });
  const existingLabels = labelsResult.data.labels;
  const labelIdCache = {};

  for (const task of taskList) {
    const labelName = CATEGORY_LABELS[task.category] || CATEGORY_LABELS.unknown;
    if (!labelIdCache[labelName]) {
      labelIdCache[labelName] = await getOrCreateLabelId(auth, labelName, existingLabels);
    }
    await auth.request({
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${task.source_email_id}/modify`,
      method: 'POST',
      data: { addLabelIds: [labelIdCache[labelName]] },
    });
    console.log(`Labeled ${task.source_email_id} as ${labelName}`);
  }
}

await applyLabels();