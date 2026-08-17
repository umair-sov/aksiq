/**
 * postDigest.js
 * -------------
 * Final step in the triage pipeline (fetchEmails.js -> emailPriority.js ->
 * syncToGoogle.js -> applyLabels.js -> postDigest.js). Builds the formatted
 * inbox digest (via formatDigest.js) and posts it to the #gmail Discord
 * channel through a webhook — no persistent bot connection needed, since a
 * webhook is just a one-off HTTP POST.
 *
 * WHICH CHANNEL THIS POSTS TO IS NOT DECIDED HERE. A Discord webhook is bound
 * to one channel at creation time, so the destination is baked into
 * DISCORD_WEBHOOK_URL and nothing in this file names, resolves, or can change
 * it — retargeting the digest means creating a webhook on the other channel
 * and swapping the env var, not editing this code. The #gmail above is
 * therefore a statement about the current .env, verified against Discord's
 * API on 2026-08-17, rather than something the code enforces. Treat it as
 * liable to drift and re-check it rather than trusting it.
 *
 * That it lands in #gmail matters beyond tidiness: discordBot.js's router
 * reads recent channel messages as conversational context and deliberately
 * keeps bot/webhook messages in that history, so posting the digest here is
 * what lets a follow-up like "what was the second one?" resolve against it.
 * Moving the digest to its own channel would silently break that.
 *
 * Depends on: formatDigest.js (message content), DISCORD_WEBHOOK_URL (env var).
 *
 * dotenv path uses a two-entry fallback array rather than one hardcoded path,
 * since this exact file gets copied unchanged between two different folder
 * layouts: locally in Agent 1, where .env lives one directory up, and on the
 * VPS deploy copy, where .env sits in the same folder as the script. dotenv
 * tries '.env' first, and if that's not found here, falls back to '../.env' —
 * so one line works correctly in both places without special-casing either.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env', '../.env'] });
import { buildDigestMessage } from './formatDigest.js';

/**
 * Inputs: message (string) — the full digest text from buildDigestMessage();
 * maxLength (number, optional, default 1900) — the size ceiling per chunk.
 * Output: Array<string> — one or more message pieces, each under maxLength.
 * What it does: splits a long digest into pieces that each fit under
 * Discord's hard 2000-character webhook limit, since Discord silently
 * rejects the ENTIRE message if it's even slightly over that limit — there's
 * no partial delivery, so without this a long digest (e.g. the LOW section
 * on a 25-email batch) could fail to post at all with no visible content.
 * How it does it: breaks only at existing newline boundaries, never mid-line,
 * so a bullet point or section header is never cut in half across two
 * messages. maxLength defaults to 1900, not 2000, as a small safety margin —
 * Discord's real limit accounts for some overhead beyond raw text length.
 */
function chunkMessage(message, maxLength = 1900) {
  const lines = message.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Inputs: none (reads DISCORD_WEBHOOK_URL from process.env, and pulls the
 * digest content from buildDigestMessage(), which itself reads emails.json/
 * task_list.json off disk).
 * Output: none — posts to Discord as a side effect, logs success/failure.
 * What it does: builds the digest, splits it into Discord-safe chunks, and
 * posts each chunk in order as its own webhook message.
 * How it does it: posts chunks sequentially (not in parallel) so they appear
 * in the correct reading order in the channel. Stops immediately and logs
 * the failure if any single chunk's POST fails, rather than continuing to
 * post out-of-order pieces after something's already gone wrong.
 */
async function postDigest() {
  const message = await buildDigestMessage();
  const chunks = chunkMessage(message);

  for (const chunk of chunks) {
    const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk }),
    });

    if (!res.ok) {
      console.error('Failed to post digest chunk:', await res.text());
      return;
    }
  }

  console.log(`Digest posted to Discord in ${chunks.length} message(s).`);
}

await postDigest();