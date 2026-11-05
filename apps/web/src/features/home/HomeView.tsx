'use client';

import { NotificationBell, PageHeader, ShellAvailability } from '@/components/shell';
import { NewSessionButton } from '@/features/sessions';
import {
  ClaudeTile,
  FirstProjectEmptyState,
  GitActivityTile,
  IntegrationsTile,
  QuickResumeTile,
  RecentProjectsTile,
  ServerTile,
  SessionsCards,
} from './desktop';
import { LatestChangesCard, PendingRequestCard, QuickResumeCard, RecentProjectsCard, SessionsRail, StatusPills } from './phone';
import type { HomeData } from './types';
import { useHomeLive } from './useHomeLive';

/**
 * Accueil — D01 (desktop, ≥ 900 px) and M01 (phone) compositions over the same live data. Both are
 * rendered and switched by CSS (`nav:` breakpoint) so the server HTML is already right on every
 * device; hidden parts are `display: none` (out of the accessibility tree).
 */
export function HomeView({ data }: { data: HomeData }) {
  const live = useHomeLive(data);
  const firstRun = data.projects.total === 0;
  const newSession = firstRun ? (
    <NewSessionButton variant="accent" disabledReason="Ajoutez d'abord un projet : une session travaille dans un dépôt cloné." />
  ) : (
    <NewSessionButton variant="accent" />
  );

  return (
    <div className="flex flex-col gap-5 nav:gap-6">
      <PageHeader
        title={`Bonjour ${data.firstName}`}
        subtitle={
          <>
            <span className="hidden nav:inline">
              <ShellAvailability variant="long" />
            </span>
            <span className="nav:hidden">
              <ShellAvailability variant="short" />
            </span>
          </>
        }
        actions={
          <>
            <NotificationBell size="sm" />
            {newSession}
          </>
        }
        mobileAction={<NotificationBell size="md" />}
      />

      {/* ---------------------------------------------------------------- D01 · desktop */}
      <div className="hidden flex-col gap-6 nav:flex">
        {firstRun ? (
          <>
            <div className="grid grid-cols-2 items-stretch gap-6 xl:grid-cols-3">
              <ServerTile live={live} generatedAt={data.generatedAt} />
              <ClaudeTile live={live} capacityMax={data.capacity.max} defaultModel={data.claude.defaultModel} />
              <div className="col-span-2 xl:col-span-1">
                <IntegrationsTile integrations={data.integrations} onRetry={live.refresh} />
              </div>
            </div>
            <FirstProjectEmptyState serverName={data.server.name} />
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 items-stretch gap-6 xl:grid-cols-3">
              <ServerTile live={live} generatedAt={data.generatedAt} />
              <ClaudeTile live={live} capacityMax={data.capacity.max} defaultModel={data.claude.defaultModel} />
              <div className="col-span-2 grid xl:col-span-1">
                <QuickResumeTile session={live.quickResume} hasProjects />
              </div>
            </div>
            <div className="grid grid-cols-2 items-stretch gap-6 xl:grid-cols-[minmax(0,8fr)_minmax(0,8fr)_minmax(0,11fr)]">
              <SessionsCards sessions={data.sessions} items={live.sessions} onRetry={live.refresh} />
              <div className="col-span-2 grid xl:col-span-1">
                <RecentProjectsTile projects={data.projects} />
              </div>
            </div>
            <div className="grid grid-cols-2 items-stretch gap-6 xl:grid-cols-3">
              <GitActivityTile activity={data.activity} onRetry={live.refresh} className="col-span-2" />
              <div className="col-span-2 grid xl:col-span-1">
                <IntegrationsTile integrations={data.integrations} onRetry={live.refresh} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- M01 · phone */}
      <div className="flex flex-col gap-5 nav:hidden">
        <StatusPills live={live} />
        {firstRun ? (
          <FirstProjectEmptyState serverName={data.server.name} />
        ) : (
          <>
            {live.pending[0] ? (
              <PendingRequestCard pending={live.pending[0]} others={new Set(live.pending.map((p) => p.sessionId)).size - 1} />
            ) : null}
            {live.quickResume ? <QuickResumeCard session={live.quickResume} /> : null}
            <SessionsRail sessions={data.sessions} items={live.sessions} count={live.activeCount} onRetry={live.refresh} />
            <RecentProjectsCard projects={data.projects} />
            <LatestChangesCard activity={data.activity} onRetry={live.refresh} />
          </>
        )}
      </div>
    </div>
  );
}
