# Multi-Gmail MCP Server

Connects more than one Gmail account to Claude at the same time. Claude's
built-in Google connector only holds one account — this runs locally instead
and exposes `search_threads` / `get_thread` / `get_message`, each taking an
`account` label so you (and Claude) can pick which mailbox to query.

Read this whole file before running anything — steps 1–4 happen on
Google's site, not in this project.

## 1. Create a Google Cloud OAuth client (one-time, ~10 minutes)

You have to do this part yourself — it needs your own Google login.

1. Go to <https://console.cloud.google.com/> and create a new project (top
   left project picker → New Project). Name doesn't matter, e.g.
   "Personal Gmail MCP".
2. **Enable the Gmail API**: left sidebar → *APIs & Services* → *Library* →
   search "Gmail API" → **Enable**.
3. **Configure the OAuth consent screen**: *APIs & Services* → *OAuth
   consent screen*.
   - User type: **External**
   - App name / support email: anything, e.g. "Personal Gmail MCP" / your
     email
   - Scopes: leave blank here, the app requests the scope itself
   - **Test users**: add *every Gmail address* you plan to connect (both
     the personal and the business one). While the app is in "Testing"
     status, only addresses on this list can sign in — this is expected
     and fine, you don't need to publish or verify the app.
4. **Create the OAuth client**: *APIs & Services* → *Credentials* →
   *Create Credentials* → *OAuth client ID*.
   - Application type: **Desktop app**
   - Name: anything
   - Click **Create**, then **Download JSON**
5. Rename the downloaded file `credentials.json` and put it directly in
   this folder (`gmail-mcp-server/credentials.json`). This file is
   git-ignored — never commit it or share it.

### Tokens expire after 7 days in "Testing" mode — this is normal

While the OAuth app's publishing status is **Testing**, Google expires the
refresh token for every connected account after **7 days**. When it happens all
your accounts usually fail at once, with `invalid_grant`, because they were
authorised on the same day.

The fix is step 2 again for that account — 30 seconds, no Google Cloud changes.
The server re-reads `tokens/` whenever the files change, so a re-auth takes
effect on the **next tool call**; you do not need to restart Claude.

If the weekly re-auth annoys you, set the OAuth consent screen to **In
production** and refresh tokens stop expiring. Because `gmail.readonly` is a
restricted scope Google may ask for verification; for a desktop app used only
by your own accounts, many people publish and accept the "unverified app"
warning at sign-in.

## 2. Connect each Gmail account

From this folder:

```bash
npm run auth -- personal
```

This opens your browser, has you sign in and grant read access, then
saves a token under `tokens/personal.json`. `personal` is just a label
you choose — pick whatever's memorable.

Repeat for the second account:

```bash
npm run auth -- business
```

Run `npm run auth -- <label>` again any time to add another account or
reconnect one whose access was revoked.

Only `gmail.readonly` scope is requested — this server can search and
read mail, not send, delete, or modify anything.

## 3. Register the server with Claude Code

Option A — CLI:

```bash
claude mcp add multi-gmail -- node "/absolute/path/to/multi-gmail-mcp/server.js"
```

Option B — manual config: add this to your `.mcp.json` (project-level) or
Claude Code's user-level MCP settings:

```json
{
  "mcpServers": {
    "multi-gmail": {
      "command": "node",
      "args": ["/absolute/path/to/multi-gmail-mcp/server.js"]
    }
  }
}
```

Restart Claude Code (or start a new session) after adding it. Tools then
appear as `list_accounts`, `search_threads`, `get_thread`, `get_message` —
ask Claude to use them same as any other tool, e.g. "search the business
Gmail for invoices from May" — Claude will call `search_threads` with
`account: "business"`.

## What this does and doesn't do

- Reads mail from every account you've run `npm run auth` for, in the
  same conversation, without needing to disconnect/reconnect anything.
- Read-only — cannot send, label, delete, or modify email.
- Cannot read attachment *content* (same limitation as Claude's built-in
  Gmail connector) — only filename/type/size.
- Runs entirely on this machine. Tokens live in `tokens/*.json`, never
  leave your computer except to talk to Google's API directly.
- This is unreviewed code written for you, not an audited product —
  reasonable for your own accounts, not something to hand to anyone else
  or point at a shared/company mailbox without a closer look first.

## Credits

Created by **Mohit Garg**.

Built because Claude's built-in Google connector holds one account at a time,
and some of us have four.

## License

MIT — see [LICENSE](LICENSE).
