'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { formatBytes, formatPercent, formatShortDate, formatTime, formatUsage } from '@nuera/shared/format';
import { Icon } from '@/components/icons';
import {
  Checkbox,
  Badge,
  Card,
  ChipGroup,
  CodeBlock,
  CompactButton,
  ConfirmDialog,
  Drawer,
  DrawerContent,
  EmptyState,
  ErrorPanel,
  KeyValueList,
  Meter,
  Skeleton,
  TileHeader,
  toast,
  UptimeBars,
} from '@/components/ui';
import { useLiveEvents } from '@/hooks/useLiveEvents';
import { cn } from '@/lib/cn';
import { loadLogsAction, loadOperationLogAction, loadStaleWorktreesAction, removeStaleWorktreesAction } from '../actions';
import {
  dirtyFilesText,
  formatAvailability,
  operationKindLabel,
  operationStatusBadge,
  plural,
  relativeLong,
  removeWorktreesLabel,
  removeWorktreesTitle,
  serverBadge,
  serviceRows,
  staleWorktreesCaption,
  freedSpaceText,
  uptimeBarDays,
  uptimeCaption,
} from '../lib/copy';
import { SECTION_IDS } from '../lib/tabs';
import type { OperationLogItem, SessionLogItem, StaleWorktreesView } from '../lib/types';
import { NumberSetting, TextSetting } from './controls';
import { InfoBox, NO_SERVER_NOTE, NoServerNote, SettingsRow, SettingsRows, UnavailableNote } from './parts';
import { useSettings } from './SettingsContext';

const SESSION_STATUS_LABELS: Record<string, string> = {
  stopped: 'Arrêtée',
  interrupted: 'Interrompue',
  failed: 'Échouée',
  finished: 'Terminée',
  archived: 'Archivée',
};

function useRunnerUnavailable(): boolean {
  const { data, serverName } = useSettings();
  const live = useLiveEvents();
  if (serverName === null) return false;
  return (!data.health.ok && Boolean(data.health.error.unavailable)) || live.runner === 'unavailable';
}

/** Section text of a load error: no server, server down, or the error itself. */
function loadErrorText(error: { message: string; unavailable?: boolean; noEnvironment?: boolean }, serverName: string | null, what: string): string {
  if (error.noEnvironment) return NO_SERVER_NOTE;
  if (error.unavailable) return `${serverName ?? 'Le serveur'} ne répond pas : ${what}`;
  return error.message;
}

/**
 * D08 `Tuile · Serveur VPS-3`: services (status dots), availability over 30 days — of the server of
 * the account's space. Without a server: « Aucun serveur ne vous est encore attribué… ».
 */
export function ServerTile({ detailed = false }: { detailed?: boolean }) {
  const { data, now, serverName } = useSettings();
  const unavailable = useRunnerUnavailable();
  const titleId = useId();
  const uptimeId = useId();
  if (serverName === null) {
    return (
      <Card as="section" id={detailed ? SECTION_IDS.services : undefined} aria-labelledby={titleId} className="scroll-mt-6 gap-3">
        <TileHeader icon="server" title={<span id={titleId}>Serveur</span>} action={<Badge tone="neutral">Aucun serveur</Badge>} />
        <NoServerNote />
      </Card>
    );
  }
  const health = data.health.ok ? data.health.data : null;
  const badge = serverBadge(health, unavailable);
  const rows = serviceRows({
    health,
    live: data.liveSessions.ok ? data.liveSessions.data : null,
    webStartedAt: data.web.startedAt,
    now,
    runnerUnavailable: unavailable,
    detailed,
  });
  return (
    <Card as="section" id={detailed ? SECTION_IDS.services : undefined} aria-labelledby={titleId} className="scroll-mt-6 gap-1">
      <TileHeader icon="server" title={<span id={titleId}>{`Serveur ${serverName}`}</span>} action={<Badge tone={badge.tone}>{badge.label}</Badge>} />
      <SettingsRows label="Services">
        {rows.map((row) => (
          <SettingsRow key={row.key} dot={row.tone} title={row.title} caption={row.caption} />
        ))}
      </SettingsRows>
      <InfoBox labelledBy={uptimeId} className="mt-1 gap-2">
        <div className="flex items-center gap-2">
          <h3 id={uptimeId} className="m-0 flex-1 font-mono text-app-11 font-normal tracking-label text-muted uppercase">
            Disponibilité · 30 jours
          </h3>
          {data.uptime.ok ? (
            <span className="font-mono text-app-12 font-medium text-text">{formatAvailability(data.uptime.data.availabilityPercent)}</span>
          ) : null}
        </div>
        {data.uptime.ok ? (
          <>
            <UptimeBars days={uptimeBarDays(data.uptime.data)} label={`Disponibilité du runner de ${serverName} sur 30 jours`} />
            <p className="m-0 font-sans text-app-12 leading-4 text-muted">{uptimeCaption(data.uptime.data, now)}</p>
          </>
        ) : (
          <UnavailableNote>{loadErrorText(data.uptime.error, serverName, "la disponibilité n'a pas pu être lue.")}</UnavailableNote>
        )}
      </InfoBox>
    </Card>
  );
}

/** D08 `Tuile · Maintenance`: journaux, CLI version check, inactive worktrees (T8). */
export function MaintenanceTile({ withSettings = false }: { withSettings?: boolean }) {
  const { data, claude, refreshClaude, refreshingClaude, claudeRefreshError, serverName } = useSettings();
  const [logsOpen, setLogsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const worktrees = data.worktrees;
  const count = worktrees.ok ? worktrees.data.items.length : 0;

  async function check() {
    await refreshClaude();
    setCheckedAt(new Date().toISOString());
  }

  const claudeCaption = (
    <>
      mis à jour par sa commande officielle, jamais en cours de session
      {checkedAt && claudeRefreshError ? (
        <span role="alert" className="block font-sans text-app-12 text-danger">
          {claudeRefreshError}
        </span>
      ) : checkedAt && claude ? (
        <span role="status" className="block font-mono text-app-11 text-text">
          {claude.installed ? `claude ${claude.version ?? 'version inconnue'} installé · vérifié à ${formatTime(checkedAt)}` : `CLI introuvable sur ${serverName}`}
        </span>
      ) : null}
    </>
  );

  return (
    <Card as="section" id={withSettings ? SECTION_IDS.worktrees : undefined} aria-label="Maintenance" className="scroll-mt-6 gap-1">
      <TileHeader icon="reglages" title="Maintenance" />
      <SettingsRows>
        <SettingsRow
          icon="book"
          title="Journaux"
          caption="sessions Claude, synchronisations Git"
          control={
            <CompactButton variant="secondaire" onClick={() => setLogsOpen(true)}>
              Consulter
            </CompactButton>
          }
        />
        {serverName !== null ? (
          <SettingsRow
            icon="refresh"
            title="Claude Code"
            caption={claudeCaption}
            control={
              <CompactButton variant="secondaire" onClick={check} loading={refreshingClaude}>
                Vérifier
              </CompactButton>
            }
          />
        ) : null}
        <SettingsRow
          icon="trash"
          title="Worktrees inactifs"
          caption={worktrees.ok ? staleWorktreesCaption(worktrees.data) : loadErrorText(worktrees.error, serverName, "les worktrees n'ont pas pu être lus")}
          control={
            <CompactButton
              variant="secondaire"
              onClick={() => setReviewOpen(true)}
              disabled={!worktrees.ok || count === 0}
              title={!worktrees.ok ? 'Indisponible' : count === 0 ? 'Aucun worktree inactif' : undefined}
            >
              Examiner…
            </CompactButton>
          }
        />
      </SettingsRows>
      {withSettings ? (
        <div className="pt-3">
          <NumberSetting
            field="worktreeStaleDays"
            label="Inactif après"
            hint="Un worktree de session sans activité depuis ce délai est proposé au nettoyage. Le clone principal n'est jamais proposé."
            unit="jours"
            min={1}
            max={365}
            successMessage={(value) => `Worktrees inactifs après ${plural(value ?? 0, 'jour')}`}
          />
        </div>
      ) : null}
      <LogsDrawer open={logsOpen} onOpenChange={setLogsOpen} />
      {worktrees.ok ? <StaleWorktreesDialog open={reviewOpen} onOpenChange={setReviewOpen} initial={worktrees.data} /> : null}
    </Card>
  );
}

export function StaleWorktreesDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (open: boolean) => void; initial: StaleWorktreesView }) {
  const { refresh, now, serverName } = useSettings();
  const [view, setView] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial.items.filter((item) => item.eligible).map((item) => item.id)));
  const [error, setError] = useState<string | null>(null);

  // Re-read the list on every opening (eligibility is re-checked on the server anyway).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react/set-state-in-effect -- reset on opening, before the async load the effect starts
    setError(null);
    void loadStaleWorktreesAction().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        // Removal re-checks eligibility on the server anyway; say the list shown may be stale.
        setError(`La liste n'a pas pu être relue : ${result.error.message}`);
        return;
      }
      setView(result.data);
      setSelected(new Set(result.data.items.filter((item) => item.eligible).map((item) => item.id)));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const chosen = view.items.filter((item) => item.eligible && selected.has(item.id));
  const count = chosen.length;
  const freed = serverName ? freedSpaceText(chosen, serverName) : null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      icon="trash"
      title={removeWorktreesTitle(count)}
      consequences={[
        ...(freed ? [{ kind: 'kept' as const, text: freed }] : []),
        { kind: 'kept', text: 'Les branches et leurs commits sont conservés : seules les copies de travail sont supprimées.' },
        { kind: 'risk', text: "Un worktree avec des modifications non commitées est exclu d'office." },
        { kind: 'risk', text: 'Les sessions liées ne pourront plus être reprises.' },
      ]}
      confirmLabel={removeWorktreesLabel(count)}
      error={error}
      onConfirm={async () => {
        setError(null);
        const ids = view.items.filter((item) => item.eligible && selected.has(item.id)).map((item) => item.id);
        if (ids.length === 0) return setError('Choisissez au moins un worktree.');
        const result = await removeStaleWorktreesAction(ids);
        if (!result.ok) return setError(result.error.message);
        const { removed, skipped } = result.data;
        if (removed.length > 0) toast({ message: removed.length === 1 ? `Worktree ${removed[0]!.name} supprimé` : `${removed.length} worktrees supprimés` });
        refresh();
        if (skipped.length > 0) {
          setError(`${plural(skipped.length, 'worktree conservé', 'worktrees conservés')} : ${skipped.map((item) => `${item.name} (${item.reason})`).join(', ')}.`);
          const fresh = await loadStaleWorktreesAction();
          if (fresh.ok) {
            setView(fresh.data);
            setSelected(new Set(fresh.data.items.filter((item) => item.eligible).map((item) => item.id)));
          }
          return;
        }
        onOpenChange(false);
      }}
    >
      {view.items.length === 0 ? (
        <p className="m-0 font-sans text-app-13 text-muted">Plus aucun worktree inactif.</p>
      ) : (
        <ul aria-label="Worktrees inactifs" className="m-0 flex max-h-[40dvh] list-none flex-col overflow-y-auto rounded-md border border-border p-0">
          {view.items.map((item) => {
            const inputId = `nu-wt-${item.id}`;
            const checked = item.eligible && selected.has(item.id);
            return (
              <li key={item.id} className="border-b border-border last:border-b-0">
                <label htmlFor={inputId} className={cn('flex min-h-11 items-center gap-2.5 px-3 py-[9px]', item.eligible ? 'cursor-pointer' : 'cursor-not-allowed')}>
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    disabled={!item.eligible}
                    onCheckedChange={(value) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (value) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                  <Icon name="worktree" size={15} className="shrink-0 text-muted" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate font-mono text-app-12 font-medium', item.eligible ? 'text-text' : 'text-muted')}>{item.name}</span>
                    <span className={cn('truncate font-sans text-app-12', item.eligible ? 'text-muted' : 'text-warn')}>
                      {item.projectName} · {item.eligible ? formatShortDate(item.lastActivityAt, now) : item.excludedReason}
                    </span>
                  </span>
                  {item.eligible ? (
                    checked ? <Badge tone="neutral">Supprimé</Badge> : <Badge tone="neutral">Conservé</Badge>
                  ) : (
                    <Badge tone="warn">Exclu</Badge>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {view.unreadable.length > 0 ? (
        <p className="m-0 font-sans text-app-12 text-muted">Worktrees illisibles, non proposés : {view.unreadable.join(', ')}.</p>
      ) : null}
    </ConfirmDialog>
  );
}

type LogsTab = 'operations' | 'sessions';

export function LogsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { now } = useSettings();
  const [tab, setTab] = useState<LogsTab>('operations');
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; operations: OperationLogItem[]; sessions: SessionLogItem[] }
  >({ kind: 'idle' });

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    void loadLogsAction().then((result) => {
      setState(result.ok ? { kind: 'ready', ...result.data } : { kind: 'error', message: result.error.message });
    });
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- synchronous « loading » state of the fetch this effect starts (external data)
    if (open) load();
  }, [open, load]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Journaux" description="Opérations Git et fins de sessions Claude enregistrées par Nuera Dev." icon="book">
        <div className="flex flex-col gap-4">
          <ChipGroup
            aria-label="Journal"
            items={[
              { value: 'operations', label: 'Synchronisations Git' },
              { value: 'sessions', label: 'Sessions Claude' },
            ]}
            value={tab}
            onValueChange={setTab}
          />
          {state.kind === 'loading' || state.kind === 'idle' ? <Skeleton className="h-40" /> : null}
          {state.kind === 'error' ? <ErrorPanel title="Les journaux n'ont pas pu être lus" excerpt={state.message} onRetry={load} retryLabel="Réessayer" /> : null}
          {state.kind === 'ready' && tab === 'operations' ? (
            state.operations.length === 0 ? (
              <EmptyState variant="plain" icon="book" title="Aucune opération">
                Les clonages, synchronisations, commits et push apparaîtront ici.
              </EmptyState>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {state.operations.map((item) => (
                  <OperationRow key={item.id} item={item} now={now} />
                ))}
              </ul>
            )
          ) : null}
          {state.kind === 'ready' && tab === 'sessions' ? (
            state.sessions.length === 0 ? (
              <EmptyState variant="plain" icon="terminal" title="Aucune session terminée">
                Les sessions arrêtées, interrompues ou terminées apparaîtront ici.
              </EmptyState>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {state.sessions.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <a href={`/workspace/${item.id}`} className="min-w-0 flex-1 truncate font-sans text-app-14 font-medium text-text hover:text-accent">
                        {item.title}
                      </a>
                      <Badge tone={item.status === 'failed' ? 'danger' : item.status === 'interrupted' ? 'warn' : 'neutral'}>
                        {SESSION_STATUS_LABELS[item.status] ?? item.status}
                      </Badge>
                    </div>
                    <p className="m-0 font-mono text-app-11 text-muted">
                      {[item.projectName, item.branch, item.endedAt ?? item.lastActivityAt ? relativeLong(item.endedAt ?? item.lastActivityAt!, now) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {item.errorMessage ? (
                      <p className="m-0 font-mono text-app-11 break-words text-danger">
                        {item.errorCode ? `${item.errorCode} · ` : ''}
                        {item.errorMessage}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function OperationRow({ item, now }: { item: OperationLogItem; now: number }) {
  const [log, setLog] = useState<{ kind: 'closed' } | { kind: 'loading' } | { kind: 'open'; text: string } | { kind: 'error'; message: string }>({ kind: 'closed' });
  const badge = operationStatusBadge(item.status);
  async function toggle() {
    if (log.kind === 'open') return setLog({ kind: 'closed' });
    setLog({ kind: 'loading' });
    const result = await loadOperationLogAction(item.id);
    if (!result.ok) return setLog({ kind: 'error', message: result.error.message });
    setLog({ kind: 'open', text: [result.data.log, result.data.raw].filter(Boolean).join('\n') || '(journal vide)' });
  }
  return (
    <li className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-sans text-app-14 font-medium text-text">
          {operationKindLabel(item.kind)}
          {item.title ? ` · ${item.title}` : ''}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="m-0 font-mono text-app-11 text-muted">{[item.projectName, relativeLong(item.createdAt, now)].filter(Boolean).join(' · ')}</p>
      {item.errorMessage ? <p className="m-0 font-sans text-app-12 text-danger">{item.errorMessage}</p> : null}
      {item.hasLog ? (
        <CompactButton variant="discret" className="self-start" onClick={toggle} loading={log.kind === 'loading'} aria-expanded={log.kind === 'open'}>
          {log.kind === 'open' ? 'Masquer le journal' : 'Voir le journal'}
        </CompactButton>
      ) : null}
      {log.kind === 'open' ? (
        <CodeBlock size="sm" wrap label={`Journal · ${operationKindLabel(item.kind)}`}>
          {log.text}
        </CodeBlock>
      ) : null}
      {log.kind === 'error' ? <p className="m-0 font-sans text-app-12 text-danger">{log.message}</p> : null}
    </li>
  );
}

/**
 * Serveur tab: detailed services, live metrics and settings of the server of the account's space
 * (sessions parallèles and memory up to the administrator's ceiling; name and location: owner and
 * administrators), web access limits of the instance (read-only for members), maintenance.
 */
export function ServerTab() {
  const { data, settings, serverName } = useSettings();
  const cap = settings.maxConcurrentSessionsCap ?? 16;
  const live = useLiveEvents();
  const unavailable = useRunnerUnavailable();
  const snapshot = data.metrics.ok ? data.metrics.data : null;
  const metrics = live.metrics
    ? {
        cpuPercent: live.metrics.cpuPercent,
        memoryUsedBytes: live.metrics.memoryUsedBytes,
        memoryTotalBytes: live.metrics.memoryTotalBytes,
        diskUsedBytes: live.metrics.diskUsedBytes,
        diskTotalBytes: live.metrics.diskTotalBytes,
      }
    : snapshot;
  const health = data.health.ok ? data.health.data : null;

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <ServerTile detailed />
        <Card as="section" aria-label="Ressources" className="gap-3">
          <TileHeader icon="cpu" title="Ressources" />
          {metrics && !unavailable ? (
            <div className="flex flex-col gap-3" aria-live="polite">
              <Meter label="Processeur" valueLabel={formatPercent(metrics.cpuPercent)} percent={metrics.cpuPercent} tone={metrics.cpuPercent >= 90 ? 'danger' : metrics.cpuPercent >= 75 ? 'warn' : 'accent'} />
              <Meter
                label="Mémoire"
                valueLabel={formatUsage(metrics.memoryUsedBytes, metrics.memoryTotalBytes)}
                percent={metrics.memoryTotalBytes > 0 ? (metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100 : null}
              />
              {metrics.diskUsedBytes !== null && metrics.diskTotalBytes !== null ? (
                <Meter
                  label="Stockage des projets"
                  valueLabel={formatUsage(metrics.diskUsedBytes, metrics.diskTotalBytes)}
                  percent={metrics.diskTotalBytes > 0 ? (metrics.diskUsedBytes / metrics.diskTotalBytes) * 100 : null}
                />
              ) : null}
              {snapshot ? (
                <p className="m-0 font-mono text-app-11 text-muted">
                  {`${plural(snapshot.cpuCount, 'cœur', 'cœurs')} · ${plural(snapshot.sessionsLive, 'session vivante', 'sessions vivantes')} · ${plural(snapshot.terminalsLive, 'terminal', 'terminaux')} · ${plural(snapshot.runsLive, 'commande', 'commandes')} en cours`}
                </p>
              ) : null}
            </div>
          ) : serverName === null ? (
            <NoServerNote />
          ) : (
            <UnavailableNote>{`${serverName} ne répond pas : les mesures reprendront à son retour.`}</UnavailableNote>
          )}
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Card as="section" aria-label="Réglages du serveur" className="gap-4">
          <TileHeader icon="server" title="Réglages du serveur" />
          {serverName === null ? (
            <NoServerNote />
          ) : (
            <>
              {(settings.serverAccounts ?? 1) > 1 ? (
                <p className="m-0 font-sans text-app-12 text-muted">
                  {`Serveur partagé entre ${settings.serverAccounts} comptes : chacun garde son espace, ses projets et sa propre connexion Claude Code ; la capacité et les mesures sont celles du serveur entier.`}
                </p>
              ) : null}
              <TextSetting field="serverName" label="Nom du serveur" hint={`Affiché dans la barre latérale et les messages (« ${serverName} ne répond pas »).`} maxLength={40} successMessage={(value) => `Nom du serveur : ${value ?? ''}`} />
              <TextSetting field="serverLocation" label="Emplacement" hint="Facultatif (hébergeur, région)." maxLength={80} nullable successMessage={(value) => (value ? `Emplacement : ${value}` : 'Emplacement retiré')} />
              <NumberSetting
                field="maxConcurrentSessions"
                label="Sessions parallèles"
                hint={
                  (settings.serverAccounts ?? 1) > 1
                    ? `Processus Claude Code vivants en même temps sur ce serveur, partagés entre ses ${settings.serverAccounts} comptes ; au-delà, une nouvelle session est refusée jusqu'à l'arrêt d'une autre. ${cap} au plus (plafond fixé par un administrateur).${settings.serverPrimary ? '' : ' Réglé par le premier compte du serveur.'}`
                    : `Processus Claude Code vivants en même temps ; au-delà, une nouvelle session est refusée jusqu'à l'arrêt d'une autre. ${cap} au plus (plafond fixé par un administrateur).`
                }
                unit="sessions"
                min={1}
                max={cap}
                successMessage={(value) => `Sessions parallèles : ${value ?? ''}`}
              />
              <NumberSetting
                field="sessionMemoryLimitMb"
                label="Mémoire par session"
                hint="Plafond par arbre de processus d'une session ; vide = aucune limite."
                unit="Mo"
                min={256}
                max={262144}
                nullable
                successMessage={(value) => (value ? `Mémoire par session : ${value} Mo` : 'Mémoire par session : aucune limite')}
              />
              <KeyValueList
                items={[
                  { label: 'Racine des projets', value: health ? health.projectsRoot : 'inconnue (runner injoignable)' },
                  ...(health?.disk ? [{ label: 'Espace libre', value: formatBytes(health.disk.freeBytes), mono: false }] : []),
                ]}
              />
              <p className="m-0 font-sans text-app-12 text-muted">La racine des projets est fixée sur le serveur par NUERA_PROJECTS_ROOT : le runner n'écrit jamais en dehors.</p>
            </>
          )}
        </Card>
        <Card as="section" aria-label="Accès web" className="gap-4">
          <TileHeader icon="lock" title="Accès web" />
          <NumberSetting
            field="webSessionIdleHours"
            label="Expiration après inactivité"
            unit="h"
            min={1}
            max={168}
            successMessage={(value) => `Un accès expire après ${value ?? ''} h d'inactivité`}
          />
          <NumberSetting
            field="webSessionMaxDays"
            label="Durée maximale d'un accès"
            unit="jours"
            min={1}
            max={90}
            successMessage={(value) => `Un accès expire au plus tard après ${plural(value ?? 0, 'jour')}`}
          />
          <p className="m-0 font-sans text-app-12 text-muted">{`Actuellement : ${settings.webSessionIdleHours} h d'inactivité, ${plural(settings.webSessionMaxDays, 'jour')} au plus. S'applique aussi aux accès déjà ouverts.`}</p>
        </Card>
        <MaintenanceTile withSettings />
        {data.worktrees.ok && data.worktrees.data.items.length > 0 ? <StaleList view={data.worktrees.data} /> : null}
      </div>
    </div>
  );
}

function StaleList({ view }: { view: StaleWorktreesView }) {
  const { now } = useSettings();
  return (
    <Card as="section" aria-label="Worktrees inactifs" className="gap-1">
      <TileHeader icon="worktree" title="Worktrees inactifs" action={<span className="font-mono text-app-12 text-muted">{view.items.length}</span>} />
      <SettingsRows>
        {view.items.map((item) => (
          <SettingsRow
            key={item.id}
            icon="worktree"
            title={<span className="font-mono text-app-13">{item.name}</span>}
            caption={`${item.projectName} · ${item.branch} · dernière activité ${relativeLong(item.lastActivityAt, now)}${item.dirtyFiles ? ` · ${dirtyFilesText(item.dirtyFiles)}` : ''}`}
            control={item.eligible ? <Badge tone="neutral">Supprimable</Badge> : <Badge tone="warn">Exclu</Badge>}
          />
        ))}
      </SettingsRows>
    </Card>
  );
}
