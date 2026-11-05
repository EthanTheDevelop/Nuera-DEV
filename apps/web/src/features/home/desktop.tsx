'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitActivityRow, IntegrationRow } from '@/components/dev';
import { Icon, type IconName } from '@/components/icons';
import { claudeLoginTerminal, useTerminalLauncher } from '@/components/terminal';
import { Badge, Button, Card, CompactButton, EmptyState, LinkButton, Meter, SectionLabel, TileHeader } from '@/components/ui';
import { NewSessionButton, workspaceUrl } from '@/features/sessions';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import {
  capacityLabel,
  claudeBadge,
  claudeNote,
  meterTone,
  pendingAlert,
  progressLine,
  serverBadge,
  serverFooter,
  serverMeters,
} from './lib';
import { HomeProjectRow, HomeSessionCard, PartUnavailable, ResumeSessionButton, sessionHref, useFavorites } from './parts';
import type { HomeActivity, HomeIntegrations, HomeProjects, HomeSession, HomeSessions } from './types';
import type { HomeLive } from './useHomeLive';

/* D01 · Accueil — desktop tiles (1440: three columns of 360 with 24 px gaps; row 2 = 320 · 320 · 440). */

export function ServerTile({ live, generatedAt }: { live: HomeLive; generatedAt: string }) {
  const now = useNow(60_000, Date.parse(generatedAt));
  const { server } = live;
  const badge = serverBadge(server.availability);
  const meters = serverMeters(server.availability === 'unavailable' ? null : server.metrics);
  const footer = serverFooter({ location: server.location, availability: server.availability, uptimeSec: server.uptimeSec, lastContactAt: server.lastContactAt, now });
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-serveur" className="gap-4">
      <TileHeader icon="server" title={<span id="accueil-serveur">{`Serveur ${server.name}`}</span>} action={<Badge tone={badge.tone}>{badge.label}</Badge>} />
      <div aria-live="off" className="flex flex-col gap-4">
        <Meter label="Processeur" valueLabel={meters.cpu.valueLabel} percent={meters.cpu.percent} tone={meterTone(meters.cpu.percent)} />
        <Meter label="Mémoire" valueLabel={meters.memory.valueLabel} percent={meters.memory.percent} tone={meterTone(meters.memory.percent)} />
        <Meter label="Stockage" valueLabel={meters.disk.valueLabel} percent={meters.disk.percent} tone={meterTone(meters.disk.percent)} />
      </div>
      {footer ? (
        <p suppressHydrationWarning className={cn('m-0 font-mono text-app-11 leading-4', server.availability === 'unavailable' ? 'text-danger' : 'text-muted')}>
          {footer}
        </p>
      ) : null}
    </Card>
  );
}

export function ClaudeTile({ live, capacityMax, defaultModel }: { live: HomeLive; capacityMax: number; defaultModel: string | null }) {
  const router = useRouter();
  const terminal = useTerminalLauncher();
  const state = live.claudeState;
  const badge = claudeBadge(state, live.pending.length, live.availability);
  const alert = state === 'connected' ? pendingAlert(live.pending) : null;
  const first = live.pending[0] ?? null;
  const reconnect = live.availability !== 'unavailable' && (state === 'disconnected' || state === 'wrong_method');
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-claude" className="gap-3">
      <TileHeader icon="terminal" title={<span id="accueil-claude">Claude Code</span>} action={<Badge tone={badge.tone}>{badge.label}</Badge>} />
      <p className="m-0 flex items-baseline gap-2">
        <span className="font-sans text-[1.875rem] leading-none font-semibold text-text">{live.activeCount}</span>
        <span className="font-sans text-app-13 text-muted">{capacityLabel(live.activeCount, capacityMax)}</span>
      </p>
      {alert && first ? (
        <p role="status" className="m-0 flex items-center gap-2 rounded-md bg-warn-pale px-3 py-2 font-sans text-app-13 text-warn">
          <Icon name="alert" size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 line-clamp-2">{alert}</span>
        </p>
      ) : null}
      {reconnect ? (
        <p role="status" className="m-0 flex items-center gap-2 rounded-md bg-warn-pale px-3 py-2 font-sans text-app-13 text-warn">
          <Icon name="alert" size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">Claude Code n'est plus connecté à votre compte Claude</span>
        </p>
      ) : null}
      <p className="m-0 font-sans text-app-12 leading-[17px] text-muted">
        {claudeNote({ state, plan: live.claudePlan, defaultModel }, live.availability)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {reconnect ? (
          <CompactButton variant="principal" icon="terminal" onClick={() => terminal.open(claudeLoginTerminal({ serverName: live.server.name, onExit: () => router.refresh() }))}>
            Se reconnecter dans un terminal
          </CompactButton>
        ) : first ? (
          <CompactButton variant="principal" icon="check" href={workspaceUrl(first.sessionId, first.id)}>
            Répondre
          </CompactButton>
        ) : null}
        <CompactButton variant="secondaire" href="/sessions">
          Voir les sessions
        </CompactButton>
      </div>
      {terminal.dialog}
    </Card>
  );
}

export function QuickResumeTile({ session, hasProjects }: { session: HomeSession | null; hasProjects: boolean }) {
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-reprise" className="gap-3">
      <TileHeader icon="history" title={<span id="accueil-reprise">Reprise rapide</span>} action={<LinkButton href="/sessions">Toutes les sessions</LinkButton>} />
      {session ? (
        <>
          <h3 className="m-0 truncate font-sans text-app-20 font-semibold text-text" title={session.title}>
            <Link href={sessionHref(session)} className="hover:underline">
              {session.title}
            </Link>
          </h3>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex min-w-0 items-center gap-1.5 font-sans text-app-12 text-muted">
              <Icon name="projets" size={14} />
              <span className="truncate">{session.projectName}</span>
            </span>
            {session.branch ? (
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-app-11 text-muted">
                <Icon name="worktree" size={14} />
                <span className="truncate">{session.branch}</span>
              </span>
            ) : null}
          </div>
          {session.lastInstruction ? (
            <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-raised px-3 py-2.5">
              <SectionLabel>Dernière instruction</SectionLabel>
              <p className="m-0 line-clamp-3 font-sans text-app-13 leading-[18px] text-text">{`« ${session.lastInstruction.trim()} »`}</p>
            </div>
          ) : null}
          {progressLine(session) ? (
            <p className="m-0 flex items-center gap-2 font-sans text-app-13 text-muted">
              <Icon name="clock" size={16} className="shrink-0 text-en-cours" />
              <span className="min-w-0 flex-1 truncate">{progressLine(session)}</span>
            </p>
          ) : null}
          <div className="flex">
            <ResumeSessionButton session={session} variant="principal" />
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
            {hasProjects
              ? 'Aucune session à reprendre : la dernière session ouverte ou reprenable apparaîtra ici.'
              : 'Ajoutez un projet pour démarrer une première session.'}
          </p>
          {hasProjects ? <NewSessionButton variant="principal" /> : null}
        </div>
      )}
    </Card>
  );
}

/** Row 2 left: the two most urgent / recent active sessions (or the T2 empty state). */
export function SessionsCards({ sessions, items, onRetry }: { sessions: HomeSessions; items: HomeSession[]; onRetry: () => void }) {
  if (sessions.error && items.length === 0) {
    return (
      <Card variant="tile" as="section" aria-label="Sessions actives" className="col-span-2">
        <PartUnavailable error={sessions.error} title="Sessions actives indisponibles" onRetry={onRetry} />
      </Card>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon="terminal"
        title="Aucune session en cours"
        className="col-span-2 justify-center"
        action={<NewSessionButton variant="principal" />}
      >
        Démarrez-en une depuis un projet. Elle continue même navigateur fermé.
      </EmptyState>
    );
  }
  const shown = items.slice(0, 2);
  return (
    <>
      {shown.map((session) => (
        <HomeSessionCard key={session.id} session={session} />
      ))}
      {shown.length === 1 ? <NewSessionButton variant="card" /> : null}
    </>
  );
}

export function RecentProjectsTile({ projects }: { projects: HomeProjects }) {
  const favorites = useFavorites();
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-projets" className="gap-1">
      <TileHeader icon="projets" title={<span id="accueil-projets">Projets récents</span>} action={<LinkButton href="/projets">Tous les projets</LinkButton>} />
      <div className="flex flex-col [&>*:last-child]:border-b-0">
        {projects.items.map((project) => (
          <HomeProjectRow
            key={project.id}
            project={project}
            variant="desktop"
            favorite={favorites.favorite(project)}
            onToggleFavorite={() => void favorites.toggle(project)}
            favoritePending={favorites.pending === project.id}
          />
        ))}
      </div>
      {favorites.error ? (
        <p role="alert" className="m-0 font-sans text-app-12 text-danger">
          {favorites.error}
        </p>
      ) : null}
    </Card>
  );
}

export function GitActivityTile({ activity, onRetry, className }: { activity: HomeActivity; onRetry: () => void; className?: string }) {
  const rows = activity.items.slice(0, 4);
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-modifications" className={cn('gap-1', className)}>
      <TileHeader
        icon="git-commit"
        title={<span id="accueil-modifications">Dernières modifications</span>}
        action={activity.githubUrl ? <LinkButton href={activity.githubUrl} external>Ouvrir sur GitHub</LinkButton> : null}
      />
      {activity.error && rows.length === 0 ? (
        <PartUnavailable error={activity.error} title="Historique Git indisponible" onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <p className="m-0 py-3 font-sans text-app-13 leading-[18px] text-muted">
          Aucune modification récente : les commits et pull requests de vos projets apparaîtront ici.
        </p>
      ) : (
        <div className="flex flex-col">
          {rows.map((event) => (
            <GitActivityRow
              key={event.id}
              kind={event.kind}
              sha={event.sha}
              number={event.number}
              message={event.message}
              projectName={event.projectName}
              branch={event.branch}
              author={event.byClaude ? 'Claude Code' : null}
              at={event.at}
              href={event.href}
            />
          ))}
        </div>
      )}
      {activity.incomplete && rows.length > 0 ? (
        <p className="m-0 pt-2 font-sans text-app-12 text-muted">Une partie de l'historique n'a pas pu être lue sur le serveur.</p>
      ) : null}
    </Card>
  );
}

export function IntegrationsTile({ integrations, onRetry }: { integrations: HomeIntegrations | null; onRetry: () => void }) {
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-integrations" className="gap-1">
      <TileHeader icon="plug" title={<span id="accueil-integrations">Intégrations</span>} action={<LinkButton href="/integrations">Gérer</LinkButton>} />
      {integrations ? (
        <>
          <div className="flex flex-col">
            {integrations.rows.map((row) => (
              <IntegrationRow key={row.id} name={row.name} icon={row.icon as IconName} detail={row.detail} badge={row.badge} href={row.href} />
            ))}
          </div>
          {integrations.inactiveMcp > 0 && integrations.rows.length === 1 ? (
            <p className="m-0 pt-2 font-sans text-app-12 leading-[17px] text-muted">
              {`Aucun serveur MCP activé dans un projet (${integrations.inactiveMcp} enregistré${integrations.inactiveMcp >= 2 ? 's' : ''}).`}
            </p>
          ) : null}
          {integrations.footer ? (
            <Link href={integrations.footer.href} className="pt-2 font-sans text-app-12 leading-[17px] text-danger hover:underline">
              {integrations.footer.text}
            </Link>
          ) : null}
        </>
      ) : (
        <PartUnavailable error="failed" title="Intégrations indisponibles" onRetry={onRetry} />
      )}
    </Card>
  );
}

/** First run (no project yet): T2 « Aucun projet pour l'instant », the entry of Flow A. */
export function FirstProjectEmptyState({ serverName, className }: { serverName: string; className?: string }) {
  return (
    <EmptyState
      icon="projets"
      title="Aucun projet pour l'instant"
      className={className}
      action={
        <Button variant="accent" href="/projets/nouveau">
          Ajouter un projet
        </Button>
      }
    >
      {`Ajoutez un dépôt GitHub : il sera cloné sur ${serverName}, prêt pour Claude Code.`}
    </EmptyState>
  );
}
