/**
 * Best-effort redaction of credentials in text that leaves the runner (error `raw`, operation
 * journals, stored Bash outputs, `claude mcp get` output). It is a safety net, not a guarantee:
 * secrets must not be produced in the first place.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // HTTP authorization headers (git extraheader, MCP headers…)
  [/(authorization\s*[:=]\s*)(basic|bearer|token)\s+[A-Za-z0-9+/=._~-]+/gi, '$1$2 [masqué]'],
  [/(x-api-key|api[-_]?key|x-access-token|private[-_]?token)(\s*[:=]\s*)["']?[A-Za-z0-9+/=._~-]{8,}["']?/gi, '$1$2[masqué]'],
  // GitHub tokens (classic, fine-grained, installation, OAuth, refresh)
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[jeton GitHub masqué]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[jeton GitHub masqué]'],
  // Runner tokens of Nuera Dev servers (nrt_ + base64url of 32 bytes)
  [/\bnrt_[A-Za-z0-9_-]{32,}/g, '[jeton du runner masqué]'],
  // Anthropic keys / OAuth tokens
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[clé Anthropic masquée]'],
  // Generic "token in URL" (https://user:secret@host)
  [/(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[masqué]@'],
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[clé privée masquée]'],
  // Slack / AWS style keys
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, '[jeton masqué]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[clé AWS masquée]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Keeps the head and the tail of a long text (UTF-16 length based). */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return { text: `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`, truncated: true };
}

/** Keeps only the tail of a text (logs). */
export function tailText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
