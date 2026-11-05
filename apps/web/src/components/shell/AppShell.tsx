'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { useToastOffset } from '@/components/ui/Toast';
import { LiveEventsProvider, useLiveEvents } from '@/hooks/useLiveEvents';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import { CommandPalette, CommandRegistryProvider, useCommandPaletteShortcut } from './CommandPalette';
import { ClaudeDisconnected, ConnectionLostBanner, Delayed, ServerUnavailable } from './GlobalStates';
import { CLAUDE_RECONNECT_HREF, hidesTabBar } from './nav-items';
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
  children: ReactNode;
}

/** Tab bar height (1 px border + 56 px row) — the bottom safe area is added on top of it. */
const TABBAR_PX = 57;

/**
 * Client root of the authenticated app: live events (one EventSource), command palette (⌘K), shell
 * data, navigation (Sidebar / SidebarRail / TabBar) and the global states:
 *  - T5 `ServerUnavailable` replaces the content while the runner does not answer (navigation kept);
 *  - T6 banner while the Claude CLI is not connected (sidebar variant);
 *  - W7-style banner while the browser cannot reach the web app (sidebar variant; the Workspace
 *    shows its own inline W7 banner with `ConnectionLostBanner context="workspace"`).
 * Pages can rely on `--shell-bottom` (space taken by the tab bar) for their sticky bottom bars.
 */
export function AppShell({ data, variant, children }: AppShellProps) {
  return (
    <ShellDataProvider data={data}>
      <LiveEventsProvider initial={data}>
        <CommandRegistryProvider>
          <TooltipProvider delayDuration={300}>
            <ShellFrame variant={variant}>{children}</ShellFrame>
          </TooltipProvider>
        </CommandRegistryProvider>
      </LiveEventsProvider>
    </ShellDataProvider>
  );
}

function ShellFrame({ variant, children }: { variant: AppShellProps['variant']; children: ReactNode }) {
  const data = useShellData();
  const live = useLiveEvents();
  const pathname = usePathname();
  const desktop = useIsDesktopNav();
  const palette = useCommandPaletteControl();
  const [retrying, setRetrying] = useState(false);

  const { open: paletteOpen, setOpen: setPaletteOpen } = palette;
  const togglePalette = useCallback(() => setPaletteOpen(!paletteOpen), [paletteOpen, setPaletteOpen]);
  useCommandPaletteShortcut(togglePalette);

  const showTabBar = variant === 'sidebar' && !hidesTabBar(pathname);
  useToastOffset(showTabBar && !desktop ? TABBAR_PX + 16 : null);

  const unavailable = live.runner === 'unavailable';
  useEffect(() => {
    if (!retrying) return;
    const done = setTimeout(() => setRetrying(false), unavailable ? 4_000 : 0);
    return () => clearTimeout(done);
  }, [retrying, unavailable, live.attempt]);

  // Reconnects the stream now: when the runner answers again, the live provider re-reads the snapshot
  // (router.refresh) — no blind refresh here, it would turn into a full navigation without network.
  const retry = () => {
    setRetrying(true);
    live.retryNow();
  };

  const claudeState = live.claude.state;
  const claudeProblem =
    !unavailable && (claudeState === 'disconnected' || claudeState === 'wrong_method' || claudeState === 'not_installed')
      ? claudeState
      : null;

  const activeSessions = live.activeSessionIds.length;
  const location = data.server.location;
  const provider = location ? (location.split(/\s+/)[0] ?? null) : null;

  const style = {
    '--shell-bottom': showTabBar ? `calc(${TABBAR_PX}px + env(safe-area-inset-bottom))` : '0px',
  } as CSSProperties;

  return (
    <div className="flex min-h-dvh bg-surface-raised" style={style}>
      <a
        href="#contenu"
        className="fixed top-4 left-4 z-[80] -translate-y-[200%] rounded-md bg-bg px-4 py-2 font-sans text-app-14 font-semibold text-text shadow-float focus-visible:translate-y-0"
      >
        Aller au contenu
      </a>

      {variant === 'sidebar' ? (
        <Sidebar
          className="hidden nav:flex"
          activeSessions={activeSessions}
          serverUnavailable={unavailable}
          onOpenSearch={() => palette.setOpen(true)}
          user={{ name: data.user.name, twoFactorEnabled: data.user.twoFactorEnabled }}
          server={{
            name: data.server.name,
            location,
            availability: live.runner,
            metrics: live.metrics,
            claudeState,
            lastContactAt: live.lastRunnerContactAt,
          }}
        />
      ) : (
        <SidebarRail className="hidden nav:flex" userName={data.user.name} serverUnavailable={unavailable} />
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
        {unavailable ? (
          <div className={cn('flex flex-1 items-start justify-center', variant === 'rail' && 'px-4 py-7 nav:px-8')}>
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

      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
    </div>
  );
}
