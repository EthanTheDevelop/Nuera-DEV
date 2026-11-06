/**
 * Next.js instrumentation: runs once when the web server starts (Node.js runtime only, never during
 * `next build`).
 *  - records the token hash of the default server (RUNNER_TOKEN) if `migrate` could not;
 *  - starts the clock of the integration checks (every 15 min per space, advisory lock,
 *    NUERA_WEB_SCHEDULER=off disables it) — MULTICOMPTE §7, server/integrations/scheduler.ts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  try {
    const { ensureDefaultRunnerTokenHash } = await import('./server/runner/config');
    await ensureDefaultRunnerTokenHash();
  } catch (error) {
    console.error('[démarrage] empreinte du jeton du serveur par défaut', error instanceof Error ? error.message : error);
  }
  try {
    const { startWebScheduler } = await import('./server/integrations/scheduler');
    startWebScheduler();
  } catch (error) {
    console.error('[démarrage] horloge des vérifications', error instanceof Error ? error.message : error);
  }
}
