import fs from 'fs';
import path from 'node:path';
import process from 'node:process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

function loadSavedCredentialsIfExist() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  const content = fs.readFileSync(TOKEN_PATH, 'utf-8');
  return google.auth.fromJSON(JSON.parse(content));
}

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

export async function getAuthorizedClient() {
  const existing = loadSavedCredentialsIfExist();
  if (existing) return existing;

  const client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials?.refresh_token) {
    saveCredentials(client);
  }
  return client;
}