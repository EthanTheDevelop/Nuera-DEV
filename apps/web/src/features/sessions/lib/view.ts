/**
 * Pure presentation logic of the Sessions page (D06 / M06), tested in view.test.ts.
 */
import type { SessionStatusEvent } from '@nuera/shared/events';
import { formatBytes, formatNumber, formatPercent } from '@nuera/shared/format';
import { isActiveStatus, isLiveStatus, workspaceUrl, type SessionListItem, type SessionStatus } from './contract';

/** « 2 sessions actives sur 4 autorisées » (D06 capacity tile). */
export function capacityTitle(active: number, max: number): string {
  return `${formatNumber(active)} ${active >= 2 ? 'sessions actives' : 'session active'} sur ${formatNumber(max)} ${max >= 2 ? 'autorisées' : 'autorisée'}`;
}

/** « 2 sessions sur 4 » (M06). */
export function capacityShort(active: number, max: number): string {
  return `${formatNumber(active)} ${active >= 2 ? 'sessions' : 'session'} sur ${formatNumber(max)}`;
}

export interface MemoryMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

const GB = 1024 ** 3;
const gb = (bytes: number) => formatNumber(bytes / GB, bytes / GB >= 100 || Number.isInteger(bytes / GB) ? 0 : 1);

/** « Mémoire libre : 10,9 Go sur 16 · processeur 23 % » (D06). */
export function memoryCaption(metrics: MemoryMetrics | null): string | null {
  if (!metrics || metrics.memoryTotalBytes <= 0) return null;
  const free = Math.max(0, metrics.memoryTotalBytes - metrics.memoryUsedBytes);
  return `Mémoire libre : ${gb(free)} Go sur ${gb(metrics.memoryTotalBytes)} · processeur ${formatPercent(Math.round(metrics.cpuPercent))}`;
}

/** « 10,9 Go libres » (M06). */
export function memoryFreeShort(metrics: MemoryMetrics | null): string | null {
  if (!metrics || metrics.memoryTotalBytes <= 0) return null;
  return `${formatBytes(Math.max(0, metrics.memoryTotalBytes - metrics.memoryUsedBytes))} libres`;
}

/** EN COURS order: desktop = running first (D06), phone = the one waiting for the owner first (M06). */
export function sortActive(items: readonly SessionListItem[], layout: 'desktop' | 'phone'): SessionListItem[] {
  const rank = (status: SessionStatus): number => {
    if (layout === 'phone') return status === 'waiting_permission' ? 0 : status === 'running' ? 1 : status === 'waiting_input' ? 2 : 3;
    return status === 'running' ? 0 : status === 'waiting_permission' ? 1 : status === 'waiting_input' ? 2 : 3;
  };
  const time = (item: SessionListItem) => Date.parse(item.startedAt ?? item.createdAt) || 0;
  return [...items].sort((a, b) => rank(a.status) - rank(b.status) || time(b) - time(a));
}

const NUMBER_WORDS = ['zéro', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const word = (n: number) => NUMBER_WORDS[n] ?? formatNumber(n);

/**
 * D06 note under the cards, for each project with ≥ 2 sessions in distinct worktrees:
 * « Les deux sessions de Nuera OS travaillent dans deux worktrees distincts (crm-core, devis-pdf) :
 * elles ne modifient jamais les mêmes fichiers. »
 */
export function worktreeNotes(items: readonly SessionListItem[]): string[] {
  const byProject = new Map<string, { name: string; worktrees: string[]; count: number }>();
  for (const item of items) {
    if (!item.worktree) continue;
    const entry = byProject.get(item.project.id) ?? { name: item.project.name, worktrees: [], count: 0 };
    entry.count += 1;
    if (!entry.worktrees.includes(item.worktree.name)) entry.worktrees.push(item.worktree.name);
    byProject.set(item.project.id, entry);
  }
  const notes: string[] = [];
  for (const { name, worktrees, count } of byProject.values()) {
    if (count < 2 || worktrees.length !== count) continue;
    notes.push(
      `Les ${word(count)} sessions de ${name} travaillent dans ${word(count)} worktrees distincts (${worktrees.join(', ')}) : elles ne modifient jamais les mêmes fichiers.`,
    );
  }
  return notes;
}

/** « EN COURS · 2 » */
export function activeLabel(count: number): string {
  return `En cours · ${formatNumber(count)}`;
}

/** Card activity line: the CLI's current activity, else what is known. */
export function cardActivity(item: SessionListItem): string | null {
  if (item.status === 'new') return 'Pas encore démarrée · aucune instruction envoyée';
  if (item.currentActivity) return item.currentActivity;
  if (item.status === 'waiting_permission') return 'Attend votre accord dans le Workspace';
  if (item.status === 'waiting_input') return item.lastInstruction ? `Dernière instruction : ${item.lastInstruction}` : null;
  return item.lastInstruction;
}

/** Card / row destination: the pending request for « Répondre », else the Workspace. */
export function sessionHref(item: Pick<SessionListItem, 'id' | 'status' | 'pendingPermissionId'>): string {
  return workspaceUrl(item.id, item.status === 'waiting_permission' ? item.pendingPermissionId : null);
}

/** Main action of a history row (D06 mapping) — the page wires it. */
export type HistoryAction = 'summary' | 'resume' | 'view' | 'why' | 'open';

export function historyAction(item: Pick<SessionListItem, 'status' | 'resumable'>): HistoryAction {
  if (item.status === 'finished') return 'summary';
  if (item.status === 'archived') return 'view';
  if (item.status === 'interrupted' || item.status === 'stopped' || item.status === 'failed') return item.resumable ? 'resume' : 'why';
  return 'open';
}

/**
 * Applies a `session.status` event to the EN COURS list. Returns the new list and whether the
 * server data must be re-read (a session appeared, or left the active statuses).
 */
export function applyStatusEvent(
  items: readonly SessionListItem[],
  event: SessionStatusEvent,
): { items: SessionListItem[]; refresh: boolean } {
  const index = items.findIndex((item) => item.id === event.sessionId);
  if (index === -1) return { items: [...items], refresh: isActiveStatus(event.status) };
  if (!isActiveStatus(event.status)) return { items: items.filter((item) => item.id !== event.sessionId), refresh: true };
  const current = items[index]!;
  const next: SessionListItem = {
    ...current,
    title: event.title ?? current.title,
    status: event.status,
    live: event.live,
    currentActivity: event.currentActivity,
    lastInstruction: event.lastInstruction,
    lastActivityAt: event.lastActivityAt,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    planDone: event.planDone,
    planTotal: event.planTotal,
    errorMessage: event.errorMessage,
    pendingPermissionId: event.pendingPermissionId,
  };
  const copy = [...items];
  copy[index] = next;
  return { items: copy, refresh: false };
}

/** Live CLIs among the EN COURS sessions (capacity once the list is live). */
export function liveCount(items: readonly SessionListItem[]): number {
  return items.filter((item) => item.live || isLiveStatus(item.status)).length;
}
