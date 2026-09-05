#!/usr/bin/env node
// One-time OAuth setup for one Gmail account.
//
// Usage:
//   node auth.js <label>
//
// <label> is just a short name YOU choose to tell accounts apart later,
// e.g. "personal" or "business". It has nothing to do with the actual
// email address — run this once per Gmail account you want connected.

const fs = require("fs");
const path = require("path");
const http = require("http");
const { google } = require("googleapis");

const ROOT = __dirname;
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const TOKENS_DIR = path.join(ROOT, "tokens");
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

async function main() {
  const label = process.argv[2];
  if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) {
    console.error("Usage: node auth.js <label>");
    console.error('  <label> is a short name like "business" or "personal" (letters, numbers, - and _ only).');
    process.exit(1);
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Missing ${CREDENTIALS_PATH}`);
    console.error("Download your OAuth client's credentials.json from Google Cloud Console first — see README.md.");
    process.exit(1);
  }
  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const creds = raw.installed || raw.web;
  if (!creds) {
    console.error("credentials.json doesn't look like a Desktop app OAuth client. See README.md.");
    process.exit(1);
  }

  const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token every time, even on re-auth
    scope: SCOPES,
  });

  console.log(`\nOpening your browser to sign in for account "${label}"...`);
  console.log("If it doesn't open automatically, visit this URL:\n");
  console.log(authUrl + "\n");

  const open = (await import("open")).default;
  open(authUrl).catch(() => {});

  const code = await waitForAuthCode();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Confirm which mailbox this actually is, so the label can't be mismatched.
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });

  const tokenPath = path.join(TOKENS_DIR, `${label}.json`);
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({ label, emailAddress: profile.data.emailAddress, tokens }, null, 2),
    { mode: 0o600 }
  );

  console.log(`\nConnected: ${profile.data.emailAddress} -> saved as "${label}"`);
  console.log(`Token stored at ${tokenPath}`);
  console.log("\nRun `node auth.js <other-label>` again to add another account, or start the server with `node server.js`.");
}

function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end(`<h2>Sign-in failed</h2><p>${error}</p><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end("<h2>Connected.</h2><p>You can close this tab and go back to the terminal.</p>");
      server.close();
      resolve(code);
    });
    server.listen(PORT);
  });
}

main().catch((err) => {
  console.error("Auth failed:", err.message || err);
  process.exit(1);
});
