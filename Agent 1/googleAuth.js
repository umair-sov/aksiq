/**
 * googleAuth.js
 *
 * Shared Google OAuth helper for the whole pipeline. Every script that needs to
 * call a Google API (Gmail, Calendar, Tasks) goes through `getAuthorizedClient()`
 * here instead of running its own OAuth flow.
 *
 * Depends on:
 * - Local files: credentials.json (OAuth client id/secret downloaded from Google
 *   Cloud Console) and token.json (cached refresh token written after the first
 *   successful login).
 * - External: `@google-cloud/local-auth` (runs the interactive browser OAuth
 *   flow) and `googleapis` (used here only for its `google.auth.fromJSON` helper
 *   to rehydrate a saved token into a usable auth client).
 *
 * Where it fits in the pipeline: this is a dependency of fetchEmails.js,
 * applyLabels.js, syncToGoogle.js, and draftReply.js — it does not run on its
 * own and has no side effects at import time (no top-level await/execution).
 */
import fs from 'fs';
import path from 'node:path';
import process from 'node:process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

// Combined scope list covering every Google API the pipeline touches
// (Gmail read/write for triage + labeling, Calendar for meeting sync, Tasks for
// action items). Kept as one list so a single login grants everything needed.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

/**
 * Inputs: none.
 * Output: an authorized Google auth client (as produced by
 * `google.auth.fromJSON`) if a cached token exists, otherwise `null`.
 * What it does: attempts to reuse a previously saved login instead of
 * re-running the interactive OAuth flow.
 * How it does it: reads token.json (written by `saveCredentials` below) and
 * passes its parsed contents to `google.auth.fromJSON`, which reconstructs a
 * client capable of refreshing its own access token using the stored
 * refresh_token.
 */
function loadSavedCredentialsIfExist() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  const content = fs.readFileSync(TOKEN_PATH, 'utf-8');
  return google.auth.fromJSON(JSON.parse(content));
}

/**
 * Inputs: client (Object) — an authenticated OAuth2 client returned by
 * `authenticate()`, expected to have a `credentials.refresh_token`.
 * Output: none (writes to disk).
 * What it does: persists the OAuth client's refresh token to token.json so
 * future runs can skip the interactive browser login.
 * How it does it: reads the client id/secret back out of credentials.json
 * (supporting either the "installed app" or "web app" credential shape) and
 * combines them with the client's refresh_token into the JSON shape that
 * `google.auth.fromJSON` expects to read back in `loadSavedCredentialsIfExist`.
 */
function saveCredentials(client) {
  const keys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  fs.writeFileSync(TOKEN_PATH, payload);
}

/**
 * Inputs: none.
 * Output: Promise resolving to an authorized Google auth client usable as the
 * `auth` argument for both raw `auth.request({...})` calls and the
 * `googleapis` client wrappers.
 * What it does: the single entry point every other file calls to get a ready-
 * to-use Google auth client, transparently reusing a cached login when
 * possible and falling back to an interactive OAuth flow otherwise.
 * How it does it: checks for a cached token first (cheap, no user interaction);
 * only if that's missing does it call `authenticate()`, which opens a browser
 * window for the user to grant SCOPES. If that flow yields a refresh_token
 * (it may not, e.g. on a re-consent without offline access), the result is
 * cached via `saveCredentials` so the next run can skip this step.
 */
export async function getAuthorizedClient() {
  const existing = loadSavedCredentialsIfExist();
  if (existing) return existing;

  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials?.refresh_token) {
    saveCredentials(client);
  }
  return client;
}