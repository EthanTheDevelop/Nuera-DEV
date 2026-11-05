'use client';

import {
  SessionSwitcherAllLink,
  SessionSwitcherHeader,
  SessionSwitcherItem,
  SessionSwitcherNewItem,
  SessionSwitcherNote,
  formatRatio,
  mostUrgentStatus,
  sessionStatusMeta,
} from '@/components/dev';
import { Icon } from '@/components/icons';
import { Popover, PopoverContent, PopoverTrigger, Sheet, SheetContent, StatusDot } from '@/components/ui';
import { NewSessionDialog } from '@/features/sessions';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { cn } from '@/lib/cn';
import { formatBytes, plural } from '@nuera/shared/format';
import { useMemo, useState } from 'react';
import { useWorkspace } from '../WorkspaceContext';
import { workspaceUrl, type SiblingSession } from '../lib/contract';

/** Sessions holding a CLI (they count against « Sessions parallèles »; a new session does not yet). */
const ACTIVE = new Set(['running', 'waiting_permission', 'waiting_input']);

/** Sessions of the project shown by W6 / S4, the current one with its live status. */
export function useSwitcherSessions(): { sessions: SiblingSession[]; active: number } {
  const ws = useWorkspace();
  const live = useOptionalLiveEvents();
  const { session } = ws.ctl.state;
  return useMemo(() => {
    const sessions = ws.data.siblings.map((s) => (s.current ? { ...s, status: session.status, title: session.title, startedAt: session.startedAt } : s));
    if (!sessions.some((s) => s.current)) {
      sessions.unshift({
        id: session.id,
        title: session.title,
        status: session.status,
        branch: ws.data.worktree?.branch ?? null,
        worktreeName: ws.data.worktree?.name ?? null,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        current: true,
      });
    }
    // Live updates of the other sessions' activity come through the shell stream.
    const updates = live?.sessionUpdates ?? {};
    const filtered = sessions.filter((s) => s.current || updates[s.id]?.active !== false);
    return { sessions: filtered, active: filtered.filter((s) => ACTIVE.has(s.status)).length };
  }, [live?.sessionUpdates, session, ws.data.siblings, ws.data.worktree]);
}

function useNewSessionCaption(): { description: string | null; disabledReason: string | null } {
  const ws = useWorkspace();
  const live = useOptionalLiveEvents();
  const metrics = live?.metrics;
  const base = ws.data.project.defaultBranch;
  const free = metrics ? Math.max(0, metrics.memoryTotalBytes - metrics.memoryUsedBytes) : null;
  const liveCount = live?.activeSessionIds.length ?? ws.data.capacity.live;
  const atCapacity = liveCount >= ws.data.capacity.max;
  return {
    description: free === null ? `Créé depuis ${base}` : `Créé depuis ${base} · ${formatBytes(free)} de mémoire libre`,
    disabledReason: atCapacity
      ? `Capacité atteinte : ${plural(ws.data.capacity.max, 'session active', 'sessions actives')} au maximum. Arrêtez-en une pour en démarrer une autre.`
      : null,
  };
}

/** D05 `Sélecteur de session` → W6 popover `Sélecteur ouvert · sessions de <projet>`. */
export function SessionSwitcherPopover() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const { sessions, active } = useSwitcherSessions();
  const caption = useNewSessionCaption();
  const urgent = mostUrgentStatus(sessions.map((s) => s.status)) ?? ws.ctl.state.session.status;
  const label = plural(sessions.length, 'session sur ce projet', 'sessions sur ce projet');

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            'nu-hit inline-flex h-[34px] shrink-0 items-center gap-2 rounded-md border border-border bg-bg px-3 py-2 font-sans text-app-13 font-medium text-text',
            'transition-colors duration-(--dur-fast) hover:bg-hover data-[state=open]:bg-accent-pale',
          )}
          aria-label={`${label} : changer de session`}
        >
          <StatusDot tone={sessionStatusMeta(urgent).dot} />
          <span className="hidden whitespace-nowrap min-[1280px]:inline">{label}</span>
          <span className="whitespace-nowrap min-[1280px]:hidden" aria-hidden>
            {sessions.length}
          </span>
          <Icon name="chevron-down" size={16} className="text-muted" />
        </PopoverTrigger>
        <PopoverContent width={400} align="end" sideOffset={6} className="flex flex-col gap-1 p-2">
          <SessionSwitcherHeader projectName={ws.data.project.name} active={active} max={ws.data.capacity.max} />
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {sessions.map((s) => (
              <li key={s.id}>
                <SessionSwitcherItem
                  title={s.title}
                  status={s.status}
                  branch={s.branch}
                  worktreeName={s.worktreeName}
                  since={s.status === 'running' ? s.startedAt : null}
                  current={s.current}
                  {...(s.current ? { onSelect: () => setOpen(false) } : { href: workspaceUrl(s.id) })}
                />
              </li>
            ))}
          </ul>
          <div className="my-1 h-px bg-border" aria-hidden />
          <SessionSwitcherNewItem
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
            description={caption.description}
            disabledReason={caption.disabledReason}
          />
          <SessionSwitcherNote />
        </PopoverContent>
      </Popover>
      <NewSessionDialog open={creating} onOpenChange={setCreating} defaultProjectId={ws.data.project.id} />
    </>
  );
}

/** S4 `Feuille · Sessions de <projet>` (phone). */
export function SessionSwitcherSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [creating, setCreating] = useState(false);
  const { sessions, active } = useSwitcherSessions();
  const caption = useNewSessionCaption();
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          title={`Sessions de ${ws.data.project.name}`}
          meta={<span title="Sessions actives / sessions parallèles autorisées">{formatRatio(active, ws.data.capacity.max)}</span>}
        >
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {sessions.map((s) => (
              <li key={s.id}>
                <SessionSwitcherItem
                  variant="sheet"
                  title={s.title}
                  status={s.status}
                  branch={s.branch}
                  worktreeName={s.worktreeName}
                  since={s.status === 'running' ? s.startedAt : null}
                  current={s.current}
                  {...(s.current ? { onSelect: () => onOpenChange(false) } : { href: workspaceUrl(s.id) })}
                />
              </li>
            ))}
          </ul>
          <SessionSwitcherNewItem
            variant="sheet"
            onClick={() => {
              onOpenChange(false);
              setCreating(true);
            }}
            disabledReason={caption.disabledReason}
          />
          <SessionSwitcherAllLink href={`/sessions?projet=${encodeURIComponent(ws.data.project.id)}`} />
        </SheetContent>
      </Sheet>
      <NewSessionDialog open={creating} onOpenChange={setCreating} defaultProjectId={ws.data.project.id} />
    </>
  );
}
