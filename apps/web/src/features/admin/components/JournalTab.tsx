'use client';

import { useState } from 'react';
import { Card, CodeBlock, LinkButton, TileHeader } from '@/components/ui';
import { formatJournalDate } from '@/features/settings/lib/copy';
import type { InstanceJournalEntry } from '@/server/admin';
import { loadJournalAction } from '../actions';
import { BREAK_GLASS_HELP } from '../lib/copy';
import { SectionError, useAdmin } from './AdminView';

/**
 * Administration › Journal: sign-ins, accounts, servers and instance settings of every account — who
 * did what, and when (IP addresses visible to administrators). Never a Git, project, session or
 * terminal event.
 */
export function JournalTab() {
  const { data } = useAdmin();
  const [extra, setExtra] = useState<{ items: InstanceJournalEntry[]; nextCursor: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data.journal.ok) return <SectionError title="Le journal n'a pas pu être lu" message={data.journal.error.message} />;
  const items = [...data.journal.data.items, ...(extra?.items ?? [])];
  const cursor = extra ? extra.nextCursor : data.journal.data.nextCursor;

  async function more() {
    if (cursor === null) return;
    setBusy(true);
    setError(null);
    const result = await loadJournalAction(cursor);
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    setExtra((current) => ({ items: [...(current?.items ?? []), ...result.data.items], nextCursor: result.data.nextCursor }));
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card as="section" aria-label="Journal de l'instance" className="gap-2">
        <TileHeader icon="history" title="Journal de l'instance" />
        <p className="m-0 font-sans text-app-13 text-muted">Connexions, comptes, serveurs et réglages : qui a fait quoi, et quand.</p>
        {items.length === 0 ? (
          <p className="m-0 font-sans text-app-13 text-muted">Aucun événement pour le moment.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {items.map((item) => (
              <li key={item.id} className="font-mono text-app-11 leading-[18px] break-words text-text">
                {formatJournalDate(item.at, data.now)} · {item.summary}
                <span className="text-muted">
                  {item.actor ? ` · ${item.actor}` : ' · Nuera Dev'}
                  {item.ip ? ` · ${item.ip}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="m-0 font-sans text-app-12 text-danger">
            {error}
          </p>
        ) : null}
        {cursor !== null ? (
          <LinkButton size={13} onClick={() => void more()} disabled={busy} className="self-start">
            {busy ? 'Lecture…' : 'Afficher les événements précédents'}
          </LinkButton>
        ) : items.length > 0 ? (
          <p className="m-0 font-sans text-app-12 text-muted">Début du journal.</p>
        ) : null}
      </Card>
      <Card as="section" aria-label="Récupération sans administrateur" className="gap-2">
        <TileHeader icon="key" title="Récupération sans administrateur" />
        <p className="m-0 font-sans text-app-13 text-muted">{BREAK_GLASS_HELP}</p>
        <CodeBlock command="pnpm --filter @nuera/db cli recovery-link --email <adresse>" wrap label="Commande de secours" />
      </Card>
    </div>
  );
}
