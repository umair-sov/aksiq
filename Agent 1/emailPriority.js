/**
 * emailPriority.js
 *
 * Second step of the `npm run triage` pipeline. Reads the emails cached by
 * fetchEmails.js, sends each one to Claude for classification (category,
 * priority, suggested task, and any detected event/deadline datetime), and
 * writes the results to task_list.json.
 *
 * Depends on:
 * - emails.json, produced by fetchEmails.js (this script does not talk to
 *   Gmail directly).
 * - `@anthropic-ai/sdk` (the Claude API) for classification.
 * - `dotenv` to load the ANTHROPIC_API_KEY (and other secrets) from a shared
 *   .env file outside this project directory.
 * - Writes: task_list.json (consumed by syncToGoogle.js, applyLabels.js,
 *   formatDigest.js, askInbox.js).
 *
 * Where it fits in the pipeline: runs second in `npm run triage`, after
 * fetchEmails.js and before syncToGoogle.js.
 */
import fs from 'fs';

/**
 * Inputs: none.
 * Output: Array<Object> — the parsed contents of emails.json (the flattened
 * email records written by fetchEmails.js).
 * What it does: loads the cached email batch that this run will classify.
 */
function loadEmails() {
    if (!fs.existsSync('emails.json')) return [];
    const raw = fs.readFileSync('emails.json', 'utf-8');
    const emails = JSON.parse(raw);
    return emails;
};


import dotenv from 'dotenv';
dotenv.config({ path: '/Users/umair/Developer/aksiq/.env'});

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Maps priority strings to a sortable numeric rank; used to order the final
// task list from most to least urgent.
const rank = { high: 1, medium: 2, low:3 };
// Caps how much of an email body is sent to the model, to keep prompts (and
// cost) bounded for unusually long emails.
const BODY_CAP = 20000;
// The only category/priority values the rest of the pipeline knows how to
// handle (applyLabels.js's CATEGORY_LABELS, formatDigest.js's bucketing, and
// the `rank` map above). Used to validate the classifier's output below,
// since nothing else in the pipeline checks this before trusting it.
const VALID_CATEGORIES = ['action_required', 'fyi', 'newsletter', 'meeting', 'personal', 'unknown'];
const VALID_PRIORITIES = ['high', 'medium', 'low'];

/**
 * Inputs: none.
 * Output: Promise<void> — writes task_list.json as a side effect (and logs it
 * to the console).
 * What it does: the main entry point for this script — classifies every
 * cached email with Claude and produces a priority-sorted task list. If there
 * are no cached emails to classify, it still writes an empty task_list.json
 * (rather than leaving a previous run's stale file in place) so downstream
 * steps correctly reflect "nothing new".
 * How it does it: for each email, truncates an overly long body, prompts
 * Claude to return a strict JSON object (category/priority/suggested_task/
 * event_datetime), parses that response, validates/coerces the returned
 * category and priority against the known enums (VALID_CATEGORIES/
 * VALID_PRIORITIES) so an unexpected value can't silently break sorting or
 * digest bucketing downstream, and pushes the result onto `taskList` tagged
 * with the source email's id. After all emails are processed, sorts the list
 * by priority rank before writing it out.
 */
async function main () {
    const emails = loadEmails();
    if (emails.length === 0){
        console.log("Inbox is empty - nothing to sort.");
        // Still write an empty task list — otherwise downstream steps and
        // the digest would keep reusing the previous run's stale
        // task_list.json instead of correctly reflecting "nothing new".
        fs.writeFileSync('task_list.json', JSON.stringify([], null, 2));
        return
    }
    const taskList = []

    for (const email of emails){
        // Skip sending the full body to Claude if it exceeds BODY_CAP; append a
        // marker so the model knows the content was cut off rather than complete.
        const wasTruncated = email.body.length > BODY_CAP
        const body = wasTruncated
            ? email.body.slice(0, BODY_CAP) + "\n\n...[truncated]"
            : email.body;
            // The prompt passes the email's own Sent timestamp so the model can
            // resolve relative dates ("tomorrow", "Tuesday") mentioned in the body
            // into an absolute ISO 8601 datetime for event_datetime.
            const prompt = `You are an email triage classifier. Classify the email below. Category must be exactly one of: action_required, fyi, newsletter, meeting, personal, unknown. Prefer unknown over a poor fit. Do not force an email into a category it does not clearly belong to. Priority must be exactly one of: high, medium, low. suggested_task: a short action string, or null if none is needed. event_datetime: if the email states a specific date and time for a meeting or deadline, resolve it to an ISO 8601 datetime that includes an explicit Asia/Karachi timezone offset (e.g. "2026-07-28T15:00:00+05:00") — assume Asia/Karachi is the relevant timezone unless the email itself states a different one — using the Sent timestamp below to resolve relative references like "Tuesday" or "tomorrow". If no specific time is stated, use null. Respond with ONLY a JSON object with keys 'category', 'priority', 'suggested_task', 'event_datetime'. No other text, no markdown.

            <email>
            Sent: ${email.timestamp}
            From: ${email.from.name} <${email.from.email}>
            To: ${email.to.join(', ')}
            Cc: ${email.cc.join(', ')}
            Subject: ${email.subject}
            Body: ${body}
            </email>`;

        const response = await client.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 150,
            messages: [
                {role: 'user', content: prompt},
                // Pre-filling the assistant turn with a literal '{' forces the
                // completion to continue directly into JSON (skipping any
                // preamble text or markdown fences the model might otherwise add).
                {role: 'assistant', content: '{'}
            ],
        });

try{
    // The leading '{' consumed by the prefill above isn't included in
    // response.content[0].text, so it has to be re-added before parsing.
    const rawText = '{' + response.content[0].text;
    const result = JSON.parse(rawText);

    // The model occasionally returns a category/priority outside the known
    // enum (or a case/spelling variant); nothing downstream validates this,
    // so an unrecognized value would silently produce a NaN sort rank
    // (emailPriority.js) or a mislabeled digest bucket (formatDigest.js).
    // Coerce and log instead of trusting it blindly.
    if (!VALID_CATEGORIES.includes(result.category)) {
        console.log(`Email ${email.id}: unexpected category "${result.category}", coercing to 'unknown'.`);
        result.category = 'unknown';
    }
    if (!VALID_PRIORITIES.includes(result.priority)) {
        console.log(`Email ${email.id}: unexpected priority "${result.priority}", coercing to 'low'.`);
        result.priority = 'low';
    }

    taskList.push({ source_email_id: email.id, ...result, truncated: wasTruncated});
}   catch(err) {
    console.log("Failed to parse response for this email:", err.message);
    console.log("Raw text was:", response.content[0].text);
}
}

// Sorts ascending by rank (high=1 first, low=3 last); any email whose parsed
// priority isn't one of the three known values ranks as NaN and its relative
// order versus other entries is left up to the sort implementation.
taskList.sort((a, b) => rank[a.priority] - rank[b.priority ]);

console.log(JSON.stringify(taskList, null, 2));
fs.writeFileSync('task_list.json', JSON.stringify(taskList, null, 2));

}



main();