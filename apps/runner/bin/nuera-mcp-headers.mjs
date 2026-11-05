#!/usr/bin/env node
// Nuera Dev — `headersHelper` for authenticated HTTP MCP servers of a session.
//
// Claude Code runs it at each MCP connection (and after a 401/403). It asks the runner's local
// listener (session token) which asks the web app (`/api/internal/mcp-headers`) for the headers of
// THIS server for THIS session's project. Prints a JSON object of string headers; `{}` when the
// request is refused or nothing answers (the server then reports « needs authentication »).
// No secret is stored in any file or in the session environment.
import { readFileSync } from 'node:fs';

function token() {
  if (process.env.NUERA_HOOK_TOKEN) return process.env.NUERA_HOOK_TOKEN.trim();
  try {
    return process.env.NUERA_HOOK_TOKEN_FILE ? readFileSync(process.env.NUERA_HOOK_TOKEN_FILE, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

async function main() {
  const base = process.env.NUERA_HOOK_URL;
  const sessionId = process.env.NUERA_SESSION_ID;
  const serverName = process.env.CLAUDE_CODE_MCP_SERVER_NAME;
  const secret = token();
  if (!base || !sessionId || !serverName || !secret) return {};
  try {
    const response = await fetch(`${base}/internal/mcp-headers/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serverName, serverUrl: process.env.CLAUDE_CODE_MCP_SERVER_URL ?? null }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return {};
    const body = await response.json();
    const headers = body && typeof body.headers === 'object' && body.headers !== null ? body.headers : {};
    const out = {};
    for (const [key, value] of Object.entries(headers)) if (typeof value === 'string') out[key] = value;
    return out;
  } catch {
    return {};
  }
}

const exit = () => process.exit(0);
main()
  .then((headers) => process.stdout.write(JSON.stringify(headers), exit))
  .catch(() => process.stdout.write('{}', exit));
