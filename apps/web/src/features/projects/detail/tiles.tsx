'use client';

import type { ReactNode } from 'react';
import { BranchRow, CommandRow, EnvVarRow, McpToolRow, commandRunBadge, sessionStatusMeta } from '@/components/dev';
import { joinParts } from '@/components/dev/lib/format';
import { Icon } from '@/components/icons';
import { Badge, Banner, Card, CodeBlock, CompactButton, ErrorPanel, LinkButton, StatusDot, Tile, TileHeader } from '@/components/ui';
import { workspaceUrl } from '@/features/sessions';
import { cn } from '@/lib/cn';
import type {
  BranchView,
  EnvVarView,
  Part,
  ProjectCommandKind,
  ProjectDetail,
  ProjectMcpToolView,
  ProjectSessionView,
  RunView,
  WorktreeView,
} from '@/server/projects/types';
import { claudeMdModified, sessionSubline } from '../format';
import { branchBadge, branchDetail, claudeMdPreview, mcpIcon, runSummary } from './model';

export interface TileContext {
  detail: ProjectDetail;
  now: number;
  serverName: string;
  /** Why commands / git actions are blocked right now (runner down, project not ready), or null. */
  blockedReason: string | null;
  runs: Partial<Record<string, RunView>>;
  runPending: Partial<Record<string, boolean>>;
  onRun: (kind: ProjectCommandKind) => void;
  onStop: (run: RunView) => void;
  onShowRun: (run: RunView) => void;
  onNewBranch: () => void;
  onCheckout: (branch: string) => void;
  checkoutPending: string | null;
  onRemoveWorktree: (worktree: WorktreeView) => void;
  onEditClaudeMd: () => void;
  mcpPending: Partial<Record<string, boolean>>;
  onToggleMcp: (tool: ProjectMcpToolView, enabled: boolean) => void;
  onAddEnv: () => void;
  onEditEnv: (variable: EnvVarView) => void;
  onEditCommands: () => void;
  onShowTab: (tab: 'branches' | 'sessions' | 'environnement') => void;
  onRetry: () => void;
}

/** A runner part that failed: sober inline state, the rest of the page stays usable. */
export function PartFailure({ part, what, onRetry, serverName }: { part: Extract<Part<unknown>, { ok: false }>; what: string; onRetry: () => void; serverName: string }) {
  if (part.unavailable) {
    return (
      <Banner tone="warn" icon="wifi-off" title={`${serverName} ne répond pas`}>
        {`${what} revient dès que le serveur répond.`}
      </Banner>
    );
  }
  return <ErrorPanel title={`${what} : lecture impossible`} excerpt={part.message} onRetry={onRetry} untouched="Rien n'a été modifié." />;
}

const DESKTOP_KINDS: ProjectCommandKind[] = ['install', 'dev', 'build', 'test'];
const PHONE_KINDS: ProjectCommandKind[] = ['install', 'dev', 'test'];

function commandRows(ctx: TileContext, kinds: ProjectCommandKind[], variant: 'desktop' | 'phone') {
  const commands = ctx.detail.project.commands as Record<string, string | null | undefined>;
  return kinds.map((kind) => {
    const last = ctx.runs[kind];
    const running = last?.status === 'running';
    return (
      <CommandRow
        key={kind}
        kind={kind}
        command={commands[kind] ?? null}
        lastRun={runSummary(last)}
        now={ctx.now}
        variant={variant}
        pending={Boolean(ctx.runPending[kind])}
        disabledReason={running ? null : ctx.blockedReason}
        onRun={() => ctx.onRun(kind)}
        {...(running && last ? { onStop: () => ctx.onStop(last) } : {})}
      />
    );
  });
}

/** D04 « Environnement de développement » / M04 « Environnement ». */
export function EnvironmentTile({ ctx, variant, full }: { ctx: TileContext; variant: 'desktop' | 'phone'; full?: boolean }) {
  const commands = ctx.detail.project.commands;
  const kinds = full ? (['install', 'dev', 'build', 'test', 'lint'] as ProjectCommandKind[]) : variant === 'phone' ? PHONE_KINDS : commands.lint ? [...DESKTOP_KINDS, 'lint' as const] : DESKTOP_KINDS;
  const Box = variant === 'phone' ? PhoneCard : Tile;
  return (
    <Box className="flex flex-col gap-1">
      {variant === 'phone' ? (
        <PhoneCardHeader icon="terminal" title="Environnement" />
      ) : (
        <TileHeader
          icon="terminal"
          title="Environnement de développement"
          action={
            full ? (
              <CompactButton variant="secondaire" icon="edit" onClick={ctx.onEditCommands} disabled={Boolean(ctx.detail.project.archivedAt)}>
                Modifier les commandes
              </CompactButton>
            ) : null
          }
        />
      )}
      <div className="flex flex-col">{commandRows(ctx, kinds, variant)}</div>
      {variant === 'desktop' ? (
        <p className="m-0 pt-2 font-sans text-app-12 leading-[17px] text-muted">
          Chaque commande tourne dans le worktree actif et s'affiche dans le Terminal du Workspace. Le résultat ci-dessus est celui du dernier lancement réel.
        </p>
      ) : null}
    </Box>
  );
}

/** Environnement tab: the last runs, each with its real output one click away (T4 for a failure). */
export function RunHistoryTile({ ctx }: { ctx: TileContext }) {
  const runs = ctx.detail.runs.recent;
  const lastFailed = runs.find((run) => run.status === 'failed');
  const latestFailedIsLast = lastFailed && ctx.runs[lastFailed.kind]?.id === lastFailed.id;
  return (
    <Tile className="flex flex-col gap-3">
      <TileHeader icon="history" title="Derniers lancements" />
      {latestFailedIsLast && lastFailed ? (
        <ErrorPanel
          title={`${lastFailed.command} a échoué`}
          exitCode={lastFailed.exitCode}
          excerpt={lastFailed.summary}
          actions={
            <>
              <CompactButton variant="secondaire" icon="refresh" onClick={() => ctx.onRun(lastFailed.kind as ProjectCommandKind)} disabled={Boolean(ctx.blockedReason)}>
                Relancer
              </CompactButton>
              <CompactButton variant="discret" onClick={() => ctx.onShowRun(lastFailed)}>
                Voir la sortie complète
              </CompactButton>
            </>
          }
        />
      ) : null}
      {runs.length === 0 ? (
        <p className="m-0 font-sans text-app-13 text-muted">Aucune commande lancée pour l'instant : le résultat de chaque lancement réel s'affichera ici.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {runs.map((run) => {
            const badge = commandRunBadge(run.kind, runSummary(run), ctx.now);
            return (
              <li key={run.id} className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                <code className="min-w-0 flex-1 truncate font-mono text-app-12 text-text" title={run.command}>
                  {run.command}
                </code>
                {run.worktreeName ? <span className="hidden font-mono text-app-11 text-muted sm:inline">{run.worktreeName}</span> : null}
                <Badge tone={badge.tone}>{badge.label}</Badge>
                <CompactButton variant="discret" onClick={() => ctx.onShowRun(run)}>
                  Voir la sortie
                </CompactButton>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

/** D04 « Branches » (overview: 4 rows) / Branches tab (all + worktrees). */
export function BranchesTile({ ctx, full }: { ctx: TileContext; full?: boolean }) {
  const part = ctx.detail.branches;
  const action = (
    <CompactButton variant="secondaire" icon="plus" onClick={ctx.onNewBranch} disabled={Boolean(ctx.blockedReason)}>
      Nouvelle branche
    </CompactButton>
  );
  return (
    <Tile className="flex flex-col gap-1">
      <TileHeader icon="git-branch" title="Branches" action={action} />
      {!part.ok ? (
        <div className="pt-2">
          <PartFailure part={part} what="La liste des branches" onRetry={ctx.onRetry} serverName={ctx.serverName} />
        </div>
      ) : (
        <BranchList ctx={ctx} branches={full ? part.data.items : part.data.items.slice(0, 4)} defaultBranch={part.data.defaultBranch} actions={Boolean(full)} />
      )}
      {!full && part.ok && part.data.items.length > 4 ? (
        <div className="pt-2">
          <LinkButton size={13} onClick={() => ctx.onShowTab('branches')}>{`Toutes les branches · ${part.data.items.length}`}</LinkButton>
        </div>
      ) : null}
    </Tile>
  );
}

function BranchList({ ctx, branches, defaultBranch, actions }: { ctx: TileContext; branches: BranchView[]; defaultBranch: string; actions: boolean }) {
  if (branches.length === 0) return <p className="m-0 py-3 font-sans text-app-13 text-muted">Aucune branche lue dans le clone.</p>;
  return (
    <div className="flex flex-col">
      {branches.map((branch) => {
        const canCheckout = actions && !branch.current && !branch.sessionId && !branch.worktreeId && !ctx.blockedReason;
        return (
          <BranchRow
            key={`${branch.kind}:${branch.name}`}
            name={branch.name}
            detail={branchDetail(branch, defaultBranch)}
            badge={branchBadge(branch)}
            protectedBranch={branch.protected}
            actions={
              canCheckout ? (
                <CompactButton variant="discret" onClick={() => ctx.onCheckout(branch.name)} loading={ctx.checkoutPending === branch.name}>
                  Passer dessus
                </CompactButton>
              ) : branch.sessionId && actions ? (
                <CompactButton variant="discret" href={workspaceUrl(branch.sessionId)}>
                  Ouvrir la session
                </CompactButton>
              ) : null
            }
          />
        );
      })}
    </div>
  );
}

/** Branches tab: worktrees of the project (primary clone + one per session), removable through T8. */
export function WorktreesTile({ ctx }: { ctx: TileContext }) {
  const part = ctx.detail.worktrees;
  return (
    <Tile className="flex flex-col gap-1">
      <TileHeader icon="worktree" title="Worktrees" />
      {!part.ok ? (
        <div className="pt-2">
          <PartFailure part={part} what="La liste des worktrees" onRetry={ctx.onRetry} serverName={ctx.serverName} />
        </div>
      ) : part.data.length === 0 ? (
        <p className="m-0 py-3 font-sans text-app-13 text-muted">Aucun worktree.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {part.data.map((worktree) => {
            const dirty = worktree.dirtyFiles ?? 0;
            const detail = joinParts(
              worktree.branch,
              worktree.isPrimary ? 'clone principal' : null,
              dirty > 0 ? `${dirty} fichier${dirty >= 2 ? 's' : ''} non commité${dirty >= 2 ? 's' : ''}` : worktree.dirtyFiles === 0 ? 'aucune modification' : null,
              (worktree.ahead ?? 0) > 0 ? `${worktree.ahead} commit${worktree.ahead! >= 2 ? 's' : ''} non poussé${worktree.ahead! >= 2 ? 's' : ''}` : null,
            );
            return (
              <li key={worktree.id} className="flex min-w-0 items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                <Icon name="worktree" size={16} className="text-muted" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="m-0 truncate font-mono text-app-13 font-medium text-text">{worktree.name}</p>
                  <p className={cn('m-0 truncate font-sans text-app-12', dirty > 0 ? 'text-warn' : 'text-muted')}>{detail}</p>
                </div>
                {worktree.liveSessionId ? <Badge tone="warn">Session active</Badge> : worktree.isPrimary ? <Badge tone="neutral">Principal</Badge> : null}
                {!worktree.isPrimary && !worktree.liveSessionId ? (
                  <CompactButton variant="discret" onClick={() => ctx.onRemoveWorktree(worktree)} disabled={Boolean(ctx.blockedReason)}>
                    Supprimer…
                  </CompactButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

function sessionAction(session: ProjectSessionView): { label: string; variant: 'principal' | 'discret'; href: string } {
  if (session.status === 'waiting_permission') return { label: 'Répondre', variant: 'principal', href: workspaceUrl(session.id, session.pendingPermissionId) };
  if (session.status === 'finished') return { label: 'Résumé', variant: 'discret', href: workspaceUrl(session.id) };
  if (['interrupted', 'stopped', 'failed'].includes(session.status)) {
    return { label: session.resumable ? 'Reprendre' : 'Voir', variant: 'discret', href: workspaceUrl(session.id) };
  }
  return { label: 'Ouvrir', variant: 'discret', href: workspaceUrl(session.id) };
}

/** D04 « Sessions de ce projet » (3 rows) / Sessions tab (all). */
export function SessionsTile({ ctx, full, newSession }: { ctx: TileContext; full?: boolean; newSession: ReactNode }) {
  const items = full ? ctx.detail.sessions.items : ctx.detail.sessions.items.slice(0, 3);
  return (
    <Tile className="flex flex-col gap-1">
      <TileHeader
        icon="terminal"
        title="Sessions de ce projet"
        action={
          full ? (
            newSession
          ) : (
            <LinkButton size={13} onClick={() => ctx.onShowTab('sessions')}>
              Tout l'historique
            </LinkButton>
          )
        }
      />
      {items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-3">
          <p className="m-0 font-sans text-app-13 text-muted">Aucune session sur ce projet. Elle continue même navigateur fermé.</p>
          {!full ? newSession : null}
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((session) => {
            const meta = sessionStatusMeta(session.status);
            const action = sessionAction(session);
            return (
              <li key={session.id} className="flex min-w-0 items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                <StatusDot tone={meta.dot} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="m-0 truncate font-sans text-app-14 font-medium text-text">
                    {session.title}
                    <span className="sr-only">{` · ${meta.label}`}</span>
                  </p>
                  <p className="m-0 truncate font-mono text-app-11 text-muted">{sessionSubline(session, ctx.now)}</p>
                </div>
                <CompactButton variant={action.variant} href={action.href}>
                  {action.label}
                </CompactButton>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

/** D04 « CLAUDE.md » (dark preview + footnote) / M04 card / CLAUDE.md tab (whole file). */
export function ClaudeMdTile({ ctx, variant, full }: { ctx: TileContext; variant: 'desktop' | 'phone'; full?: boolean }) {
  const part = ctx.detail.claudeMd;
  const Box = variant === 'phone' ? PhoneCard : Tile;
  const exists = part.ok && part.data.exists;
  const edit = (
    <CompactButton variant={variant === 'phone' ? 'discret' : 'secondaire'} icon="edit" onClick={ctx.onEditClaudeMd} disabled={!part.ok || Boolean(ctx.blockedReason)}>
      {exists || !part.ok ? 'Modifier' : 'Créer'}
    </CompactButton>
  );
  const lastCommit = part.ok ? part.data.lastCommit : null;
  const modified = part.ok ? claudeMdModified(lastCommit?.committedAt ?? part.data.modifiedAt, lastCommit?.sha ?? ctx.detail.project.claudeMdCommitSha, ctx.now) : null;
  return (
    <Box className="flex flex-col gap-3">
      {variant === 'phone' ? <PhoneCardHeader icon="book" title="CLAUDE.md" action={edit} /> : <TileHeader icon="book" title="CLAUDE.md" action={edit} />}
      {!part.ok ? (
        <PartFailure part={part} what="CLAUDE.md" onRetry={ctx.onRetry} serverName={ctx.serverName} />
      ) : !part.data.exists ? (
        <p className="m-0 font-sans text-app-13 text-muted">Aucun CLAUDE.md à la racine du dépôt. Créez-le pour donner à Claude Code les règles et commandes du projet.</p>
      ) : (
        <CodeBlock
          wrap
          label="Aperçu de CLAUDE.md"
          className={cn('px-3.5 py-3', variant === 'phone' && !full && 'max-h-[110px] overflow-hidden px-3 py-2.5', full && 'max-h-[70dvh] overflow-y-auto')}
        >
          {full ? (part.data.content ?? '') : claudeMdPreview(part.data.content, variant === 'phone' ? 6 : 11)}
        </CodeBlock>
      )}
      {variant === 'desktop' && part.ok && part.data.exists ? (
        <p className="m-0 font-sans text-app-12 leading-[17px] text-muted">
          {modified ? `${modified} ` : ''}Chaque modification passe par un commit sur la branche courante.
        </p>
      ) : null}
    </Box>
  );
}

/** D04 « Outils MCP du projet » / M04 « Outils MCP ». */
export function McpTile({ ctx, variant }: { ctx: TileContext; variant: 'desktop' | 'phone' }) {
  const part = ctx.detail.mcp;
  const Box = variant === 'phone' ? PhoneCard : Tile;
  const degraded = part.ok ? part.data.filter((tool) => tool.needsReconnect) : [];
  return (
    <Box className="flex flex-col gap-1">
      {variant === 'phone' ? <PhoneCardHeader icon="plug" title="Outils MCP" /> : <TileHeader icon="plug" title="Outils MCP du projet" />}
      {!part.ok ? (
        <PartFailure part={part} what="Les outils MCP" onRetry={ctx.onRetry} serverName={ctx.serverName} />
      ) : part.data.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="m-0 font-sans text-app-13 text-muted">Aucun serveur MCP. Ajoutez Figma, GitHub ou Coolify, puis activez-les projet par projet.</p>
          <CompactButton variant="secondaire" icon="plus" href="/integrations">
            Ajouter un serveur MCP
          </CompactButton>
        </div>
      ) : (
        <div className="flex flex-col">
          {part.data.map((tool) => (
            <McpToolRow
              key={tool.id}
              name={tool.label}
              icon={mcpIcon(tool.name)}
              description={variant === 'phone' && tool.needsReconnect ? null : tool.line}
              warning={tool.needsReconnect ? 'à reconnecter' : null}
              enabled={tool.enabled}
              pending={Boolean(ctx.mcpPending[tool.id])}
              variant={variant}
              {...(ctx.detail.project.archivedAt ? {} : { onToggle: (next: boolean) => ctx.onToggleMcp(tool, next) })}
            />
          ))}
        </div>
      )}
      {degraded.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
          {degraded.map((tool) => (
            <LinkButton key={tool.id} size={13} href={tool.reconnectHref} icon="refresh">
              {`Reconnecter ${tool.label} dans Intégrations`}
            </LinkButton>
          ))}
        </div>
      ) : null}
    </Box>
  );
}

/** D04 « Variables d'environnement »: names, masked secrets (replace only), plain values. */
export function EnvVarsTile({ ctx, full }: { ctx: TileContext; full?: boolean }) {
  const vars = ctx.detail.env;
  const archived = Boolean(ctx.detail.project.archivedAt);
  return (
    <Tile className="flex flex-col gap-1">
      <TileHeader icon="key" title="Variables d'environnement" action={<Badge tone="success">chiffrées · hors Git</Badge>} />
      {vars.length === 0 ? (
        <p className="m-0 py-2 font-sans text-app-13 text-muted">Aucune variable : les commandes du projet tournent avec l'environnement du serveur.</p>
      ) : (
        <div className="flex flex-col">
          {vars.map((variable) => (
            <EnvVarRow
              key={variable.id}
              name={variable.key}
              secret={variable.secret}
              value={variable.value}
              {...(archived ? {} : { onEdit: () => ctx.onEditEnv(variable) })}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 pt-2">
        <p className="m-0 min-w-0 flex-1 font-sans text-app-12 text-muted">Secrets masqués, jamais écrits dans un fichier versionné.</p>
        <CompactButton variant="discret" icon="plus" onClick={ctx.onAddEnv} disabled={archived}>
          Ajouter
        </CompactButton>
      </div>
      {full ? (
        <p className="m-0 pt-1 font-sans text-app-12 text-muted">
          Elles sont données aux commandes lancées depuis Nuera Dev (installation, lancement, build, tests). Une valeur secrète ne peut qu'être remplacée.
        </p>
      ) : null}
    </Tile>
  );
}

function PhoneCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Card variant="card" className={cn('p-4', className)}>
      {children}
    </Card>
  );
}

function PhoneCardHeader({ icon, title, action }: { icon: 'terminal' | 'book' | 'plug'; title: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2">
      <Icon name={icon} size={16} className="text-accent" />
      <h2 className="m-0 min-w-0 flex-1 font-sans text-app-15 font-semibold text-text">{title}</h2>
      {action}
    </div>
  );
}
