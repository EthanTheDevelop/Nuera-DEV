#!/usr/bin/env node
// TEST-ONLY — what Claude Code does when a session connects to an HTTP MCP server of its
// `--mcp-config`: run the server's `headersHelper` (with CLAUDE_CODE_MCP_SERVER_NAME / _URL, in the
// session environment: NUERA_HOOK_URL, NUERA_SESSION_ID, NUERA_HOOK_TOKEN), then `initialize` with
// the headers it printed. Run by a fake CLI `bash` step (`run: true`) of a parcours spec:
//
//   node apps/web/e2e/harness/mcp-connect.mjs <mcp.json> <server name>
//
// Prints one line WITHOUT any header value: `MCP <name> · en-têtes : <names> · HTTP <status> · <server>`.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [file, name] = process.argv.slice(2);
const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers?.[name];
if (!entry || !entry.url) {
  process.stdout.write(`MCP ${name} · absent de la configuration\n`);
  process.exit(1);
}
let headers = { ...(entry.headers ?? {}) };
if (entry.headersHelper) {
  const printed = execSync(entry.headersHelper, {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_MCP_SERVER_NAME: name, CLAUDE_CODE_MCP_SERVER_URL: entry.url },
    timeout: 15_000,
  });
  headers = { ...headers, ...JSON.parse(printed || '{}') };
}
const response = await fetch(entry.url, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } } }),
  signal: AbortSignal.timeout(10_000),
});
let server = '?';
try {
  server = (await response.json())?.result?.serverInfo?.name ?? '?';
} catch {
  // not JSON (401 body, SSE…)
}
const names = Object.keys(headers).sort().join(', ') || 'aucun';
process.stdout.write(`MCP ${name} · en-têtes : ${names} · HTTP ${response.status} · ${server}\n`);
process.exit(response.ok ? 0 : 1);
