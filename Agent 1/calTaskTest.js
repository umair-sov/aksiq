/**
 * calTaskTest.js
 *
 * Standalone diagnostic script — not part of `npm run triage` or any other
 * pipeline step, and not imported by any other file. Used to manually verify
 * that the Calendar and Tasks OAuth scopes are granted and working, by
 * listing the user's calendars and task lists.
 *
 * Depends on:
 * - credentials.json for the OAuth client id/secret.
 * - `@google-cloud/local-auth` to run its own interactive login (separately
 *   from googleAuth.js — this script does NOT reuse or write token.json, so
 *   every run re-authenticates).
 *
 * Where it fits in the pipeline: nowhere — it's a manual debugging tool, run
 * directly via `node calTaskTest.js`, useful for confirming Calendar/Tasks
 * access works before relying on it in syncToGoogle.js.
 */
import path from 'node:path';
import process from 'node:process';
import { authenticate } from '@google-cloud/local-auth';

// Covers both APIs this script probes: full Calendar event access plus
// read-only Calendar list access, and full Tasks access.
const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks',
];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Inputs: none.
 * Output: Promise<void> — only logs to the console.
 * What it does: authenticates fresh (no cached token) and confirms Calendar
 * and Tasks API access by listing the user's calendars and task lists.
 * How it does it: makes one raw `auth.request` call per API — Calendar's
 * calendarList endpoint and Tasks' lists endpoint — and logs just the
 * human-readable names (`summary` for calendars, `title` for task lists)
 * rather than the full response objects.
 */
async function testAccess() {
  const auth = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });

  const calResult = await auth.request({
    url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  });
  console.log('Calendars:', calResult.data.items.map((c) => c.summary));

  const taskListsResult = await auth.request({
    url: 'https://tasks.googleapis.com/tasks/v1/users/@me/lists',
  });
  console.log('Task lists:', taskListsResult.data.items.map((t) => t.title));
}

await testAccess();