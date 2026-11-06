'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Banner, Button, Card, Checkbox, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, IconButton, Input, Label, Select, Switch, TileHeader, toast } from '@/components/ui';
import type { SkillItem, SkillWriteResult } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { AUDIENCE_OPTIONS, ENFORCEMENT_OPTIONS, SCRIPTS_WARNING, plural } from '../lib/copy';
import { SectionIntro, useClaudeAdmin } from './AdminClaudeTab';
import { InlineError, ItemBadges, MarkdownEditor, VersionsDialog } from './parts';

/**
 * Skills: `SKILL.md` + text files, written by each runner in the `skills/` folder of its CLI (folders
 * marked « géré par Nuera Dev », replaced atomically, removed when deleted), offered as « commun » in
 * the composer's « / » palette. Import from a .zip (scripts refused unless allowed, with a warning) or
 * written in the editor.
 */

const NEW_SKILL_MD = '---\nname: mon-skill\ndescription: Quand Claude doit utiliser ce skill, en une phrase.\n---\n\n# Mon skill\n\nÉtapes à suivre…\n';

interface SkillDetail {
  skill: SkillItem;
  files: Array<{ path: string; content: string; executable: boolean }>;
}

export function SkillsSection() {
  const { overview, reload } = useClaudeAdmin();
  const skills = overview.rows.skills;
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<SkillItem | 'new' | null>(null);
  const [options, setOptions] = useState<SkillItem | null>(null);
  const [versions, setVersions] = useState<SkillItem | null>(null);
  const [deleting, setDeleting] = useState<SkillItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(skill: SkillItem, enabled: boolean) {
    const result = await claudeApi('PATCH', `/api/admin/claude/skills/${skill.id}`, { enabled, expectedVersion: skill.version });
    if (!result.ok) return setError(errorText(result.error));
    setError(null);
    toast({ message: enabled ? `Skill « ${skill.name} » activé` : `Skill « ${skill.name} » désactivé` });
    await reload();
  }

  return (
    <Card as="section" aria-label="Skills communs" className="gap-3">
      <TileHeader
        icon="sparkle"
        title="Skills communs"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" onClick={() => setEditing('new')}>
              Nouveau skill
            </Button>
            <Button variant="accent" onClick={() => setImporting(true)}>
              Importer un skill (.zip)
            </Button>
          </div>
        }
      />
      <SectionIntro>
        Écrits par chaque serveur dans le dossier skills de son CLI, en lecture seule, et proposés comme « commun » dans la palette « / »
        du compositeur. Un skill du même nom créé par le compte sur son serveur n'est jamais remplacé.
      </SectionIntro>
      {skills.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="Aucun skill commun"
          variant="plain"
          action={
            <Button variant="accent" onClick={() => setImporting(true)}>
              Importer un skill (.zip)
            </Button>
          }
        >
          Importez un dossier contenant SKILL.md (et ses références) ou écrivez-en un dans l'éditeur.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {skills.map((skill) => (
            <li key={skill.id} className="flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="m-0 font-mono text-app-14 font-medium text-text">/{skill.name}</p>
                  <ItemBadges
                    locked={skill.enforcement === 'locked'}
                    admins={skill.audience === 'admins'}
                    disabled={!skill.enabled}
                    extra={
                      <span className="font-mono text-app-11 text-muted">
                        v{skill.version} · {plural(skill.fileCount, 'fichier', 'fichiers')}
                        {skill.allowScripts ? ' · scripts autorisés' : ''}
                      </span>
                    }
                  />
                  <p className="m-0 line-clamp-2 font-sans text-app-12 text-muted">{skill.description}</p>
                </div>
                <Switch checked={skill.enabled} onCheckedChange={(next) => void toggle(skill, next)} aria-label={`Appliquer « ${skill.name} »`} />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <IconButton icon="edit" label={`Modifier « ${skill.name} »`} onClick={() => setEditing(skill)} />
                <IconButton icon="reglages" label={`Options de « ${skill.name} »`} onClick={() => setOptions(skill)} />
                <IconButton icon="history" label={`Versions de « ${skill.name} »`} onClick={() => setVersions(skill)} />
                <IconButton icon="trash" label={`Supprimer « ${skill.name} »`} onClick={() => setDeleting(skill)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <InlineError>{error}</InlineError>
      {importing ? <ImportDialog onClose={() => setImporting(false)} onDone={reload} /> : null}
      {editing ? <SkillEditor key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} skill={editing} onClose={() => setEditing(null)} onDone={reload} /> : null}
      {options ? <SkillOptions key={`${options.id}:${options.version}`} skill={options} onClose={() => setOptions(null)} onDone={reload} /> : null}
      <VersionsDialog
        open={versions !== null}
        onOpenChange={(open) => !open && setVersions(null)}
        title={versions ? `Versions de « ${versions.name} »` : 'Versions'}
        kind="skill"
        {...(versions ? { itemId: versions.id } : {})}
        onRestored={() => void reload()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        tone="danger"
        icon="trash"
        title={deleting ? `Supprimer le skill « ${deleting.name} » ?` : 'Supprimer le skill ?'}
        consequences={[
          { kind: 'risk', text: 'Chaque serveur retire son dossier à la prochaine synchronisation ; il disparaît de la palette.' },
          { kind: 'kept', text: "Ses versions (fichiers compris) restent dans l'historique : il peut être restauré." },
        ]}
        confirmLabel="Supprimer le skill"
        onConfirm={async () => {
          if (!deleting) return;
          const result = await claudeApi('DELETE', `/api/admin/claude/skills/${deleting.id}`);
          if (!result.ok) throw new Error(errorText(result.error));
          toast({ message: `Skill « ${deleting.name} » supprimé` });
          setDeleting(null);
          await reload();
        }}
      />
    </Card>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const formId = useId();
  const fileId = useId();
  const scriptsId = useId();
  const replaceId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [allowScripts, setAllowScripts] = useState(false);
  const [replace, setReplace] = useState(false);
  const [audience, setAudience] = useState<'all' | 'admins'>('all');
  const [enforcement, setEnforcement] = useState<'default' | 'locked'>('default');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return setError('Choisissez un fichier .zip.');
    const form = new FormData();
    form.set('file', file);
    if (allowScripts) form.set('allowScripts', 'on');
    if (replace) form.set('replace', 'on');
    form.set('audience', audience);
    form.set('enforcement', enforcement);
    setBusy(true);
    setError(null);
    const result = await claudeApi<SkillWriteResult>('POST', '/api/admin/claude/skills/import', form);
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    const { skill, scripts, created } = result.data;
    toast({
      message: `${created ? 'Skill importé' : 'Nouvelle version importée'} : « ${skill.name} » (version ${skill.version})${scripts.length ? ` · ${plural(scripts.length, 'script', 'scripts')}` : ''}`,
    });
    onClose();
    await onDone();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Importer un skill (.zip)"
        description="Un dossier avec SKILL.md (en-tête name et description) et ses fichiers texte : références, modèles, scripts. 4 Mio au plus."
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Import…">
              Importer
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          <Field label="Archive .zip" id={fileId}>
            <input
              id={fileId}
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="font-sans text-app-13 text-text file:mr-3 file:rounded-sm file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:font-sans file:text-app-13 file:text-text"
            />
          </Field>
          <div className="flex items-start gap-3">
            <Checkbox id={scriptsId} checked={allowScripts} onCheckedChange={setAllowScripts} />
            <Label htmlFor={scriptsId}>Autoriser les scripts</Label>
          </div>
          {allowScripts ? (
            <Banner tone="warn" icon="alert" title="Scripts exécutables sur chaque serveur">
              {SCRIPTS_WARNING}
            </Banner>
          ) : null}
          <div className="flex items-start gap-3">
            <Checkbox id={replaceId} checked={replace} onCheckedChange={setReplace} />
            <Label htmlFor={replaceId}>Remplacer la version actuelle d'un skill du même nom</Label>
          </div>
          {!replace ? (
            <div className="grid grid-cols-1 gap-4 nav:grid-cols-2">
              <Field label="Application">
                <Select options={ENFORCEMENT_OPTIONS} value={enforcement} onValueChange={(value) => setEnforcement(value as 'default' | 'locked')} aria-label="Application" />
              </Field>
              <Field label="Pour">
                <Select options={AUDIENCE_OPTIONS} value={audience} onValueChange={(value) => setAudience(value as 'all' | 'admins')} aria-label="Pour" />
              </Field>
            </div>
          ) : null}
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SkillEditor({ skill, onClose, onDone }: { skill: SkillItem | 'new'; onClose: () => void; onDone: () => Promise<void> }) {
  const existing = skill !== 'new' ? skill : null;
  const formId = useId();
  const [name, setName] = useState(existing?.name ?? '');
  const [skillMd, setSkillMd] = useState(existing ? '' : NEW_SKILL_MD);
  const [files, setFiles] = useState<SkillDetail['files']>([]);
  const [loading, setLoading] = useState(Boolean(existing));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!existing) return;
    let cancelled = false;
    void claudeApi<SkillDetail>('GET', `/api/admin/claude/skills/${existing.id}`).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) return setError(errorText(result.error));
      setSkillMd(result.data.files.find((file) => file.path === 'SKILL.md')?.content ?? '');
      setFiles(result.data.files.filter((file) => file.path !== 'SKILL.md'));
    });
    return () => {
      cancelled = true;
    };
  }, [existing]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = existing
      ? await claudeApi<SkillWriteResult>('PUT', `/api/admin/claude/skills/${existing.id}/content`, { skillMd, expectedVersion: existing.version })
      : await claudeApi<SkillWriteResult>('POST', '/api/admin/claude/skills', { name, skillMd });
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: `Skill « ${result.data.skill.name} » enregistré (version ${result.data.skill.version})` });
    onClose();
    await onDone();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={existing ? `Modifier « ${existing.name} »` : 'Nouveau skill'}
        description="SKILL.md commence par un en-tête --- name: … description: … --- : la description dit à Claude quand utiliser le skill."
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Enregistrement…" disabled={loading}>
              Enregistrer
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          {existing ? null : (
            <Field label="Nom" hint="Minuscules, chiffres et tirets : le skill s'appelle /nom dans le CLI. Il doit être celui du champ name.">
              <Input value={name} onChange={(event) => setName(event.target.value.trim())} maxLength={64} mono placeholder="mon-skill" />
            </Field>
          )}
          {loading ? <p className="m-0 font-sans text-app-13 text-muted">Lecture du skill…</p> : <MarkdownEditor label="SKILL.md" value={skillMd} onChange={setSkillMd} rows={16} />}
          {files.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="m-0 font-sans text-app-13 font-medium text-text">Autres fichiers (gardés tels quels)</p>
              <ul className="m-0 flex list-none flex-col p-0">
                {files.map((file) => (
                  <li key={file.path} className="font-mono text-app-12 text-muted">
                    {file.path}
                    {file.executable ? ' · exécutable' : ''} · {file.content.length.toLocaleString('fr-FR')} caractères
                  </li>
                ))}
              </ul>
              <p className="m-0 font-sans text-app-12 text-muted">Pour les changer, importez une nouvelle version (.zip) avec « Remplacer la version actuelle ».</p>
            </div>
          ) : null}
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SkillOptions({ skill, onClose, onDone }: { skill: SkillItem; onClose: () => void; onDone: () => Promise<void> }) {
  const formId = useId();
  const scriptsId = useId();
  const [audience, setAudience] = useState(skill.audience);
  const [enforcement, setEnforcement] = useState(skill.enforcement);
  const [allowScripts, setAllowScripts] = useState(skill.allowScripts);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await claudeApi('PATCH', `/api/admin/claude/skills/${skill.id}`, { audience, enforcement, allowScripts, expectedVersion: skill.version });
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: `Options de « ${skill.name} » enregistrées` });
    onClose();
    await onDone();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={`Options de « ${skill.name} »`}
        size="sm"
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Enregistrement…">
              Enregistrer
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          <Field label="Application" hint={ENFORCEMENT_OPTIONS.find((option) => option.value === enforcement)?.description}>
            <Select options={ENFORCEMENT_OPTIONS} value={enforcement} onValueChange={(value) => setEnforcement(value as 'default' | 'locked')} aria-label="Application" />
          </Field>
          <Field label="Pour">
            <Select options={AUDIENCE_OPTIONS} value={audience} onValueChange={(value) => setAudience(value as 'all' | 'admins')} aria-label="Pour" />
          </Field>
          <div className="flex items-start gap-3">
            <Checkbox id={scriptsId} checked={allowScripts} onCheckedChange={setAllowScripts} />
            <Label htmlFor={scriptsId}>Autoriser les scripts</Label>
          </div>
          {allowScripts ? <p className="m-0 font-sans text-app-12 text-warn">{SCRIPTS_WARNING}</p> : null}
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}
