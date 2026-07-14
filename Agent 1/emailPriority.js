import fs from 'fs';

function loadEmails() {
    const raw = fs.readFileSync('emails.json', 'utf-8');
    const emails = JSON.parse(raw);
    return emails;
};

const emails = loadEmails();
console.log(emails[0]);

import dotenv from 'dotenv';
dotenv.config({ path: '/Users/umair/Developer/aksiq/.env'});

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function main () {
    const emails = loadEmails();
    const taskList = []

    for (const email of emails){
    const prompt = `You are an email triage classifier. Classify the email below. Category must be exactly one of: action_required, fyi, newsletter, meeting, personal. Priority must be exactly one of: high, medium, low suggested_task: a short action string, or null if none is needed. Respond with ONLY a JSON object with keys 'category', 'priority', 'suggested_task'. No other text, no markdown.
    

    <email>
    From: ${email.from.name} <${email.from.email}>
    To: ${email.to.join(', ')}
    Cc: ${email.cc.join(', ')}
    Subject: ${email.subject}
    Body: ${email.body}
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
    taskList.push({ source_email_id: email.id, ...result});
}   catch(err) {
    console.log("Failed to parse response for this email:", err.message);
    console.log("Raw text was:", response.content[0].text);
}
}

console.log(JSON.stringify(taskList, null, 2));
fs.writeFileSync('task_list.json', JSON.stringify(taskList, null, 2));

}



main();