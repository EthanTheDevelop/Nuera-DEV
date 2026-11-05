/**
 * Parser for `git clone --progress` stderr (English or French git, `remote:` lines from GitHub).
 * Splits `\r` updates (live line) from `\n` final lines (journal), and maps phases to a
 * percentage: counting/compressing 0–5, receiving 5–80, resolving deltas 80–95, checkout 95–100.
 */

export type ClonePhase = 'remote' | 'receiving' | 'resolving' | 'checkout' | 'other';

export interface ProgressUpdate {
  phase: ClonePhase;
  /** Phase percentage 0–100. */
  percent: number | null;
  /** Overall clone percentage 0–100 (phase-weighted). */
  overall: number | null;
  /** Received bytes (`84.2 MiB` → bytes) when printed. */
  bytes: number | null;
}

const PHASE_RANGES: Record<Exclude<ClonePhase, 'other'>, [number, number]> = {
  remote: [0, 5],
  receiving: [5, 80],
  resolving: [80, 95],
  checkout: [95, 100],
};

export function detectPhase(line: string): ClonePhase {
  const l = line.toLowerCase();
  if (/receiving objects|réception d.objets|reception d.objets/.test(l)) return 'receiving';
  if (/resolving deltas|résolution des deltas|resolution des deltas/.test(l)) return 'resolving';
  if (/updating files|mise à jour des fichiers|checking out files|extraction des fichiers/.test(l)) return 'checkout';
  if (/^remote:|^distant/.test(l) || /counting objects|compressing objects|enumerating objects|énumération|décompte|compression des objets/.test(l)) {
    return 'remote';
  }
  return 'other';
}

const UNIT_BYTES: Record<string, number> = {
  bytes: 1,
  octets: 1,
  kib: 1024,
  kio: 1024,
  mib: 1024 ** 2,
  mio: 1024 ** 2,
  gib: 1024 ** 3,
  gio: 1024 ** 3,
};

export function parseProgressLine(line: string): ProgressUpdate | null {
  const phase = detectPhase(line);
  const pct = /(\d{1,3})%/.exec(line);
  const size = /(\d+(?:[.,]\d+)?)\s*(bytes|octets|KiB|MiB|GiB|Kio|Mio|Gio)\b/i.exec(line);
  if (!pct && !size) return phase === 'other' ? null : { phase, percent: null, overall: null, bytes: null };
  const percent = pct ? Math.min(100, Number(pct[1])) : null;
  const bytes = size ? Math.round(Number(size[1]!.replace(',', '.')) * (UNIT_BYTES[size[2]!.toLowerCase()] ?? 1)) : null;
  let overall: number | null = null;
  if (percent !== null && phase !== 'other') {
    const [start, end] = PHASE_RANGES[phase];
    overall = Math.round(start + ((end - start) * percent) / 100);
  }
  return { phase, percent, overall, bytes };
}

/**
 * Incremental splitter: feed raw stderr chunks, get finalised lines and the current live line.
 */
export class ProgressStream {
  private buffer = '';
  live: string | null = null;

  push(chunk: string): { lines: string[]; live: string | null } {
    this.buffer += chunk;
    const lines: string[] = [];
    let index: number;
    // eslint-disable-next-line no-cond-assign
    while ((index = this.buffer.search(/[\r\n]/)) !== -1) {
      const piece = this.buffer.slice(0, index);
      const sep = this.buffer[index];
      const next = this.buffer[index + 1];
      if (sep === '\r' && next === '\n') {
        this.buffer = this.buffer.slice(index + 2);
        if (piece.trim()) lines.push(piece);
        this.live = null;
        continue;
      }
      this.buffer = this.buffer.slice(index + 1);
      if (sep === '\n') {
        if (piece.trim()) lines.push(piece);
        this.live = null;
      } else if (piece.trim()) {
        this.live = piece;
      }
    }
    if (this.buffer.trim()) this.live = this.buffer;
    return { lines, live: this.live };
  }

  /** Remaining text at the end of the stream (as a final line). */
  flush(): string[] {
    const rest = this.buffer.trim() ? [this.buffer] : this.live ? [this.live] : [];
    this.buffer = '';
    this.live = null;
    return rest;
  }
}
