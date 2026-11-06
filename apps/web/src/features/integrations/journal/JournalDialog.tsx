'use client';

import { Dialog, DialogContent } from '@/components/ui';
import type { IntegrationsOverview } from '../types';
import { CheckJournal } from './CheckJournal';

export type PageJournal = 'github' | 'coolify';

export function isPageJournal(value: string | null | undefined): value is PageJournal {
  return value === 'github' || value === 'coolify';
}

/**
 * `/integrations?journal=github|coolify` — the journal of the GitHub App (`&source=<id>`: of that
 * GitHub source, among several) or of the Coolify token (« Voir le journal » of the diagnostic
 * banners). MCP servers show theirs in their drawer (`/integrations/mcp/<nom>?journal=1`).
 */
export function JournalDialog({
  journal,
  sourceId = null,
  overview,
  onClose,
}: {
  journal: PageJournal | null;
  sourceId?: string | null;
  overview: IntegrationsOverview;
  onClose: () => void;
}) {
  const githubSource = sourceId ? overview.github.sources.find((item) => item.id === sourceId) : undefined;
  const source = journal === 'github' ? (githubSource ?? overview.github) : journal === 'coolify' ? overview.coolify : null;
  const label = journal === 'github' ? (githubSource && overview.github.sources.length > 1 ? `GitHub · ${githubSource.label}` : 'GitHub') : 'Coolify';
  return (
    <Dialog open={journal !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {journal ? (
        <DialogContent
          title={`Journal · ${label}`}
          description={
            journal === 'github'
              ? "Vérifications de l'application GitHub : requêtes en lecture seule, sans jeton affiché."
              : 'Vérifications du jeton Coolify : requêtes en lecture seule, sans jeton affiché.'
          }
        >
          <CheckJournal last={source?.lastCheck ?? null} history={source?.history ?? []} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
