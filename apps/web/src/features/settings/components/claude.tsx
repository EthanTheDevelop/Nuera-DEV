'use client';

import { useId } from 'react';
import { LiveTime } from '@/components/dev';
import { Badge, Card, CompactButton, Field, KeyValueList, TileHeader } from '@/components/ui';
import { cn } from '@/lib/cn';
import { authMethodLabel, claudeBadge, claudeStateNote, formatSeconds, planLabel } from '../lib/copy';
import { DEFAULT_AUTO_RESUME_INSTRUCTION } from '@nuera/shared/runner';
import { BlockBypassSwitch, BooleanSwitch, EffortSelect, ModelSelect, NumberSetting, PermissionModeSelect, TextSetting } from './controls';
import { AdminSetNote, InlineError, NoServerNote, SettingsRow, SettingsRows, UnavailableNote } from './parts';
import { useSettings } from './SettingsContext';

/** Figma copy when the CLI is connected; « se connecte » otherwise (never claim a connection that is not there). */
const DESCRIPTION = (server: string, connected: boolean) =>
  `Le CLI officiel ${connected ? 'est connecté' : 'se connecte'} à votre compte Claude par sa propre procédure (claude /login), lancée dans un terminal de ${server}. Nuera Dev ne lit ni n'enregistre aucun identifiant.`;

function useRunnerReason(): string | null {
  const { data, claude, serverName } = useSettings();
  if (claude) return null;
  return data.claude.ok ? null : data.claude.error.unavailable ? `${serverName} ne répond pas : le terminal ne peut pas s'ouvrir.` : null;
}

/**
 * D08 `Tuile · Claude Code · compte Claude` (featured tile, 1.5 px accent border). The CLI is the one
 * of the server of the account's space (its own Claude login). Without a server: no CLI to show nor
 * to connect — the tile says so; the defaults of new sessions stay editable (space settings).
 */
export function ClaudeTile({ className }: { className?: string }) {
  const { claude, data, serverName, openLogin, openStatus, errorFor, canEdit, settings } = useSettings();
  const badge = serverName === null ? { tone: 'neutral' as const, label: 'Aucun serveur' } : claudeBadge(claude);
  const note = claude && serverName ? claudeStateNote(claude, serverName) : null;
  const modelId = useId();
  const modeId = useId();
  const guardTitle = useId();
  const guardCaption = useId();
  const unavailable = useRunnerReason();

  return (
    <Card as="section" aria-labelledby={`${modelId}-titre`} className={cn('gap-3 border-[1.5px] border-accent', className)}>
      <TileHeader
        icon="terminal"
        title={<span id={`${modelId}-titre`}>Claude Code · compte Claude</span>}
        action={<Badge tone={badge.tone}>{badge.label}</Badge>}
      />
      {serverName === null ? (
        <NoServerNote />
      ) : (
        <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{DESCRIPTION(serverName, claude?.state === 'connected')}</p>
      )}
      {note ? <p className="m-0 font-sans text-app-13 leading-[18px] text-warn">{note}</p> : null}
      {serverName !== null && !data.claude.ok && !claude ? (
        <UnavailableNote>
          {data.claude.error.unavailable
            ? `${serverName} ne répond pas : l'état du CLI n'a pas pu être lu.`
            : `État du CLI illisible : ${data.claude.error.message}`}
        </UnavailableNote>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Modèle par défaut" id={modelId}>
          <ModelSelect id={modelId} />
        </Field>
        <Field label="Mode de permission" id={modeId}>
          <PermissionModeSelect id={modeId} />
        </Field>
      </div>

      <SettingsRows>
        <SettingsRow
          titleId={guardTitle}
          title="Bloquer le mode sans autorisation"
          caption={<span id={guardCaption}>Le mode qui contourne toutes les demandes n'est jamais proposé dans Nuera Dev.</span>}
          control={<BlockBypassSwitch labelledBy={guardTitle} describedBy={guardCaption} />}
        >
          <InlineError>{errorFor('blockBypassPermissions')}</InlineError>
          {settings.forceBlockBypassPermissions || !canEdit('blockBypassPermissions') ? <AdminSetNote /> : null}
        </SettingsRow>
        {serverName !== null ? (
          <SettingsRow
            className="py-4"
            title="Utilisation et limites"
            caption="Celles qu'affiche le CLI : Nuera Dev n'estime ni coût, ni quota, ni jetons."
            control={
              <CompactButton variant="secondaire" icon="terminal" onClick={openStatus} disabled={Boolean(unavailable)} title={unavailable ?? undefined}>
                Ouvrir /status
              </CompactButton>
            }
          />
        ) : null}
      </SettingsRows>

      {serverName !== null ? (
        <div className="flex flex-col gap-1">
          <CompactButton
            variant={claude && claude.state !== 'connected' ? 'principal' : 'discret'}
            icon={claude && claude.state !== 'connected' ? 'terminal' : 'refresh'}
            onClick={openLogin}
            disabled={Boolean(unavailable)}
            className="self-start"
          >
            Se reconnecter dans un terminal
          </CompactButton>
          {unavailable ? <p className="m-0 font-sans text-app-12 text-muted">{unavailable}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

/** Claude Code tab: the D08 tile, what the CLI reports, and the defaults of new sessions. */
export function ClaudeTab() {
  const { claude, data, refreshClaude, refreshingClaude, claudeRefreshError, serverName, settings } = useSettings();
  const remoteTitle = useId();
  const remoteCaption = useId();
  const resumeTitle = useId();
  const resumeCaption = useId();
  const effortId = useId();
  const plan = claude ? planLabel(claude.subscriptionType) : null;

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <ClaudeTile />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Card as="section" aria-label="État du CLI" className="gap-3">
          <TileHeader
            icon="monitor"
            title="État du CLI"
            action={
              serverName !== null ? (
                <CompactButton variant="secondaire" icon="refresh" onClick={() => void refreshClaude()} loading={refreshingClaude}>
                  Actualiser
                </CompactButton>
              ) : null
            }
          />
          {serverName === null ? (
            <NoServerNote />
          ) : claude ? (
            <>
              <KeyValueList
                items={[
                  { label: 'Installé', value: claude.installed ? `oui · claude ${claude.version ?? 'version inconnue'}` : 'non', mono: true },
                  { label: 'Connecté', value: claude.loggedIn === null ? 'inconnu' : claude.loggedIn ? 'oui' : 'non', mono: false },
                  { label: 'Méthode de connexion', value: authMethodLabel(claude.authMethod), mono: false },
                  { label: 'Formule', value: plan ?? 'non indiquée par le CLI', mono: false },
                  ...(claude.loginExpiresAt
                    ? [{ label: "Connexion valable jusqu'au", value: <LiveTime value={claude.loginExpiresAt} format="datetime" />, mono: false }]
                    : []),
                  { label: 'Vérifié', value: <LiveTime value={claude.checkedAt} format="relative" />, mono: false },
                ]}
              />
              <p className="m-0 font-sans text-app-12 text-muted">
                Valeurs lues dans claude auth status sur {serverName}. Le compte, l'utilisation et les limites détaillées
                s'affichent avec /status, tels que le CLI les donne.
              </p>
            </>
          ) : (
            <UnavailableNote>
              {!data.claude.ok && data.claude.error.unavailable
                ? `${serverName} ne répond pas : l'état du CLI n'a pas pu être lu.`
                : "L'état du CLI n'a pas pu être lu."}
            </UnavailableNote>
          )}
          <InlineError>{claudeRefreshError}</InlineError>
        </Card>

        <Card as="section" aria-label="Nouvelles sessions" className="gap-3">
          <TileHeader icon="reglages" title="Nouvelles sessions" />
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
            Valeurs proposées dans « Nouvelle session ». Une session en cours garde les siennes.
          </p>
          <Field label="Effort par défaut" id={effortId}>
            <EffortSelect id={effortId} />
          </Field>
          <NumberSetting
            field="permissionWaitSeconds"
            label="Délai de réponse aux autorisations"
            hint={`Temps laissé pour répondre depuis Nuera Dev avant que la demande ne passe dans le terminal du CLI (actuellement ${formatSeconds(settings.permissionWaitSeconds)}).`}
            unit="s"
            min={10}
            max={1800}
            successMessage={(value) => `Délai de réponse : ${formatSeconds(value ?? 0)}`}
          />
          <SettingsRows>
            <SettingsRow
              titleId={remoteTitle}
              title="Remote Control par défaut"
              caption={<span id={remoteCaption}>Ouvre la session dans l'application Claude (claude --remote-control) en plus de Nuera Dev.</span>}
              control={
                <BooleanSwitch
                  field="remoteControlByDefault"
                  labelledBy={remoteTitle}
                  describedBy={remoteCaption}
                  onMessage="Remote Control activé par défaut"
                  offMessage="Remote Control désactivé par défaut"
                />
              }
            />
            <SettingsRow
              titleId={resumeTitle}
              title="Reprise automatique après la limite d'utilisation"
              caption={
                <span id={resumeCaption}>
                  Quand le CLI s'arrête sur la limite de votre abonnement, la session reprend 2 min après l'heure de levée qu'il annonce. Chaque session peut changer ce choix.
                </span>
              }
              control={
                <BooleanSwitch
                  field="autoResumeAfterLimit"
                  labelledBy={resumeTitle}
                  describedBy={resumeCaption}
                  onMessage="Reprise automatique activée par défaut"
                  offMessage="Reprise automatique désactivée par défaut"
                />
              }
            />
          </SettingsRows>
          <TextSetting
            field="autoResumeInstruction"
            label="Instruction de reprise"
            hint="Tapée dans la session quand elle reprend après la limite."
            maxLength={2000}
            nullable
            placeholder={DEFAULT_AUTO_RESUME_INSTRUCTION}
            successMessage={(value) => (value ? 'Instruction de reprise enregistrée' : "Instruction de reprise : « Continue là où tu t'es arrêté. »")}
          />
        </Card>
      </div>
    </div>
  );
}
