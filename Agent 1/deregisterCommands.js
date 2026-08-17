/**
 * deregisterCommands.js
 *
 * One-off teardown script — removes the /triage, /ask and /draft slash
 * commands from the guild. The counterpart to registerCommand.js, and the
 * last step of the move to natural-language messages.
 *
 * WHY THIS IS NEEDED AT ALL: deleting discordBot.js's interactionCreate
 * handler stops the bot from ANSWERING slash commands, but it does not remove
 * them from Discord. They are registered server-side and keep appearing in
 * the command picker until something deletes them, so a user who types
 * /triage gets Discord's own "The application did not respond" error — the
 * worst of both worlds, since the command looks supported, silently does
 * nothing, and gives no hint that plain English is now the way in.
 *
 * Run it once, by hand: `node deregisterCommands.js`. It is not part of any
 * npm script and nothing calls it automatically, exactly like the
 * registration script it mirrors.
 *
 * Depends on:
 * - `discord.js` (REST client, Routes helper).
 * - `dotenv` for DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID.
 * - No local file dependencies; this only talks to Discord's API.
 *
 * Reversible: registerCommand.js still holds the command definitions, so
 * running that script puts all three back exactly as they were.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env', '../.env'] });
import { REST, Routes } from 'discord.js';

const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

// PUT with an empty array is a full replacement of the guild's command set,
// which is how Discord expresses "delete all of them" — there is no bulk
// DELETE. Scoped to the guild rather than globally, matching how
// registerCommand.js registered them in the first place; a global
// deregistration would not touch guild-scoped commands.
await rest.put(
  Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
  { body: [] }
);

console.log('Slash commands deregistered: /triage, /ask, /draft are gone. Talk to the bot in #gmail instead.');
