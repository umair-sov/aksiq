import path from 'node:path';
import process from 'node:process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

async function listLabels() {
  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  console.log('--- Raw credentials on the auth client ---');
  console.log(auth.credentials);

  console.log('--- Attempt 1: direct request via the auth client itself ---');
  try {
    const direct = await auth.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels' });
    console.log('Direct request succeeded:', direct.data);
  } catch (err) {
    console.log('Direct request failed:', err.message);
  }

  console.log('--- Attempt 2: via the googleapis wrapper (what we tried before) ---');
  const gmail = google.gmail({ version: 'v1', auth });
  const result = await gmail.users.labels.list({ userId: 'me' });
  console.log('Wrapper request succeeded:', result.data);
}

await listLabels();