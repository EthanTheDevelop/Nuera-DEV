'use client';

import { useEffect, useRef } from 'react';
import type { CloneResult } from '@nuera/shared/runner';
import { formatDuration, formatNumber } from '@nuera/shared/format';
import { Icon, type IconName } from '@/components/icons';
import { Badge, Banner, ErrorPanel, Pastille, ProgressBar, Skeleton, StepList } from '@/components/ui';
import { joinParts } from '@/components/dev/lib/format';
import { stripAnsi } from '@/components/dev/lib/ansi';
import type { Failure } from '../FailureBanner';
import { detectedCommandsText } from '../format';
import type { OperationStreamState } from './useOperationStream';

export type CloneOutcome = 'running' | 'succeeded' | 'failed';

export function cloneOutcome(stream: OperationStreamState): CloneOutcome {
  const status = stream.operation?.status;
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'running';
}

export function cloneResult(stream: OperationStreamState): CloneResult | null {
  const result = stream.operation?.result;
  return result && typeof result === 'object' && 'path' in result ? (result as unknown as CloneResult) : null;
}

export interface CloneStepProps {
  fullName: string | null;
  /** « Nom dans Nuera Dev » (A3 title). */
  name: string | null;
  stream: OperationStreamState;
  /** Retry of a failed clone in flight / its own failure. */
  retryFailure: Failure | null;
  serverName: string;
}

/**
 * A2 (running: percentage, sub-steps, live journal), A3 (success: recap) and the clone failure (T4:
 * what failed, what was not touched, raw output; « Réessayer » is in the footer).
 */
export function CloneStep({ fullName, name, stream, retryFailure, serverName }: CloneStepProps) {
  const outcome = cloneOutcome(stream);
  const op = stream.operation;

  if (!op) {
    if (stream.failed) {
      return (
        <ErrorPanel
          title="Le suivi du clonage n'a pas pu s'ouvrir"
          excerpt="L'opération est peut-être terminée, ou la session web a expiré."
          untouched={`Le clonage continue sur ${serverName} s'il était en cours : la liste des projets le montre.`}
        />
      );
    }
    return (
      <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-label="Connexion au suivi du clonage">
        <Skeleton width={260} height={16} />
        <Skeleton height={8} shape="pill" />
        <Skeleton height={120} className="rounded-md" />
      </div>
    );
  }

  if (outcome === 'succeeded') return <CloneSuccess name={name} stream={stream} serverName={serverName} />;

  const pct = op.progress;
  const title = `Clonage de ${fullName ?? op.title?.replace(/^Clonage de /, '') ?? 'dépôt'}`;
  return (
    <div className="flex flex-col gap-4">
      {stream.unavailable ? (
        <Banner tone="warn" icon="wifi-off" title={`${serverName} ne répond pas`} live>
          {`Le clonage continue peut-être sur ${serverName} : le suivi reprend dès que le serveur répond.`}
        </Banner>
      ) : null}
      <div className="flex items-center gap-3">
        <p className="m-0 min-w-0 flex-1 truncate font-sans text-app-16 font-semibold text-text">{title}</p>
        {pct !== null && outcome === 'running' ? <Badge tone="accent">{`${formatNumber(pct)} %`}</Badge> : null}
        {outcome === 'failed' ? <Badge tone="danger">Échec</Badge> : null}
      </div>
      <ProgressBar value={pct} label={title} />
      <StepList
        items={op.steps.map((step) => ({ key: step.key, label: step.label, status: step.status, meta: step.detail ?? null }))}
      />
      <CloneLog log={stream.log} liveLine={stream.liveLine} />
      {outcome === 'failed' && op.error ? (
        <ErrorPanel
          title={op.error.message}
          untouched={op.error.untouched ?? null}
          raw={op.error.raw ?? null}
          excerpt={op.error.reason === 'GIT_AUTH_FAILED' ? "Vérifiez l'accès de l'application GitHub à ce dépôt dans Intégrations." : null}
        />
      ) : null}
      {retryFailure ? (
        <ErrorPanel title={retryFailure.message} excerpt={retryFailure.detail} untouched={retryFailure.untouched ?? null} raw={retryFailure.raw ?? null} />
      ) : null}
    </div>
  );
}

function CloneLog({ log, liveLine }: { log: string; liveLine: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const text = stripAnsi(`${log}${liveLine ?? ''}`).replace(/\n+$/, liveLine ? '' : '');
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- text is the trigger: follow new output
  }, [text]);
  return (
    <div
      ref={ref}
      data-tone="dark"
      role="log"
      aria-label="Journal du clonage"
      aria-live="off"
      className="max-h-[157px] min-h-16 overflow-y-auto rounded-md bg-bg px-3.5 py-3"
    >
      <pre className="m-0 font-mono text-app-12 leading-[19px] break-words whitespace-pre-wrap text-muted">{text || ' '}</pre>
    </div>
  );
}

function CloneSuccess({ name, stream, serverName }: { name: string | null; stream: OperationStreamState; serverName: string }) {
  const result = cloneResult(stream);
  const installed = result?.install && result.install.exitCode === 0;
  const commands = detectedCommandsText(result?.commands ?? null);
  const rows: Array<{ icon: IconName; label: string; value: string }> = [];
  if (result?.path) rows.push({ icon: 'projets', label: 'Dossier', value: result.path });
  if (result?.branch) rows.push({ icon: 'git-branch', label: 'Branche', value: result.branch });
  rows.push({ icon: 'terminal', label: 'Commandes détectées', value: commands ?? 'aucune' });
  rows.push({
    icon: 'book',
    label: 'CLAUDE.md',
    value: result?.claudeMd.found
      ? joinParts(['.', 'racine', '/', ''].includes(result.claudeMd.location ?? '') ? 'trouvé à la racine' : `trouvé dans ${result.claudeMd.location}`, result.claudeMd.lines !== null ? `${formatNumber(result.claudeMd.lines)} lignes` : null)
      : 'absent',
  });
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <Pastille icon="check" size={56} tone="success" shape="circle" />
      <h3 className="m-0 font-sans text-app-22 font-semibold text-text">{`${name ?? 'Le projet'} est prêt`}</h3>
      <p className="m-0 font-sans text-app-14 leading-5 text-muted">
        {installed
          ? `Le dépôt est sur ${serverName}, ses dépendances sont installées. Claude Code peut y travailler.`
          : `Le dépôt est sur ${serverName}. Claude Code peut y travailler.`}
      </p>
      <dl className="m-0 flex w-full flex-col overflow-hidden rounded-md border border-border text-left">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
            <Icon name={row.icon} size={16} className="shrink-0 text-muted" />
            <dt className="shrink-0 font-sans text-app-13 text-muted">{row.label}</dt>
            <dd className="m-0 min-w-0 flex-1 truncate text-right font-mono text-app-12 text-text" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A3 footer note « Ajouté à Projets · 912 paquets installés en 38 s ». */
export function cloneFooterNote(stream: OperationStreamState): string {
  const install = cloneResult(stream)?.install;
  if (install && install.exitCode === 0) {
    const packages = install.packages !== null ? `${formatNumber(install.packages)} paquets installés en ${formatDuration(install.durationMs)}` : `dépendances installées en ${formatDuration(install.durationMs)}`;
    return joinParts('Ajouté à Projets', packages);
  }
  return 'Ajouté à Projets';
}
