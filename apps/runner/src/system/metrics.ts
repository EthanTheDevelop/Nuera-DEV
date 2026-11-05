import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import type { SystemMetrics } from '@nuera/shared/runner';

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function readNumber(file: string): Promise<number | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    if (text === 'max') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function memInfo(): Promise<{ total: number; available: number } | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const get = (key: string) => {
      const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = get('MemTotal');
    const available = get('MemAvailable');
    return total !== null && available !== null ? { total, available } : null;
  } catch {
    return null;
  }
}

/** Memory of the container when a cgroup limit applies (v2 then v1), else of the host. */
export async function memoryUsage(): Promise<SystemMetrics['memory']> {
  const hostTotal = os.totalmem();
  if (process.platform === 'linux') {
    const v2Limit = await readNumber('/sys/fs/cgroup/memory.max');
    const v2Current = await readNumber('/sys/fs/cgroup/memory.current');
    const v1Limit = v2Limit === null ? await readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes') : null;
    const v1Usage = v2Limit === null ? await readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes') : null;
    const limit = v2Limit ?? v1Limit;
    const usage = v2Limit !== null ? v2Current : v1Usage;
    if (limit !== null && usage !== null && limit < hostTotal) {
      let inactive = 0;
      try {
        const stat = await readFile(v2Limit !== null ? '/sys/fs/cgroup/memory.stat' : '/sys/fs/cgroup/memory/memory.stat', 'utf8');
        const m = /^(?:total_)?inactive_file (\d+)$/m.exec(stat);
        inactive = m ? Number(m[1]) : 0;
      } catch {
        inactive = 0;
      }
      const used = Math.max(0, usage - inactive);
      return { usedBytes: used, totalBytes: limit, freeBytes: Math.max(0, limit - used), source: 'cgroup' };
    }
    const info = await memInfo();
    if (info) return { usedBytes: info.total - info.available, totalBytes: info.total, freeBytes: info.available, source: 'os' };
  }
  const free = os.freemem();
  return { usedBytes: hostTotal - free, totalBytes: hostTotal, freeBytes: free, source: 'os' };
}

export async function diskUsage(target: string): Promise<SystemMetrics['disk']> {
  try {
    const s = await statfs(target);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    return { path: target, usedBytes: used, totalBytes: total, freeBytes: free };
  } catch {
    return null;
  }
}

/** Whole-machine CPU % over the interval between two samples (first call: since boot). */
export class CpuSampler {
  private previous: CpuTimes = cpuTimes();
  private last = 0;

  sample(): number {
    const current = cpuTimes();
    const idle = current.idle - this.previous.idle;
    const total = current.total - this.previous.total;
    this.previous = current;
    if (total > 0) this.last = Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 1000) / 10));
    return this.last;
  }
}

export class MetricsCollector {
  private readonly cpu = new CpuSampler();
  private readonly startedAt = Date.now();

  constructor(
    private readonly projectsRoot: string,
    private readonly counts: () => { sessions: { live: number; max: number }; runs: number; terminals: number },
  ) {
    setTimeout(() => this.cpu.sample(), 1000).unref?.();
  }

  async collect(): Promise<SystemMetrics> {
    const [memory, disk] = await Promise.all([memoryUsage(), diskUsage(this.projectsRoot)]);
    const load = os.loadavg();
    const counts = this.counts();
    return {
      sampledAt: new Date().toISOString(),
      hostname: os.hostname(),
      platform: `${process.platform}-${process.arch}`,
      cpuPercent: this.cpu.sample(),
      cpuCount: os.cpus().length,
      load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      memory,
      disk,
      uptimeSec: Math.round(os.uptime()),
      runnerUptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      sessions: counts.sessions,
      runs: { live: counts.runs },
      terminals: { live: counts.terminals },
    };
  }
}
