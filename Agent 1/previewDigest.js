/**
 * previewDigest.js
 *
 * Standalone entry point for `npm run preview-digest`. Builds the same inbox
 * digest message as postDigest.js but prints it to the local console instead
 * of posting it to Discord — useful for checking what the digest will say
 * without spamming the Discord channel.
 *
 * Depends on:
 * - formatDigest.js for the message content (which in turn depends on
 *   task_list.json and emails.json — run `npm run triage` first if those
 *   don't exist yet).
 * - `dotenv` is loaded here for parity with postDigest.js's environment even
 *   though this script itself doesn't read any env vars directly.
 *
 * Where it fits in the pipeline: not part of `npm run triage`; run manually,
 * any time after fetchEmails.js and emailPriority.js have produced their
 * output files, as a dry run before postDigest.js would post to Discord.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/Users/umair/Developer/aksiq/.env' });
import { buildDigestMessage } from './formatDigest.js';

const message = await buildDigestMessage();
console.log(message);