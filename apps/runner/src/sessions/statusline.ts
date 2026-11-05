import type { CliStatus } from '@nuera/shared/runner';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 500 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function epochToIso(v: unknown): string | null {
  const n = num(v);
  if (n !== null) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const s = str(v);
  if (s && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return null;
}

function rateWindow(v: unknown): NonNullable<CliStatus['rateLimits']>['fiveHour'] {
  if (!isObj(v)) return null;
  const used = num(v.used_percentage) ?? num(v.usedPercentage);
  const resets = epochToIso(v.resets_at ?? v.resetsAt);
  if (used === null && resets === null) return null;
  return { usedPercentage: used, resetsAt: resets };
}

/**
 * Whitelisted copy of the status-line JSON the CLI pipes to `statusLine.command`. Only what the
 * CLI published, nothing estimated; the API-price cost estimate is deliberately dropped (P3).
 */
export function sanitizeStatusLine(input: unknown): CliStatus | null {
  if (!isObj(input)) return null;
  const model = isObj(input.model) ? { id: str(input.model.id), displayName: str(input.model.display_name) ?? str(input.model.displayName) } : null;
  const ctx = isObj(input.context_window) ? input.context_window : null;
  const rate = isObj(input.rate_limits) ? input.rate_limits : null;
  const cost = isObj(input.cost) ? input.cost : null;
  const pr = isObj(input.pr) ? input.pr : null;
  const effort = isObj(input.effort) ? str(input.effort.level) : str(input.effort);
  const outputStyle = isObj(input.output_style) ? str(input.output_style.name) : null;
  const fiveHour = rate ? rateWindow(rate.five_hour) : null;
  const sevenDay = rate ? rateWindow(rate.seven_day) : null;
  return {
    receivedAt: new Date().toISOString(),
    version: str(input.version),
    model: model && (model.id || model.displayName) ? model : null,
    contextWindow: ctx
      ? { usedPercentage: num(ctx.used_percentage) ?? num(ctx.usedPercentage), size: num(ctx.context_window_size) ?? num(ctx.size) }
      : null,
    rateLimits: fiveHour || sevenDay ? { fiveHour, sevenDay } : null,
    effort,
    outputStyle,
    sessionName: str(input.session_name),
    linesAdded: cost ? num(cost.total_lines_added) : null,
    linesRemoved: cost ? num(cost.total_lines_removed) : null,
    totalDurationMs: cost ? num(cost.total_duration_ms) : null,
    pr: pr ? { number: num(pr.number), url: str(pr.url) } : null,
  };
}

/** Same data minus `receivedAt`, to skip identical updates. */
export function statusFingerprint(status: CliStatus | null): string {
  if (!status) return '';
  const { receivedAt: _receivedAt, ...rest } = status;
  return JSON.stringify(rest);
}
