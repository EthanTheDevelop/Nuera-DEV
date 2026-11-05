import 'server-only';
import { LOCALE, TIME_ZONE } from '@nuera/shared/format';
import { createNotification, resolveNotifications } from '@/server/notifications';

/**
 * T7 « Autorisation expirée » — « Même logique pour GitHub, Figma ou Coolify : prévenir avant, dire
 * ce qui s'arrête après, et renvoyer vers le service qui délivre l'accès. »
 *
 * Called after every check with the previous and the new state; creates one notification on each
 * transition into « bientôt expirée », « expirée » or « injoignable », and resolves them when the
 * integration is healthy again.
 */

export type HealthState = 'ok' | 'expiring' | 'expired' | 'error' | 'inactive';

export interface TransitionInput {
  /** 'github' | 'coolify' | `mcp:${name}` — also the dedup key prefix. */
  target: string;
  /** « GitHub », « Coolify », « Figma »… */
  label: string;
  previous: HealthState;
  next: HealthState;
  /** Known expiry (T7 avant). */
  expiresAt?: Date | null;
  /** Start of the failure streak (« depuis 09:12 »). */
  failingSince?: Date | null;
  /** What stops when access is lost (T7 après), French sentence. */
  impact: string;
  /** French reason from the check (« Application non installée »). */
  reason?: string | null;
  /** Where the notification leads (/integrations, /integrations/mcp/coolify). */
  href: string;
}

const dayMonth = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, day: 'numeric', month: 'long' });
const clock = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });

/** « 12 novembre » */
export function formatDayMonth(date: Date): string {
  return dayMonth.format(date);
}

/** « 09:12 » */
export function formatClock(date: Date): string {
  return clock.format(date);
}

export function dedupKeyFor(target: string, state: Exclude<HealthState, 'ok' | 'inactive'>): string {
  return `integration:${target}:${state}`;
}

/** « Autorisation expirée » → « Autorisation expirée. » (reasons are joined into one paragraph). */
export function sentence(text: string | null | undefined): string | null {
  const value = text?.trim();
  if (!value) return null;
  return /[.!?…»]$/.test(value) ? value : `${value}.`;
}

/** Non-empty parts as sentences, joined by a space. */
export function paragraph(...parts: Array<string | null | undefined>): string {
  return parts
    .map(sentence)
    .filter((part): part is string => part !== null)
    .join(' ');
}

export async function applyHealthTransition(input: TransitionInput): Promise<void> {
  const { target, label } = input;
  if (input.next === input.previous) return;
  try {
    if (input.next === 'ok' || input.next === 'inactive') {
      await resolveNotifications(`integration:${target}:`);
      return;
    }
    if (input.next === 'expiring') {
      const when = input.expiresAt ? ` avant le ${formatDayMonth(input.expiresAt)}` : '';
      await createNotification({
        kind: 'integration_expiring',
        severity: 'warning',
        title: `Autorisation ${label} bientôt expirée`,
        body: `Renouvelez l'accès${when}.`,
        href: input.href,
        dedupKey: dedupKeyFor(target, 'expiring'),
      });
      return;
    }
    if (input.next === 'expired') {
      // The new state supersedes « bientôt expirée » and « ne répond plus ».
      await resolveNotifications(dedupKeyFor(target, 'expiring'));
      await resolveNotifications(dedupKeyFor(target, 'error'));
      await createNotification({
        kind: 'integration_expired',
        severity: 'danger',
        title: `L'accès ${label} a été retiré`,
        body: paragraph(input.impact, input.reason),
        href: input.href,
        dedupKey: dedupKeyFor(target, 'expired'),
      });
      return;
    }
    // error: provider unreachable after two failed checks (hysteresis applied by the caller).
    const since = input.failingSince ? ` depuis ${formatClock(input.failingSince)}` : '';
    await createNotification({
      kind: 'integration_error',
      severity: 'danger',
      title: `${label} ne répond plus${since}`,
      body: paragraph(input.reason, input.impact),
      href: input.href,
      dedupKey: dedupKeyFor(target, 'error'),
    });
  } catch (error) {
    // A notification failure must never break a health check.
    console.error('[integrations] notification de transition impossible', target, error instanceof Error ? error.message : error);
  }
}

/** Maps a DB integration status to the health state used for transitions. */
export function healthOfIntegrationStatus(status: string): HealthState {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'expiring':
      return 'expiring';
    case 'expired':
      return 'expired';
    case 'error':
      return 'error';
    default:
      return 'inactive';
  }
}

/**
 * Maps an MCP status to the health state used for transitions. `needs_auth` (never authorised, or
 * credential removed by the owner) is not a withdrawal: no « L’accès … a été retiré » for it — the
 * card badge « Connexion requise » and the D01 attention list carry it. A grant that stops working
 * is `expired`.
 */
export function healthOfMcpStatus(status: string): HealthState {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'expired':
      return 'expired';
    case 'error':
      return 'error';
    default:
      return 'inactive';
  }
}
