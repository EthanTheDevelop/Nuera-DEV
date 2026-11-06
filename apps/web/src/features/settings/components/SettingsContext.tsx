'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { claudeLoginTerminal, claudeStatusTerminal, useTerminalLauncher, type TerminalLauncher } from '@/components/terminal';
import { toast } from '@/components/ui';
import { useNow } from '@/hooks/useNow';
import { loadLiveStatusAction, refreshClaudeStatusAction, updateSettingsAction } from '../actions';
import type { ClaudeCliView, LiveStatusView, SettingKey, SettingsPageData, SettingsValues } from '../lib/types';

/**
 * Shared state of Paramètres: the server snapshot, an optimistic copy of the settings (save on
 * change + T3 toast, reverted with an inline error on failure), what this account may change
 * (`canEdit`: false → read-only « Réglé par un administrateur »), the clock for relative times, the
 * terminal window (claude auth login, /status, on the server of the account's space) and a
 * throttled refresh.
 */

export interface SettingsContextValue {
  data: SettingsPageData;
  settings: SettingsValues;
  save: (patch: Partial<Omit<SettingsValues, 'editable' | 'updatedAt'>>, successMessage: string) => Promise<boolean>;
  pending: ReadonlySet<SettingKey>;
  errorFor: (key: SettingKey) => string | null;
  /** This account may change `key` (its scope and role allow it). */
  canEdit: (key: SettingKey) => boolean;
  now: number;
  /** Server of the account's space (« VPS-3 »); null while none is assigned. */
  serverName: string | null;
  terminal: TerminalLauncher;
  claude: ClaudeCliView | null;
  openLogin: () => void;
  openStatus: () => void;
  refreshClaude: () => Promise<void>;
  refreshingClaude: boolean;
  /** Last « Actualiser » / « Vérifier » failure (French), null after a successful read. */
  claudeRefreshError: string | null;
  refresh: () => void;
  /** Re-reads only the sections that follow the session statuses (no page refresh). */
  refreshLive: () => void;
}

const Context = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useSettings() hors de <SettingsProvider>');
  return value;
}

export function SettingsProvider({ data: snapshotData, children }: { data: SettingsPageData; children: ReactNode }) {
  const router = useRouter();
  // Live sections re-read after a session status change, until the next server snapshot replaces them.
  const [live, setLive] = useState<{ snapshot: SettingsPageData; view: LiveStatusView } | null>(null);
  const data = useMemo(
    () => (live && live.snapshot === snapshotData ? { ...snapshotData, ...live.view } : snapshotData),
    [live, snapshotData],
  );
  const serverName = data.environment?.name ?? null;
  const now = useNow(30_000, Date.parse(data.now));
  const terminal = useTerminalLauncher();

  // Optimistic settings, replaced by every new server snapshot.
  const [settings, setSettings] = useState(data.settings);
  const [snapshot, setSnapshot] = useState(data.settings);
  if (snapshot !== data.settings) {
    setSnapshot(data.settings);
    setSettings(data.settings);
  }
  const [pending, setPending] = useState<Set<SettingKey>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});

  const lastRefresh = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (refreshTimer.current) return;
    const wait = Math.max(0, lastRefresh.current + 1500 - Date.now());
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      lastRefresh.current = Date.now();
      router.refresh();
    }, wait);
  }, [router]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const snapshotRef = useRef(snapshotData);
  useEffect(() => {
    snapshotRef.current = snapshotData;
  }, [snapshotData]);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLive = useRef(0);
  const refreshLive = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (liveTimer.current) return;
    const wait = Math.max(0, lastLive.current + 1500 - Date.now());
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      lastLive.current = Date.now();
      const readFor = snapshotRef.current;
      void loadLiveStatusAction()
        .then((result) => {
          if (result.ok && snapshotRef.current === readFor) setLive({ snapshot: readFor, view: result.data });
        })
        .catch(() => undefined); // the server does not answer: the sections keep their last state
    }, wait);
  }, []);
  useEffect(() => () => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
  }, []);

  const save = useCallback(
    async (patch: Partial<Omit<SettingsValues, 'editable' | 'updatedAt'>>, successMessage: string) => {
      const keys = Object.keys(patch) as SettingKey[];
      const previous = settings;
      setSettings((current) => ({ ...current, ...patch }));
      setPending((current) => new Set([...current, ...keys]));
      setErrors((current) => {
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      });
      const result = await updateSettingsAction(patch as Record<string, unknown>);
      setPending((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!result.ok) {
        setSettings(previous);
        const message = result.error.detail ? `${result.error.message} ${result.error.detail}` : result.error.message;
        setErrors((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, message])) }));
        return false;
      }
      setSettings(result.data);
      toast({ message: successMessage });
      refresh();
      return true;
    },
    [settings, refresh],
  );

  const errorFor = useCallback((key: SettingKey) => errors[key] ?? null, [errors]);
  const canEdit = useCallback((key: SettingKey) => settings.editable[key] === true, [settings.editable]);

  const [claude, setClaude] = useState<ClaudeCliView | null>(data.claude.ok ? data.claude.data : null);
  const [claudeSnapshot, setClaudeSnapshot] = useState(data.claude);
  if (claudeSnapshot !== data.claude) {
    setClaudeSnapshot(data.claude);
    if (data.claude.ok) setClaude(data.claude.data);
  }
  const [refreshingClaude, setRefreshingClaude] = useState(false);
  const [claudeRefreshError, setClaudeRefreshError] = useState<string | null>(null);
  const refreshClaude = useCallback(async () => {
    setRefreshingClaude(true);
    const result = await refreshClaudeStatusAction().catch(() => null);
    setRefreshingClaude(false);
    if (result?.ok) {
      setClaude(result.data);
      setClaudeRefreshError(null);
    } else {
      setClaudeRefreshError(`L'état du CLI n'a pas pu être relu : ${result ? result.error.message : 'le serveur ne répond pas.'}`);
    }
    refresh();
  }, [refresh]);

  // No server: there is no CLI to log in (the buttons are not offered; this is a no-op guard).
  const openLogin = useCallback(() => {
    if (!serverName) return;
    terminal.open(claudeLoginTerminal({ serverName, onExit: () => void refreshClaude() }));
  }, [terminal, serverName, refreshClaude]);
  const openStatus = useCallback(() => {
    if (!serverName) return;
    terminal.open(claudeStatusTerminal({ serverName }));
  }, [terminal, serverName]);

  // The login window closed without the process exiting: re-read the CLI state anyway.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !terminal.isOpen && serverName) void refreshClaude();
    wasOpen.current = terminal.isOpen;
  }, [terminal.isOpen, refreshClaude, serverName]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      data,
      settings,
      save,
      pending,
      errorFor,
      canEdit,
      now,
      serverName,
      terminal,
      claude,
      openLogin,
      openStatus,
      refreshClaude,
      refreshingClaude,
      claudeRefreshError,
      refresh,
      refreshLive,
    }),
    [data, settings, save, pending, errorFor, canEdit, now, serverName, terminal, claude, openLogin, openStatus, refreshClaude, refreshingClaude, claudeRefreshError, refresh, refreshLive],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {terminal.dialog}
    </Context.Provider>
  );
}
