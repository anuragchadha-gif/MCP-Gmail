#!/usr/bin/env node
// Multi-account Gmail MCP server.
//
// Loads every token file in ./tokens/ (one per Gmail account, created by
// `node auth.js <label>`) and exposes search/read tools that take an
// `account` label so Claude can query whichever mailbox you ask about —
// including more than one in the same conversation.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { summarizeMessage, getHeader } = require("./lib/gmail-parse.js");

const ROOT = __dirname;
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const TOKENS_DIR = path.join(ROOT, "tokens");
const REDIRECT_URI = "http://localhost:53682/oauth2callback";

function loadAccounts() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing ${CREDENTIALS_PATH} — see README.md.`);
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const creds = raw.installed || raw.web;

  const accounts = new Map(); // label -> { emailAddress, gmail, oAuth2Client }
  if (!fs.existsSync(TOKENS_DIR)) return accounts;

  for (const file of fs.readdirSync(TOKENS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const stored = JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, file), "utf-8"));
    const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
    oAuth2Client.setCredentials(stored.tokens);
    // Persist refreshed access tokens back to disk so re-runs don't re-prompt.
    oAuth2Client.on("tokens", (newTokens) => {
      const merged = { ...stored.tokens, ...newTokens };
      stored.tokens = merged;
      fs.writeFileSync(path.join(TOKENS_DIR, file), JSON.stringify(stored, null, 2));
    });
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    accounts.set(stored.label, { emailAddress: stored.emailAddress, gmail, oAuth2Client });
  }
  return accounts;
}

// ── token freshness ─────────────────────────────────────────────────────────
// Accounts are re-read whenever the files in tokens/ change, rather than being
// cached for the life of the process.
//
// This used to be a single `const accounts = loadAccounts()` at module load.
// The consequence was not obvious until it bit: Google expires refresh tokens
// for OAuth apps in "Testing" publishing status after 7 days, so every account
// dies roughly weekly. Re-running `npm run auth -- <label>` rewrote the token
// file correctly, but the running server kept using the expired one it had read
// at startup, so every call still failed with `invalid_grant` until the whole
// MCP client was restarted. The re-auth appeared not to work.
//
// Keyed on (filename, mtime, size) for every token file: cheap enough to do per
// call (a handful of stat()s), and it catches a rewrite even when the mtime
// resolution is coarse, because a re-auth changes the file's size too.
let cachedAccounts = null;
let cachedSignature = null;

function tokensSignature() {
  if (!fs.existsSync(TOKENS_DIR)) return "";
  return fs
    .readdirSync(TOKENS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const s = fs.statSync(path.join(TOKENS_DIR, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    })
    .join("|");
}

function getAccounts({ force = false } = {}) {
  let signature = "";
  try {
    signature = tokensSignature();
  } catch (err) {
    // A transient read error must not take the server down; fall back to
    // whatever was loaded last, and try again on the next call.
    if (cachedAccounts) return cachedAccounts;
  }
  if (force || cachedAccounts === null || signature !== cachedSignature) {
    cachedAccounts = loadAccounts();
    cachedSignature = signature;
  }
  return cachedAccounts;
}

function requireAccount(label, opts) {
  const accounts = getAccounts(opts);
  const acct = accounts.get(label);
  if (!acct) {
    const known = [...accounts.keys()].join(", ") || "(none configured)";
    throw new Error(`Unknown account "${label}". Known accounts: ${known}`);
  }
  return acct;
}

function isInvalidGrant(err) {
  const blob = `${err && err.message} ${err && err.response && JSON.stringify(err.response.data)}`;
  return /invalid_grant/i.test(blob);
}

// Every Gmail call goes through here so one expired token produces one clear,
// actionable message instead of a bare `invalid_grant` that looks like a bug in
// the server. The retry covers the narrow case where the token was re-written
// after this process last stat()ed the directory.
async function callGmail(label, fn) {
  try {
    return await fn(requireAccount(label));
  } catch (err) {
    if (!isInvalidGrant(err)) throw err;
    try {
      return await fn(requireAccount(label, { force: true }));
    } catch (retryErr) {
      if (!isInvalidGrant(retryErr)) throw retryErr;
      throw new Error(
        `Google rejected the stored token for account "${label}" (invalid_grant). ` +
          `This normally means the refresh token expired — Google expires them after ` +
          `7 days while the OAuth app is in "Testing" publishing status. Re-run ` +
          `\`npm run auth -- ${label}\` from the server folder; it takes effect on the ` +
          `next call, no restart needed.`
      );
    }
  }
}

const server = new McpServer({ name: "multi-gmail", version: "1.0.0" });

server.registerTool(
  "list_accounts",
  {
    title: "List connected Gmail accounts",
    description:
      "Lists every Gmail account this server currently has access to, with the short label used to address it in other tools.",
    inputSchema: {},
  },
  async () => {
    // getAccounts(), not a captured map: a newly authorised account appears
    // here without restarting the server.
    const list = [...getAccounts().entries()].map(([label, a]) => ({ label, emailAddress: a.emailAddress }));
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  }
);

server.registerTool(
  "search_threads",
  {
    title: "Search Gmail threads",
    description:
      "Searches one connected Gmail account's threads using Gmail search syntax (from:, subject:, after:YYYY/MM/DD, newer_than:, etc). Returns id, subject, sender, date, snippet per thread — call get_message for full body text.",
    inputSchema: {
      account: z.string().describe('Account label from list_accounts, e.g. "business" or "personal".'),
      query: z.string().describe("Gmail search query string."),
      maxResults: z.number().int().min(1).max(100).default(20).describe("Max threads to return (default 20, max 100)."),
      pageToken: z.string().optional().describe("Continue a previous search using its nextPageToken."),
    },
  },
  async ({ account, query, maxResults, pageToken }) =>
    callGmail(account, async ({ gmail }) => {
    const res = await gmail.users.threads.list({
      userId: "me",
      q: query,
      maxResults,
      pageToken,
    });
    const threads = res.data.threads || [];

    // Threads.list only gives ids/snippets; pull headers for each via a light
    // metadata-only message fetch so results are actually useful without a
    // second round trip per thread.
    const detailed = await Promise.all(
      threads.map(async (t) => {
        try {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: t.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const payload = msg.data.payload || {};
          return {
            threadId: t.id,
            subject: getHeader(payload, "Subject"),
            from: getHeader(payload, "From"),
            date: getHeader(payload, "Date"),
            snippet: msg.data.snippet || t.snippet || "",
          };
        } catch (err) {
          return { threadId: t.id, error: String(err.message || err) };
        }
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ resultSizeEstimate: res.data.resultSizeEstimate, nextPageToken: res.data.nextPageToken, threads: detailed }, null, 2),
        },
      ],
    };
    })
);

server.registerTool(
  "get_thread",
  {
    title: "Get a Gmail thread",
    description:
      "Fetches every message in a thread with plain-text bodies (HTML is stripped by default to keep responses small). Attachment content is not accessible — only filename/type/size.",
    inputSchema: {
      account: z.string().describe("Account label from list_accounts."),
      threadId: z.string().describe("Thread id, from search_threads."),
      maxBodyChars: z.number().int().min(200).max(20000).default(4000).describe("Truncate each message body to this many characters."),
    },
  },
  async ({ account, threadId, maxBodyChars }) =>
    callGmail(account, async ({ gmail }) => {
      const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      const messages = (res.data.messages || []).map((m) => summarizeMessage(m, { maxBodyChars }));
      return { content: [{ type: "text", text: JSON.stringify({ threadId, messages }, null, 2) }] };
    })
);

server.registerTool(
  "get_message",
  {
    title: "Get a single Gmail message",
    description: "Fetches one message by id with a plain-text body (HTML stripped by default).",
    inputSchema: {
      account: z.string().describe("Account label from list_accounts."),
      messageId: z.string().describe("Message id."),
      maxBodyChars: z.number().int().min(200).max(20000).default(4000).describe("Truncate the body to this many characters."),
    },
  },
  async ({ account, messageId, maxBodyChars }) =>
    callGmail(account, async ({ gmail }) => {
      const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const summary = summarizeMessage(res.data, { maxBodyChars });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server failed to start:", err.message || err);
  process.exit(1);
});
