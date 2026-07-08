import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function main () {
    const response = await client.messages.create ({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [
            {role: 'user', content: 'Say Hello and give a fun fact about APIs.'},
            {role: 'user', content: 'Say Bye and give a fun fact about coding.'},
            {role: 'user', content: 'Say whats up and tell me the top 3 footballers in the world.'}
        ],
    });

    console.log(response.content[0].text);
}
main();