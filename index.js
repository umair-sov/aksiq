import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function main () {
    const response = await client.messages.create ({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        messages: [
            { role: 'user', content: 'Say hello and tell me one fact about APIs.' }
        ],
    });

    console.log(response.content[0].text);

}

main();

