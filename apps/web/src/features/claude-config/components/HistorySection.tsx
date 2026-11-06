'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, LinkButton, TileHeader } from '@/components/ui';
import type { VersionView } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { KIND_LABELS } from '../lib/copy';
import { SectionIntro, useClaudeAdmin } from './AdminClaudeTab';
import { InlineError, VersionsDialog, versionLine } from './parts';

/**
 * Historique: every version of every item, newest first (who, when, what). Each opens its diff and
 * « Revenir à cette version ». The instance journal (Administration › Journal) records the same
 * changes as `instance.claude_*` events.
 */
export function HistorySection() {
  const { overview, reload } = useClaudeAdmin();
  const [items, setItems] = useState<VersionView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VersionView | null>(null);
  const revision = overview.rows.policy.revision;

  const load = useCallback(async (before: number | null) => {
    const query = new URLSearchParams({ limit: '30', ...(before ? { before: String(before) } : {}) });
    const result = await claudeApi<{ items: VersionView[]; nextBefore: number | null }>('GET', `/api/admin/claude/history?${query.toString()}`);
    if (!result.ok) return setError(errorText(result.error));
    setError(null);
    setItems((current) => (before ? [...current, ...result.data.items] : result.data.items));
    setNext(result.data.nextBefore);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load, revision]);

  const [now] = useState(() => new Date().toISOString());
  return (
    <Card as="section" aria-label="Historique de la configuration commune" className="gap-3">
      <TileHeader icon="history" title="Historique" />
      <SectionIntro>Chaque modification, par qui et quand. Ouvrez une version pour voir ses différences ou y revenir.</SectionIntro>
      {items.length === 0 && !error ? <p className="m-0 font-sans text-app-13 text-muted">Aucune modification pour le moment.</p> : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
            <span className="min-w-0 font-sans text-app-13 text-text">
              <span className="font-medium">
                {KIND_LABELS[item.kind]} « {item.label} »
              </span>{' '}
              <span className="font-mono text-app-12 text-muted">· {versionLine(item, now)}</span>
            </span>
            <LinkButton size={13} onClick={() => setSelected(item)}>
              Voir
            </LinkButton>
          </li>
        ))}
      </ul>
      {next !== null ? (
        <LinkButton size={13} className="self-start" onClick={() => void load(next)}>
          Afficher les modifications précédentes
        </LinkButton>
      ) : null}
      <InlineError>{error}</InlineError>
      <VersionsDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected ? `${KIND_LABELS[selected.kind]} « ${selected.label} »` : 'Versions'}
        {...(selected ? { kind: selected.kind, itemId: selected.itemId } : {})}
        onRestored={() => void reload()}
      />
    </Card>
  );
}
