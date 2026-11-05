'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/shell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useLiveEvent } from '@/hooks/useLiveEvents';
import { cn } from '@/lib/cn';
import { DEFAULT_SETTINGS_TAB, parseSettingsTab, RECONNECT_ACTION, SECTION_IDS, SETTINGS_TABS, settingsTabLabel, type SettingsTab } from '../lib/tabs';
import type { SettingsPageData } from '../lib/types';
import { ClaudeTab, ClaudeTile } from './claude';
import { MobileOverview } from './mobile';
import { PreferencesTab, PreferencesTile, PushProvider } from './preferences';
import { SecurityTab, SecurityTile } from './security';
import { MaintenanceTile, ServerTab, ServerTile } from './server';
import { SettingsProvider, useSettings } from './SettingsContext';

/** Writes search params through the History API (no server round trip; `useSearchParams` follows). */
function writeUrl(update: Record<string, string | null>, mode: 'push' | 'replace', hash?: string | null): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (hash !== undefined) url.hash = hash ? `#${hash}` : '';
  const next = `${url.pathname}${url.search}${url.hash}`;
  // Radix may report the same tab twice: never stack identical history entries.
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (mode === 'push') window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

function scrollToSection(id: string | null | undefined) {
  if (!id) return;
  requestAnimationFrame(() => {
    const element = document.getElementById(id);
    if (!element) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  });
}

export function SettingsView({ data }: { data: SettingsPageData }) {
  return (
    <SettingsProvider data={data}>
      <PushProvider>
        <SettingsPage />
      </PushProvider>
    </SettingsProvider>
  );
}

function SettingsPage() {
  const params = useSearchParams();
  const tab = parseSettingsTab(params.get('onglet'));
  const { data, refresh, openLogin } = useSettings();
  const firstName = data.owner.name.trim().split(/\s+/)[0] ?? data.owner.name;

  useLiveEvent('claude.status', () => refresh());
  useLiveEvent('stream.reset', () => refresh());
  useLiveEvent('session.status', () => refresh());

  const setTab = useCallback((next: SettingsTab, section?: string) => {
    writeUrl({ onglet: next === DEFAULT_SETTINGS_TAB ? null : next, action: null }, 'push', section ?? null);
    if (section) scrollToSection(section);
    else window.scrollTo({ top: 0 });
  }, []);

  // T6 target: /parametres?onglet=claude-code&action=reconnexion opens the login terminal once.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (params.get('action') === RECONNECT_ACTION) {
      writeUrl({ action: null }, 'replace');
      openLogin();
    }
    if (window.location.hash) scrollToSection(decodeURIComponent(window.location.hash.slice(1)));
  }, [params, openLogin]);

  const isOverview = tab === DEFAULT_SETTINGS_TAB;

  return (
    <div className="flex min-w-0 flex-col gap-3 nav:gap-5">
      {/* Phone drill-down: back to the M08 list. */}
      {!isOverview ? (
        <div className="flex flex-col gap-2 nav:hidden">
          <button
            type="button"
            onClick={() => setTab(DEFAULT_SETTINGS_TAB)}
            className="-ml-1 flex min-h-11 items-center gap-0.5 self-start pr-2 pl-1 font-sans text-app-15 text-accent"
          >
            <Icon name="arrow-left" size={20} />
            Paramètres
          </button>
          <h1 className="m-0 font-sans text-app-26 font-semibold text-text">{settingsTabLabel(tab)}</h1>
        </div>
      ) : null}
      <PageHeader
        className={cn(!isOverview && 'hidden nav:flex')}
        title="Paramètres"
        subtitle={
          <>
            <span className="hidden nav:inline">Compte, sécurité, Claude Code et serveur. Un seul propriétaire, aucun autre compte.</span>
            <span className="nav:hidden">{`Un seul propriétaire : ${firstName}`}</span>
          </>
        }
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} activationMode="manual" className="flex flex-col gap-5">
        <TabsList aria-label="Sections des paramètres" className="hidden nav:flex">
          {SETTINGS_TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="vue-d-ensemble" tabIndex={-1}>
          <div className="hidden grid-cols-2 items-start gap-5 nav:grid">
            <div className="flex min-w-0 flex-col gap-5">
              <ClaudeTile />
              <SecurityTile
                onShowJournal={() => setTab('compte-et-securite', SECTION_IDS.journal)}
                onShowAccess={() => setTab('compte-et-securite', SECTION_IDS.sessions)}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <ServerTile />
              <MaintenanceTile />
              <PreferencesTile />
            </div>
          </div>
          <div className="nav:hidden">
            <MobileOverview onOpenTab={setTab} />
          </div>
        </TabsContent>
        <TabsContent value="compte-et-securite" tabIndex={-1}>
          <SecurityTab />
        </TabsContent>
        <TabsContent value="claude-code" tabIndex={-1}>
          <ClaudeTab />
        </TabsContent>
        <TabsContent value="serveur" tabIndex={-1}>
          <ServerTab />
        </TabsContent>
        <TabsContent value="preferences" tabIndex={-1}>
          <PreferencesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
