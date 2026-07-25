import fs from 'fs';
import path from 'node:path';
import process from 'node:process';
import { getAuthorizedClient } from './googleAuth.js';

const SYNCED_PATH = path.join(process.cwd(), 'synced_ids.json');

function loadSyncedIds() {
  if (!fs.existsSync(SYNCED_PATH)) return [];
  return JSON.parse(fs.readFileSync(SYNCED_PATH, 'utf-8'));
}

function saveSyncedIds(ids) {
  fs.writeFileSync(SYNCED_PATH, JSON.stringify(ids, null, 2));
}

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