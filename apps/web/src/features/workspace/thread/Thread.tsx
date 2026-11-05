'use client';

import {
  ClaudeMessage,
  CommandOutput,
  InstructionMessage,
  PermissionRequestCard,
  PlanCard,
  SessionEmptyState,
  SessionSummaryCard,
  ToolLine,
  isCommandTool,
  newSessionDescription,
  permissionModeLabel,
  sessionSummaryMeta,
} from '@/components/dev';
import { Banner, CompactButton, EmptyState, ErrorPanel, SkeletonList } from '@/components/ui';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import type { SessionEventItem } from '@nuera/shared/runner';
import { formatTime } from '@nuera/shared/format';
import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useWorkspace } from '../WorkspaceContext';
import {
  allowedCount,
  bulletPoints,
  lastAssistantText,
  newSessionSuggestions,
  permissionCardStatus,
  permissionOptionsOf,
  sessionDurationMs,
  type PendingInstruction,
} from '../lib/thread';

export type ThreadVariant = 'desktop' | 'phone';

function safeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatTime(date);
}

/** Muted centred line for status / notification / system items (undesigned, sober). */
function SystemLine({ children, at }: { children: ReactNode; at?: string | null }) {
  const time = safeTime(at);
  return (
    <p className="m-0 w-full text-center font-mono text-app-11 text-muted">
      {children}
      {time ? ` · ${time}` : null}
    </p>
  );
}

const TOOL_STATUS = { running: 'running', done: 'done', error: 'error', denied: 'denied' } as const;

/** One conversation item (session_events row) drawn with the Figma composite. */
const ThreadItem = memo(function ThreadItem({ item, variant }: { item: SessionEventItem; variant: ThreadVariant }) {
  const ws = useWorkspace();
  switch (item.kind) {
    case 'instruction':
      return <InstructionMessage text={item.payload.text} at={item.payload.at} variant={variant} />;
    case 'assistant':
      return <ClaudeMessage markdown={item.payload.text} at={item.payload.at} />;
    case 'tool': {
      const p = item.payload;
      const output = p.output ?? (p.status === 'error' ? p.error : null);
      const detail = output ? (
        <CommandOutput
          command={isCommandTool(p.tool) ? p.target : null}
          output={output}
          exitCode={p.meta?.kind === 'command' ? p.meta.exitCode : null}
          truncated={p.outputTruncated}
          maxHeight={variant === 'phone' ? 320 : 420}
        />
      ) : null;
      return (
        <ToolLine
          tool={p.subagent ? `${p.tool} · ${p.subagent}` : p.tool}
          target={p.target}
          status={TOOL_STATUS[p.status]}
          meta={p.summary}
          startedAt={p.status === 'running' ? p.startedAt : null}
        >
          {detail}
        </ToolLine>
      );
    }
    case 'plan':
      return <PlanCard steps={item.payload.items} />;
    case 'permission': {
      const p = item.payload;
      const status = permissionCardStatus(p, ws.ctl.state.session.status, ws.ctl.state.permission);
      const pendingOption = ws.decision?.permissionId === p.permissionId ? ws.decision.optionId : null;
      const error = ws.decisionError?.permissionId === p.permissionId ? ws.decisionError.message : null;
      const openTerminal = () => {
        if (variant === 'phone') ws.url.set({ onglet: 'session', vue: 'terminal' });
        else ws.url.set({ vue: 'terminal' });
      };
      return (
        <PermissionRequestCard
          id={`demande-${p.permissionId}`}
          status={status}
          title={p.title}
          target={p.target}
          isCommand={isCommandTool(p.tool)}
          toolName={p.tool}
          explanation={p.detail}
          options={permissionOptionsOf(p)}
          modeLabel={permissionModeLabel(ws.ctl.state.session.permissionMode)}
          variant={variant}
          onDecide={(option) => void ws.decide(p.permissionId, option)}
          pendingOptionId={pendingOption}
          disabledReason={ws.reconnecting ? 'Connexion au serveur perdue : la demande attend votre réponse à la reconnexion.' : null}
          error={error}
          onAnswerInTerminal={openTerminal}
        />
      );
    }
    case 'notification':
      return <SystemLine at={item.payload.at}>{item.payload.title ? `${item.payload.title} · ${item.payload.message}` : item.payload.message}</SystemLine>;
    case 'status':
      return <SystemLine at={item.payload.at}>{item.payload.label}</SystemLine>;
    case 'error':
      return (
        <Banner tone="danger" title={item.payload.message} className="w-full">
          {item.payload.detail ?? undefined}
        </Banner>
      );
    case 'compact':
      return (
        <SystemLine at={item.payload.at}>
          {item.payload.phase === 'start' ? 'Claude Code compacte le contexte de la conversation…' : 'Contexte de la conversation compacté par Claude Code'}
        </SystemLine>
      );
    case 'subagent':
      return (
        <ToolLine
          tool="Agent"
          target={item.payload.agentType}
          status={item.payload.status === 'running' ? 'running' : 'done'}
          meta={item.payload.status === 'running' ? null : 'terminé'}
          startedAt={item.payload.status === 'running' ? item.payload.at : null}
        />
      );
    case 'system':
      return <SystemLine at={item.payload.at}>{item.payload.message}</SystemLine>;
  }
});

function PendingBubble({ pending, variant }: { pending: PendingInstruction; variant: ThreadVariant }) {
  return <InstructionMessage text={pending.text} at={pending.at} queued={pending.queued} variant={variant} />;
}

/** Keeps the newest item visible while the reader is at the bottom (never yanks a reader who scrolled up). */
function useStickToBottom(ref: React.RefObject<HTMLDivElement | null>, signal: unknown) {
  const atBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- signal is the trigger: stay pinned to the bottom on new content
  }, [ref, signal]);
}

function FinishedSummary({ items }: { items: SessionEventItem[] }) {
  const ws = useWorkspace();
  const { session, changes } = ws.ctl.state;
  const now = useNow(60_000, ws.initialNow);
  const duration = sessionDurationMs(session, now) ?? 0;
  const files = changes?.totals.files ?? 0;
  const hasChanges = files > 0;
  const meta = changes
    ? sessionSummaryMeta({
        files,
        additions: changes.totals.insertions,
        deletions: changes.totals.deletions,
        allowedCommands: Math.max(allowedCount(items), ws.data.allowedCommands),
      })
    : null;
  return (
    <SessionSummaryCard
      durationMs={duration}
      points={bulletPoints(lastAssistantText(items))}
      badge={hasChanges ? 'Prête pour un commit' : null}
      meta={meta}
      actions={
        <>
          {hasChanges ? (
            <CompactButton variant="principal" icon="git-commit" disabled={Boolean(ws.serverDisabledReason)} onClick={() => ws.openCommit('commit')}>
              Préparer le commit
            </CompactButton>
          ) : null}
          {hasChanges ? (
            <CompactButton
              variant="secondaire"
              icon="file-diff"
              onClick={() => ws.url.set({ revue: '1', onglet: 'diff' })}
            >
              Voir le diff
            </CompactButton>
          ) : null}
          {ws.composer.state === 'ready' ? (
            <CompactButton variant="discret" onClick={ws.focusComposer}>
              Continuer la conversation
            </CompactButton>
          ) : null}
        </>
      }
    />
  );
}

export interface ThreadProps {
  variant: ThreadVariant;
  className?: string;
}

/**
 * `Fil de la session` (D05 214:1528, M05): the conversation items of the CLI stream, bottom-anchored
 * (newest visible), W1 empty state, W3 summary. Dimmed and inert while the connection is lost (W7).
 */
export function Thread({ variant, className }: ThreadProps) {
  const ws = useWorkspace();
  const { items } = ws.ctl;
  const { session, pending, threadError, threadLoading, permission } = ws.ctl.state;
  const scroller = useRef<HTMLDivElement | null>(null);
  useStickToBottom(scroller, `${items.length}:${ws.ctl.state.version}:${pending.length}:${permission?.id ?? ''}`);

  // Deep link `#demande-<id>` (notification « Répondre »): bring the request into view once.
  const scrolledToRequest = useRef(false);
  useEffect(() => {
    if (scrolledToRequest.current) return;
    const hash = window.location.hash;
    if (!hash.startsWith('#demande-')) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    scrolledToRequest.current = true;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- retry once new items are rendered
  }, [items.length]);

  const empty = items.length === 0 && pending.length === 0;
  const blank = empty && session.status === 'new';
  const phone = variant === 'phone';

  let body: ReactNode;
  if (threadLoading && empty) {
    body = <SkeletonList rows={4} label="Chargement du fil de la session" />;
  } else if (threadError && empty) {
    body = (
      <ErrorPanel
        title="Le fil de la session est indisponible"
        excerpt={threadError}
        untouched={`La session continue sur ${ws.host} : rien n'est perdu.`}
        onRetry={() => void ws.ctl.reloadThread()}
        retrying={threadLoading}
      />
    );
  } else if (blank) {
    const claudeMd = ws.data.claudeMd;
    body = (
      <SessionEmptyState
        repoName={ws.data.project.repoName}
        description={
          ws.data.worktree
            ? newSessionDescription({
                worktreeName: ws.data.worktree.name,
                baseBranch: ws.data.worktree.baseBranch ?? ws.data.project.defaultBranch,
                claudeMdRead: Boolean(claudeMd?.exists && ws.data.project.readClaudeMd),
              })
            : null
        }
        suggestions={newSessionSuggestions({ hasClaudeMd: Boolean(claudeMd?.exists), testCommand: ws.data.project.commands.test })}
        onSuggestion={
          ws.composer.state === 'ready'
            ? (s) => {
                ws.setDraft(s.label);
                ws.focusComposer();
              }
            : undefined
        }
      />
    );
  } else if (empty) {
    body = (
      <EmptyState icon="messages" title="Aucun échange pour l'instant" variant="plain">
        Le fil se remplit avec la sortie du CLI dès que Claude Code travaille dans cette session.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {items.map((item) => (
          <ThreadItem key={item.key ?? `id:${item.id}`} item={item} variant={variant} />
        ))}
        {pending.map((p) => (
          <PendingBubble key={p.localId} pending={p} variant={variant} />
        ))}
        {session.status === 'finished' ? <FinishedSummary items={items} /> : null}
      </>
    );
  }

  return (
    <div
      ref={scroller}
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      aria-busy={threadLoading || undefined}
    >
      <div
        role="log"
        aria-label="Fil de la session"
        aria-live="polite"
        aria-relevant="additions"
        inert={ws.reconnecting || undefined}
        className={cn(
          'mx-auto flex min-h-full w-full flex-col items-stretch transition-opacity duration-(--dur-fast)',
          blank ? 'justify-center' : 'justify-end',
          phone ? 'gap-3 px-4 py-3' : 'max-w-[784px] gap-3.5 px-8 py-5',
          ws.reconnecting && 'opacity-50',
        )}
      >
        {body}
      </div>
    </div>
  );
}

