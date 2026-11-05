#!/usr/bin/env node
// Nuera Dev — Claude Code hook bridge (command hook for every event of a Nuera session).
//
// Reads the hook JSON on stdin (max 1 MiB) and POSTs it to the runner's local listener with the
// session token. Prints NOTHING and exits 0 for every event (plain stdout would become Claude
// context on some events), except PermissionRequest: it waits for the decision taken in Nuera Dev
// and prints the runner's answer verbatim (official decision JSON). No answer → no output → the
// CLI shows its own permission dialog in the terminal. Any error is swallowed: a hook must never
// break the session.
//
// node:http rather than fetch: undici's 300 s headers timeout would cut long permission waits.
import { readFileSync } from 'node:fs';
import http from 'node:http';

const MAX_INPUT = 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_INPUT) chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(size <= MAX_INPUT ? Buffer.concat(chunks).toString('utf8') : null));
    process.stdin.on('error', () => resolve(null));
  });
}

function token() {
  if (process.env.NUERA_HOOK_TOKEN) return process.env.NUERA_HOOK_TOKEN.trim();
  if (process.env.NUERA_HOOK_TOKEN_FILE) {
    try {
      return readFileSync(process.env.NUERA_HOOK_TOKEN_FILE, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

function post(url, secret, body, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const payload = Buffer.from(body, 'utf8');
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy());
    req.end(payload);
  });
}

async function main() {
  const base = process.env.NUERA_HOOK_URL;
  const sessionId = process.env.NUERA_SESSION_ID;
  const secret = token();
  const raw = await readStdin();
  if (!base || !sessionId || !secret || !raw) return '';
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return '';
  }
  if (typeof payload !== 'object' || payload === null) return '';
  if (process.env.CLAUDE_CODE_BRIDGE_SESSION_ID) payload.nuera_bridge_session_id = process.env.CLAUDE_CODE_BRIDGE_SESSION_ID;
  const event = payload.hook_event_name;
  const waitsForDecision = event === 'PermissionRequest';
  // PermissionRequest: no client timeout, the CLI's own hook timeout bounds the wait.
  const timeoutMs = waitsForDecision ? 0 : event === 'SessionEnd' ? 1000 : 4000;
  const response = await post(`${base}/internal/hooks/${encodeURIComponent(sessionId)}`, secret, JSON.stringify(payload), timeoutMs);
  if (waitsForDecision && response && response.status === 200 && response.text.trim()) return response.text;
  return '';
}

const exit = () => process.exit(0);
main()
  .then((output) => (output ? process.stdout.write(output, exit) : exit()))
  .catch(exit);
