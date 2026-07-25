import fs from 'fs';

function loadEmails() {
    const raw = fs.readFileSync('emails.json', 'utf-8');
    const emails = JSON.parse(raw);
    return emails;
};


import dotenv from 'dotenv';
dotenv.config({ path: '/Users/umair/Developer/aksiq/.env'});

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const rank = { high: 1, medium: 2, low:3 };
const BODY_CAP = 20000;

async function main () {
    const emails = loadEmails();
    if (emails.length === 0){
        console.log("Inbox is empty - nothing to sort.");
        return
    }
    const taskList = []

    for (const email of emails){
        const wasTruncated = email.body.length > BODY_CAP
        const body = wasTruncated
            ? email.body.slice(0, BODY_CAP) + "\n\n...[truncated]"
            : email.body;
            const prompt = `You are an email triage classifier. Classify the email below. Category must be exactly one of: action_required, fyi, newsletter, meeting, personal, unknown. Prefer unknown over a poor fit. Do not force an email into a category it does not clearly belong to. Priority must be exactly one of: high, medium, low. suggested_task: a short action string, or null if none is needed. event_datetime: if the email states a specific date and time for a meeting or deadline, resolve it to an ISO 8601 datetime (e.g. "2026-07-28T15:00:00") using the Sent timestamp below to resolve relative references like "Tuesday" or "tomorrow". If no specific time is stated, use null. Respond with ONLY a JSON object with keys 'category', 'priority', 'suggested_task', 'event_datetime'. No other text, no markdown.

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
                {role: 'assistant', content: '{'}
            ],
        });

try{
    const rawText = '{' + response.content[0].text;
    const result = JSON.parse(rawText);
    taskList.push({ source_email_id: email.id, ...result, truncated: wasTruncated});
}   catch(err) {
    console.log("Failed to parse response for this email:", err.message);
    console.log("Raw text was:", response.content[0].text);
}
}

taskList.sort((a, b) => rank[a.priority] - rank[b.priority ]);

console.log(JSON.stringify(taskList, null, 2));
fs.writeFileSync('task_list.json', JSON.stringify(taskList, null, 2));

}



main();