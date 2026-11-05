#!/usr/bin/env node
// Nuera Dev — status line of Claude Code sessions.
//
// The CLI pipes its official status JSON on stdin. This script forwards it to the runner (stored
// as sessions.cli_status, never estimated) and prints a short line for the TUI:
// « <modèle> · contexte <n> % ». Errors are silent.
import { readFileSync } from 'node:fs';

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 256 * 1024) chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function token() {
  if (process.env.NUERA_HOOK_TOKEN) return process.env.NUERA_HOOK_TOKEN.trim();
  try {
    return process.env.NUERA_HOOK_TOKEN_FILE ? readFileSync(process.env.NUERA_HOOK_TOKEN_FILE, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

const formatPercent = (n) => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n)} %`;

async function main() {
  const raw = await readStdin();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  const base = process.env.NUERA_HOOK_URL;
  const sessionId = process.env.NUERA_SESSION_ID;
  const secret = token();
  const send =
    base && sessionId && secret && data
      ? fetch(`${base}/internal/statusline/${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(1500),
        }).catch(() => undefined)
      : Promise.resolve();

  const parts = [];
  const model = data?.model?.display_name ?? data?.model?.id;
  if (typeof model === 'string' && model) parts.push(model);
  const ctx = data?.context_window?.used_percentage;
  if (typeof ctx === 'number' && Number.isFinite(ctx)) parts.push(`contexte ${formatPercent(ctx)}`);
  await send;
  return parts.length ? parts.join(' · ') : 'Nuera Dev';
}

const exit = () => process.exit(0);
main()
  .then((line) => process.stdout.write(line, exit))
  .catch(exit);
