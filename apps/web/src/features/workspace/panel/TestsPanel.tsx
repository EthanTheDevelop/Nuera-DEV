'use client';

import { LiveTime, testCountsMeta } from '@/components/dev';
import { Icon, type IconName } from '@/components/icons';
import { Badge, CompactButton, EmptyState, ErrorPanel, SkeletonList, type BadgeTone } from '@/components/ui';
import { cn } from '@/lib/cn';
import { parseRunnerEvent } from '@nuera/shared/events';
import { formatDuration, formatNumber } from '@nuera/shared/format';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRun, fetchRuns, startTestsRequest, type RunDetailView, type RunListItem } from '../api';
import { lastClaudeTestRun } from '../lib/thread';
import { useWorkspace } from '../WorkspaceContext';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; run: RunDetailView | null };

const RUN_BADGE: Record<RunListItem['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'En cours', tone: 'accent' },
  succeeded: { label: 'Réussis', tone: 'success' },
  failed: { label: 'Échec', tone: 'danger' },
  stopped: { label: 'Arrêtés', tone: 'neutral' },
};

const TEST_ICON: Record<'passed' | 'failed' | 'running' | 'skipped', { icon: IconName; className: string; sr: string }> = {
  passed: { icon: 'check', className: 'text-success', sr: 'réussi' },
  failed: { icon: 'x', className: 'text-danger', sr: 'en échec' },
  running: { icon: 'clock', className: 'text-en-cours', sr: 'en cours' },
  skipped: { icon: 'minus', className: 'text-muted', sr: 'ignoré' },
};

const ORDER = { failed: 0, running: 1, passed: 2, skipped: 3 } as const;

/** « 3,1 s », « 12,0 s », « 1 min 05 » (W2 Tests list). */
export function formatTestDuration(ms: number): string {
  if (ms < 60_000) return `${formatNumber(ms / 1000, 1).replace(/^(\d+)$/, '$1,0')} s`;
  return formatDuration(ms);
}

function Counter({ value, label, className }: { value: number; label: string; className: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn('font-sans text-app-20 font-semibold', className)}>{formatNumber(value)}</span>
      <span className="font-sans text-app-12 text-muted">{label}</span>
    </span>
  );
}

/** Live run (`run.status` of /api/stream/runs/<id>, the PROJECTS lot relay). */
function useRunStream(runId: string | null, running: boolean, onRun: (run: Record<string, unknown>) => void) {
  useEffect(() => {
    if (!runId || !running) return;
    const source = new EventSource(`/api/stream/runs/${encodeURIComponent(runId)}`, { withCredentials: true });
    source.addEventListener('message', (message) => {
      const event = parseRunnerEvent(message.data);
      if (event?.type === 'run.status') onRun(event.data.run as unknown as Record<string, unknown>);
    });
    return () => source.close();
  }, [onRun, runId, running]);
}

/** W2 `Résultats des tests` (227:3589): latest test run of the worktree, parsed live from its output. */
export function TestsPanel() {
  const ws = useWorkspace();
  const worktree = ws.data.worktree;
  const project = ws.data.project;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const claudeRun = useMemo(() => lastClaudeTestRun(ws.ctl.items), [ws.ctl.items]);

  const worktreeId = worktree?.present ? worktree.id : null;
  const projectId = project.id;
  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!worktreeId) return;
      try {
        const { runs } = await fetchRuns(projectId, worktreeId, signal);
        const latest = runs.find((r) => r.kind === 'test') ?? null;
        setLoad({ status: 'ready', run: latest ? await fetchRun(latest.id, signal) : null });
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setLoad({ status: 'error', message: (error as Error).message });
      }
    },
    [projectId, worktreeId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);

  const current = load.status === 'ready' ? load.run : null;
  const onRun = useCallback(
    (run: Record<string, unknown>) => {
      const status = run.status as RunListItem['status'];
      const tests = (run.tests as RunDetailView['tests']) ?? null;
      setLoad((prev) => {
        if (prev.status !== 'ready' || !prev.run || prev.run.run.id !== run.id) return prev;
        return { status: 'ready', run: { ...prev.run, live: status === 'running', run: { ...prev.run.run, status, summary: (run.summary as string | null) ?? null, finishedAt: (run.finishedAt as string | null) ?? null }, tests: tests ?? prev.run.tests } };
      });
      if (status !== 'running') void read();
    },
    [read],
  );
  useRunStream(current?.run.id ?? null, current?.run.status === 'running', onRun);

  const start = async () => {
    if (!worktree?.present) return;
    setStarting(true);
    setStartError(null);
    try {
      await startTestsRequest(project.id, worktree.id);
      await read();
    } catch (error) {
      setStartError((error as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const testCommand = project.commands.test;
  const running = current?.run.status === 'running';
  const startReason = !worktree?.present
    ? 'Worktree supprimé : aucun test ne peut être lancé.'
    : !testCommand
      ? "Aucune commande de test n'est configurée pour ce projet (onglet Environnement du projet)."
      : running
        ? 'Une exécution est déjà en cours.'
        : ws.serverDisabledReason;
  const startButton = (
    <CompactButton variant={current ? 'secondaire' : 'principal'} icon="play" loading={starting} disabled={Boolean(startReason)} title={startReason ?? undefined} onClick={() => void start()}>
      Lancer les tests
    </CompactButton>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {load.status === 'loading' ? <SkeletonList rows={5} card={false} label="Lecture des derniers tests" /> : null}
      {load.status === 'error' ? <ErrorPanel title="Les derniers tests sont indisponibles" excerpt={load.message} onRetry={() => void read()} /> : null}
      {load.status === 'ready' && !current ? (
        <EmptyState icon="list-checks" title="Aucun test lancé dans ce worktree" variant="plain" action={startButton}>
          {testCommand
            ? `Lancez ${testCommand} : les résultats s'affichent ici en direct, lus dans la sortie de la commande.`
            : "Aucune commande de test n'est configurée pour ce projet : renseignez-la dans l'onglet Environnement du projet."}
        </EmptyState>
      ) : null}
      {current ? <RunResults detail={current} /> : null}
      {current ? <div className="flex flex-wrap items-center gap-2">{startButton}</div> : null}
      {startError ? (
        <p role="alert" className="m-0 font-sans text-app-12 text-danger">
          {startError}
        </p>
      ) : null}
      {claudeRun ? (
        <p className="m-0 font-sans text-app-12 leading-4 text-muted">
          {`Dernière exécution par Claude : ${claudeRun.command ?? 'commande'} · ${testCountsMeta(claudeRun.tests.passed, claudeRun.tests.failed)} · `}
          <LiveTime value={claudeRun.at} format="relative" />
        </p>
      ) : null}
    </div>
  );
}

function RunResults({ detail }: { detail: RunDetailView }) {
  const { run, tests } = detail;
  const badge = RUN_BADGE[run.status];
  const counts = tests?.counts ?? (run.tests ? { ...run.tests, running: 0, durationMs: null } : null);
  const total = counts?.total ?? 0;
  const segments = counts
    ? [
        { value: counts.passed, className: 'bg-success' },
        { value: counts.failed, className: 'bg-danger' },
        { value: counts.running, className: 'bg-en-cours' },
      ]
    : [];
  const list = useMemo(
    () => [...(tests?.tests ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]).slice(0, 300),
    [tests?.tests],
  );

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-12 font-medium text-text" title={run.command}>
          {run.command}
        </p>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {counts ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-3" aria-live="polite">
            <Counter value={counts.passed} label={counts.passed >= 2 ? 'réussis' : 'réussi'} className="text-success" />
            <Counter value={counts.failed} label={counts.failed >= 2 ? 'échecs' : 'échec'} className="text-danger" />
            {counts.running > 0 ? <Counter value={counts.running} label="en cours" className="text-en-cours" /> : null}
            {counts.skipped > 0 ? <Counter value={counts.skipped} label={counts.skipped >= 2 ? 'ignorés' : 'ignoré'} className="text-muted" /> : null}
          </div>
          <div
            role="img"
            aria-label={`${formatNumber(counts.passed)} réussis, ${formatNumber(counts.failed)} en échec sur ${formatNumber(total)}`}
            className="flex h-2 w-full overflow-hidden rounded-full border border-border bg-surface-raised"
          >
            {total > 0 ? segments.map((s, i) => (s.value > 0 ? <span key={i} className={s.className} style={{ width: `${(s.value / total) * 100}%` }} /> : null)) : null}
          </div>
        </div>
      ) : (
        <p className="m-0 font-sans text-app-13 text-muted">
          {run.status === 'running' ? 'Lecture de la sortie en cours…' : (run.summary ?? 'Aucun résultat de test lisible dans la sortie de la commande.')}
        </p>
      )}
      {list.length > 0 ? (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-md border border-border p-0">
          {list.map((test, i) => {
            const spec = TEST_ICON[test.status];
            return (
              <li
                key={`${i}-${test.name}`}
                className={cn('flex min-w-0 items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0', test.status === 'failed' && 'bg-danger-pale')}
              >
                <Icon name={spec.icon} size={15} className={cn('shrink-0', spec.className)} />
                <span className="sr-only">{spec.sr} :</span>
                <span className="min-w-0 flex-1 truncate font-mono text-app-12 text-text" title={test.name}>
                  {test.name}
                </span>
                <span className="shrink-0 font-mono text-app-11 text-muted">
                  {test.status === 'running' ? 'en cours' : typeof test.durationMs === 'number' ? formatTestDuration(test.durationMs) : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {(tests?.failures ?? []).slice(0, 3).map((failure, i) => (
        <pre
          key={`${i}-${failure.name}`}
          data-tone="dark"
          className="m-0 overflow-x-auto rounded-md bg-bg px-3 py-2.5 font-mono text-app-11 leading-[17px] whitespace-pre-wrap text-muted"
        >
          {`${failure.name}${failure.location ? ` · ${failure.location}` : ''}\n${failure.excerpt}`}
        </pre>
      ))}
      <p className="m-0 font-sans text-app-12 leading-4 text-muted">Résultats lus en direct dans la sortie de la commande, rien n&apos;est simulé.</p>
    </>
  );
}
