/**
 * syncToGoogle.js
 *
 * Third step of the `npm run triage` pipeline. Reads the classified emails in
 * task_list.json and, for each one not already synced, creates either a
 * Google Calendar event (for meetings with a known date/time) or a Google
 * Task (for anything else actionable). Keeps a record of which source emails
 * have already been synced so re-running the pipeline doesn't duplicate
 * calendar events or tasks.
 *
 * Depends on:
 * - googleAuth.js for an authorized Calendar/Tasks API client.
 * - task_list.json, produced by emailPriority.js.
 * - Reads/writes synced_ids.json to track which emails have already produced
 *   a calendar event or task.
 *
 * Where it fits in the pipeline: runs third in `npm run triage`, after
 * emailPriority.js and before applyLabels.js.
 */
import fs from 'fs';
import path from 'node:path';
import process from 'node:process';
import { getAuthorizedClient } from './googleAuth.js';

const SYNCED_PATH = path.join(process.cwd(), 'synced_ids.json');

/**
 * Inputs: none.
 * Output: Array<string> — source_email_id values that have already been
 * synced to Calendar/Tasks, or [] if the file doesn't exist yet (first run).
 * What it does: loads the sync history so already-processed emails can be
 * skipped this run.
 */
function loadSyncedIds() {
  if (!fs.existsSync(SYNCED_PATH)) return [];
  return JSON.parse(fs.readFileSync(SYNCED_PATH, 'utf-8'));
}

/**
 * Inputs: ids (Array<string>) — the full, updated list of synced
 * source_email_id values.
 * Output: none (writes to disk).
 * What it does: persists the sync history back to synced_ids.json for future
 * runs to read via `loadSyncedIds`.
 */
function saveSyncedIds(ids) {
  fs.writeFileSync(SYNCED_PATH, JSON.stringify(ids, null, 2));
}

/**
 * Inputs: auth (Object) — authorized Google auth client; task (Object) — a
 * task_list.json entry expected to have `event_datetime` (ISO string),
 * `suggested_task` (string|null), and `category` (string).
 * Output: Promise<void> — creates an event as a side effect via the Calendar
 * API.
 * What it does: creates a 30-minute Google Calendar event on the user's
 * primary calendar starting at the task's detected event time.
 * How it does it: the classifier (emailPriority.js) only ever produces a
 * start time, not a duration, so this assumes a fixed 30-minute block by
 * adding 30 * 60000 ms to the start time to compute the end time.
 */
async function createCalendarEvent(auth, task) {
  const start = new Date(task.event_datetime);
  const end = new Date(start.getTime() + 30 * 60000); // assumes 30-min duration

  await auth.request({
    url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    method: 'POST',
    data: {
      summary: task.suggested_task || task.category,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });
}

/**
 * Inputs: auth (Object) — authorized Google auth client; task (Object) — a
 * task_list.json entry expected to have `suggested_task`, `priority`, and
 * `source_email_id`.
 * Output: Promise<void> — creates a task as a side effect via the Tasks API.
 * What it does: creates a Google Task on the user's default task list for
 * follow-up items that aren't tied to a specific meeting time.
 * How it does it: stashes the priority and originating email id in the task's
 * `notes` field, since the Google Tasks API has no dedicated priority field.
 */
async function createTask(auth, task) {
  await auth.request({
    url: 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks',
    method: 'POST',
    data: {
      title: task.suggested_task,
      notes: `Priority: ${task.priority} | Source email: ${task.source_email_id}`,
    },
  });
}

/**
 * Inputs: none.
 * Output: Promise<void> — creates calendar events/tasks and updates
 * synced_ids.json as side effects.
 * What it does: the main entry point for this script — walks every
 * classified email and routes it to a calendar event, a task, or no action,
 * while skipping anything already synced in a previous run.
 * How it does it: meeting-category tasks with a known event_datetime become
 * calendar events; anything else with a suggested_task becomes a Google Task;
 * everything else (e.g. fyi/newsletter with no suggested action) is skipped.
 * Each processed task's id is appended to `syncedIds` (regardless of which
 * branch it took) so it's excluded on the next run, and the full list is
 * saved once at the end.
 */
async function syncTasks() {
  const auth = await getAuthorizedClient();
  const taskList = JSON.parse(fs.readFileSync('task_list.json', 'utf-8'));
  const syncedIds = loadSyncedIds();

  for (const task of taskList) {
    if (syncedIds.includes(task.source_email_id)) {
      console.log(`Already synced, skipping: ${task.source_email_id}`);
      continue;
    }

    if (task.category === 'meeting' && task.event_datetime) {
      await createCalendarEvent(auth, task);
      console.log(`Created calendar event: ${task.source_email_id}`);
    } else if (task.suggested_task) {
      await createTask(auth, task);
      console.log(`Created task: ${task.source_email_id}`);
    } else {
      console.log(`No action needed, skipping: ${task.source_email_id}`);
    }

    syncedIds.push(task.source_email_id);
  }

  saveSyncedIds(syncedIds);
}

await syncTasks();