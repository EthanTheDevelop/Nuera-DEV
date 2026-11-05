'use client';

import { useId, useState } from 'react';
import type { PermissionMode } from '@nuera/db/schema';
import { Icon } from '@/components/icons';
import { Sheet, SheetContent } from '@/components/ui';
import { useTheme } from '@/hooks/useTheme';
import { THEME_LABELS } from '@/lib/theme';
import { cn } from '@/lib/cn';
import {
  claudeBadge,
  CLI_DEFAULT,
  formatAvailability,
  MODEL_OTHER,
  modelLabel,
  modelOptions,
  permissionModeLong,
  permissionModeOptions,
  permissionModeShort,
  serverBadge,
  serviceRows,
} from '../lib/copy';
import { SECTION_IDS, type SettingsTab } from '../lib/tabs';
import { MobileGroup, MobileRow } from './parts';
import { PushSwitch, usePush, usePushDisabledReason } from './preferences';
import { LogsDrawer, StaleWorktreesDialog } from './server';
import { useSettings } from './SettingsContext';

/**
 * M08 — the phone overview: D08's tabs become overline groups on one scrolling page, dropdowns become
 * value rows opening a picker sheet, lists collapse into counts that drill down into the tab pages.
 */
export function MobileOverview({ onOpenTab }: { onOpenTab: (tab: SettingsTab, section?: string) => void }) {
  const { data, claude, settings, serverName, openStatus, now } = useSettings();
  const [picker, setPicker] = useState<'model' | 'mode' | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const push = usePush();
  const pushReason = usePushDisabledReason();
  const pushTitle = useId();
  const pushSwitchId = useId();
  const { theme } = useTheme();

  const account = data.account.ok ? data.account.data : null;
  const health = data.health.ok ? data.health.data : null;
  const unavailable = !data.health.ok && Boolean(data.health.error.unavailable);
  const services = serviceRows({
    health,
    live: data.liveSessions.ok ? data.liveSessions.data : null,
    webStartedAt: data.web.startedAt,
    now,
    runnerUnavailable: unavailable,
  });
  const stateSublabel = [
    `${services.length} services`,
    data.uptime.ok && data.uptime.data.availabilityPercent !== null ? `${formatAvailability(data.uptime.data.availabilityPercent)} sur 30 jours` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const stale = data.worktrees.ok ? data.worktrees.data.items.length : null;
  const claudeUnavailable = !claude && !data.claude.ok && data.claude.error.unavailable;

  return (
    <div className="flex flex-col gap-3">
      <MobileGroup label="Claude Code" footnote="Nuera Dev ne stocke aucun identifiant Claude et n'estime aucun coût.">
        <MobileRow
          icon="terminal"
          label="Compte Claude"
          sublabel="Connexion par le CLI officiel"
          badge={claudeBadge(claude, 'phone')}
          onClick={() => onOpenTab('claude-code')}
        />
        <MobileRow icon="reglages" label="Modèle par défaut" value={modelLabel(settings.defaultModel, data.seenModels)} onClick={() => setPicker('model')} />
        <MobileRow icon="shield" label="Mode de permission" value={permissionModeShort(settings.defaultPermissionMode)} onClick={() => setPicker('mode')} />
        <MobileRow
          icon="history"
          label="Utilisation"
          value="Ouvrir /status"
          onClick={openStatus}
          disabled={Boolean(claudeUnavailable)}
          sublabel={claudeUnavailable ? `${serverName} ne répond pas` : undefined}
        />
      </MobileGroup>

      <MobileGroup label="Sécurité">
        <MobileRow
          icon="lock"
          label="Double facteur"
          badge={account ? (account.twoFactor.enabled ? { tone: 'success', label: 'Actif' } : { tone: 'danger', label: 'Inactif' }) : null}
          onClick={() => onOpenTab('compte-et-securite', SECTION_IDS.twoFactor)}
        />
        <MobileRow icon="monitor" label="Accès ouverts" value={account ? String(account.sessions.length) : null} onClick={() => onOpenTab('compte-et-securite', SECTION_IDS.sessions)} />
        <MobileRow icon="history" label="Journal de sécurité" onClick={() => onOpenTab('compte-et-securite', SECTION_IDS.journal)} />
      </MobileGroup>

      <MobileGroup label={`Serveur ${serverName}`}>
        <MobileRow icon="server" label="État" sublabel={stateSublabel} badge={serverBadge(health, unavailable)} onClick={() => onOpenTab('serveur', SECTION_IDS.services)} />
        <MobileRow icon="book" label="Journaux" onClick={() => setLogsOpen(true)} />
        <MobileRow
          icon="trash"
          iconTone="danger"
          label="Nettoyer les worktrees inactifs"
          labelTone="danger"
          value={stale === null ? null : String(stale)}
          onClick={() => setCleanOpen(true)}
          disabled={stale === null || stale === 0}
          sublabel={stale === 0 ? 'aucun worktree inactif' : stale === null ? 'worktrees illisibles' : undefined}
        />
      </MobileGroup>

      <MobileGroup label="Préférences">
        <li className="[&:last-child>*]:border-b-0">
          <div className="flex min-h-[60px] w-full items-center gap-3 border-b border-border py-2">
            <Icon name="bell" size={20} className="shrink-0 text-accent" />
            {/* M08: the whole row toggles the switch (label of the switch). */}
            <label htmlFor={pushSwitchId} className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center gap-0.5">
              <span id={pushTitle} className="font-sans text-app-15 text-text">
                Notifications
              </span>
              <span className="font-sans text-app-12 text-muted">{pushReason ?? push.error ?? 'Autorisations et fins de session'}</span>
            </label>
            <PushSwitch id={pushSwitchId} labelledBy={pushTitle} />
          </div>
        </li>
        <MobileRow icon="reglages" label="Thème" value={THEME_LABELS[theme]} onClick={() => onOpenTab('preferences')} />
      </MobileGroup>

      <PickerSheet kind={picker} onClose={() => setPicker(null)} onCustomModel={() => onOpenTab('claude-code')} />
      <LogsDrawer open={logsOpen} onOpenChange={setLogsOpen} />
      {data.worktrees.ok ? <StaleWorktreesDialog open={cleanOpen} onOpenChange={setCleanOpen} initial={data.worktrees.data} /> : null}
    </div>
  );
}

function PickerSheet({ kind, onClose, onCustomModel }: { kind: 'model' | 'mode' | null; onClose: () => void; onCustomModel: () => void }) {
  const { settings, data, save, pending } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [forKind, setForKind] = useState(kind);
  if (forKind !== kind) {
    setForKind(kind);
    setError(null);
  }
  const options =
    kind === 'model'
      ? modelOptions(settings.defaultModel, data.seenModels)
      : kind === 'mode'
        ? permissionModeOptions(settings.blockBypassPermissions)
        : [];
  const current = kind === 'model' ? (settings.defaultModel ?? CLI_DEFAULT) : settings.defaultPermissionMode;

  async function choose(value: string) {
    if (kind === 'model') {
      if (value === MODEL_OTHER) {
        onClose();
        onCustomModel();
        return;
      }
      const next = value === CLI_DEFAULT ? null : value;
      if (next === settings.defaultModel) return onClose();
      setError(null);
      // The sheet stays open on failure: the phone overview has no other place for the error.
      if (await save({ defaultModel: next }, next ? `Modèle par défaut : ${next}` : 'Modèle par défaut : défaut du CLI')) onClose();
      else setError("Le modèle par défaut n'a pas pu être enregistré.");
    } else if (kind === 'mode') {
      const mode = value as PermissionMode;
      if (mode === settings.defaultPermissionMode) return onClose();
      setError(null);
      if (await save({ defaultPermissionMode: mode }, `Mode de permission par défaut : ${permissionModeLong(mode).toLowerCase()}`)) onClose();
      else setError("Le mode de permission n'a pas pu être enregistré.");
    }
  }
  const busy = pending.has('defaultModel') || pending.has('defaultPermissionMode');

  return (
    <Sheet open={kind !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent title={kind === 'model' ? 'Modèle par défaut' : 'Mode de permission'}>
        <ul role="radiogroup" aria-label={kind === 'model' ? 'Modèle par défaut' : 'Mode de permission'} className="m-0 flex list-none flex-col gap-1 p-0 pb-4">
          {options.map((option) => {
            const selected = option.value === current;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => void choose(option.value)}
                  className={cn('flex min-h-14 w-full items-center gap-3 rounded-md p-3 text-left', selected ? 'bg-accent-pale' : 'hover:bg-hover')}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn('font-sans text-app-15', selected ? 'font-semibold text-accent' : 'text-text')}>{option.label}</span>
                    {option.description ? <span className="font-sans text-app-12 text-muted">{option.description}</span> : null}
                  </span>
                  {selected ? <Icon name="check" size={18} className="shrink-0 text-accent" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {error ? (
          <p role="alert" className="m-0 pb-4 font-sans text-app-13 text-danger">
            {error}
          </p>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
