'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { CompactButton } from '@/components/ui/CompactButton';
import { Pastille } from '@/components/ui/Pastille';
import { useNow } from '@/hooks/useNow';
import { useOptionalShellData } from './ShellContext';
import { lastContactText } from './status-text';
import type { ClaudeState } from './types';

/** app_settings.serverName inside the shells (« VPS-3 » is only the schema default, used by the gallery). */
function useServerName(explicit: string | undefined): string {
  const shell = useOptionalShellData();
  return explicit ?? shell?.server.name ?? 'VPS-3';
}

/* -----------------------------------------------------------------------------------------------
   Shared anatomy of T5 / T6 (« Carte · VPS-3 ne répond pas »): bg surface, radius 28, padding 28,
   gap 14, Shadow/Soft; Pastille 48 (radius 12, tinted) with a 24 px icon; title Outfit 600 20;
   text 14 / 20 muted; « Ce qui est sûr » box (surface-raised, 1 px border, radius 12, padding 12 × 14,
   gap 6; rows icon 16 + Outfit 13 / 18); actions gap 10.
   ----------------------------------------------------------------------------------------------- */

export interface Fact {
  kind: 'ok' | 'risk';
  text: ReactNode;
}

function FactsBox({ facts, label }: { facts: readonly Fact[]; label: string }) {
  return (
    <ul aria-label={label} className="m-0 flex w-full list-none flex-col gap-1.5 rounded-md border border-border bg-surface-raised px-3.5 py-3">
      {facts.map((fact, i) => (
        <li key={i} className="flex items-start gap-2 font-sans text-app-13 leading-[18px] text-text">
          <Icon name={fact.kind === 'ok' ? 'check' : 'alert'} size={16} className={cn('mt-px', fact.kind === 'ok' ? 'text-success' : 'text-warn')} />
          <span className="min-w-0">{fact.text}</span>
        </li>
      ))}
    </ul>
  );
}

export interface ServerUnavailableProps {
  /** « VPS-3 ». */
  serverName: string;
  lastContactAt: string | null;
  /** Provider status page (« État du serveur chez OVH »); the button is hidden when unknown. */
  statusUrl?: string | null;
  /** Provider name for the status button (« OVH », from the server location). */
  providerName?: string | null;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}

/**
 * T5 « Serveur indisponible » — « Remplace le contenu de toutes les pages tant que le serveur ne répond
 * pas. L'Accueil et la barre latérale passent en rouge, sans masquer la navigation. »
 */
export function ServerUnavailable({
  serverName,
  lastContactAt,
  statusUrl,
  providerName,
  onRetry,
  retrying = false,
  className,
}: ServerUnavailableProps) {
  const now = useNow(10_000);
  const contact = lastContactText(lastContactAt, now);
  return (
    <section
      role="alert"
      aria-labelledby="t5-title"
      className={cn('flex w-full max-w-[656px] flex-col items-start gap-3.5 rounded-xl bg-bg p-7 shadow-soft', className)}
    >
      <Pastille icon="wifi-off" size={48} tone="danger" />
      <h1 id="t5-title" className="m-0 font-sans text-app-20 font-semibold text-text">
        {`${serverName} ne répond pas`}
      </h1>
      <p className="m-0 font-sans text-app-14 leading-5 text-muted" suppressHydrationWarning>
        {contact ? `${contact}. ` : ''}Nuera Dev réessaie toutes les 10 s, sans rien faire de plus.
      </p>
      <FactsBox
        label="Ce qui est sûr"
        facts={[
          { kind: 'ok', text: 'Vos dépôts, worktrees et commits poussés sont intacts sur le disque du serveur.' },
          { kind: 'ok', text: "Une coupure réseau n'arrête pas les sessions tmux : elles reprendront à l'affichage." },
          {
            kind: 'risk',
            text: 'Si le serveur a redémarré, les sessions seront marquées « Interrompue », reprenables par claude --resume.',
          },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="accent" onClick={onRetry} loading={retrying} loadingLabel="Nouvel essai en cours…">
          Réessayer maintenant
        </Button>
        {statusUrl ? (
          <Button href={statusUrl} external>
            {providerName ? `État du serveur chez ${providerName}` : 'État du serveur'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export interface ClaudeDisconnectedProps {
  state: Extract<ClaudeState, 'disconnected' | 'wrong_method' | 'not_installed'>;
  /** Where « Se reconnecter dans un terminal » leads (terminal running the CLI login). */
  reconnectHref: string;
  /** `card` = page-level T6 card (where Claude is required) · `banner` = warn banner on other pages. */
  variant?: 'card' | 'banner';
  /** Server name of the copy (default: app_settings.serverName from the shell). */
  serverName?: string;
  className?: string;
}

const whyText = (server: string) =>
  `« Se reconnecter » ouvre un terminal sur ${server} qui lance la procédure de connexion du CLI (claude /login). Aucun formulaire de jeton dans Nuera Dev.`;

/**
 * T6 « Claude Code déconnecté »: same anatomy as T5 with the warn tone and the terminal icon. The
 * reconnection always happens in the CLI, in a terminal — never through a token form (P2).
 */
export function ClaudeDisconnected({ state, reconnectHref, variant = 'card', serverName, className }: ClaudeDisconnectedProps) {
  const server = useServerName(serverName);
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const copy =
    state === 'disconnected'
      ? {
          title: "Claude Code n'est plus connecté à votre compte Claude",
          text: "Le CLI officiel signale une connexion expirée. Les sessions en cours s'arrêteront à leur prochaine requête.",
        }
      : state === 'wrong_method'
        ? {
            title: "Claude Code n'utilise pas votre compte Claude",
            text: "Le CLI est connecté par une clé d'API : reconnectez-le avec votre compte Claude, dans un terminal.",
          }
        : {
            title: `Claude Code n'est pas installé sur ${server}`,
            text: 'Le CLI officiel est introuvable sur le serveur : aucune session ne peut démarrer.',
          };

  const reconnect =
    state === 'not_installed' ? null : (
      <CompactButton href={reconnectHref} icon="terminal">
        Se reconnecter dans un terminal
      </CompactButton>
    );

  if (variant === 'banner') {
    return (
      <Banner tone={state === 'not_installed' ? 'danger' : 'warn'} icon="terminal" title={copy.title} action={reconnect} className={className}>
        {copy.text}
      </Banner>
    );
  }

  return (
    <section
      role="alert"
      aria-labelledby={`${whyId}-title`}
      className={cn('flex w-full max-w-[656px] flex-col items-start gap-3.5 rounded-xl bg-bg p-7 shadow-soft', className)}
    >
      <Pastille icon="terminal" size={48} tone={state === 'not_installed' ? 'danger' : 'warn'} />
      <h2 id={`${whyId}-title`} className="m-0 font-sans text-app-20 font-semibold text-text">
        {copy.title}
      </h2>
      <p className="m-0 font-sans text-app-14 leading-5 text-muted">{copy.text}</p>
      <FactsBox
        label="Ce qui est sûr"
        facts={[
          { kind: 'ok', text: "Aucun identifiant n'est stocké par Nuera Dev : la reconnexion se fait dans le CLI." },
          { kind: 'ok', text: 'Les conversations restent enregistrées et reprenables après reconnexion.' },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        {reconnect}
        <CompactButton variant="discret" aria-expanded={why} aria-controls={`${whyId}-why`} onClick={() => setWhy((v) => !v)}>
          Pourquoi ?
        </CompactButton>
      </div>
      <p id={`${whyId}-why`} hidden={!why} className="m-0 font-sans text-app-13 leading-[18px] text-muted">
        {whyText(server)}
      </p>
    </section>
  );
}

/** T6 as a page banner (pages that do not require Claude): alias of `<ClaudeDisconnected variant="banner" />`. */
export function ClaudeDisconnectedBanner(props: Omit<ClaudeDisconnectedProps, 'variant'>) {
  return <ClaudeDisconnected {...props} variant="banner" />;
}

export interface ConnectionLostBannerProps {
  /** When the next automatic attempt happens (ms epoch), from useLiveEvents().nextRetryAt. */
  nextRetryAt: number | null;
  onRetry: () => void;
  /**
   * `workspace` = W7 copy (« La session continue sur VPS-3… », shown inline at the top of the thread) ·
   * `page` = the same banner on the other pages (live values are frozen meanwhile).
   */
  context?: 'workspace' | 'page';
  /** Server name of the W7 copy (default: app_settings.serverName from the shell). */
  serverName?: string;
  className?: string;
}

/**
 * W7 `Dev · Bandeau` « Connexion perdue »: warn-pale, wifi-off icon (warn), « Connexion au serveur perdue ·
 * nouvel essai dans 4 s » (live countdown) + Secondaire « Réessayer maintenant ».
 */
export function ConnectionLostBanner({ nextRetryAt, onRetry, context = 'workspace', serverName, className }: ConnectionLostBannerProps) {
  const server = useServerName(serverName);
  const now = useNow(1_000);
  const seconds = nextRetryAt === null ? null : Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
  const title =
    seconds === null || seconds === 0
      ? 'Connexion au serveur perdue · nouvel essai en cours…'
      : `Connexion au serveur perdue · nouvel essai dans ${seconds} s`;
  // The banner is an alert (announced once); the per-second countdown is visual only, otherwise screen
  // readers would read it out every second.
  return (
    <Banner
      tone="warn"
      icon="wifi-off"
      title={
        <>
          <span aria-hidden suppressHydrationWarning>
            {title}
          </span>
          <span className="sr-only">Connexion au serveur perdue · nouvel essai automatique</span>
        </>
      }
      action={
        <CompactButton variant="secondaire" onClick={onRetry}>
          Réessayer maintenant
        </CompactButton>
      }
      className={className}
    >
      {context === 'workspace'
        ? `La session continue sur ${server} : rien n'est perdu, le fil se recharge à la reconnexion.`
        : 'Les valeurs affichées sont figées ; elles se mettent à jour dès la reconnexion.'}
    </Banner>
  );
}

/** Shows `children` only after `active` stayed true for `delayMs` (no banner flash on a quick reconnect). */
export function Delayed({ active, delayMs = 1500, children }: { active: boolean; delayMs?: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      const reset = setTimeout(() => setShown(false), 0);
      return () => clearTimeout(reset);
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown ? <>{children}</> : null;
}
