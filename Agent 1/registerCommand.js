/**
 * registerCommand.js
 *
 * One-off setup script — registers the /triage, /ask, and /draft slash
 * commands with Discord for a specific guild (server). Not part of the
 * running pipeline; must be run manually once (or again whenever the command
 * definitions here change) before discordBot.js can respond to them, since
 * Discord requires slash commands to be registered via the REST API before
 * they show up in a server.
 *
 * Depends on:
 * - `discord.js` (REST client, Routes helper, SlashCommandBuilder) to build
 *   and submit the command definitions.
 * - `dotenv` for DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID.
 * - No local file dependencies; this only talks to Discord's API.
 *
 * Where it fits in the pipeline: a prerequisite for discordBot.js, not part
 * of `npm run triage`. Run via its own script/command, separately.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env', '../.env'] });
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

// Defines the three slash commands discordBot.js knows how to handle; each
// builder is converted to Discord's plain JSON command schema via .toJSON()
// since that's the format the REST API's PUT endpoint expects.
const commands = [
  new SlashCommandBuilder().setName('triage').setDescription('Fetch, classify, and sync your latest emails'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a question about your recently triaged inbox')
    .addStringOption((opt) => opt.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('draft')
    .setDescription('Draft a reply to an email in Gmail')
    .addStringOption((opt) => opt.setName('email').setDescription('Sender name or subject keyword').setRequired(true))
    .addStringOption((opt) => opt.setName('instructions').setDescription('What the reply should say').setRequired(true)),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

// applicationGuildCommands scopes registration to a single guild (near-
// instant propagation), as opposed to global commands which can take up to
// an hour to appear — appropriate for a single-server personal bot like this.
await rest.put(
  Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
  { body: commands }
);

console.log('Slash commands registered: /triage, /ask, /draft');