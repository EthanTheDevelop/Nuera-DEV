'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import {
  Banner,
  Button,
  CompactButton,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorPanel,
  Field,
  Input,
  Select,
  SegmentedControl,
  Sheet,
  SheetContent,
  Skeleton,
  SlotMeter,
  Switch,
  Textarea,
} from '@/components/ui';
import { useOptionalShellData } from '@/components/shell';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/cn';
import { loadNewSessionOptionsAction, loadProjectBranchesAction, retryFirstInstructionAction, type ActionError } from './actions';
import { createSessionRequest, SessionApiError } from './api';
import {
  DEFAULT_SESSION_TITLE,
  type BranchMode,
  type CreateSessionResult,
  type NewSessionOptions,
  type PermissionMode,
  type ProjectBranchOptions,
} from './lib/contract';
import {
  BRANCH_MODE_ITEMS,
  CLI_DEFAULT,
  capacityFullReason,
  capacityLine,
  defaultBranchMode,
  effortOptions,
  existingBranchOptions,
  newBranchError,
  permissionModeOptions,
  suggestBranchName,
  toCreateInput,
  worktreeHint,
  type NewSessionFormState,
} from './lib/form';

export interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselected project (Projets D04, Workspace W6, A3 « Démarrer une session »). */
  defaultProjectId?: string | null;
  /**
   * Called after creation, before navigation. Default behaviour: `router.push(workspaceUrl)`.
   * Return `false` to stay on the page.
   */
  onCreated?: (result: CreateSessionResult) => void | boolean;
}

type Failure = { message: string; detail?: string; untouched?: string; raw?: string };

const UNTOUCHED_DEFAULT = 'Aucun worktree créé, aucune session démarrée.';

function failureFrom(error: unknown): Failure {
  if (error instanceof SessionApiError) {
    return {
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.untouched ? { untouched: error.untouched } : {}),
      ...(error.raw ? { raw: error.raw } : {}),
    };
  }
  return { message: error instanceof Error && error.message ? error.message : "La session n'a pas pu être créée." };
}

function failureFromAction(error: ActionError): Failure {
  return {
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.untouched ? { untouched: error.untouched } : {}),
    ...(error.raw ? { raw: error.raw } : {}),
  };
}

type Load<T> = { state: 'loading' } | { state: 'error'; error: Failure } | { state: 'ready'; data: T };

/**
 * « Nouvelle session » (W1 entry): project, title, branch (new branch from a base, existing branch or
 * the primary clone), permission mode, CLI options, optional first instruction. Dialog on desktop,
 * bottom sheet on the phone (the layout is frozen while it is open). Not drawn in Figma: composed
 * from the design system (Dev · Champ, Liste déroulante, Interrupteur, Barre de vue).
 */
export function NewSessionDialog({ open, onOpenChange, defaultProjectId, onCreated }: NewSessionDialogProps) {
  const isDesktop = useIsDesktopNav();
  const [layout, setLayout] = useState<'dialog' | 'sheet'>(isDesktop ? 'dialog' : 'sheet');
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setLayout(isDesktop ? 'dialog' : 'sheet');
    wasOpen.current = open;
  }, [open, isDesktop]);
  // While closed, follow the viewport (so the first opening uses the right layout).
  const current = open ? layout : isDesktop ? 'dialog' : 'sheet';

  const serverName = useOptionalShellData()?.server.name ?? 'VPS-3';
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && busy) return;
      onOpenChange(next);
    },
    [busy, onOpenChange],
  );

  const form = open ? (
    <NewSessionForm
      serverName={serverName}
      layout={current}
      defaultProjectId={defaultProjectId ?? null}
      onBusyChange={setBusy}
      onCancel={close}
      onCreated={onCreated}
      onClose={close}
    />
  ) : null;

  if (current === 'dialog') {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {open ? (
          <DialogContent
            title="Nouvelle session"
            description={`Un processus Claude Code sur ${serverName}, dans son propre worktree. Il continue même navigateur fermé.`}
            dismissible={!busy}
            bodyClassName="gap-5"
          >
            {form}
          </DialogContent>
        ) : null}
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {open ? (
        <SheetContent title="Nouvelle session" description={`Un processus Claude Code sur ${serverName}, dans son propre worktree.`}>
          {form}
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

interface NewSessionFormProps {
  serverName: string;
  layout: 'dialog' | 'sheet';
  defaultProjectId: string | null;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
  onCreated?: NewSessionDialogProps['onCreated'];
}

const EMPTY_FORM: NewSessionFormState = {
  projectId: '',
  title: '',
  mode: 'new',
  newBranch: '',
  base: '',
  existingBranch: '',
  permissionMode: 'manual',
  model: '',
  effort: CLI_DEFAULT,
  remoteControl: false,
  instruction: '',
};

function NewSessionForm({ serverName, layout, defaultProjectId, onBusyChange, onCancel, onClose, onCreated }: NewSessionFormProps) {
  const router = useRouter();
  const formId = useId();
  const [options, setOptions] = useState<Load<NewSessionOptions>>({ state: 'loading' });
  const [branches, setBranches] = useState<Load<ProjectBranchOptions> | null>(null);
  const [form, setForm] = useState<NewSessionFormState>(EMPTY_FORM);
  const [branchTouched, setBranchTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [created, setCreated] = useState<{ result: CreateSessionResult; retrying: boolean; error: Failure } | null>(null);

  useEffect(() => onBusyChange(submitting), [submitting, onBusyChange]);

  const set = useCallback(<K extends keyof NewSessionFormState>(key: K, value: NewSessionFormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  // --- options ------------------------------------------------------------------------------
  const loadOptions = useCallback(async () => {
    setOptions({ state: 'loading' });
    const result = await loadNewSessionOptionsAction().catch(() => null);
    if (!result) {
      setOptions({ state: 'error', error: { message: 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.' } });
      return;
    }
    if (!result.ok) {
      setOptions({ state: 'error', error: failureFromAction(result.error) });
      return;
    }
    const data = result.data;
    setOptions({ state: 'ready', data });
    setForm((previous) => {
      const ready = data.projects.filter((p) => p.ready);
      const preferred = ready.find((p) => p.id === defaultProjectId) ?? ready[0];
      return {
        ...previous,
        projectId: previous.projectId || preferred?.id || '',
        permissionMode: data.defaults.permissionMode,
        model: data.defaults.model ?? '',
        effort: data.defaults.effort ?? CLI_DEFAULT,
        remoteControl: data.defaults.remoteControl,
      };
    });
  }, [defaultProjectId]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  const project = options.state === 'ready' ? (options.data.projects.find((p) => p.id === form.projectId) ?? null) : null;

  // --- branches of the selected project -------------------------------------------------------
  const branchRequest = useRef(0);
  const loadBranches = useCallback(async (projectId: string) => {
    const request = ++branchRequest.current;
    setBranches({ state: 'loading' });
    const result = await loadProjectBranchesAction(projectId).catch(() => null);
    if (request !== branchRequest.current) return;
    if (!result) {
      setBranches({ state: 'error', error: { message: 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.' } });
      return;
    }
    setBranches(result.ok ? { state: 'ready', data: result.data } : { state: 'error', error: failureFromAction(result.error) });
  }, []);

  useEffect(() => {
    if (!project?.ready) {
      setBranches(null);
      return;
    }
    setForm((previous) => ({
      ...previous,
      mode: defaultBranchMode(project.worktreePerSession),
      base: project.defaultBranch,
      existingBranch: '',
    }));
    void loadBranches(project.id);
    // Only when the project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Branch name follows the title until the owner edits it.
  useEffect(() => {
    if (!branchTouched) setForm((previous) => ({ ...previous, newBranch: suggestBranchName(previous.title) }));
  }, [form.title, branchTouched]);

  const branchData = branches?.state === 'ready' ? branches.data : null;
  const primaryBusy = branchData?.primaryBusy ?? false;
  const existingOptions = useMemo(() => existingBranchOptions(branchData, primaryBusy), [branchData, primaryBusy]);
  const baseOptions = useMemo(
    () =>
      (branchData?.branches ?? []).map((b) => ({
        value: b.name,
        label: b.name,
        ...(b.isDefault ? { description: 'branche par défaut' } : b.kind === 'remote' ? { description: 'sur origin' } : {}),
      })),
    [branchData],
  );

  // --- validation -------------------------------------------------------------------------------
  const capacity = options.state === 'ready' ? options.data.capacity : null;
  const capacityFull = capacity ? capacity.active >= capacity.max : false;
  const runnerDown = options.state === 'ready' && options.data.runnerUnavailable;
  const blockBypass = options.state === 'ready' ? options.data.defaults.blockBypassPermissions : true;

  const errors = {
    project: !form.projectId ? 'Choisissez un projet.' : project && !project.ready ? project.unavailableReason : null,
    newBranch: form.mode === 'new' ? newBranchError(form.newBranch, branchData?.branches ?? null) : null,
    existingBranch:
      form.mode === 'existing'
        ? !form.existingBranch
          ? 'Choisissez une branche.'
          : existingOptions.find((o) => o.value === form.existingBranch)?.disabled
            ? 'Une session tourne déjà sur cette branche.'
            : null
        : null,
    primary: form.mode === 'primary' && primaryBusy ? 'Une session tourne déjà dans le clone principal.' : null,
    title: form.title.length > 200 ? '200 caractères au maximum.' : null,
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const blockedReason = runnerDown
    ? `${serverName} ne répond pas : impossible de créer une session pour le moment.`
    : capacityFull && capacity
      ? capacityFullReason(capacity.active, capacity.max)
      : null;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (submitting) return;
    setShowErrors(true);
    if (hasErrors || blockedReason || options.state !== 'ready' || branches?.state === 'loading') return;
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await createSessionRequest(toCreateInput(form));
      if (result.instruction === 'failed') {
        setCreated({ result, retrying: false, error: result.instructionError ?? { message: "L'instruction n'a pas été transmise." } });
        return;
      }
      finish(result);
    } catch (error) {
      setFailure(failureFrom(error));
    } finally {
      setSubmitting(false);
    }
  };

  const finish = (result: CreateSessionResult) => {
    const keep = onCreated?.(result);
    onClose();
    if (keep !== false) router.push(result.workspaceUrl);
  };

  const retryInstruction = async () => {
    if (!created) return;
    setCreated({ ...created, retrying: true });
    const outcome = await retryFirstInstructionAction(created.result.sessionId, form.instruction).catch(() => null);
    if (outcome?.ok) {
      finish({ ...created.result, instruction: outcome.data, instructionError: null });
      return;
    }
    setCreated({
      ...created,
      retrying: false,
      error: outcome ? failureFromAction(outcome.error) : { message: 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.' },
    });
  };

  // --- render -----------------------------------------------------------------------------------
  if (options.state === 'loading') return <FormSkeleton />;
  if (options.state === 'error') {
    return (
      <ErrorPanel
        title="Les projets n'ont pas pu être chargés"
        excerpt={options.error.detail ? `${options.error.message} ${options.error.detail}` : options.error.message}
        untouched="Aucune session créée."
        onRetry={() => void loadOptions()}
        retryLabel="Réessayer"
      />
    );
  }
  if (options.data.projects.length === 0) {
    return (
      <EmptyState
        icon="projets"
        title="Aucun projet pour l'instant"
        variant="plain"
        action={
          <CompactButton variant="principal" icon="plus" href="/projets/nouveau" onClick={onClose}>
            Ajouter un projet
          </CompactButton>
        }
      >
        {`Ajoutez un dépôt GitHub : il sera cloné sur ${serverName}, prêt pour Claude Code.`}
      </EmptyState>
    );
  }

  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="success" title="Session créée">
          {`Le worktree et la session existent sur ${serverName}.`}
        </Banner>
        <ErrorPanel
          title="La première instruction n'a pas été transmise"
          excerpt={created.error.detail ? `${created.error.message} ${created.error.detail}` : created.error.message}
          untouched="L'instruction est conservée ci-dessous ; rien n'a été envoyé à Claude."
          onRetry={() => void retryInstruction()}
          retrying={created.retrying}
          retryLabel="Renvoyer l'instruction"
          actions={
            <CompactButton variant="discret" onClick={() => finish({ ...created.result })}>
              Ouvrir la session sans l'envoyer
            </CompactButton>
          }
        />
        <Field label="Première instruction">
          <Textarea value={form.instruction} onChange={(e) => set('instruction', e.target.value)} rows={4} />
        </Field>
      </div>
    );
  }

  const projectOptions = options.data.projects.map((p) => ({
    value: p.id,
    label: p.name,
    description: p.ready ? p.fullName : `${p.fullName} · ${p.unavailableReason ?? "pas prêt"}`,
    disabled: !p.ready,
  }));
  const permission = permissionModeOptions(blockBypass);
  const permissionHint = permission.find((o) => o.value === form.permissionMode)?.description;
  const err = (message: string | null | undefined) => (showErrors && message ? message : undefined);

  const branchSection = (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-1.5 p-0 font-sans text-app-13 font-medium text-text">Branche</legend>
      <SegmentedControl<BranchMode>
        aria-label="Branche de la session"
        items={BRANCH_MODE_ITEMS.map((item) => ({
          ...item,
          label: layout === 'sheet' ? item.short : item.label,
          disabled: item.value === 'primary' && primaryBusy,
        }))}
        value={form.mode}
        onValueChange={(mode) => set('mode', mode)}
        className="w-full overflow-x-auto [&>*]:flex-1 [&>*]:justify-center"
      />
      {branches?.state === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Chargement des branches">
          <Skeleton height={40} className="w-full rounded-md" />
        </div>
      ) : branches?.state === 'error' ? (
        <ErrorPanel
          title="Les branches n'ont pas pu être lues"
          excerpt={branches.error.message}
          untouched="Aucune branche ni aucun worktree modifié."
          onRetry={() => project && void loadBranches(project.id)}
          retryLabel="Réessayer"
        />
      ) : form.mode === 'new' ? (
        <div className="grid min-w-0 grid-cols-1 gap-3 nav:grid-cols-[minmax(0,1fr)_200px]">
          <Field
            label="Nom de la nouvelle branche"
            error={err(errors.newBranch)}
            hint={!errors.newBranch ? worktreeHint(form.newBranch, form.base || project?.defaultBranch || '') : undefined}
          >
            <Input
              mono
              value={form.newBranch}
              placeholder="feature/ma-tache"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setBranchTouched(true);
                set('newBranch', e.target.value);
              }}
            />
          </Field>
          <Field label="Depuis">
            <Select
              options={baseOptions}
              value={form.base || undefined}
              onValueChange={(value) => set('base', value)}
              placeholder={project?.defaultBranch ?? 'Branche'}
              icon="git-branch"
            />
          </Field>
        </div>
      ) : form.mode === 'existing' ? (
        <Field
          label="Branche existante"
          error={err(errors.existingBranch)}
          hint="Son worktree est réutilisé s'il existe ; sinon un worktree dédié est créé sur cette branche."
        >
          <Select
            options={existingOptions}
            value={form.existingBranch || undefined}
            onValueChange={(value) => set('existingBranch', value)}
            placeholder="Choisir une branche…"
            icon="git-branch"
          />
        </Field>
      ) : (
        <p className={cn('m-0 flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3.5 py-3 font-sans text-app-13 leading-[18px]', errors.primary ? 'text-danger' : 'text-text')}>
          <Icon name="folder" size={16} className="mt-px shrink-0 text-muted" />
          <span>
            {errors.primary ??
              `Claude travaille directement dans le clone principal${branchData?.currentBranch ? `, sur ${branchData.currentBranch}` : ''}. Aucun worktree n'est créé.`}
          </span>
        </p>
      )}
    </fieldset>
  );

  const footer = (
    <>
      <Button type="button" onClick={onCancel} disabled={submitting} block={layout === 'sheet'}>
        Annuler
      </Button>
      <Button
        type="submit"
        variant="accent"
        loading={submitting}
        loadingLabel="Création de la session…"
        disabled={Boolean(blockedReason)}
        block={layout === 'sheet'}
      >
        {form.instruction.trim() ? 'Créer et envoyer' : 'Créer la session'}
      </Button>
    </>
  );

  return (
    <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="flex min-w-0 flex-col gap-5">
      {capacity ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface-raised px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Icon name="cpu" size={16} className="text-accent" />
            <p className="m-0 min-w-0 flex-1 font-sans text-app-13 font-medium text-text">{capacityLine(capacity.active, capacity.max)}</p>
            {capacity.source === 'database' ? <span className="font-mono text-app-11 text-muted">non vérifié</span> : null}
          </div>
          <SlotMeter used={capacity.active} total={capacity.max} label={capacityLine(capacity.active, capacity.max)} />
        </div>
      ) : null}
      {blockedReason ? (
        <Banner tone={runnerDown ? 'danger' : 'warn'} title={runnerDown ? `${serverName} ne répond pas` : 'Capacité atteinte'}
          action={
            <CompactButton variant="secondaire" icon="refresh" onClick={() => void loadOptions()}>
              Vérifier à nouveau
            </CompactButton>
          }
        >
          {runnerDown ? 'Impossible de créer une session pour le moment.' : capacityFullReason(capacity!.active, capacity!.max)}
        </Banner>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 nav:grid-cols-2">
        <Field label="Projet" error={err(errors.project)}>
          <Select options={projectOptions} value={form.projectId || undefined} onValueChange={(value) => set('projectId', value)} icon="projets" placeholder="Choisir un projet…" />
        </Field>
        <Field label="Titre" error={err(errors.title)} hint="Visible dans Sessions et dans le CLI (--name).">
          <Input value={form.title} placeholder={DEFAULT_SESSION_TITLE} maxLength={200} onChange={(e) => set('title', e.target.value)} />
        </Field>
      </div>

      {project?.ready ? branchSection : null}

      <Field label="Mode de permission" hint={permissionHint}>
        <Select
          options={permission}
          value={form.permissionMode}
          onValueChange={(value) => set('permissionMode', value as PermissionMode)}
          icon="shield"
        />
      </Field>

      <div className="flex min-w-0 flex-col gap-3">
        <button
          type="button"
          className="nu-hit inline-flex items-center gap-1.5 self-start font-sans text-app-13 font-medium text-accent"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          <Icon name={advanced ? 'chevron-down' : 'chevron'} size={14} />
          Options du CLI
          <span className="font-normal text-muted">
            · {form.model.trim() || 'modèle du CLI'} · {form.effort === CLI_DEFAULT ? 'effort du CLI' : form.effort}
            {form.remoteControl ? ' · Remote Control' : ''}
          </span>
        </button>
        {advanced ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="grid min-w-0 grid-cols-1 gap-3 nav:grid-cols-2">
              <Field label="Modèle" hint="Alias ou identifiant passé à --model ; vide = défaut du CLI.">
                <Input mono value={form.model} placeholder="Défaut du CLI" autoComplete="off" spellCheck={false} onChange={(e) => set('model', e.target.value)} />
              </Field>
              <Field label="Effort">
                <Select options={effortOptions(form.effort === CLI_DEFAULT ? null : form.effort)} value={form.effort} onValueChange={(value) => set('effort', value)} />
              </Field>
            </div>
            <SwitchRow
              label="Remote Control"
              caption="Session aussi pilotable depuis l'application Claude (--remote-control)."
              checked={form.remoteControl}
              onCheckedChange={(checked) => set('remoteControl', checked)}
            />
          </div>
        ) : null}
      </div>

      <Field
        label="Première instruction"
        labelAside={<span className="font-sans text-app-12 text-muted">facultatif</span>}
        hint="Envoyée dès la création : Claude Code démarre aussitôt. Sinon il démarre au premier envoi depuis le Workspace."
      >
        <Textarea value={form.instruction} onChange={(e) => set('instruction', e.target.value)} rows={3} placeholder="Écrire une instruction à Claude…" />
      </Field>

      {failure ? (
        <ErrorPanel
          title={failure.message}
          excerpt={failure.detail}
          untouched={failure.untouched ?? UNTOUCHED_DEFAULT}
          raw={failure.raw ?? null}
          onRetry={() => void submit()}
          retrying={submitting}
          retryLabel="Réessayer"
        />
      ) : null}

      {layout === 'dialog' ? (
        <div className="sticky -bottom-6 -mx-5 -mb-6 flex flex-col-reverse gap-3 border-t border-border bg-bg px-5 py-4 nav:-mx-7 nav:flex-row nav:items-center nav:justify-end nav:px-7">
          {blockedReason ? <p className="m-0 min-w-0 flex-1 font-sans text-app-12 text-muted">{blockedReason}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-3">{footer}</div>
        </div>
      ) : (
        <div className="sticky -bottom-4 -mx-4 -mb-4 flex flex-col gap-2 border-t border-border bg-bg px-4 pt-3 pb-4">
          {blockedReason ? <p className="m-0 font-sans text-app-12 text-muted">{blockedReason}</p> : null}
          <div className="flex flex-col-reverse gap-2">{footer}</div>
        </div>
      )}
    </form>
  );
}

function SwitchRow({ label, caption, checked, onCheckedChange }: { label: string; caption: ReactNode; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="font-sans text-app-14 font-medium text-text">
          {label}
        </label>
        <p id={`${id}-caption`} className="m-0 font-sans text-app-12 leading-4 text-muted">
          {caption}
        </p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-describedby={`${id}-caption`} />
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Chargement des projets">
      <Skeleton height={56} className="w-full rounded-md" />
      <div className="grid grid-cols-1 gap-3 nav:grid-cols-2">
        <Skeleton height={64} className="w-full rounded-md" />
        <Skeleton height={64} className="w-full rounded-md" />
      </div>
      <Skeleton height={96} className="w-full rounded-md" />
      <Skeleton height={64} className="w-full rounded-md" />
    </div>
  );
}
