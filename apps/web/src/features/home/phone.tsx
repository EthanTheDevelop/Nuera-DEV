'use client';

import { useEffect, useRef, useState } from 'react';
import { GitActivityRow, sessionStatusMeta } from '@/components/dev';
import { Icon } from '@/components/icons';
import { Badge, Card, CompactButton, LinkButton, SectionLabel, StatusDot } from '@/components/ui';
import { workspaceUrl } from '@/features/sessions';
import { cn } from '@/lib/cn';
import { activeOverline, claudePill, NO_SERVER_PILL, pendingContext, progressLine, serverPill } from './lib';
import { HomeProjectRow, HomeSessionCard, PartUnavailable, ResumeSessionButton } from './parts';
import type { HomeActivity, HomePendingPermission, HomeProjects, HomeSession, HomeSessions } from './types';
import type { HomeLive } from './useHomeLive';

/* M01 · Accueil — phone composition (390 × 844: 16 px gutters, gap 20, cards radius 20). */

const PILL_TONES = {
  success: 'bg-success-pale text-success',
  warn: 'bg-warn-pale text-warn',
  danger: 'bg-danger-pale text-danger',
  neutral: 'bg-surface-raised text-muted border border-border',
} as const;

function StatusPill({ label, tone }: { label: string; tone: keyof typeof PILL_TONES }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 font-sans text-app-12 font-medium', PILL_TONES[tone])}>
      <StatusDot tone={tone} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** `États`: « VPS-3 en ligne » · « Claude Code connecté » (« Aucun serveur attribué » without a server). */
export function StatusPills({ live }: { live: HomeLive }) {
  if (!live.server) {
    return (
      <div aria-live="polite" className="flex flex-wrap items-center gap-2">
        <StatusPill label={NO_SERVER_PILL.label} tone={NO_SERVER_PILL.tone} />
      </div>
    );
  }
  const server = serverPill(live.server.name, live.availability);
  const claude = claudePill(live.claudeState, live.availability);
  return (
    <div aria-live="polite" className="flex flex-wrap items-center gap-2">
      <StatusPill label={server.label} tone={server.tone} />
      <StatusPill label={claude.label} tone={claude.tone} />
    </div>
  );
}

/** `Demande en attente` (shown only while a request waits): warn card, command, full-width « Répondre ». */
export function PendingRequestCard({ pending, others }: { pending: HomePendingPermission; others: number }) {
  return (
    <section aria-labelledby="accueil-demande" className="flex flex-col gap-2.5 rounded-lg border border-warn bg-warn-pale p-4">
      <h2 id="accueil-demande" className="m-0 flex items-center gap-2 font-sans text-app-15 font-semibold text-text">
        <Icon name="alert" size={18} className="shrink-0 text-warn" />
        <span>Une session attend votre accord</span>
      </h2>
      <p className="m-0 truncate font-sans text-app-13 text-muted">{pendingContext(pending)}</p>
      {pending.target ? (
        <p className="m-0 overflow-x-auto rounded-sm border border-border bg-bg px-2.5 py-2 font-mono text-app-12 whitespace-pre text-text">
          {pending.isCommand ? `$ ${pending.target}` : pending.target}
        </p>
      ) : (
        <p className="m-0 font-sans text-app-13 text-text">{pending.title}</p>
      )}
      <CompactButton variant="principal" size="lg" block href={workspaceUrl(pending.sessionId, pending.id)}>
        Répondre
      </CompactButton>
      {others > 0 ? (
        <p className="m-0 font-sans text-app-12 text-muted">
          {others === 1 ? 'Une autre demande attend aussi.' : `${others} autres demandes attendent aussi.`}
        </p>
      ) : null}
    </section>
  );
}

/** `Reprise rapide` card (no instruction quote, secondary button: « Répondre » is the screen's primary). */
export function QuickResumeCard({ session }: { session: HomeSession }) {
  const meta = sessionStatusMeta(session.status);
  const progress = progressLine(session);
  const context = [session.projectName, session.branch].filter(Boolean).join(' · ');
  return (
    <Card variant="card" as="section" aria-labelledby="accueil-reprise-tel" className="gap-2.5">
      <div className="flex items-center gap-2">
        <Icon name="history" size={16} className="shrink-0 text-accent" />
        <SectionLabel as="h2" id="accueil-reprise-tel" className="min-w-0 flex-1">
          Reprise rapide
        </SectionLabel>
        <Badge tone={meta.badge}>{meta.label}</Badge>
      </div>
      <p className="m-0 truncate font-sans text-app-18 font-semibold text-text">{session.title}</p>
      {context ? (
        <p className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-app-11 text-muted">
          <Icon name="worktree" size={14} className="shrink-0" />
          <span className="truncate">{context}</span>
        </p>
      ) : null}
      {progress ? (
        <p className="m-0 flex min-w-0 items-center gap-2 font-sans text-app-13 text-muted">
          <Icon name="clock" size={16} className="shrink-0 text-en-cours" />
          <span className="truncate">{progress}</span>
        </p>
      ) : null}
      <ResumeSessionButton session={session} variant="secondaire" size="lg" block />
    </Card>
  );
}

const CARD_WIDTH = 290;
const RAIL_GAP = 12;

/** `Rail · sessions actives` + `Indicateur du rail` (scroll snap, dots follow the snapped card). */
export function SessionsRail({ sessions, items, count, onRetry }: { sessions: HomeSessions; items: HomeSession[]; count: number; onRetry: () => void }) {
  const rail = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    const onScroll = () => setIndex(Math.min(items.length - 1, Math.max(0, Math.round(node.scrollLeft / (CARD_WIDTH + RAIL_GAP)))));
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [items.length]);

  return (
    <section aria-labelledby="accueil-actives" className="flex flex-col gap-5">
      <SectionLabel as="h2" id="accueil-actives" action={<LinkButton href="/sessions">Tout voir</LinkButton>}>
        {activeOverline(count)}
      </SectionLabel>
      {sessions.error && items.length === 0 ? (
        <PartUnavailable error={sessions.error} title="Sessions actives indisponibles" onRetry={onRetry} />
      ) : items.length === 0 ? (
        <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
          Aucune session en cours. Démarrez-en une depuis un projet. Elle continue même navigateur fermé.
        </p>
      ) : (
        <>
          <div
            ref={rail}
            role="list"
            aria-label="Sessions actives"
            className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {items.map((session) => (
              <div role="listitem" key={session.id} className="w-[290px] shrink-0 snap-start">
                <HomeSessionCard session={session} className="h-full" />
              </div>
            ))}
          </div>
          {items.length > 1 ? (
            <div aria-hidden className="flex h-1.5 items-center justify-center gap-1.5">
              {items.map((session, i) => (
                <span key={session.id} className={cn('h-1.5 rounded-[3px] transition-[width] duration-(--dur-fast)', i === index ? 'w-[18px] bg-accent' : 'w-1.5 bg-border')} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function RecentProjectsCard({ projects }: { projects: HomeProjects }) {
  const rows = projects.items.slice(0, 3);
  return (
    <section aria-labelledby="accueil-projets-tel" className="flex flex-col gap-5">
      <SectionLabel as="h2" id="accueil-projets-tel" action={<LinkButton href="/projets">Tous</LinkButton>}>
        Projets récents
      </SectionLabel>
      <Card variant="card" className="py-1">
        {rows.map((project) => (
          <HomeProjectRow key={project.id} project={project} variant="phone" />
        ))}
      </Card>
    </section>
  );
}

export function LatestChangesCard({ activity, onRetry }: { activity: HomeActivity; onRetry: () => void }) {
  const commits = activity.items.filter((e) => e.kind === 'commit').slice(0, 2);
  return (
    <section aria-labelledby="accueil-modifs-tel" className="flex flex-col gap-5">
      <SectionLabel as="h2" id="accueil-modifs-tel">
        Dernières modifications
      </SectionLabel>
      <Card variant="card" className="py-1">
        {activity.error && commits.length === 0 ? (
          <PartUnavailable error={activity.error} title="Historique Git indisponible" onRetry={onRetry} />
        ) : commits.length === 0 ? (
          <p className="m-0 py-3 font-sans text-app-13 leading-[18px] text-muted">Aucun commit récent dans vos projets.</p>
        ) : (
          commits.map((event) => (
            <GitActivityRow
              key={event.id}
              kind="commit"
              sha={event.sha}
              message={event.message}
              projectName={event.projectName}
              branch={event.branch}
              at={event.at}
              href={event.href}
              variant="phone"
            />
          ))
        )}
      </Card>
    </section>
  );
}
