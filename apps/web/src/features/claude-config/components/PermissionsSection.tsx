'use client';

import { useState } from 'react';
import { Button, Card, CompactButton, Field, IconButton, Input, Select, TileHeader, toast } from '@/components/ui';
import type { PolicyItem } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { ENFORCEMENT_OPTIONS } from '../lib/copy';
import { SectionIntro, useClaudeAdmin } from './AdminClaudeTab';
import { InlineError, VersionsDialog } from './parts';

/**
 * Permissions et réglages communs: `permissions.allow | ask | deny` of Claude Code (deny wins over ask,
 * ask over allow, in every mode — a project `allow` never lifts an instance `ask`), non-secret
 * variables (« Imposé » in the session settings, « Par défaut » under the project's variables) and the
 * model of new sessions.
 */

type ListKey = 'allow' | 'ask' | 'deny';
type Draft = { id?: string; rule: string; enforcement: 'default' | 'locked'; note?: string | null };
type EnvDraft = { id?: string; name: string; value: string; enforcement: 'default' | 'locked' };

const LISTS: Array<{ key: ListKey; title: string; hint: string; placeholder: string }> = [
  { key: 'deny', title: 'Toujours refuser', hint: 'Refusé dans tous les modes, même sans autorisation.', placeholder: 'Bash(rm -rf /*)' },
  { key: 'ask', title: 'Toujours demander', hint: "Une demande d'autorisation, même si le projet autorise la commande.", placeholder: 'Bash(git push:*)' },
  { key: 'allow', title: 'Autoriser sans demander', hint: "Ajouté aux autorisations ; n'annule jamais un refus ou une demande.", placeholder: 'Bash(npm test:*)' },
];

export function PermissionsSection() {
  const { overview, reload } = useClaudeAdmin();
  const policy = overview.rows.policy;
  const [lists, setLists] = useState<Record<ListKey, Draft[]>>(() => ({ allow: policy.allow, ask: policy.ask, deny: policy.deny }));
  const [env, setEnv] = useState<EnvDraft[]>(() => policy.env);
  const [model, setModel] = useState(policy.defaultModel ?? '');
  const [modelEnforcement, setModelEnforcement] = useState(policy.modelEnforcement);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState<PolicyItem>(policy);

  // A reload with a newer version (another administrator, rollback): start from it again.
  if (policy.version !== base.version) {
    setBase(policy);
    setLists({ allow: policy.allow, ask: policy.ask, deny: policy.deny });
    setEnv(policy.env);
    setModel(policy.defaultModel ?? '');
    setModelEnforcement(policy.modelEnforcement);
  }

  const update = (key: ListKey, index: number, patch: Partial<Draft>) =>
    setLists((current) => ({ ...current, [key]: current[key].map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) }));

  async function save() {
    setBusy(true);
    setError(null);
    const clean = (entries: Draft[]) => entries.filter((entry) => entry.rule.trim()).map((entry) => ({ ...entry, rule: entry.rule.trim() }));
    const result = await claudeApi<{ policy: PolicyItem }>('PATCH', '/api/admin/claude/policy', {
      allow: clean(lists.allow),
      ask: clean(lists.ask),
      deny: clean(lists.deny),
      env: env.filter((entry) => entry.name.trim()).map((entry) => ({ ...entry, name: entry.name.trim() })),
      defaultModel: model.trim() || null,
      modelEnforcement,
      expectedVersion: policy.version,
    });
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: 'Permissions et réglages communs enregistrés' });
    await reload();
  }

  return (
    <Card as="section" aria-label="Permissions et réglages communs" className="gap-4">
      <TileHeader
        icon="shield"
        title="Permissions et réglages communs"
        action={
          <CompactButton variant="discret" icon="history" onClick={() => setVersionsOpen(true)}>
            Versions
          </CompactButton>
        }
      />
      <SectionIntro>
        Règles de permission de Claude Code ajoutées aux réglages de chaque session (Outil, Outil(motif) ou mcp__serveur__outil). Un
        refus l'emporte sur une demande, une demande sur une autorisation, quel que soit le projet.
      </SectionIntro>
      {LISTS.map((list) => (
        <div key={list.key} className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <p className="m-0 font-sans text-app-14 font-semibold text-text">{list.title}</p>
            <p className="m-0 font-sans text-app-12 text-muted">{list.hint}</p>
          </div>
          {lists[list.key].map((entry, index) => (
            <div key={entry.id ?? `new-${index}`} className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                aria-label={`${list.title} : règle ${index + 1}`}
                value={entry.rule}
                onChange={(event) => update(list.key, index, { rule: event.target.value })}
                placeholder={list.placeholder}
                shellClassName="min-w-0 flex-1 basis-60"
                className="font-mono"
              />
              <Select
                options={ENFORCEMENT_OPTIONS}
                value={entry.enforcement}
                onValueChange={(value) => update(list.key, index, { enforcement: value as 'default' | 'locked' })}
                aria-label={`${list.title} : application de la règle ${index + 1}`}
                className="w-36"
              />
              <IconButton
                icon="trash"
                label={`Retirer la règle ${entry.rule || index + 1}`}
                onClick={() => setLists((current) => ({ ...current, [list.key]: current[list.key].filter((_, i) => i !== index) }))}
              />
            </div>
          ))}
          <CompactButton
            variant="secondaire"
            icon="plus"
            className="self-start"
            onClick={() => setLists((current) => ({ ...current, [list.key]: [...current[list.key], { rule: '', enforcement: 'default' }] }))}
          >
            Ajouter une règle
          </CompactButton>
        </div>
      ))}

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="m-0 font-sans text-app-14 font-semibold text-text">Variables d'environnement</p>
          <p className="m-0 font-sans text-app-12 text-muted">
            Valeurs non secrètes (un nom qui évoque un secret est refusé). « Imposé » : dans les réglages de la session, au-dessus du projet.
            « Par défaut » : les variables du projet l'emportent.
          </p>
        </div>
        {env.map((entry, index) => (
          <div key={entry.id ?? `env-${index}`} className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              aria-label={`Nom de la variable ${index + 1}`}
              value={entry.name}
              onChange={(event) => setEnv((current) => current.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))}
              placeholder="TZ"
              shellClassName="w-48"
              className="font-mono"
            />
            <Input
              aria-label={`Valeur de la variable ${index + 1}`}
              value={entry.value}
              onChange={(event) => setEnv((current) => current.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
              placeholder="Europe/Paris"
              shellClassName="min-w-0 flex-1 basis-40"
              className="font-mono"
            />
            <Select
              options={ENFORCEMENT_OPTIONS}
              value={entry.enforcement}
              onValueChange={(value) => setEnv((current) => current.map((item, i) => (i === index ? { ...item, enforcement: value as 'default' | 'locked' } : item)))}
              aria-label={`Application de la variable ${index + 1}`}
              className="w-36"
            />
            <IconButton icon="trash" label={`Retirer la variable ${entry.name || index + 1}`} onClick={() => setEnv((current) => current.filter((_, i) => i !== index))} />
          </div>
        ))}
        <CompactButton variant="secondaire" icon="plus" className="self-start" onClick={() => setEnv((current) => [...current, { name: '', value: '', enforcement: 'default' }])}>
          Ajouter une variable
        </CompactButton>
      </div>

      <div className="grid grid-cols-1 gap-4 nav:grid-cols-2">
        <Field label="Modèle des nouvelles sessions" hint="Alias (opus, sonnet…) ou nom complet. Vide : celui de l'espace, sinon celui du CLI.">
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="opus" className="font-mono" />
        </Field>
        <Field label="Application du modèle" hint={modelEnforcement === 'locked' ? 'Chaque session démarre avec ce modèle ; le réglage des espaces devient en lecture seule.' : "Utilisé quand l'espace n'a pas choisi de modèle."}>
          <Select options={ENFORCEMENT_OPTIONS} value={modelEnforcement} onValueChange={(value) => setModelEnforcement(value as 'default' | 'locked')} aria-label="Application du modèle" />
        </Field>
      </div>

      <InlineError>{error}</InlineError>
      <Button variant="accent" className="self-start" onClick={() => void save()} loading={busy} loadingLabel="Enregistrement…">
        Enregistrer les permissions et réglages
      </Button>
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} title="Versions des permissions et réglages" kind="policy" itemId="instance" onRestored={() => void reload()} />
    </Card>
  );
}

