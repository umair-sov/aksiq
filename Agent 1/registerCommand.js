/**
 * registerCommand.js
 *
 * SUPERSEDED — DO NOT RUN THIS UNLESS YOU ARE DELIBERATELY REVERTING.
 * discordBot.js no longer handles slash commands at all; its
 * interactionCreate handler is gone, replaced by natural-language messages
 * in the #gmail channel (see messageRouter.js). Running this script would
 * re-register three commands that nothing answers, so Discord would show
 * them in the picker and then report "The application did not respond" when
 * one is used. Use deregisterCommands.js to remove them instead.
 *
 * Kept on disk because it is the only record of the command definitions and
 * is what you would run to put the slash-command interface back.
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
//
// On /draft, `instructions` is added BEFORE `email` because Discord requires
// every required option to precede every optional one in the definition —
// registering them the other way round is rejected outright, not silently
// reordered. `email` is optional: omit it (or give a term that matches
// nothing cached) and /draft composes a fresh standalone email instead of a
// threaded reply.
const commands = [
  new SlashCommandBuilder().setName('triage').setDescription('Fetch, classify, and sync your latest emails'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a question about your recently triaged inbox')
    .addStringOption((opt) => opt.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('draft')
    .setDescription('Draft a reply, or a brand-new email, in Gmail')
    .addStringOption((opt) => opt.setName('instructions').setDescription('What the email should say').setRequired(true))
    .addStringOption((opt) => opt.setName('email').setDescription('Sender name or subject keyword to reply to (leave blank to compose a new email)').setRequired(false)),
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
