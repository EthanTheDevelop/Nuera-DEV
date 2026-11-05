'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { parseRunnerEvent } from '@nuera/shared/events';
import { plural } from '@nuera/shared/format';
import { CommandOutput, commandRunBadge } from '@/components/dev';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  ErrorPanel,
  Field,
  Input,
  SecretField,
  Switch,
  Textarea,
  toast,
  type Consequence,
} from '@/components/ui';
import type { EnvVarView, ProjectCommands, RunView, WorktreeRemovalPreview, WorktreeView } from '@/server/projects/types';
import { failureOf, projectsApi } from '../api';
import { COMMAND_FIELDS, type CommandKey } from '../add/ConfigStep';
import type { Failure } from '../FailureBanner';
import { runSummary } from './model';

// ---------------------------------------------------------------------------------------------
// Variables d'environnement
// ---------------------------------------------------------------------------------------------

export type EnvDialogTarget = { mode: 'add' } | { mode: 'edit'; variable: EnvVarView };

/**
 * Add / edit / replace a project variable (not drawn: Dialog in the D03 language). A secret is
 * never shown: its field starts empty and replaces the value. Delete goes through a T8 dialog.
 */
export function EnvVarDialog({
  projectId,
  target,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  target: EnvDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const keyId = useId();
  const valueId = useId();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setFailure(null);
    setPending(false);
    if (target.mode === 'add') {
      setKey('');
      setValue('');
      setSecret(true);
    } else {
      setKey(target.variable.key);
      setValue(target.variable.secret ? '' : (target.variable.value ?? ''));
      setSecret(target.variable.secret);
    }
  }, [target]);

  if (!target) return null;
  const editing = target.mode === 'edit' ? target.variable : null;
  const replacingSecret = Boolean(editing?.secret);
  // A secret becoming visible needs a new value (the old one is never sent to the browser).
  const needsValue = !editing || (replacingSecret && !secret);
  const valueMissing = needsValue && value === '';
  const nameInvalid = !editing && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key.trim());

  const save = async () => {
    if (pending || nameInvalid || valueMissing) return;
    setPending(true);
    setFailure(null);
    try {
      if (!editing) {
        await projectsApi.createEnv(projectId, { key: key.trim(), value, secret });
        toast({ message: `Variable ${key.trim()} ajoutée` });
      } else {
        const body: { id: string; value?: string; secret?: boolean } = { id: editing.id };
        if (replacingSecret ? value !== '' : value !== (editing.value ?? '')) body.value = value;
        if (secret !== editing.secret) body.secret = secret;
        await projectsApi.updateEnv(projectId, body);
        toast({ message: `Variable ${editing.key} enregistrée` });
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setFailure(failureOf(error, "La variable n'a pas pu être enregistrée."));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !pending && onOpenChange(open)}>
        <DialogContent
          size="sm"
          title={editing ? (replacingSecret ? `Remplacer ${editing.key}` : `Modifier ${editing.key}`) : 'Ajouter une variable'}
          description="Chiffrée sur le serveur et donnée aux commandes du projet. Jamais écrite dans un fichier versionné."
          dismissible={!pending}
          footer={
            <>
              {editing ? (
                <Button onClick={() => setConfirmDelete(true)} disabled={pending}>
                  Supprimer
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)} disabled={pending}>
                Annuler
              </Button>
              <Button variant="accent" onClick={() => void save()} loading={pending} disabled={nameInvalid || valueMissing}>
                Enregistrer
              </Button>
            </>
          }
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field id={keyId} label="Nom" hint={editing ? undefined : 'Lettres, chiffres et _ (par exemple DATABASE_URL).'} error={key && nameInvalid ? 'Nom invalide.' : undefined}>
              <Input mono value={key} onChange={(event) => setKey(event.target.value)} disabled={Boolean(editing)} autoComplete="off" spellCheck={false} autoFocus={!editing} />
            </Field>
            <Field
              id={valueId}
              label={replacingSecret ? 'Nouvelle valeur' : 'Valeur'}
              hint={replacingSecret ? 'La valeur actuelle reste secrète : laissez vide pour la garder.' : undefined}
            >
              {secret ? (
                <SecretField value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" placeholder={replacingSecret ? 'Valeur actuelle conservée' : undefined} autoFocus={Boolean(editing)} />
              ) : (
                <Input mono value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} autoFocus={Boolean(editing)} />
              )}
            </Field>
            <label className="flex items-center gap-3 rounded-md border border-border px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-sans text-app-14 font-medium text-text">Valeur secrète</span>
                <span className="font-sans text-app-12 text-muted">Masquée partout, jamais renvoyée au navigateur : elle ne peut qu'être remplacée.</span>
              </span>
              <Switch checked={secret} onCheckedChange={setSecret} aria-label="Valeur secrète" />
            </label>
            {failure ? <ErrorPanel title={failure.message} excerpt={failure.detail} untouched={failure.untouched ?? null} /> : null}
            <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
          </form>
        </DialogContent>
      </Dialog>
      {editing ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          icon="trash"
          title={`Supprimer ${editing.key} ?`}
          consequences={[
            { kind: 'risk', text: 'Les prochaines commandes du projet ne la recevront plus.' },
            { kind: 'kept', text: 'Les commandes déjà lancées gardent leur environnement.' },
            { kind: 'kept', text: "Aucun fichier du dépôt n'est modifié." },
          ]}
          confirmLabel="Supprimer la variable"
          error={deleteError ?? undefined}
          onConfirm={async () => {
            setDeleteError(null);
            try {
              await projectsApi.deleteEnv(projectId, editing.id);
            } catch (error) {
              setDeleteError(failureOf(error, "La variable n'a pas pu être supprimée.").message);
              throw error;
            }
            setConfirmDelete(false);
            onOpenChange(false);
            toast({ message: `Variable ${editing.key} supprimée` });
            onSaved();
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------------------------

/** « Modifier les commandes » of the Environnement tab (commands run by the runner through a shell). */
export function CommandsDialog({
  projectId,
  commands,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  commands: ProjectCommands;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<CommandKey, string>>({ install: '', dev: '', build: '', test: '', lint: '' });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    if (!open) return;
    setFailure(null);
    setValues({
      install: commands.install ?? '',
      dev: commands.dev ?? '',
      build: commands.build ?? '',
      test: commands.test ?? '',
      lint: commands.lint ?? '',
    });
  }, [open, commands]);

  const save = async () => {
    setPending(true);
    setFailure(null);
    try {
      const next: Record<string, string | null> = {};
      for (const field of COMMAND_FIELDS) next[field.key] = values[field.key].trim() || null;
      await projectsApi.patch(projectId, { commands: next });
      toast({ message: 'Commandes enregistrées' });
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setFailure(failureOf(error, "Les commandes n'ont pas pu être enregistrées."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        title="Commandes du projet"
        description="Lancées dans le worktree du projet, avec ses variables. Une commande vide n'est pas proposée."
        dismissible={!pending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Annuler
            </Button>
            <Button variant="accent" onClick={() => void save()} loading={pending}>
              Enregistrer
            </Button>
          </>
        }
      >
        {COMMAND_FIELDS.map((field) => (
          <Field key={field.key} label={field.label}>
            <Input
              mono
              value={values[field.key]}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              maxLength={1000}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ))}
        {failure ? <ErrorPanel title={failure.message} excerpt={failure.detail} untouched={failure.untouched ?? null} /> : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------------------------

/**
 * CLAUDE.md editor (D04 « Modifier », not drawn): written by the runner at the root of the clone
 * and, by default, committed on the current branch (« Chaque modification passe par un commit »).
 */
export function ClaudeMdEditor({
  projectId,
  initial,
  branch,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  initial: string;
  branch: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const textId = useId();
  const [content, setContent] = useState(initial);
  const [commit, setCommit] = useState(true);
  const [message, setMessage] = useState('docs: mise à jour de CLAUDE.md');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (!open) return;
    setContent(initial);
    setCommit(true);
    setMessage('docs: mise à jour de CLAUDE.md');
    setFailure(null);
    setConfirmDiscard(false);
  }, [open, initial]);

  const dirty = content !== initial;
  const requestClose = (next: boolean) => {
    if (next || pending) return;
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const save = async () => {
    setPending(true);
    setFailure(null);
    try {
      const result = await projectsApi.writeClaudeMd(projectId, { content, commit, ...(commit && message.trim() ? { message: message.trim() } : {}) });
      toast({ message: result.commitSha ? `CLAUDE.md enregistré · commit ${result.commitSha.slice(0, 7)}` : 'CLAUDE.md enregistré' });
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setFailure(failureOf(error, "CLAUDE.md n'a pas pu être enregistré."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        size="lg"
        title="Modifier CLAUDE.md"
        description="Claude Code le lit au début de chaque session de ce projet."
        dismissible={!pending}
        footer={
          <>
            <Button onClick={() => requestClose(false)} disabled={pending}>
              Annuler
            </Button>
            <Button variant="accent" onClick={() => void save()} loading={pending} disabled={!dirty || (commit && !message.trim())}>
              {commit ? 'Enregistrer et committer' : 'Enregistrer'}
            </Button>
          </>
        }
      >
        {confirmDiscard ? (
          <Banner
            tone="warn"
            title="Les modifications ne sont pas enregistrées"
            action={
              <div className="flex gap-2">
                <Button onClick={() => setConfirmDiscard(false)}>Continuer</Button>
                <Button variant="accent" onClick={() => onOpenChange(false)}>
                  Abandonner
                </Button>
              </div>
            }
          >
            Fermer maintenant les abandonne.
          </Banner>
        ) : null}
        <Field id={textId} label="Contenu">
          <Textarea mono rows={16} value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} className="min-h-[280px]" />
        </Field>
        <label className="flex items-center gap-3 rounded-md border border-border px-4 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-sans text-app-14 font-medium text-text">Committer la modification</span>
            <span className="font-sans text-app-12 text-muted">{branch ? `Un commit sur ${branch}, rien n'est poussé.` : "Un commit sur la branche courante, rien n'est poussé."}</span>
          </span>
          <Switch checked={commit} onCheckedChange={setCommit} aria-label="Committer la modification" />
        </label>
        {commit ? (
          <Field label="Message du commit">
            <Input mono value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500} />
          </Field>
        ) : null}
        {failure ? <ErrorPanel title={failure.message} excerpt={failure.detail} untouched={failure.untouched ?? 'CLAUDE.md n\'a pas été modifié.'} raw={failure.raw ?? null} /> : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Sortie d'un lancement
// ---------------------------------------------------------------------------------------------

const MAX_OUTPUT = 256 * 1024;

/** Live output of a run (`run.status` + `run.output` of /api/stream/runs/<id>, replayed on connect). */
export function RunOutputDialog({ run, onOpenChange, onStopped }: { run: RunView | null; onOpenChange: (open: boolean) => void; onStopped: () => void }) {
  const [state, setState] = useState<RunView | null>(run);
  const [output, setOutput] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailure, setStopFailure] = useState<Failure | null>(null);
  const runId = run?.id ?? null;
  const base = useRef(run);
  useEffect(() => {
    base.current = run;
  });

  useEffect(() => {
    if (!runId) return;
    setState(base.current);
    setOutput('');
    setUnavailable(false);
    setStopFailure(null);
    const source = new EventSource(`/api/stream/runs/${encodeURIComponent(runId)}`);
    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseRunnerEvent(message.data);
      if (!event) return;
      if (event.type === 'stream.error') setUnavailable(true);
      if (event.type === 'run.output') {
        setUnavailable(false);
        setOutput((current) => {
          const next = event.data.replay ? event.data.data : current + event.data.data;
          return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
        });
      }
      if (event.type === 'run.status') {
        const dto = event.data.run;
        setState((current) =>
          current
            ? {
                ...current,
                status: dto.status,
                exitCode: dto.exitCode,
                port: dto.port,
                summary: dto.summary,
                finishedAt: dto.finishedAt,
                tests: dto.tests ? { passed: dto.tests.counts.passed, failed: dto.tests.counts.failed, skipped: dto.tests.counts.skipped, total: dto.tests.counts.total } : current.tests,
              }
            : current,
        );
      }
    };
    return () => source.close();
  }, [runId]);

  if (!run || !state) return null;
  const badge = commandRunBadge(state.kind, runSummary(state));
  const stop = async () => {
    setStopping(true);
    setStopFailure(null);
    try {
      await projectsApi.stopRun(state.id);
      onStopped();
    } catch (error) {
      setStopFailure(failureOf(error, "La commande n'a pas pu être arrêtée."));
    } finally {
      setStopping(false);
    }
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Sortie de la commande"
        description={state.worktreeName ? `Dans le worktree ${state.worktreeName}.` : undefined}
        header={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {state.summary ? <span className="font-sans text-app-13 text-muted">{state.summary}</span> : null}
          </div>
        }
        footer={
          <>
            {state.status === 'running' ? (
              <Button onClick={() => void stop()} loading={stopping}>
                Arrêter
              </Button>
            ) : null}
            <Button variant="accent" onClick={() => onOpenChange(false)}>
              Fermer
            </Button>
          </>
        }
      >
        {unavailable ? (
          <Banner tone="warn" icon="wifi-off" title="Le serveur ne répond pas">
            La commande continue peut-être : la sortie reprend dès que le serveur répond.
          </Banner>
        ) : null}
        <CommandOutput command={state.command} output={output} exitCode={state.status === 'running' ? null : state.exitCode} maxHeight={420} label={`Sortie de ${state.command}`} />
        {stopFailure ? <ErrorPanel title={stopFailure.message} excerpt={stopFailure.detail} /> : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Suppression d'un worktree (T8)
// ---------------------------------------------------------------------------------------------

/**
 * T8 « Supprimer le worktree … ? »: lists what is kept and lost; a worktree with uncommitted files
 * is only removed after typing its name (force).
 */
export function RemoveWorktreeDialog({
  projectId,
  worktree,
  onOpenChange,
  onRemoved,
}: {
  projectId: string;
  worktree: WorktreeView | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [preview, setPreview] = useState<WorktreeRemovalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);

  useEffect(() => {
    if (!worktree) return;
    setPreview(null);
    setError(null);
    setDeleteBranch(false);
    let cancelled = false;
    projectsApi
      .worktreePreview(projectId, worktree.id)
      .then((value) => !cancelled && setPreview(value))
      .catch((e: unknown) => !cancelled && setError(failureOf(e, 'Le worktree n\'a pas pu être lu.').message));
    return () => {
      cancelled = true;
    };
  }, [projectId, worktree]);

  if (!worktree) return null;
  const dirty = preview?.dirtyFiles.length ?? worktree.dirtyFiles ?? 0;
  const consequences: Consequence[] = [
    { kind: 'kept', text: deleteBranch ? `La branche ${worktree.branch} est supprimée seulement si elle est fusionnée.` : `La branche ${worktree.branch} est conservée.` },
    { kind: 'kept', text: 'Les commits déjà poussés restent sur GitHub.' },
    { kind: 'risk', text: 'Les sessions liées ne pourront plus être reprises.' },
  ];
  if (dirty > 0) consequences.unshift({ kind: 'risk', text: `${plural(dirty, 'fichier non commité', 'fichiers non commités')} ${dirty >= 2 ? 'seront perdus' : 'sera perdu'}.` });
  if ((worktree.ahead ?? 0) > 0) consequences.push({ kind: 'risk', text: `${plural(worktree.ahead!, 'commit')} pas encore ${worktree.ahead! >= 2 ? 'poussés restent' : 'poussé reste'} dans la branche, pas sur GitHub.` });
  if (preview && !preview.canRemove && preview.blockedReason) consequences.push({ kind: 'risk', text: preview.blockedReason });

  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      tone="danger"
      icon="trash"
      title={`Supprimer le worktree ${worktree.name} ?`}
      consequences={consequences}
      confirmLabel="Supprimer le worktree"
      error={error ?? undefined}
      {...(dirty > 0 ? { typedConfirmation: { expected: worktree.name, label: `Tapez ${worktree.name} pour abandonner ses modifications` } } : {})}
      onConfirm={async () => {
        if (preview && !preview.canRemove) {
          setError(preview.blockedReason ?? 'Ce worktree ne peut pas être supprimé.');
          throw new Error('blocked');
        }
        try {
          const result = await projectsApi.removeWorktree(projectId, worktree.id, { force: dirty > 0, deleteBranch });
          onOpenChange(false);
          toast({ message: result.branchDeleted ? `Worktree ${worktree.name} et sa branche supprimés` : `Worktree ${worktree.name} supprimé` });
          onRemoved();
        } catch (e) {
          const failure = failureOf(e, "Le worktree n'a pas pu être supprimé.");
          setError([failure.message, failure.detail, failure.untouched].filter(Boolean).join(' '));
          throw e;
        }
      }}
    >
      {preview && preview.dirtyFiles.length > 0 ? (
        <ul className="m-0 flex max-h-40 list-none flex-col overflow-y-auto rounded-md border border-border p-0">
          {preview.dirtyFiles.map((file) => (
            <li key={file} className="truncate border-b border-border px-3 py-2 font-mono text-app-12 text-text last:border-b-0">
              {file}
            </li>
          ))}
        </ul>
      ) : null}
      <label className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
        <span className="min-w-0 flex-1 font-sans text-app-13 text-text">Supprimer aussi la branche si elle est fusionnée</span>
        <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} aria-label="Supprimer aussi la branche si elle est fusionnée" />
      </label>
    </ConfirmDialog>
  );
}
