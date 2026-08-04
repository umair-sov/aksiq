// config/env.js
//
// Single shared place that loads environment variables from .env.
// The .env file lives in `aksiq/` — the PARENT folder of this whole
// `Agent 2` project — not inside Agent 2 itself.

const path = require("path");
const dotenv = require("dotenv");

const ENV_PATH = path.resolve(__dirname, "..", "..", ".env");

const result = dotenv.config({ path: ENV_PATH });

if (result.error) {
  console.warn(
    `[env] Could not load .env from ${ENV_PATH} — falling back to whatever's already in process.env.`,
    result.error.message
  );
}

module.exports = { ENV_PATH };