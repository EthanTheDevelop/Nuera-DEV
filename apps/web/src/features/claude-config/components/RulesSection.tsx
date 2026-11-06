'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, Card, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, IconButton, Input, Select, Switch, TileHeader, toast } from '@/components/ui';
import type { RuleItem } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { AUDIENCE_OPTIONS, ENFORCEMENT_OPTIONS } from '../lib/copy';
import { SectionIntro, useClaudeAdmin } from './AdminClaudeTab';
import { InlineError, ItemBadges, MarkdownEditor, VersionsDialog } from './parts';

/**
 * Règles: Markdown sections, in order, each « Imposé » (system prompt of every session, before the
 * project's CLAUDE.md, which cannot take precedence) or « Par défaut » (user-level memory, loaded
 * before the project's CLAUDE.md; a space may turn it off), for every account or administrators only.
 */
export function RulesSection() {
  const { overview, reload } = useClaudeAdmin();
  const rules = overview.rows.rules;
  const [editing, setEditing] = useState<RuleItem | 'new' | null>(null);
  const [versions, setVersions] = useState<RuleItem | null>(null);
  const [deleting, setDeleting] = useState<RuleItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function move(index: number, delta: -1 | 1) {
    const ids = rules.map((rule) => rule.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    const result = await claudeApi('POST', '/api/admin/claude/rules/order', { ids });
    if (!result.ok) return setError(errorText(result.error));
    setError(null);
    await reload();
  }

  async function toggle(rule: RuleItem, enabled: boolean) {
    const result = await claudeApi('PATCH', `/api/admin/claude/rules/${rule.id}`, { enabled, expectedVersion: rule.version });
    if (!result.ok) return setError(errorText(result.error));
    setError(null);
    toast({ message: enabled ? `Règle « ${rule.title} » activée` : `Règle « ${rule.title} » désactivée` });
    await reload();
  }

  return (
    <Card as="section" aria-label="Règles communes" className="gap-3">
      <TileHeader
        icon="book"
        title="Règles communes"
        action={
          <Button variant="accent" onClick={() => setEditing('new')}>
            Nouvelle règle
          </Button>
        }
      />
      <SectionIntro>
        Normes de développement partagées, en Markdown, dans cet ordre. « Par défaut » : chargées par le CLI avant le CLAUDE.md du
        projet, qui peut les préciser. « Imposé » : ajoutées aux instructions système de chaque session, prioritaires sur le projet.
      </SectionIntro>
      {rules.length === 0 ? (
        <EmptyState icon="book" title="Aucune règle commune" variant="plain" action={<Button onClick={() => setEditing('new')}>Nouvelle règle</Button>}>
          Écrivez les normes que Claude doit suivre dans toutes les sessions : messages de commit, tests, secrets, revue…
        </EmptyState>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {rules.map((rule, index) => (
            <li key={rule.id} className="flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 w-6 shrink-0 font-mono text-app-12 text-muted">{index + 1}.</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="m-0 font-sans text-app-14 font-medium text-text">{rule.title}</p>
                  <ItemBadges locked={rule.enforcement === 'locked'} admins={rule.audience === 'admins'} disabled={!rule.enabled} extra={<span className="font-mono text-app-11 text-muted">v{rule.version}</span>} />
                  <p className="m-0 line-clamp-2 font-sans text-app-12 text-muted">{rule.body}</p>
                </div>
                <Switch checked={rule.enabled} onCheckedChange={(next) => void toggle(rule, next)} aria-label={`Appliquer « ${rule.title} »`} />
              </div>
              <div className="flex flex-wrap items-center gap-1 pl-9">
                <IconButton icon="chevron" label="Monter" className="-rotate-90" disabled={index === 0} onClick={() => void move(index, -1)} />
                <IconButton icon="chevron-down" label="Descendre" disabled={index === rules.length - 1} onClick={() => void move(index, 1)} />
                <IconButton icon="edit" label={`Modifier « ${rule.title} »`} onClick={() => setEditing(rule)} />
                <IconButton icon="history" label={`Versions de « ${rule.title} »`} onClick={() => setVersions(rule)} />
                <IconButton icon="trash" label={`Supprimer « ${rule.title} »`} onClick={() => setDeleting(rule)} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <InlineError>{error}</InlineError>
      {editing ? <RuleEditor key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} rule={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
      <VersionsDialog
        open={versions !== null}
        onOpenChange={(open) => !open && setVersions(null)}
        title={versions ? `Versions de « ${versions.title} »` : 'Versions'}
        kind="rule"
        {...(versions ? { itemId: versions.id } : {})}
        onRestored={() => void reload()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        tone="danger"
        icon="trash"
        title={deleting ? `Supprimer la règle « ${deleting.title} » ?` : 'Supprimer la règle ?'}
        consequences={[
          { kind: 'risk', text: 'Elle disparaît des prochaines sessions de tous les comptes.' },
          { kind: 'kept', text: "Ses versions restent dans l'historique : elle peut être restaurée." },
        ]}
        confirmLabel="Supprimer la règle"
        onConfirm={async () => {
          if (!deleting) return;
          const result = await claudeApi('DELETE', `/api/admin/claude/rules/${deleting.id}`);
          if (!result.ok) throw new Error(errorText(result.error));
          toast({ message: `Règle « ${deleting.title} » supprimée` });
          setDeleting(null);
          await reload();
        }}
      />
    </Card>
  );
}

function RuleEditor({ rule, onClose, onSaved }: { rule: RuleItem | 'new'; onClose: () => void; onSaved: () => Promise<void> }) {
  const existing = rule !== 'new' ? rule : null;
  const formId = useId();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [enforcement, setEnforcement] = useState<'default' | 'locked'>(existing?.enforcement ?? 'default');
  const [audience, setAudience] = useState<'all' | 'admins'>(existing?.audience ?? 'all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return setError('Titre et texte requis.');
    setBusy(true);
    setError(null);
    const payload = { title, body, enforcement, audience };
    const result = existing
      ? await claudeApi('PATCH', `/api/admin/claude/rules/${existing.id}`, { ...payload, expectedVersion: existing.version })
      : await claudeApi('POST', '/api/admin/claude/rules', payload);
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: existing ? `Règle « ${title.trim()} » enregistrée` : `Règle « ${title.trim()} » ajoutée` });
    onClose();
    await onSaved();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={existing ? `Modifier « ${existing.title} »` : 'Nouvelle règle'}
        description="Texte Markdown donné à Claude Code. Une nouvelle version est gardée à chaque enregistrement."
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Enregistrement…">
              {existing ? 'Enregistrer' : 'Ajouter la règle'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={save} noValidate className="flex min-w-0 flex-col gap-4">
          <Field label="Titre">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Messages de commit" />
          </Field>
          <MarkdownEditor label="Texte" value={body} onChange={setBody} placeholder={'- Messages conventionnels sobres (feat:, fix:…).\n- Jamais de secret dans un commit.'} />
          <div className="grid grid-cols-1 gap-4 nav:grid-cols-2">
            <Field label="Application" hint={ENFORCEMENT_OPTIONS.find((option) => option.value === enforcement)?.description}>
              <Select options={ENFORCEMENT_OPTIONS} value={enforcement} onValueChange={(value) => setEnforcement(value as 'default' | 'locked')} aria-label="Application" />
            </Field>
            <Field label="Pour">
              <Select options={AUDIENCE_OPTIONS} value={audience} onValueChange={(value) => setAudience(value as 'all' | 'admins')} aria-label="Pour" />
            </Field>
          </div>
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}
