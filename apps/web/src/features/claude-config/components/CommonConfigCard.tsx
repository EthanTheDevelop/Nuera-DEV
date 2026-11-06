'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { formatDateTimeShort } from '@nuera/shared/format';
import { ClaudeMarkdown } from '@/components/dev/conversation/ClaudeMarkdown';
import { Badge, Button, Card, CompactButton, Dialog, DialogContent, Field, Input, LinkButton, SegmentedControl, Switch, Textarea, TileHeader, toast } from '@/components/ui';
import type { EffectiveState, MyClaudeConfigView, ProposalView } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { APPLY_NOTE } from '../lib/copy';
import { InlineError, ItemBadges, MarkdownEditor } from './parts';

/**
 * Paramètres › Claude Code › « Configuration commune » (lot K1): what the instance gives to this
 * account's sessions (rules, skills, MCP servers, permissions, variables, model), « Imposé » or
 * « Par défaut », the copy on its server, and — for the owner of the space — the switches that turn a
 * « Par défaut » item off for the space. Every account may propose a rule or a skill.
 */

interface ConfigResponse {
  config: MyClaudeConfigView;
  proposals: ProposalView[];
}

const PROPOSAL_STATUS = { pending: 'en attente', approved: 'approuvée', rejected: 'refusée', withdrawn: 'retirée' } as const;
const LIST_LABELS = { allow: 'autoriser', ask: 'demander', deny: 'refuser' } as const;

export function CommonConfigCard() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [proposing, setProposing] = useState(false);

  const load = useCallback(async () => {
    const result = await claudeApi<ConfigResponse>('GET', '/api/claude/config');
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else setError(errorText(result.error));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(item: EffectiveState, applied: boolean) {
    const result = await claudeApi<{ config: MyClaudeConfigView }>('PATCH', '/api/claude/config/overrides', { key: item.key, disabled: !applied });
    if (!result.ok) return setError(errorText(result.error));
    setError(null);
    setData((current) => (current ? { ...current, config: result.data.config } : current));
    toast({ message: applied ? 'Élément appliqué à votre espace' : 'Élément désactivé pour votre espace' });
  }

  const [now] = useState(() => new Date().toISOString());
  const config = data?.config ?? null;
  const effective = config?.effective ?? null;

  return (
    <Card as="section" aria-label="Configuration commune" className="gap-3">
      <TileHeader
        icon="sparkle"
        title="Configuration commune"
        action={
          effective ? (
            <CompactButton variant="secondaire" icon="eye" onClick={() => setDetails(true)}>
              Voir le détail
            </CompactButton>
          ) : null
        }
      />
      {!data && !error ? <p className="m-0 font-sans text-app-13 text-muted">Lecture…</p> : null}
      {config && effective ? (
        <>
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
            Donnée par l'administration de l'instance à toutes vos sessions, avant le CLAUDE.md du projet : <span className="font-medium text-text">{config.summary}</span>
            {effective.counts.permissions ? ` · ${effective.counts.permissions} règles de permission` : ''}
            {effective.model.value ? ` · modèle ${effective.model.value}${effective.model.locked ? ' (imposé)' : ''}` : ''}. Révision {effective.revision}.
          </p>
          <p className="m-0 font-sans text-app-12 text-muted">{APPLY_NOTE}</p>
          {config.server ? (
            <p className="m-0 font-sans text-app-12 text-muted">
              {config.server.upToDate
                ? `À jour sur ${config.server.name}${config.server.appliedAt ? ` depuis ${formatDateTimeShort(config.server.appliedAt, now)}` : ''}.`
                : config.server.error
                  ? config.server.error
                  : `${config.server.name} n'a pas encore reçu la dernière révision : elle s'appliquera au prochain démarrage d'une session.`}
              {config.server.conflicts.map((conflict) => ` ${conflict.name} : ${conflict.reason}`).join('')}
            </p>
          ) : null}
          {config.canChoose && hasDefaults(config) ? (
            <p className="m-0 font-sans text-app-12 text-muted">Ouvrez le détail pour désactiver, dans votre espace, un élément « Par défaut ».</p>
          ) : null}
        </>
      ) : null}
      <InlineError>{error}</InlineError>
      <div className="flex flex-wrap gap-2">
        <CompactButton variant="secondaire" icon="plus" onClick={() => setProposing(true)}>
          Proposer une règle ou un skill
        </CompactButton>
      </div>
      {data && data.proposals.length > 0 ? <MyProposals proposals={data.proposals} onChange={load} /> : null}
      {details && config ? <DetailsDialog config={config} onClose={() => setDetails(false)} onToggle={toggle} /> : null}
      {proposing ? <ProposeDialog onClose={() => setProposing(false)} onDone={load} /> : null}
    </Card>
  );
}

function hasDefaults(config: MyClaudeConfigView): boolean {
  const e = config.effective;
  return [...e.rules, ...e.skills, ...e.mcp, ...e.permissions, ...e.env].some((item) => !item.locked);
}

function ToggleOrBadge({ item, canChoose, label, onToggle }: { item: EffectiveState; canChoose: boolean; label: string; onToggle: (item: EffectiveState, applied: boolean) => void }) {
  if (item.locked || !canChoose) return null;
  return <Switch checked={item.applied} onCheckedChange={(next) => onToggle(item, next)} aria-label={`Appliquer ${label} à mon espace`} />;
}

function DetailsDialog({ config, onClose, onToggle }: { config: MyClaudeConfigView; onClose: () => void; onToggle: (item: EffectiveState, applied: boolean) => void }) {
  const e = config.effective;
  const [open, setOpen] = useState<string | null>(null);
  const row = 'flex min-w-0 items-start justify-between gap-3 border-b border-border py-2 last:border-b-0';
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Configuration commune"
        description={`Révision ${e.revision} · « Imposé » s'applique toujours ; « Par défaut » peut être désactivé pour votre espace.`}
        size="lg"
        footer={
          <Button variant="default" onClick={onClose}>
            Fermer
          </Button>
        }
      >
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-1">
            <h3 className="m-0 font-sans text-app-14 font-semibold text-text">Règles</h3>
            {e.rules.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">Aucune règle commune.</p> : null}
            <ul className="m-0 flex list-none flex-col p-0">
              {e.rules.map((rule) => (
                <li key={rule.id} className="flex min-w-0 flex-col gap-2 border-b border-border py-2 last:border-b-0">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="font-sans text-app-13 font-medium text-text">{rule.title}</span>
                      <ItemBadges locked={rule.locked} admins={rule.audience === 'admins'} disabled={rule.disabledBySpace} />
                      <LinkButton size={13} className="self-start" onClick={() => setOpen(open === rule.id ? null : rule.id)}>
                        {open === rule.id ? 'Masquer le texte' : 'Lire le texte'}
                      </LinkButton>
                    </div>
                    <ToggleOrBadge item={rule} canChoose={config.canChoose} label={`« ${rule.title} »`} onToggle={onToggle} />
                  </div>
                  {open === rule.id ? (
                    <div className="rounded-md border border-border bg-surface px-4 py-3">
                      <ClaudeMarkdown>{rule.body}</ClaudeMarkdown>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="m-0 font-sans text-app-14 font-semibold text-text">Skills</h3>
            {e.skills.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">Aucun skill commun.</p> : null}
            <ul className="m-0 flex list-none flex-col p-0">
              {e.skills.map((skill) => (
                <li key={skill.id} className={row}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-app-13 font-medium text-text">/{skill.name}</span>
                    <span className="font-sans text-app-12 text-muted">{skill.description}</span>
                    <ItemBadges locked={skill.locked} admins={skill.audience === 'admins'} disabled={skill.disabledBySpace} extra={<span className="font-mono text-app-11 text-muted">v{skill.version}</span>} />
                  </div>
                  <ToggleOrBadge item={skill} canChoose={config.canChoose} label={`/${skill.name}`} onToggle={onToggle} />
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="m-0 font-sans text-app-14 font-semibold text-text">Serveurs MCP</h3>
            {e.mcp.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">Aucun serveur MCP commun.</p> : null}
            <ul className="m-0 flex list-none flex-col p-0">
              {e.mcp.map((server) => (
                <li key={server.id} className={row}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="font-sans text-app-13 font-medium text-text">
                      {server.label} <span className="font-mono text-app-12 text-muted">mcp__{server.name}</span>
                    </span>
                    <ItemBadges locked={server.locked} admins={server.audience === 'admins'} disabled={server.disabledBySpace} />
                    {server.unavailable ? <span className="font-sans text-app-12 text-warn">{server.unavailable}</span> : null}
                  </div>
                  <ToggleOrBadge item={server} canChoose={config.canChoose} label={server.label} onToggle={onToggle} />
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="m-0 font-sans text-app-14 font-semibold text-text">Permissions et variables</h3>
            {e.permissions.length + e.env.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">Aucune règle de permission ni variable commune.</p> : null}
            <ul className="m-0 flex list-none flex-col p-0">
              {e.permissions.map((entry) => (
                <li key={entry.id} className={row}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-app-12 text-text">
                      {LIST_LABELS[entry.list]} · {entry.rule}
                    </span>
                    <ItemBadges locked={entry.locked} disabled={entry.disabledBySpace} />
                  </div>
                  <ToggleOrBadge item={entry} canChoose={config.canChoose} label={entry.rule} onToggle={onToggle} />
                </li>
              ))}
              {e.env.map((entry) => (
                <li key={entry.id} className={row}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-app-12 text-text">
                      {entry.name}={entry.value}
                    </span>
                    <ItemBadges locked={entry.locked} disabled={entry.disabledBySpace} />
                  </div>
                  <ToggleOrBadge item={entry} canChoose={config.canChoose} label={entry.name} onToggle={onToggle} />
                </li>
              ))}
            </ul>
            {e.model.value ? (
              <p className="m-0 font-sans text-app-12 text-muted">
                Modèle des nouvelles sessions : <span className="font-mono">{e.model.value}</span> {e.model.locked ? '(imposé)' : "(si l'espace n'en choisit pas)"}.
              </p>
            ) : null}
          </section>
          <p className="m-0 font-sans text-app-12 text-muted">{APPLY_NOTE}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProposeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const formId = useId();
  const [kind, setKind] = useState<'rule' | 'skill'>('rule');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [skillMd, setSkillMd] = useState('---\nname: mon-skill\ndescription: Quand Claude doit utiliser ce skill.\n---\n\n');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const payload = kind === 'rule' ? { kind, title, body, note: note || null } : { kind, name, skillMd, note: note || null };
    const result = await claudeApi('POST', '/api/claude/proposals', payload);
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: 'Proposition envoyée aux administrateurs' });
    onClose();
    await onDone();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Proposer une règle ou un skill"
        description="Les administrateurs de l'instance la relisent : elle ne s'applique qu'une fois approuvée."
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Envoi…">
              Envoyer la proposition
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          <SegmentedControl
            aria-label="Type de proposition"
            value={kind}
            onValueChange={setKind}
            items={[
              { value: 'rule', label: 'Règle', icon: 'book' },
              { value: 'skill', label: 'Skill', icon: 'sparkle' },
            ]}
          />
          {kind === 'rule' ? (
            <>
              <Field label="Titre">
                <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
              </Field>
              <MarkdownEditor label="Texte" value={body} onChange={setBody} rows={8} />
            </>
          ) : (
            <>
              <Field label="Nom" hint="Minuscules, chiffres et tirets ; identique au champ name de SKILL.md.">
                <Input value={name} onChange={(event) => setName(event.target.value.trim())} maxLength={64} />
              </Field>
              <MarkdownEditor label="SKILL.md" value={skillMd} onChange={setSkillMd} rows={10} />
            </>
          )}
          <Field label="Message aux administrateurs (facultatif)">
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={1000} />
          </Field>
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MyProposals({ proposals, onChange }: { proposals: ProposalView[]; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  async function withdraw(proposal: ProposalView) {
    const result = await claudeApi('DELETE', `/api/claude/proposals/${proposal.id}`);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: `Proposition « ${proposal.title} » retirée` });
    await onChange();
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 font-sans text-app-13 font-medium text-text">Mes propositions</p>
      <ul className="m-0 flex list-none flex-col p-0">
        {proposals.slice(0, 10).map((proposal) => (
          <li key={proposal.id} className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
            <span className="min-w-0 font-sans text-app-13 text-text">
              {proposal.kind === 'rule' ? 'Règle' : 'Skill'} « {proposal.title} »{' '}
              <Badge tone={proposal.status === 'approved' ? 'success' : proposal.status === 'rejected' ? 'danger' : 'neutral'}>{PROPOSAL_STATUS[proposal.status]}</Badge>
              {proposal.reviewNote ? <span className="block font-sans text-app-12 text-muted">« {proposal.reviewNote} »</span> : null}
            </span>
            {proposal.status === 'pending' ? (
              <LinkButton size={13} onClick={() => void withdraw(proposal)}>
                Retirer
              </LinkButton>
            ) : null}
          </li>
        ))}
      </ul>
      <InlineError>{error}</InlineError>
    </div>
  );
}
