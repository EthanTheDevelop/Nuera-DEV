/**
 * Copy helpers of the Projets pages (pure, tested in format.test.ts). French formats through
 * @nuera/shared/format (fr-FR, Europe/Paris); an invalid date yields null instead of throwing.
 */
import { formatBytes, formatDuration, formatNumber, formatRelative, formatShortDate, plural } from '@nuera/shared/format';
import { joinParts } from '@/components/dev/lib/format';
import type { DiskUsage, ProjectSessionView } from '@/server/projects/types';

type DateLike = string | number | Date | null | undefined;

export function validDate(value: DateLike): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const GB = 1024 ** 3;

/** « 41 Go » (rounded, as in D02 « 41 Go utilisés sur 160 »). */
export function roundedGb(bytes: number): string {
  return `${formatNumber(Math.round(bytes / GB))} Go`;
}

/**
 * D02 « 5 dépôts clonés sur VPS-3 · 41 Go utilisés sur 160 » / M02 « 5 dépôts sur VPS-3 · 41 Go ».
 * Without the disk (VPS-3 not answering), only the count.
 */
export function projectsSubtitle(count: number, disk: DiskUsage | null, serverName: string, variant: 'long' | 'short'): string {
  const repos = variant === 'long' ? `${plural(count, 'dépôt')} ${count >= 2 ? 'clonés' : 'cloné'} sur ${serverName}` : `${plural(count, 'dépôt')} sur ${serverName}`;
  if (!disk || disk.totalBytes <= 0) return repos;
  return variant === 'long'
    ? joinParts(repos, `${roundedGb(disk.usedBytes)} utilisés sur ${formatNumber(Math.round(disk.totalBytes / GB))}`)
    : joinParts(repos, roundedGb(disk.usedBytes));
}

/** D03 helper « Dossier vide requis. Espace libre : 99 Go sur 160. » */
export function freeSpaceText(disk: DiskUsage | null): string {
  if (!disk || disk.totalBytes <= 0) return 'Dossier vide requis.';
  return `Dossier vide requis. Espace libre : ${roundedGb(disk.freeBytes)} sur ${formatNumber(Math.round(disk.totalBytes / GB))}.`;
}

/**
 * A1 last-push age: « il y a 6 min », « il y a 2 h », « il y a 2 j », « il y a 1 semaine »,
 * « il y a 3 semaines », « il y a 1 mois » — `short` (M03): « il y a 1 sem. ».
 */
export function repoAge(value: DateLike, now: DateLike = new Date(), variant: 'long' | 'short' = 'long'): string | null {
  const date = validDate(value);
  const ref = validDate(now) ?? new Date();
  if (!date) return null;
  const minutes = Math.max(0, Math.round((ref.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  const weeks = Math.round(days / 7);
  if (days < 35) return variant === 'short' ? `il y a ${weeks} sem.` : `il y a ${weeks} ${weeks >= 2 ? 'semaines' : 'semaine'}`;
  const months = Math.max(1, Math.round(days / 30.4));
  if (months < 12) return `il y a ${months} mois`;
  const years = Math.round(days / 365);
  return `il y a ${years} ${years >= 2 ? 'ans' : 'an'}`;
}

/** Long form used in the D03 « Dépôt choisi » card: « mis à jour il y a 2 jours ». */
export function updatedAgo(value: DateLike, now: DateLike = new Date()): string | null {
  const age = repoAge(value, now, 'long');
  if (!age) return null;
  return `mis à jour ${age.replace(/ (\d+) j$/, (_m, n: string) => ` ${n} ${Number(n) >= 2 ? 'jours' : 'jour'}`)}`;
}

/** « Privé · TypeScript · il y a 2 j » (A1 / M03 row meta). */
export function repoMeta(repo: { private: boolean; language: string | null; pushedAt: string | null }, now: DateLike, variant: 'long' | 'short' = 'long'): string {
  return joinParts(repo.private ? 'Privé' : 'Public', repo.language, repoAge(repo.pushedAt, now, variant));
}

/** « roux-conseil » → « Roux Conseil » (prefill of « Nom dans Nuera Dev », editable). */
export function humanizeRepoName(name: string): string {
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** « 84 Mo » */
export function sizeText(bytes: number | null | undefined): string | null {
  return typeof bytes === 'number' && bytes > 0 ? formatBytes(bytes) : null;
}

/**
 * D04 « Sessions de ce projet » sub-line (JetBrains Mono 11): « feature/crm-core · depuis 12 min »,
 * « feature/devis-pdf · attend une autorisation », « 19 oct. · terminée · 1 h 05 ».
 */
export function sessionSubline(session: ProjectSessionView, now: DateLike = new Date()): string {
  const ref = validDate(now) ?? new Date();
  const started = validDate(session.startedAt);
  const ended = validDate(session.endedAt);
  switch (session.status) {
    case 'waiting_permission':
      return joinParts(session.branch, 'attend une autorisation');
    case 'running':
    case 'waiting_input': {
      const since = started ? `depuis ${formatDuration(ref.getTime() - started.getTime())}` : null;
      return joinParts(session.branch, session.status === 'waiting_input' ? 'attend une instruction' : since);
    }
    case 'new':
      return joinParts(session.branch, 'pas encore démarrée');
    default: {
      const day = ended ?? validDate(session.lastActivityAt) ?? validDate(session.createdAt);
      const word =
        session.status === 'finished'
          ? 'terminée'
          : session.status === 'interrupted'
            ? 'interrompue'
            : session.status === 'failed'
              ? 'en échec'
              : session.status === 'stopped'
                ? 'arrêtée'
                : 'archivée';
      const duration = started && ended ? formatDuration(ended.getTime() - started.getTime()) : null;
      return joinParts(day ? formatShortDate(day, ref) : null, word, duration);
    }
  }
}

/** « synchronisé il y a 4 min » (D04 meta row). */
export function syncedAgo(value: DateLike, now: DateLike = new Date()): string | null {
  const date = validDate(value);
  if (!date) return null;
  return `synchronisé ${formatRelative(date, validDate(now) ?? new Date())}`;
}

/** « Modifié le 28 oct. · commit 4c1d0e2. » (D04 CLAUDE.md footnote, first sentence). */
export function claudeMdModified(modifiedAt: DateLike, sha: string | null | undefined, now: DateLike = new Date()): string | null {
  const date = validDate(modifiedAt);
  if (!date) return null;
  return `${joinParts(`Modifié le ${formatShortDate(date, validDate(now) ?? new Date())}`, sha ? `commit ${sha.slice(0, 7)}` : null)}.`;
}

/** Commands detected by the runner after the clone (A3 « dev · build · test · lint »). */
export function detectedCommandsText(commands: Partial<Record<string, string | null>> | null | undefined): string | null {
  if (!commands) return null;
  const names = (['dev', 'build', 'test', 'lint'] as const).filter((key) => Boolean(commands[key]));
  return names.length ? joinParts(...names) : null;
}
