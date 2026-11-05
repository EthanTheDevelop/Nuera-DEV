'use client';

import { createContext, useContext, useId, type ReactNode } from 'react';
import { formatShortDate } from '@nuera/shared/format';
import { Card, CompactButton, EmptyState, Select, Switch, TileHeader, toast } from '@/components/ui';
import { useTheme } from '@/hooks/useTheme';
import { THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';
import { relativeLong } from '../lib/copy';
import { InlineError, SettingsRow, SettingsRows } from './parts';
import { useSettings } from './SettingsContext';
import { usePushSubscription, type PushState } from './usePushSubscription';

const PushContext = createContext<PushState | null>(null);

export function PushProvider({ children }: { children: ReactNode }) {
  const { data } = useSettings();
  const push = data.push.ok ? data.push.data : null;
  const state = usePushSubscription({ enabled: push?.enabled ?? false, publicKey: push?.publicKey ?? null, initialDevices: push?.devices ?? [] });
  return <PushContext.Provider value={state}>{children}</PushContext.Provider>;
}

export function usePush(): PushState {
  const value = useContext(PushContext);
  if (!value) throw new Error('usePush() hors de <PushProvider>');
  return value;
}

/** Why the switch cannot be used here (VAPID missing on the server, browser support, permission). */
export function usePushDisabledReason(): string | null {
  const { data } = useSettings();
  const push = usePush();
  if (!data.push.ok) return `État des notifications illisible : ${data.push.error.message}`;
  if (!data.push.data.enabled) return data.push.data.reason ?? 'Notifications push indisponibles sur le serveur.';
  if (push.support.kind === 'unsupported' || push.support.kind === 'denied') return push.support.reason;
  return null;
}

/** « ce téléphone » on a phone, « cette tablette », else « cet appareil » (the switch is per device). */
export function useThisDevice(): string {
  const { data } = useSettings();
  const kind = data.account.ok ? data.account.data.sessions.find((session) => session.current)?.deviceKind : undefined;
  return kind === 'phone' ? 'ce téléphone' : kind === 'tablet' ? 'cette tablette' : 'cet appareil';
}

export function PushSwitch({ labelledBy, describedBy }: { labelledBy: string; describedBy?: string }) {
  const push = usePush();
  const reason = usePushDisabledReason();
  const device = useThisDevice();
  return (
    <Switch
      checked={push.subscribed}
      disabled={Boolean(reason) || push.busy || push.support.kind === 'checking'}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCheckedChange={async (checked) => {
        const ok = checked ? await push.enable() : await push.disable();
        if (ok) toast({ message: checked ? `Notifications activées sur ${device}` : `Notifications désactivées sur ${device}` });
      }}
    />
  );
}

function ThemeSelect({ id }: { id?: string }) {
  const { theme, setTheme, pending, error } = useTheme();
  return (
    <span className="flex flex-col items-end gap-1">
      <Select
        id={id}
        className="w-[140px]"
        options={THEME_PREFERENCES.map((value) => ({ value, label: THEME_LABELS[value] }))}
        value={theme}
        disabled={pending}
        aria-label="Thème"
        onValueChange={(value) => {
          if (value === theme) return;
          setTheme(value as ThemePreference);
          toast({ message: `Thème : ${THEME_LABELS[value as ThemePreference].toLowerCase()}` });
        }}
      />
      <InlineError>{error}</InlineError>
    </span>
  );
}

/** D08 `Tuile · Préférences`. */
export function PreferencesTile() {
  const push = usePush();
  const reason = usePushDisabledReason();
  const device = useThisDevice();
  const pushTitle = useId();
  const pushCaption = useId();
  const themeId = useId();
  return (
    <Card as="section" aria-label="Préférences" className="gap-1">
      <TileHeader icon="bell" title="Préférences" className="mb-2" />
      <SettingsRows>
        <SettingsRow
          titleId={pushTitle}
          title={`Notifications sur ${device}`}
          caption={<span id={pushCaption}>Quand Claude demande une autorisation ou termine une session</span>}
          control={<PushSwitch labelledBy={pushTitle} describedBy={pushCaption} />}
        >
          {reason ? <p className="m-0 font-sans text-app-12 text-muted">{reason}</p> : null}
          <InlineError>{push.error}</InlineError>
        </SettingsRow>
        <SettingsRow title="Thème" caption="Suit les modes clair et sombre du système de design" control={<ThemeSelect id={themeId} />} />
        <SettingsRow
          title="Langue"
          caption="Interface en français"
          control={<Select className="w-[140px]" options={[{ value: 'fr', label: 'Français' }]} value="fr" aria-label="Langue" />}
        />
      </SettingsRows>
    </Card>
  );
}

/** Préférences tab: the D08 tile, the devices that receive notifications, the test notification. */
export function PreferencesTab() {
  const { now, data } = useSettings();
  const push = usePush();
  const reason = usePushDisabledReason();
  const serverDisabled = !data.push.ok || !data.push.data.enabled;
  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <PreferencesTile />
      <Card as="section" aria-label="Appareils notifiés" className="gap-1">
        <TileHeader icon="smartphone" title="Appareils notifiés" className="mb-2" />
        {push.devices.length === 0 ? (
          <EmptyState variant="plain" icon="bell" title="Aucun appareil">
            Activez les notifications sur un téléphone ou un ordinateur pour être prévenu quand une session attend votre accord.
          </EmptyState>
        ) : (
          <SettingsRows label="Appareils notifiés">
            {push.devices.map((device) => (
              <SettingsRow
                key={device.id}
                icon="bell"
                title={device.deviceLabel ?? 'Appareil sans nom'}
                caption={[
                  device.service,
                  `ajouté le ${formatShortDate(device.createdAt, now)}`,
                  device.lastUsedAt ? `dernier envoi ${relativeLong(device.lastUsedAt, now)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                control={
                  <CompactButton
                    variant="discret"
                    aria-label={`Retirer ${device.deviceLabel ?? 'cet appareil'}`}
                    onClick={async () => {
                      if (await push.removeDevice(device.id)) toast({ message: `Appareil retiré : ${device.deviceLabel ?? 'sans nom'}` });
                    }}
                  >
                    Retirer
                  </CompactButton>
                }
              />
            ))}
          </SettingsRows>
        )}
        <div className="flex flex-col gap-1 pt-3">
          <CompactButton
            variant="secondaire"
            icon="send"
            className="self-start"
            disabled={serverDisabled || push.devices.length === 0}
            onClick={async () => {
              const result = await push.sendTest();
              if (result) toast({ message: result.sent === 1 ? 'Notification de test envoyée à 1 appareil' : `Notification de test envoyée à ${result.sent} appareils` });
            }}
          >
            Envoyer une notification de test
          </CompactButton>
          {serverDisabled ? (
            <p className="m-0 font-sans text-app-12 text-muted">{reason}</p>
          ) : push.devices.length === 0 ? (
            <p className="m-0 font-sans text-app-12 text-muted">Aucun appareil abonné pour le moment.</p>
          ) : null}
          <InlineError>{push.error}</InlineError>
        </div>
      </Card>
    </div>
  );
}
