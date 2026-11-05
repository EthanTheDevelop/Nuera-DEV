'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { mcpStatusBadge } from '@/components/dev';
import { Icon, type IconName } from '@/components/icons';
import { useOptionalShellData } from '@/components/shell';
import { mcpLoginTerminal, useTerminalLauncher } from '@/components/terminal';
import {
  Badge,
  Banner,
  Button,
  CodeBlock,
  CompactButton,
  ConfirmDialog,
  EmptyState,
  ErrorPanel,
  Field,
  KeyValueList,
  SecretField,
  SectionLabel,
  Switch,
  toast,
} from '@/components/ui';
import { formatShortDate, formatTime, plural } from '@nuera/shared/format';
import { cn } from '@/lib/cn';
import { integrationsApi, toApiError, type IntegrationsApiError } from '../api';
import { CheckJournal } from '../journal/CheckJournal';
import { markIntegrationsStale } from '../refresh';
import {
  checkRaw,
  connectionValue,
  drawerMode,
  effectiveMcpStatus,
  iconOf,
  lastCallValue,
  lastTestLine,
  reconnectBanner,
  verificationValue,
  type ReconnectVia,
} from '../model';
import type { CoolifyReconnectResult, McpDetailContext, McpServerView } from '../types';
import { CoolifyReconnect, type CoolifyReconnectState } from './CoolifyReconnect';
import { useMcpServer } from './useMcpServer';

export interface McpDetailView {
  title: string;
  subtitle: string;
  icon: IconName;
  badge: ReactNode;
  body: ReactNode;
  footer: ReactNode;
}

function Section({ title, id, children, className }: { title: string; id: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn('flex flex-col', className)}>
      <SectionLabel as="h3" id={id} className="pb-1.5">
        {title}
      </SectionLabel>
      {children}
    </section>
  );
}

function writeJournalParam(open: boolean) {
  const url = new URL(window.location.href);
  if (open) url.searchParams.set('journal', '1');
  else url.searchParams.delete('journal');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Content of the MCP server drawer (D1 connected / D2 to reconnect) and of its full page: header
 * fields, body sections and footer actions, all from the server view (`getMcpServer`) and its
 * context (Coolify settings, GitHub App). `onClose` leaves the drawer (or the page).
 */
export function useMcpDetailView(initial: { server: McpServerView; context: McpDetailContext }, onClose: () => void): McpDetailView {
  const state = useMcpServer(initial);
  const { server, context } = state;
  const serverName = useOptionalShellData()?.server.name ?? 'VPS-3';
  const terminal = useTerminalLauncher();
  const params = useSearchParams();
  const baseId = useId();
  const [forceReconnect, setForceReconnect] = useState(false);
  const [journalOpen, setJournalOpen] = useState(params.get('journal') === '1');
  const journalRef = useRef<HTMLDivElement>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coolifyForm, setCoolifyForm] = useState<CoolifyReconnectState>({ pending: false, canSubmit: false });
  const [secret, setSecret] = useState('');
  const [secretPending, setSecretPending] = useState(false);
  const [secretError, setSecretError] = useState<IntegrationsApiError | null>(null);

  useEffect(() => {
    if (journalOpen && params.get('journal') === '1') journalRef.current?.scrollIntoView({ block: 'start' });
    // Only on mount: a deep link `?journal=1` opens and shows the journal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleJournal = () => {
    setJournalOpen((open) => {
      writeJournalParam(!open);
      return !open;
    });
  };

  const mode = forceReconnect ? reconnectModeOf(server) : drawerMode(server, context.coolify);
  const reconnecting = mode.kind === 'reconnect';
  const via: ReconnectVia | null = mode.kind === 'reconnect' ? mode.via : null;
  const badge = mcpStatusBadge(effectiveMcpStatus(server, context.coolify), 'long');
  const coolifyPreset = server.preset === 'coolify';
  const formId = `${baseId}-reconnect`;

  const openLogin = useCallback(() => {
    terminal.open(
      mcpLoginTerminal(
        { name: server.name, label: server.label },
        {
          serverName,
          onExit: () => {
            const verify = async () => {
              const result = await state.test({ successMessage: `${server.label} reconnecté` });
              if (result?.status === 'connected') setForceReconnect(false);
            };
            void verify();
          },
        },
      ),
    );
  }, [terminal, server.name, server.label, serverName, state]);

  const githubTarget = context.github.action?.url ?? context.github.manageAccessUrl ?? context.github.installUrl;
  const openGithub = () => {
    if (!githubTarget) return;
    if (/^https?:/i.test(githubTarget)) window.open(githubTarget, '_blank', 'noopener,noreferrer');
    else window.location.assign(githubTarget);
  };

  const onCoolifyReconnected = (result: CoolifyReconnectResult) => {
    state.setContext((current) => ({ ...current, coolify: result.settings }));
    setForceReconnect(false);
    // The page behind re-reads its data (banner, card) as soon as the drawer is closed.
    markIntegrationsStale();
    onClose();
  };

  const submitSecret = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret.trim() || secretPending) return;
    setSecretPending(true);
    setSecretError(null);
    try {
      const headerKey = server.secretKeys.find((key) => key.toLowerCase() !== 'authorization');
      const body = server.authKind === 'bearer' || !headerKey ? { bearerToken: secret.trim() } : { headers: { [headerKey]: secret } };
      state.replace(await integrationsApi.replaceMcpSecret(server.name, body));
      setSecret('');
      const result = await state.test({ successMessage: `${server.label} reconnecté` });
      if (result?.status === 'connected') setForceReconnect(false);
      else if (!result) toast({ message: 'Secret remplacé' });
    } catch (error) {
      setSecretError(toApiError(error));
    } finally {
      setSecretPending(false);
    }
  };

  // ---------------------------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------------------------

  const testFailure = state.testFailure ? (
    'server' in state.testFailure ? (
      <ErrorPanel
        title={`Test de connexion : ${mcpStatusBadge(state.testFailure.server.status, 'long').label}`}
        excerpt={state.testFailure.server.lastError ?? state.testFailure.server.lastCheck?.result.reason}
        untouched="Aucun réglage n'a été modifié : les projets gardent leur activation."
        raw={checkRaw(state.testFailure.server.lastCheck)}
        onRetry={() => void state.test()}
        retryLabel="Tester à nouveau"
        retrying={state.testing}
      />
    ) : (
      <ErrorPanel
        title="Le test de connexion n'a pas pu être lancé"
        excerpt={[state.testFailure.error.message, state.testFailure.error.detail].filter(Boolean).join(' · ')}
        untouched="Aucun réglage n'a été modifié."
        raw={state.testFailure.error.raw}
        onRetry={() => void state.test()}
        retryLabel="Réessayer"
        retrying={state.testing}
      />
    )
  ) : null;

  // Not rendered while closed: an empty block would add a gap of the body's column.
  const journal = journalOpen ? (
    <div ref={journalRef} className="flex flex-col gap-2">
      <Section title="Journal" id={`${baseId}-journal`}>
        <CheckJournal last={server.lastCheck} history={server.history} />
      </Section>
    </div>
  ) : null;

  const journalToggle = (
    <CompactButton variant="discret" onClick={toggleJournal} aria-expanded={journalOpen}>
      {journalOpen ? 'Masquer le journal' : 'Voir le journal'}
    </CompactButton>
  );

  const projects = (
    <Section title="Activé dans" id={`${baseId}-projects`}>
      {server.projects.length === 0 ? (
        <EmptyState icon="projets" title="Aucun projet sur le serveur" variant="plain" action={<CompactButton variant="secondaire" icon="plus" href="/projets/nouveau">Ajouter un projet</CompactButton>}>
          Un serveur MCP s'active projet par projet.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {server.projects.map((project) => {
            const switchId = `${baseId}-project-${project.id}`;
            const error = state.toggleErrors[project.id];
            return (
              <li key={project.id} className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0">
                <div className="flex min-h-6 items-center gap-3">
                  <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer truncate font-sans text-app-14 text-text">
                    {project.name}
                  </label>
                  <Switch
                    id={switchId}
                    checked={project.enabled}
                    disabled={Boolean(state.toggling[project.id])}
                    onCheckedChange={(checked) => void state.toggle(project.id, checked)}
                    aria-describedby={error ? `${switchId}-error` : undefined}
                  />
                </div>
                {error ? (
                  <p id={`${switchId}-error`} role="alert" className="m-0 font-sans text-app-12 text-danger">
                    {error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 pt-2 font-sans text-app-12 leading-4 text-muted">Pris en compte par les sessions démarrées ou reprises ensuite.</p>
    </Section>
  );

  const coolifyExpiry = coolifyPreset && context.coolify.declaredExpiresAt && !Number.isNaN(new Date(context.coolify.declaredExpiresAt).getTime()) ? context.coolify.declaredExpiresAt : null;

  const stateBlock = (
    <Section title="État" id={`${baseId}-state`}>
      <KeyValueList
        items={[
          { key: 'connexion', label: <span className="text-muted">Connexion</span>, value: connectionValue(server, context) },
          { key: 'appel', label: <span className="text-muted">Dernier appel</span>, value: lastCallValue(server.lastCall) },
          { key: 'verification', label: <span className="text-muted">Vérification</span>, value: verificationValue(server, context.checkIntervalMinutes) },
          ...(coolifyExpiry ? [{ key: 'expiration', label: <span className="text-muted">Expiration du jeton</span>, value: formatShortDate(coolifyExpiry) }] : []),
        ]}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
        <CompactButton variant="secondaire" icon="refresh" loading={state.testing} onClick={() => void state.test()}>
          Tester la connexion
        </CompactButton>
        {replaceAction(server, () => setForceReconnect(true), openLogin)}
        {journalToggle}
      </div>
      {lastTestLine(server) ? <p className="m-0 pt-2 font-mono text-app-11 text-muted">{lastTestLine(server)}</p> : null}
    </Section>
  );

  const warnings: ReactNode[] = [];
  if (coolifyPreset && context.coolify.status === 'expiring') {
    warnings.push(
      <Banner
        key="expiring"
        tone="warn"
        title="Autorisation Coolify bientôt expirée"
        action={
          <CompactButton variant="secondaire" onClick={() => setForceReconnect(true)}>
            Renouveler
          </CompactButton>
        }
      >
        {coolifyExpiry ? `Renouvelez l'accès avant le ${formatShortDate(coolifyExpiry)}.` : "Renouvelez l'accès."}
      </Banner>,
    );
  }
  if (coolifyPreset) {
    for (const warning of context.coolify.warnings) {
      warnings.push(
        <Banner key={warning} tone="warn" title="À vérifier">
          {warning}
        </Banner>,
      );
    }
  }
  if (!reconnecting && server.displayStatus === 'error' && server.lastError) {
    warnings.push(
      <Banner key="error" tone="danger" title={server.failingSince ? `Ne répond plus depuis ${formatSince(server.failingSince)}` : 'Ne répond plus'}>
        {server.lastError}
      </Banner>,
    );
  }

  const permissions =
    server.permissions.length || server.permissionsNote ? (
      <Section title="Permissions accordées" id={`${baseId}-permissions`}>
        {server.permissions.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {server.permissions.map((line) => (
              <li key={line.label} className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                <Icon name={line.granted ? 'check' : 'x'} size={16} className={line.granted ? 'text-success' : 'text-muted'} />
                <span className="sr-only">{line.granted ? 'Accordé :' : 'Non accordé :'}</span>
                <span className={cn('min-w-0 flex-1 font-sans text-app-14', line.granted ? 'text-text' : 'text-muted')}>{line.label}</span>
                {line.note ? <span className="shrink-0 font-sans text-app-12 text-muted">{line.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {server.permissionsNote ? <p className="m-0 pt-2 font-sans text-app-12 leading-4 text-muted">{server.permissionsNote}</p> : null}
      </Section>
    ) : null;

  const configuration = (
    <Section title="Configuration" id={`${baseId}-configuration`}>
      <CodeBlock size="sm" wrap label={`Configuration de ${server.label}`}>
        {server.configurationLines.join('\n')}
      </CodeBlock>
    </Section>
  );

  const reconnectIntro = (() => {
    if (forceReconnect) {
      return via === 'mcp_login' ? null : (
        <Banner tone="info" title={via === 'coolify_token' ? 'Remplacer le jeton Coolify' : 'Remplacer le secret'}>
          Le secret actuel reste utilisé tant que le nouveau n'a pas été validé.
        </Banner>
      );
    }
    const banner = reconnectBanner(server, context.coolify);
    return (
      <Banner tone={banner.tone} title={banner.title}>
        {banner.body}
      </Banner>
    );
  })();

  let reconnectBlock: ReactNode = null;
  if (via === 'coolify_token') {
    reconnectBlock = (
      <CoolifyReconnect formId={formId} coolify={context.coolify} serverName={serverName} onStateChange={setCoolifyForm} onReconnected={onCoolifyReconnected} />
    );
  } else if (via === 'mcp_login') {
    reconnectBlock = (
      <Section title="Reconnecter" id={`${baseId}-login`}>
        <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
          {`La connexion à ${server.label} passe par Claude Code : un terminal s'ouvre sur ${serverName} avec claude mcp login ${server.name}. Ouvrez l'adresse affichée, autorisez l'accès, puis collez l'adresse de retour dans le terminal. Nuera Dev n'en garde rien.`}
        </p>
      </Section>
    );
  } else if (via === 'github_app') {
    reconnectBlock = (
      <Section title="Reconnecter" id={`${baseId}-github`}>
        <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
          Ce serveur utilise l'application GitHub de Nuera Dev, en lecture seule et limitée au dépôt de chaque session. Réautorisez l'application sur GitHub, puis testez la connexion.
        </p>
      </Section>
    );
  } else if (via === 'headers') {
    reconnectBlock = (
      <form id={formId} noValidate onSubmit={submitSecret} className="flex flex-col gap-2.5">
        <SectionLabel as="h3">Reconnecter</SectionLabel>
        <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
          {`Collez le nouveau secret${server.secretKeys.length ? ` (${server.secretKeys.join(', ')})` : ''}. Il remplace l'ancien, est chiffré sur ${serverName} et n'est plus jamais affiché.`}
        </p>
        <Field error={secretError?.message} hint={secretError ? (secretError.detail ?? secretError.untouched) : undefined}>
          <SecretField
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            leadingIcon="key"
            aria-label={`Nouveau secret de ${server.label}`}
            maxLength={4096}
            disabled={secretPending}
          />
        </Field>
      </form>
    );
  }

  const body = reconnecting ? (
    <>
      {reconnectIntro}
      {reconnectBlock}
      {testFailure}
      {server.projectCount === 0 && via !== 'coolify_token' ? projects : null}
      <div className="flex flex-wrap items-center gap-3">{journalToggle}</div>
      {journal}
      {terminal.dialog}
    </>
  ) : (
    <>
      {warnings}
      {stateBlock}
      {testFailure}
      {journal}
      {projects}
      {permissions}
      {configuration}
      {terminal.dialog}
    </>
  );

  const disableDialog = (
    <ConfirmDialog
      open={confirmDisable}
      onOpenChange={setConfirmDisable}
      tone="warn"
      icon="plug"
      title={`Désactiver ${server.label} partout ?`}
      consequences={[
        { kind: 'risk', text: `${server.label} n'est plus proposé aux sessions de ${plural(server.projectCount, 'projet')}, dès leur prochain démarrage ou leur reprise.` },
        { kind: 'kept', text: "L'autorisation et la configuration restent enregistrées : il suffit de le réactiver projet par projet." },
        { kind: 'kept', text: 'Les sessions déjà en cours gardent leur configuration actuelle.' },
      ]}
      confirmLabel="Désactiver partout"
      onConfirm={async () => {
        await state.disableEverywhere();
        setConfirmDisable(false);
      }}
    />
  );

  const deleteDialog = (
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      tone="danger"
      icon="trash"
      title={`Supprimer « ${server.label} » ?`}
      consequences={[
        { kind: 'risk', text: 'Le serveur et ses en-têtes chiffrés sont supprimés de Nuera Dev.' },
        { kind: 'risk', text: `Les projets où il est activé (${plural(server.projectCount, 'projet')}) ne le proposent plus à leurs sessions.` },
        { kind: 'kept', text: "Le serveur MCP lui-même n'est pas touché." },
      ]}
      confirmLabel="Supprimer le serveur"
      onConfirm={async () => {
        await state.remove();
        setConfirmDelete(false);
        onClose();
      }}
    />
  );

  const closeButton = (
    <Button variant="default" onClick={onClose}>
      Fermer
    </Button>
  );

  let footer: ReactNode;
  if (reconnecting && via === 'coolify_token') {
    footer = (
      <>
        <Button variant="default" onClick={forceReconnect ? () => setForceReconnect(false) : onClose} disabled={coolifyForm.pending}>
          Annuler
        </Button>
        <Button variant="accent" type="submit" form={formId} disabled={!coolifyForm.canSubmit} loading={coolifyForm.pending} loadingLabel="Vérification du jeton…">
          Reconnecter
        </Button>
      </>
    );
  } else if (reconnecting && via === 'mcp_login') {
    footer = (
      <>
        <Button variant="default" onClick={forceReconnect ? () => setForceReconnect(false) : onClose}>
          Annuler
        </Button>
        <Button variant="accent" onClick={openLogin} loading={state.testing} loadingLabel="Vérification…">
          Reconnecter
        </Button>
      </>
    );
  } else if (reconnecting && via === 'github_app') {
    footer = (
      <>
        <CompactButton variant="discret" icon="refresh" loading={state.testing} onClick={() => void state.test()}>
          Tester la connexion
        </CompactButton>
        {closeButton}
        {githubTarget ? (
          <Button variant="accent" onClick={openGithub}>
            Réautoriser sur GitHub
          </Button>
        ) : null}
      </>
    );
  } else if (reconnecting && via === 'headers') {
    footer = (
      <>
        <Button
          variant="default"
          onClick={
            forceReconnect
              ? () => {
                  // A secret typed then abandoned is never shown again on the next « Remplacer ».
                  setSecret('');
                  setSecretError(null);
                  setForceReconnect(false);
                }
              : onClose
          }
          disabled={secretPending}
        >
          Annuler
        </Button>
        <Button variant="accent" type="submit" form={formId} disabled={!secret.trim()} loading={secretPending} loadingLabel="Vérification…">
          Reconnecter
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        {!server.preset ? (
          <CompactButton variant="discret" onClick={() => setConfirmDelete(true)}>
            Supprimer
          </CompactButton>
        ) : null}
        {server.projectCount > 0 ? (
          <CompactButton variant="discret" onClick={() => setConfirmDisable(true)}>
            Désactiver partout
          </CompactButton>
        ) : null}
        {closeButton}
      </>
    );
  }

  return {
    title: server.label,
    subtitle: server.subtitle ?? `Serveur MCP · ${server.transport === 'stdio' ? 'commande locale' : server.transport === 'sse' ? 'SSE distant' : 'HTTP distant'}`,
    icon: iconOf(server.icon),
    badge: <Badge tone={badge.tone}>{badge.label}</Badge>,
    body: (
      <>
        {body}
        {disableDialog}
        {deleteDialog}
      </>
    ),
    footer,
  };
}

function formatSince(value: string): string {
  return Number.isNaN(new Date(value).getTime()) ? '' : formatTime(value);
}

/** The reconnect form a connected server offers on « Remplacer… » (token rotation, OAuth again). */
function reconnectModeOf(server: McpServerView): { kind: 'reconnect'; via: ReconnectVia } | { kind: 'detail' } {
  switch (server.credential) {
    case 'coolify_token':
      return { kind: 'reconnect', via: 'coolify_token' };
    case 'stored_headers':
      return { kind: 'reconnect', via: 'headers' };
    case 'claude_oauth':
      return { kind: 'reconnect', via: 'mcp_login' };
    default:
      return { kind: 'detail' };
  }
}

/** Secondary action of « ÉTAT » for servers whose credential can be replaced from Nuera Dev. */
function replaceAction(server: McpServerView, onReplace: () => void, onLogin: () => void): ReactNode {
  if (server.credential === 'coolify_token') {
    return (
      <CompactButton variant="discret" icon="key" onClick={onReplace}>
        Remplacer le jeton
      </CompactButton>
    );
  }
  if (server.credential === 'stored_headers') {
    return (
      <CompactButton variant="discret" icon="key" onClick={onReplace}>
        Remplacer le secret
      </CompactButton>
    );
  }
  if (server.credential === 'claude_oauth') {
    return (
      <CompactButton variant="discret" icon="terminal" onClick={onLogin}>
        Reconnecter dans un terminal
      </CompactButton>
    );
  }
  return null;
}

/** Back link of the full page. */
export function BackToIntegrations() {
  return (
    <Link href="/integrations" className="inline-flex min-h-11 items-center gap-1 self-start font-sans text-app-15 text-accent hover:underline">
      <Icon name="arrow-left" size={20} />
      Intégrations
    </Link>
  );
}
