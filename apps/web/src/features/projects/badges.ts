import { syncBadge } from '@/components/dev/lib/git';
import type { BadgeTone } from '@/components/ui';
import type { ProjectListItem } from '@/server/projects/types';

/**
 * Badge of a project row / header: the clone states first (not drawn: sober copy in the same
 * Badge), then the Figma sync badge (`syncBadge`, long D02 / short M02).
 */
export function projectBadge(item: Pick<ProjectListItem, 'status' | 'sync' | 'archivedAt'>, variant: 'long' | 'short' = 'long'): { label: string; tone: BadgeTone } {
  if (item.status === 'cloning') return { label: 'Clonage…', tone: 'accent' };
  if (item.status === 'error') return { label: variant === 'long' ? 'Clonage en échec' : 'Échec', tone: 'danger' };
  if (item.archivedAt) return { label: 'Archivé', tone: 'neutral' };
  return syncBadge(item.sync, variant);
}
