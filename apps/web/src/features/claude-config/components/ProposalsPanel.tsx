'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDateTimeShort } from '@nuera/shared/format';
import { ClaudeMarkdown } from '@/components/dev/conversation/ClaudeMarkdown';
import { Button, Card, Field, Input, TileHeader, toast } from '@/components/ui';
import type { ProposalView } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { useClaudeAdmin } from './AdminClaudeTab';
import { InlineError } from './parts';

/**
 * Propositions des membres, en attente: « Approuver » applies the change (new version authored by the
 * administrator, the author is told), « Refuser » keeps nothing (with an optional note to the author).
 */
export function ProposalsPanel({ highlighted }: { highlighted: boolean }) {
  const { overview, reload } = useClaudeAdmin();
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = overview.pendingProposals;

  const load = useCallback(async () => {
    const result = await claudeApi<{ proposals: ProposalView[] }>('GET', '/api/admin/claude/proposals');
    if (result.ok) setProposals(result.data.proposals);
    else setError(errorText(result.error));
  }, []);

  useEffect(() => {
    void load();
  }, [load, pending]);

  const [now] = useState(() => new Date().toISOString());
  if (proposals.length === 0 && !highlighted) return null;

  async function decide(proposal: ProposalView, decision: 'approve' | 'reject') {
    setBusy(`${proposal.id}:${decision}`);
    setError(null);
    const result = await claudeApi('POST', `/api/admin/claude/proposals/${proposal.id}`, { decision, note: notes[proposal.id]?.trim() || null });
    setBusy(null);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: decision === 'approve' ? `Proposition « ${proposal.title} » appliquée` : `Proposition « ${proposal.title} » refusée` });
    await reload();
    await load();
  }

  return (
    <Card as="section" aria-label="Propositions en attente" className="gap-3">
      <TileHeader icon="messages" title="Propositions en attente" />
      {proposals.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">Aucune proposition en attente.</p> : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {proposals.map((proposal) => (
          <li key={proposal.id} className="flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0">
            <p className="m-0 font-sans text-app-14 font-medium text-text">
              {proposal.kind === 'rule' ? 'Règle' : 'Skill'} « {proposal.title} » · {proposal.targetId ? 'modification' : 'ajout'}
            </p>
            <p className="m-0 font-sans text-app-12 text-muted">
              Proposée par {proposal.author.name || proposal.author.email || 'un compte'} · {formatDateTimeShort(proposal.createdAt, now)}
              {proposal.note ? ` · « ${proposal.note} »` : ''}
            </p>
            <div className="max-h-64 overflow-auto rounded-md border border-border bg-surface px-4 py-3">
              <ClaudeMarkdown>{String(proposal.kind === 'rule' ? proposal.payload.body ?? '' : proposal.payload.skillMd ?? '')}</ClaudeMarkdown>
            </div>
            <Field label="Note pour l'auteur (facultative)">
              <Input value={notes[proposal.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [proposal.id]: event.target.value }))} maxLength={1000} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="accent" loading={busy === `${proposal.id}:approve`} loadingLabel="Application…" onClick={() => void decide(proposal, 'approve')}>
                Approuver
              </Button>
              <Button variant="default" loading={busy === `${proposal.id}:reject`} loadingLabel="Refus…" onClick={() => void decide(proposal, 'reject')}>
                Refuser
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <InlineError>{error}</InlineError>
    </Card>
  );
}
