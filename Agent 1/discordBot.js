/**
 * discordBot.js
 *
 * Long-running Discord bot process (`npm run bot`). Listens for the
 * /triage, /ask, and /draft slash commands registered by registerCommand.js
 * and wires each one to the corresponding pipeline functionality.
 *
 * Depends on:
 * - `discord.js` for the gateway connection and interaction handling.
 * - registerCommand.js must have been run at least once beforehand so Discord
 *   knows about these slash commands — this file only handles responding to
 *   them, not registering them.
 * - askInbox.js (/ask) and draftReply.js (/draft) for their respective
 *   command logic.
 * - Shells out to `npm run triage` (the fetchEmails.js -> emailPriority.js ->
 *   syncToGoogle.js -> applyLabels.js -> postDigest.js chain) for /triage,
 *   then reads the task_list.json it produces to summarize the results.
 * - `dotenv` for DISCORD_BOT_TOKEN.
 * - `DISCORD_ALLOWED_USER_ID` env var — a comma-separated list of Discord
 *   user IDs (a single ID is also valid) allowed to invoke any slash
 *   command. Every command here can read or act on the private inbox, so
 *   only allowlisted users may invoke /triage, /ask, or /draft; everyone
 *   else is rejected before any command logic runs.
 *
 * Where it fits in the pipeline: the interactive front-end to the whole
 * project — it triggers the same triage pipeline the npm scripts run
 * directly, plus exposes ad hoc inbox Q&A and reply drafting.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/Users/umair/Developer/aksiq/.env' });
import { Client, GatewayIntentBits } from 'discord.js';
import { exec } from 'child_process';
import fs from 'fs';
import process from 'node:process';
import { askInbox } from './askInbox.js';
import { draftReplyTo } from './draftReply.js';

// Guilds intent is sufficient since this bot only responds to slash command
// interactions — it never needs to read regular message content.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Only these Discord user IDs may invoke any slash command — every command
// here can read or act on the private inbox (full recent-inbox context for
// /ask, draft creation and a full triage run), so this isn't optional.
// DISCORD_ALLOWED_USER_ID holds one ID, or several separated by commas.
const ALLOWED_USER_IDS = (process.env.DISCORD_ALLOWED_USER_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log('Allowed:', process.env.DISCORD_ALLOWED_USER_ID, '| Actual:', interaction.user.id);
  
  if (!ALLOWED_USER_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: "Sorry, you're not authorized to use this bot.", ephemeral: true });
    return;
  }

  if (interaction.commandName === 'triage') {
    await interaction.reply('Running triage — this can take a minute...');
    // Runs the full triage pipeline as a child process (rather than importing
    // and calling each step's code directly) since each step is its own
    // top-level-await script designed to run standalone via `node file.js`.
    exec('npm run triage', { cwd: process.cwd() }, async (error) => {
      if (error) return void interaction.editReply(`Failed: ${error.message}`);
      try {
        const tasks = JSON.parse(fs.readFileSync('task_list.json', 'utf-8'));
        const summary = tasks.slice(0, 10).map((t) => `**[${t.priority}]** ${t.suggested_task || t.category}`).join('\n');
        await interaction.editReply(`Done. Latest triage:\n${summary || 'Nothing new to triage.'}`);
      } catch (err) {
        await interaction.editReply(`Triage ran, but summarizing the results failed: ${err.message}`);
      }
    });
  }

  if (interaction.commandName === 'ask') {
    await interaction.reply('Thinking...');
    try {
      const question = interaction.options.getString('question');
      const answer = await askInbox(question);
      await interaction.editReply(answer);
    } catch (err) {
      await interaction.editReply(`Sorry, something went wrong answering that: ${err.message}`);
    }
  }

  if (interaction.commandName === 'draft') {
    await interaction.reply('Drafting...');
    try {
      const email = interaction.options.getString('email');
      const instructions = interaction.options.getString('instructions');
      const result = await draftReplyTo(email, instructions);
      if (!result.success) {
        await interaction.editReply(result.error);
      } else {
        await interaction.editReply(`Draft created in Gmail.\n**To:** ${result.to}\n**Subject:** ${result.subject}\n\n${result.body}`);
      }
    } catch (err) {
      await interaction.editReply(`Sorry, something went wrong drafting that reply: ${err.message}`);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);