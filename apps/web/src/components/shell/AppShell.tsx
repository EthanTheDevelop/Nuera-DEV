'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { useToastOffset } from '@/components/ui/Toast';
import { LiveEventsProvider, useLiveEvents } from '@/hooks/useLiveEvents';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import { CommandPalette, CommandRegistryProvider, useCommandPaletteShortcut } from './CommandPalette';
import { ClaudeDisconnected, ConnectionLostBanner, Delayed, ServerUnavailable, ServerUnavailableBanner } from './GlobalStates';
import { CLAUDE_RECONNECT_HREF, hidesTabBar, isRunnerIndependentPage } from './nav-items';
import { ShellDataProvider, useCommandPaletteControl, useShellData } from './ShellContext';
import { Sidebar } from './Sidebar';
import { SidebarRail } from './SidebarRail';
import { TabBar } from './TabBar';
import type { ShellData } from './types';

export interface AppShellProps {
  data: ShellData;
  /**
   * `sidebar` = pages of the (shell) group: 248 px sidebar on desktop, tab bar on the phone, page padding.
   * `rail` = the Workspace: 72 px rail on desktop, no tab bar, no padding (the session takes the room).
   */
  variant: 'sidebar' | 'rail';
  /**
   * Global providers that render no page content (GlobalSearch: palette groups + its dialog). Mounted
   * outside the T5 gate, so they stay registered while `ServerUnavailable` replaces the content.
   */
  globals?: ReactNode;
  children: ReactNode;
}

/** Tab bar height (1 px border + 56 px row) — the bottom safe area is added on top of it. */
const TABBAR_PX = 57;

/**
 * Client root of the authenticated app: live events (one EventSource, multi-tab identity guard),
 * command palette (⌘K), shell data, navigation (Sidebar / SidebarRail / TabBar, « Administration » for
 * the owner and administrators) and the global states:
 *  - T5 `ServerUnavailable` replaces the content while the runner of the account's server does not
 *    answer (navigation kept) — except on the pages that do not need it (Administration, Paramètres ›
 *    Compte et sécurité and Préférences, and Paramètres' default tab that leads to them), which keep
 *    their content under a T5 banner;
 *  - no server assigned: never T5 nor T6 (the server card says « Aucun serveur attribué »; pages that
 *    need a runner render `NoServerAssigned`);
 *  - T6 banner while the Claude CLI is not connected (sidebar variant);
 *  - W7-style banner while the browser cannot reach the web app (sidebar variant; the Workspace
 *    shows its own inline W7 banner with `ConnectionLostBanner context="workspace"`).
 * Pages can rely on `--shell-bottom` (space taken by the tab bar) for their sticky bottom bars.
 */
export function AppShell({ data, variant, globals, children }: AppShellProps) {
  return (
    <ShellDataProvider data={data}>
      <LiveEventsProvider initial={data}>
        <CommandRegistryProvider>
          <TooltipProvider delayDuration={300}>
            <ShellFrame variant={variant} globals={globals}>
              {children}
            </ShellFrame>
          </TooltipProvider>
        </CommandRegistryProvider>
      </LiveEventsProvider>
    </ShellDataProvider>
  );
}

const COLLAPSE_KEY = 'nuera.shell.collapsed.';

/**
 * Desktop: the logo folds the 248 px bar into the 72 px rail and back. Remembered per layout
 * (the pages and the Workspace each keep their own choice) by the browser; default = the layout's own.
 */
function useCollapsedNav(variant: 'sidebar' | 'rail') {
  const [collapsed, setCollapsed] = useState(variant === 'rail');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSE_KEY + variant);
      // eslint-disable-next-line react/set-state-in-effect -- the stored choice is only readable after mount (SSR renders the default)
      if (stored === '1' || stored === '0') setCollapsed(stored === '1');
    } catch {
      // storage blocked: keep the layout's default
    }
  }, [variant]);
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY + variant, next ? '1' : '0');
      } catch {
        // storage blocked: the choice lasts for this page only
      }
      return next;
    });
  }, [variant]);
  return { collapsed, toggle };
}

function ShellFrame({ variant, globals, children }: { variant: AppShellProps['variant']; globals?: ReactNode; children: ReactNode }) {
  const data = useShellData();
  const live = useLiveEvents();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const desktop = useIsDesktopNav();
  const palette = useCommandPaletteControl();
  const [retrying, setRetrying] = useState(false);
  const nav = useCollapsedNav(variant);

  const { open: paletteOpen, setOpen: setPaletteOpen } = palette;
  const togglePalette = useCallback(() => setPaletteOpen(!paletteOpen), [paletteOpen, setPaletteOpen]);
  useCommandPaletteShortcut(togglePalette);

  const showTabBar = variant === 'sidebar' && !hidesTabBar(pathname);
  useToastOffset(showTabBar && !desktop ? TABBAR_PX + 16 : null);

  const hasServer = data.environment !== null;
  const unavailable = hasServer && live.runner === 'unavailable';
  // T5 never takes the pages that do not need the runner (an administrator must reach the console).
  const replaceByT5 = unavailable && !isRunnerIndependentPage(pathname, searchParams.get('onglet'));
  useEffect(() => {
    if (!retrying) return;
    const done = setTimeout(() => setRetrying(false), unavailable ? 4_000 : 0);
    return () => clearTimeout(done);
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- each reconnection attempt restarts the « retrying » timer
  }, [retrying, unavailable, live.attempt]);

  // Reconnects the stream now: when the runner answers again, the live provider re-reads the snapshot
  // (router.refresh) — no blind refresh here, it would turn into a full navigation without network.
  const retry = () => {
    setRetrying(true);
    live.retryNow();
  };

  const claudeState = live.claude.state;
  const claudeProblem =
    hasServer && !unavailable && (claudeState === 'disconnected' || claudeState === 'wrong_method' || claudeState === 'not_installed')
      ? claudeState
      : null;

  const activeSessions = live.activeSessionIds.length;
  const location = data.server.location;
  const provider = location ? (location.split(/\s+/)[0] ?? null) : null;

  const style = {
    '--shell-bottom': showTabBar ? `calc(${TABBAR_PX}px + env(safe-area-inset-bottom))` : '0px',
  } as CSSProperties;

  return (
    <div className="flex min-h-dvh bg-surface-raised" style={style} data-shell={variant}>
      <a
        href="#contenu"
        className="fixed top-4 left-4 z-[80] -translate-y-[200%] rounded-md bg-bg px-4 py-2 font-sans text-app-14 font-semibold text-text shadow-float focus-visible:translate-y-0"
      >
        Aller au contenu
      </a>

      {!nav.collapsed ? (
        <Sidebar
          className="hidden nav:flex"
          onToggleCollapse={nav.toggle}
          activeSessions={activeSessions}
          serverUnavailable={unavailable}
          onOpenSearch={() => palette.setOpen(true)}
          user={{ name: data.user.name, role: data.user.role, twoFactorEnabled: data.user.twoFactorEnabled }}
          server={{
            name: hasServer ? data.server.name : null,
            location,
            availability: live.runner,
            metrics: live.metrics,
            claudeState,
            lastContactAt: live.lastRunnerContactAt,
          }}
        />
      ) : (
        <SidebarRail className="hidden nav:flex" userName={data.user.name} role={data.user.role} serverUnavailable={unavailable} onToggleCollapse={nav.toggle} />
      )}

      <main
        id="contenu"
        tabIndex={-1}
        className={cn(
          'flex min-w-0 flex-1 flex-col outline-none',
          variant === 'sidebar' &&
            'gap-6 px-4 pt-[calc(8px+env(safe-area-inset-top))] pb-[calc(24px+var(--shell-bottom))] nav:px-8 nav:pt-7 nav:pb-7',
          variant === 'rail' && 'min-h-dvh',
        )}
      >
        {replaceByT5 ? (
          <div className={cn('flex flex-1 items-start justify-center', variant === 'rail' && 'flex-col items-stretch justify-start px-4 pt-[calc(8px+env(safe-area-inset-top))] pb-7 nav:flex-row nav:items-start nav:justify-center nav:px-8 nav:py-7')}>
            {variant === 'rail' ? (
              // T5 « sans masquer la navigation »: the phone Workspace has neither rail nor tab bar, so its
              // session header is the only way out — keep a back link while the card replaces it.
              <Link href="/sessions" className="nu-hit mb-2 inline-flex h-11 items-center gap-1 self-start font-sans text-app-15 font-medium text-accent nav:hidden">
                <Icon name="arrow-left" size={18} />
                Sessions
              </Link>
            ) : null}
            <ServerUnavailable
              serverName={data.server.name}
              lastContactAt={live.lastRunnerContactAt}
              statusUrl={data.server.statusUrl}
              providerName={provider}
              onRetry={retry}
              retrying={retrying}
              className="mt-0 nav:mt-10"
            />
          </div>
        ) : (
          <>
            {unavailable ? (
              <ServerUnavailableBanner serverName={data.server.name} lastContactAt={live.lastRunnerContactAt} onRetry={retry} retrying={retrying} />
            ) : null}
            {variant === 'sidebar' ? (
              <>
                <Delayed active={live.connection === 'reconnecting'}>
                  <ConnectionLostBanner nextRetryAt={live.nextRetryAt} onRetry={live.retryNow} context="page" />
                </Delayed>
                {claudeProblem ? <ClaudeDisconnected state={claudeProblem} reconnectHref={CLAUDE_RECONNECT_HREF} variant="banner" /> : null}
              </>
            ) : null}
            {children}
          </>
        )}
      </main>

      {showTabBar ? <TabBar className="nav:hidden" activeSessions={activeSessions} serverUnavailable={unavailable} /> : null}

      {globals}
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
    </div>
  );
}
