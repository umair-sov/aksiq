/**
 * authTest.js
 *
 * Standalone diagnostic script — not part of `npm run triage` or any other
 * pipeline step, and not imported by any other file. Used to manually verify
 * that Google OAuth is working and to compare two different ways of calling
 * the Gmail API (a raw authenticated request vs. the `googleapis` client
 * wrapper), which is useful when debugging auth issues in isolation from the
 * rest of the pipeline.
 *
 * Depends on:
 * - credentials.json for the OAuth client id/secret.
 * - `@google-cloud/local-auth` to run its own interactive login (separately
 *   from googleAuth.js — this script does NOT reuse or write token.json, so
 *   every run re-authenticates).
 * - `googleapis` for the wrapper-based request in Attempt 2.
 *
 * Where it fits in the pipeline: nowhere — it's a manual debugging tool, run
 * directly via `node authTest.js`.
 */
import path from 'node:path';
import process from 'node:process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

// Read-only scope only, since this script just lists labels — it never
// modifies anything, unlike googleAuth.js's broader SCOPES used elsewhere.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Inputs: none.
 * Output: Promise<void> — only logs to the console.
 * What it does: authenticates fresh (no cached token) and lists Gmail labels
 * two different ways, to compare their behavior when debugging auth issues.
 * How it does it: Attempt 1 calls `auth.request` directly against the raw
 * Gmail REST endpoint; Attempt 2 wraps the same auth client in the
 * `googleapis` library's typed `gmail.users.labels.list` method. Both should
 * return equivalent data — this script exists to confirm that when
 * diagnosing whether an auth problem is specific to one calling style.
 */
async function listLabels() {
  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  // Deliberately not printing auth.credentials here — it contains a live
  // OAuth access token (and refresh token, if offline access was granted),
  // and logging it risks that credential ending up captured in shell
  // history, terminal scrollback, or a log file.
  console.log('--- Raw credentials on the auth client (redacted) ---');

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