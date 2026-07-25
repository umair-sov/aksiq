import path from 'node:path';
import process from 'node:process';
import { authenticate } from '@google-cloud/local-auth';

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks',
];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

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