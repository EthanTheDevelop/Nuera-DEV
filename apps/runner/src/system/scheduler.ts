import { and, eq, isNull } from 'drizzle-orm';
import { projects, type Database } from '@nuera/db';
import type { Logger } from 'pino';
import type { EnvironmentScope } from '../environment';
import type { GitService } from '../git/service';
import { RunnerError } from '../errors';
import type { WebClient } from '../web/client';
import type { UptimeTracker } from './uptime';

/**
 * Periodic jobs of this runner's server (never overlapping), off when NUERA_SCHEDULER=0:
 * - every minute: uptime heartbeat;
 * - every 10 min: background `git fetch` of the server's ready projects with a read token minted
 *   by the web (skipped silently when the web cannot be reached; a failing fetch is recorded on the
 *   project).
 * The integration checks are clocked by the web (one scheduler for every space), never by runners.
 * The server heartbeat (`environments.last_seen_at`, status re-read) is not one of these jobs: it is
 * part of the runner's identity and runs even without the scheduler (buildRunner, app.ts).
 */
export class Scheduler {
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private running = new Set<string>();

  constructor(
    private readonly deps: {
      db: Database;
      environment: EnvironmentScope;
      git: GitService;
      web: WebClient;
      uptime: UptimeTracker;
      logger: Logger;
    },
  ) {}

  start(): void {
    this.every('uptime', 60_000, () => this.deps.uptime.beat());
    this.every('fetch', 10 * 60_000, () => this.fetchProjects(), 90_000);
    void this.deps.uptime.beat().catch(() => undefined);
  }

  private every(name: string, intervalMs: number, job: () => Promise<unknown>, firstDelayMs?: number): void {
    const run = async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (error) {
        this.deps.logger.warn({ err: error, job: name }, 'tâche planifiée en échec');
      } finally {
        this.running.delete(name);
      }
    };
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    this.timers.push(timer);
    if (firstDelayMs !== undefined) {
      const first = setTimeout(() => void run(), firstDelayMs);
      first.unref?.();
    }
  }

  async fetchProjects(): Promise<{ fetched: number; skipped: number; failed: number }> {
    const rows = await this.deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.environmentId, this.deps.environment.id), eq(projects.status, 'ready'), isNull(projects.archivedAt)));
    let fetched = 0;
    let skipped = 0;
    let failed = 0;
    for (const project of rows) {
      const credentials = await this.deps.web.gitCredentials({ projectId: project.id, fullName: project.githubFullName, access: 'read' });
      if (!credentials && !project.isPrivate) {
        // public repository: fetch without a token
      } else if (!credentials) {
        skipped += 1;
        continue;
      }
      try {
        await this.deps.git.fetch(project.id, { extraHeader: credentials?.extraHeader }, { record: false });
        fetched += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof RunnerError ? error.message : 'Récupération impossible.';
        await this.deps.db.update(projects).set({ statusDetail: `Synchronisation : ${message}` }).where(eq(projects.id, project.id));
      }
    }
    return { fetched, skipped, failed };
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
