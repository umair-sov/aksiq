/**
 * runTriage.js
 *
 * The full triage pipeline (fetchEmails.js -> emailPriority.js ->
 * syncToGoogle.js -> applyLabels.js -> postDigest.js) wrapped as one
 * callable, awaitable function.
 *
 * Lifted out of what used to be discordBot.js's /triage slash-command
 * handler with its behavior unchanged: same `npm run triage` child process,
 * same 10-minute ceiling, same task_list.json summary, same three outcome
 * messages. It had to move because the natural-language router triggers a
 * run from a plain channel message rather than from a slash-command
 * interaction, and the old code was welded to `interaction.editReply` — it
 * built its reply text inside the exec callback instead of returning it, so
 * there was nothing to call.
 *
 * Depends on:
 * - The `triage` npm script in package.json (the five-step chain above).
 *   This file deliberately shells out rather than importing those steps,
 *   because each one is a standalone top-level-await script designed to run
 *   as `node file.js` — importing one would execute it on import.
 * - task_list.json, written by emailPriority.js, for the summary line.
 *
 * Where it fits in the pipeline: it *is* the pipeline, invoked from the
 * Discord layer. The cron-driven runs still call the npm script directly and
 * never load this file.
 */
import { exec } from 'child_process';
import fs from 'fs';
import process from 'node:process';

// Hard ceiling on a triage run. Without it, exec() waits forever: a stalled
// provider call anywhere in the five-script chain leaves the callback
// pending, and the caller is left awaiting a promise that never settles — a
// hang and a success look identical from the channel. On expiry Node sends
// killSignal to the child and invokes the callback with error.killed === true.
const TRIAGE_TIMEOUT_MS = 10 * 60 * 1000;

// How many task_list.json entries the summary shows. The full list can run to
// dozens of lines on a big batch, which is both unreadable in a chat message
// and a risk of blowing Discord's 2000-character message limit.
const SUMMARY_LIMIT = 10;

/**
 * Inputs: none.
 * Output: Promise<Error|null> — the exec error if the pipeline failed or was
 * killed on timeout, or null if it exited cleanly.
 * What it does: runs the triage npm script to completion as a child process.
 * How it does it: wraps callback-style exec() in a promise that always
 * resolves rather than rejecting, so the single caller below can branch on
 * the error object (specifically error.killed) instead of splitting its logic
 * across a try/catch. The command string is a hardcoded literal with no
 * interpolated input, so there is no shell-injection surface here.
 */
function execTriage() {
  return new Promise((resolve) => {
    exec(
      'npm run triage',
      { cwd: process.cwd(), timeout: TRIAGE_TIMEOUT_MS, killSignal: 'SIGTERM' },
      (error) => resolve(error ?? null)
    );
  });
}

/**
 * Inputs: none.
 * Output: Promise<string> — a human-readable, ready-to-post summary of what
 * happened, whether the run succeeded, failed, or timed out.
 * What it does: the main export — runs the whole triage chain and reports the
 * outcome.
 * How it does it: distinguishes a timeout kill from the pipeline exiting
 * non-zero on its own, because those are very different situations and a bare
 * message the user can't act on is worse than no message. Never throws: every
 * outcome, including failure, comes back as text for the caller to post. Note
 * that an exec error's .message carries the child's stderr and can be
 * thousands of characters — callers posting this to Discord must enforce the
 * 2000-character message limit themselves rather than assuming this fits.
 */
export async function runTriagePipeline() {
  const error = await execTriage();

  if (error) {
    const minutes = Math.round(TRIAGE_TIMEOUT_MS / 60000);
    return error.killed
      ? `Triage timed out after ${minutes} minutes and was stopped. Nothing was posted to the digest — check the server logs before re-running.`
      : `Failed: ${error.message}`;
  }

  try {
    const tasks = JSON.parse(fs.readFileSync('task_list.json', 'utf-8'));
    const summary = tasks
      .slice(0, SUMMARY_LIMIT)
      .map((t) => `**[${t.priority}]** ${t.suggested_task || t.category}`)
      .join('\n');
    return `Done. Latest triage:\n${summary || 'Nothing new to triage.'}`;
  } catch (err) {
    return `Triage ran, but summarizing the results failed: ${err.message}`;
  }
}
