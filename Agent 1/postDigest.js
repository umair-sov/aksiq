/**
 * postDigest.js
 *
 * Fifth and final step of the `npm run triage` pipeline. Builds the inbox
 * digest message (via formatDigest.js) and posts it to a Discord channel
 * through a webhook URL.
 *
 * Depends on:
 * - formatDigest.js for the message content (which in turn depends on
 *   task_list.json and emails.json).
 * - `dotenv` to load DISCORD_WEBHOOK_URL from a shared .env file.
 * - The Discord webhook HTTP API (no discord.js client needed for a one-off
 *   webhook post).
 *
 * Where it fits in the pipeline: runs last in `npm run triage`, after
 * applyLabels.js. See also previewDigest.js, which builds the same message
 * but prints it locally instead of posting to Discord.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/Users/umair/Developer/aksiq/.env' });
import { buildDigestMessage } from './formatDigest.js';

/**
 * Inputs: none.
 * Output: Promise<void> — posts to Discord as a side effect.
 * What it does: the main entry point for this script — builds the digest text
 * and delivers it to the configured Discord channel.
 * How it does it: Discord webhooks accept a plain POST with a JSON body whose
 * `content` field is the message text, so this just builds that payload and
 * checks `res.ok` to report success or log the failure response body.
 */
async function postDigest() {
  const message = await buildDigestMessage();

  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message }),
  });

  if (!res.ok) {
    console.error('Failed to post digest:', await res.text());
  } else {
    console.log('Digest posted to Discord.');
  }
}

await postDigest();