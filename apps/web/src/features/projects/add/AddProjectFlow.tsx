'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { IconButton, Button, Dialog, DialogContent, StepProgress, Stepper } from '@/components/ui';
import { NewSessionButton } from '@/features/sessions';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import type { AddRepoItem, DestinationView } from '@/server/projects/types';
import { ProjectApiError, failureOf, projectsApi } from '../api';
import type { Failure } from '../FailureBanner';
import { humanizeRepoName } from '../format';
import { useServerName, writeSearchParams } from '../hooks';
import { CloneStep, cloneFooterNote, cloneOutcome } from './CloneStep';
import { COMMAND_FIELDS, ConfigStep, type CommandKey, type ConfigForm, type DestinationConflict, type DestinationState, type PreviewState } from './ConfigStep';
import { RepoStep, type ReposState } from './RepoStep';
import { useOperationStream } from './useOperationStream';

type Step = 'depot' | 'configuration' | 'clonage';
const STEPS = [{ label: 'Dépôt' }, { label: 'Configuration' }, { label: 'Clonage' }] as const;
const STEP_INDEX: Record<Step, number> = { depot: 0, configuration: 1, clonage: 2 };

const emptyCommands = (): Record<CommandKey, string> => ({ install: '', dev: '', build: '', test: '', lint: '' });

export interface AddProjectFlowProps {
  /** `modal` = intercepted over /projets (close = back), `page` = hard load of /projets/nouveau. */
  mode: 'modal' | 'page';
}

type ConfigFailure = Failure & { projectHref?: string };

/**
 * Parcours A « Ajouter un projet »: A1 Dépôt → D03 Configuration (A4 on a refused destination) →
 * A2 Clonage → A3 Réussi. Desktop: the 640 modal over Projets (or the same card on a hard load);
 * phone: the full-screen M03 flow (top bar, 3-segment progress, sticky action bar).
 * URL: ?etape=depot|configuration|clonage, ?depot=owner/repo, ?projet=<id>, ?operation=<id> — a
 * closed modal can be reopened on a running clone, which keeps going on the server.
 */
export function AddProjectFlow({ mode }: AddProjectFlowProps) {
  const router = useRouter();
  const params = useSearchParams();
  const desktop = useIsDesktopNav();
  const serverName = useServerName();
  const now = useNow(60_000);

  // URL at mount (later changes come from this component itself).
  const [initial] = useState(() => ({
    etape: params.get('etape'),
    depot: params.get('depot'),
    projet: params.get('projet'),
    operation: params.get('operation'),
  }));

  const [step, setStep] = useState<Step>(
    initial.operation ? 'clonage' : initial.etape === 'configuration' && initial.depot ? 'configuration' : 'depot',
  );
  const [selected, setSelected] = useState<string | null>(initial.depot);
  const [repos, setRepos] = useState<ReposState>({ status: 'loading' });
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('tous');
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [destination, setDestination] = useState<DestinationState>({ status: 'idle' });
  const [conflict, setConflict] = useState<DestinationConflict | null>(null);
  const [failure, setFailure] = useState<ConfigFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openingExisting, setOpeningExisting] = useState(false);
  const [created, setCreated] = useState<{ projectId: string; operationId: string } | null>(
    initial.operation && initial.projet ? { projectId: initial.projet, operationId: initial.operation } : null,
  );
  const [projectName, setProjectName] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryFailure, setRetryFailure] = useState<Failure | null>(null);

  const stream = useOperationStream(step === 'clonage' ? (created?.operationId ?? initial.operation) : null);
  const outcome = cloneOutcome(stream);

  // --- URL state -------------------------------------------------------------------------------
  useEffect(() => {
    writeSearchParams({
      etape: step === 'depot' ? null : step,
      depot: step === 'depot' ? (selected ?? null) : step === 'configuration' ? selected : null,
      projet: step === 'clonage' ? (created?.projectId ?? initial.projet) : null,
      operation: step === 'clonage' ? (created?.operationId ?? initial.operation) : null,
    });
  }, [step, selected, created, initial.projet, initial.operation]);

  // --- Data --------------------------------------------------------------------------------------
  const loadRepos = useCallback(() => {
    setRepos({ status: 'loading' });
    projectsApi
      .repos()
      .then((data) => setRepos({ status: 'ready', data }))
      .catch((error: unknown) => setRepos({ status: 'error', failure: failureOf(error, 'GitHub ne répond pas.') }));
  }, []);
  // Loaded once, the first time step 1 shows (a failed load waits for « Réessayer »).
  const reposRequested = useRef(false);
  useEffect(() => {
    if (step !== 'depot' || reposRequested.current) return;
    reposRequested.current = true;
    loadRepos();
  }, [step, loadRepos]);

  const loadPreview = useCallback((fullName: string) => {
    setPreview({ status: 'loading' });
    setPreviewFor(fullName);
    projectsApi
      .preview(fullName)
      .then((data) => {
        setPreview({ status: 'ready', data });
        const repoName = fullName.split('/')[1] ?? fullName;
        const commands = emptyCommands();
        for (const field of COMMAND_FIELDS) commands[field.key] = data.inspection?.commands[field.key] ?? '';
        setForm({
          branch: data.defaultBranch,
          name: humanizeRepoName(repoName),
          destination: data.destination?.path ?? repoName,
          installDeps: true,
          worktreePerSession: true,
          commands,
        });
        setDestination(data.destination ? { status: 'ready', check: data.destination } : { status: 'idle' });
      })
      .catch((error: unknown) => {
        setPreview({ status: 'error', failure: failureOf(error, 'GitHub ne répond pas.') });
        const repoName = fullName.split('/')[1] ?? fullName;
        setForm((current) => current ?? { branch: '', name: humanizeRepoName(repoName), destination: repoName, installDeps: true, worktreePerSession: true, commands: emptyCommands() });
      });
  }, []);
  useEffect(() => {
    if (step === 'configuration' && selected && previewFor !== selected) {
      // eslint-disable-next-line react/set-state-in-effect -- reset before loading the preview of the newly selected repository
      setForm(null);
      setConflict(null);
      setFailure(null);
      loadPreview(selected);
    }
  }, [step, selected, previewFor, loadPreview]);

  // Live destination check (debounced), skipped when it is the value the preview already checked.
  const lastChecked = useRef<string | null>(null);
  useEffect(() => {
    if (preview.status === 'ready' && preview.data.destination) lastChecked.current = preview.data.destination.path;
  }, [preview]);
  const destinationValue = form?.destination.trim() ?? '';
  useEffect(() => {
    if (step !== 'configuration' || !selected || !destinationValue) return;
    if (destinationValue === lastChecked.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setDestination({ status: 'checking' });
      projectsApi
        .checkDestination(destinationValue, selected, controller.signal)
        .then((check: DestinationView) => {
          lastChecked.current = destinationValue;
          setDestination({ status: 'ready', check });
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError' || controller.signal.aborted) return;
          setDestination({ status: 'error', message: failureOf(error, 'Le dossier n\'a pas pu être vérifié.').message });
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [destinationValue, selected, step]);

  // Name of the project for A3 when the flow was reopened on a running clone.
  useEffect(() => {
    if (step !== 'clonage' || projectName || form?.name) return;
    const id = created?.projectId ?? initial.projet;
    if (!id) return;
    fetch(`/api/projects/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((detail: { project?: { name?: string } } | null) => detail?.project?.name && setProjectName(detail.project.name))
      .catch(() => undefined);
  }, [step, projectName, form?.name, created?.projectId, initial.projet]);

  // --- Actions -----------------------------------------------------------------------------------
  const close = useCallback(() => {
    if (mode === 'modal') router.back();
    else router.push('/projets');
  }, [mode, router]);

  const selectedRepo: AddRepoItem | null = useMemo(
    () => (repos.status === 'ready' && repos.data.connected ? (repos.data.repos.find((repo) => repo.fullName === selected) ?? null) : null),
    [repos, selected],
  );

  const goConfiguration = () => {
    if (!selected) return;
    setStep('configuration');
  };

  const patchForm = (patch: Partial<ConfigForm>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    if (patch.destination !== undefined) setFailure(null);
  };

  const submit = async () => {
    if (!form || !selected || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const commands: Partial<Record<CommandKey, string | null>> = {};
      for (const field of COMMAND_FIELDS) commands[field.key] = form.commands[field.key].trim() || null;
      const result = await projectsApi.create({
        fullName: selected,
        ...(form.branch ? { branch: form.branch } : {}),
        name: form.name.trim(),
        destination: form.destination.trim(),
        installDeps: form.installDeps,
        worktreePerSession: form.worktreePerSession,
        readClaudeMd: true,
        commands,
      });
      setConflict(null);
      setProjectName(form.name.trim());
      setCreated(result);
      setStep('clonage');
    } catch (error) {
      if (error instanceof ProjectApiError && error.reason === 'DESTINATION_NOT_EMPTY' && error.data) {
        const data = error.data as Partial<DestinationConflict>;
        setConflict({
          path: typeof data.path === 'string' ? data.path : form.destination,
          fileCount: typeof data.fileCount === 'number' ? data.fileCount : 0,
          suggestedPath: typeof data.suggestedPath === 'string' ? data.suggestedPath : null,
          existingClone: data.existingClone ?? null,
          existingProject: data.existingProject ?? null,
        });
      } else if (error instanceof ProjectApiError && error.reason === 'ALREADY_TRACKED') {
        const existing = (error.data?.existingProject ?? null) as { id?: string } | null;
        setFailure({ ...failureOf(error, ''), ...(existing?.id ? { projectHref: `/projets/${existing.id}` } : {}) });
      } else {
        setFailure(failureOf(error, "Le clonage n'a pas pu démarrer."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const useSuggested = (path: string) => {
    patchForm({ destination: path });
    setConflict(null);
  };

  const openExisting = async (project: NonNullable<DestinationConflict['existingProject']>) => {
    if (!project.archived) {
      router.push(`/projets/${project.id}`);
      return;
    }
    setOpeningExisting(true);
    try {
      await projectsApi.restore(project.id);
      router.push(`/projets/${project.id}`);
    } catch (error) {
      setConflict(null);
      setFailure(failureOf(error, "Le projet n'a pas pu être restauré."));
    } finally {
      setOpeningExisting(false);
    }
  };

  const retryClone = async () => {
    const projectId = created?.projectId ?? initial.projet;
    if (!projectId) return;
    setRetrying(true);
    setRetryFailure(null);
    try {
      const result = await projectsApi.retryClone(projectId);
      setCreated(result);
    } catch (error) {
      setRetryFailure(failureOf(error, "Le clonage n'a pas pu reprendre."));
    } finally {
      setRetrying(false);
    }
  };

  // --- Composition -------------------------------------------------------------------------------
  const projectId = created?.projectId ?? initial.projet;
  const fullName = selected ?? (stream.operation?.title?.replace(/^Clonage de /, '') || null);
  const displayName = projectName ?? form?.name ?? null;
  const installFailed = (stream.operation?.error?.data as { stage?: string } | undefined)?.stage === 'install';
  const canSubmit = Boolean(form && form.name.trim() && form.destination.trim()) && !submitting;
  const reposData = repos.status === 'ready' && repos.data.connected ? repos.data : null;
  const phone = !desktop;
  const variant = phone ? 'phone' : 'desktop';

  let body: ReactNode = null;
  if (step === 'depot') {
    body = (
      <RepoStep
        repos={repos}
        selected={selected}
        onSelect={(repo) => setSelected(repo.fullName)}
        onConfirm={goConfiguration}
        search={search}
        onSearch={setSearch}
        account={account}
        onAccount={setAccount}
        onRetry={loadRepos}
        variant={variant}
        now={now}
        serverName={serverName}
      />
    );
  } else if (step === 'configuration' && selected) {
    body = form ? (
      <ConfigStep
        fullName={selected}
        preview={preview}
        form={form}
        onChange={patchForm}
        onCommand={(key, value) => setForm((current) => (current ? { ...current, commands: { ...current.commands, [key]: value } } : current))}
        destination={destination}
        conflict={conflict}
        failure={failure}
        onChangeRepo={() => setStep('depot')}
        onRetryPreview={() => loadPreview(selected)}
        onUseSuggested={useSuggested}
        onOpenExisting={(project) => void openExisting(project)}
        openingExisting={openingExisting}
        variant={variant}
        now={now}
        serverName={serverName}
      />
    ) : (
      <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-label="Lecture du dépôt sur GitHub">
        <div className="h-[62px] animate-pulse rounded-md border border-border bg-surface-raised" />
        <div className="h-10 animate-pulse rounded-md border border-border bg-surface-raised" />
        <div className="h-10 animate-pulse rounded-md border border-border bg-surface-raised" />
      </div>
    );
  } else if (step === 'clonage') {
    body = <CloneStep fullName={fullName} name={displayName} stream={stream} retryFailure={retryFailure} serverName={serverName} />;
  }

  const sessionButton = projectId ? (
    <NewSessionButton projectId={projectId} variant="accent" className={phone ? 'w-full' : undefined}>
      Démarrer une session
    </NewSessionButton>
  ) : null;
  const seeProject = projectId ? (
    <Button href={`/projets/${projectId}`} block={phone}>
      Voir le projet
    </Button>
  ) : null;

  // Footer: note (desktop) + actions, per step and outcome.
  let note: ReactNode = null;
  let actions: ReactNode = null;
  if (step === 'depot') {
    note = reposData ? (
      <>
        {`${reposData.total} ${reposData.total >= 2 ? 'dépôts accessibles' : 'dépôt accessible'} · `}
        {reposData.manageAccessUrl ? (
          <a href={reposData.manageAccessUrl} target="_blank" rel="noopener noreferrer" className="text-muted underline-offset-2 hover:underline">
            gérer l'accès sur GitHub
          </a>
        ) : (
          "gérer l'accès sur GitHub"
        )}
      </>
    ) : null;
    actions = (
      <>
        {!phone ? <Button onClick={close}>Annuler</Button> : null}
        <Button variant="accent" onClick={goConfiguration} disabled={!selected || !selectedRepo || Boolean(selectedRepo.clonedProject)} block={phone}>
          Continuer
        </Button>
      </>
    );
  } else if (step === 'configuration') {
    note = <span className="font-mono">Étape 2 sur 3</span>;
    actions = (
      <>
        {!phone ? (
          <Button onClick={() => (conflict ? setConflict(null) : setStep('depot'))} disabled={submitting}>
            Retour
          </Button>
        ) : null}
        <Button variant="accent" onClick={() => void submit()} loading={submitting} disabled={!canSubmit} block={phone}>
          {conflict ? 'Réessayer' : `Cloner sur ${serverName}`}
        </Button>
      </>
    );
  } else if (outcome === 'succeeded') {
    note = cloneFooterNote(stream);
    actions = phone ? (
      <div className="flex w-full flex-col gap-2">
        {sessionButton}
        {seeProject}
      </div>
    ) : (
      <>
        {seeProject}
        {sessionButton}
      </>
    );
  } else if (outcome === 'failed') {
    note = installFailed ? `Le dépôt est cloné sur ${serverName} : l'installation se relance depuis le projet.` : 'Rien n\'a été laissé sur le serveur.';
    actions = (
      <>
        {!phone ? <Button onClick={close}>Fermer</Button> : null}
        {installFailed ? (
          seeProject
        ) : (
          <Button variant="accent" onClick={() => void retryClone()} loading={retrying} block={phone}>
            Réessayer
          </Button>
        )}
      </>
    );
  } else {
    note = `Vous pouvez fermer : le clonage continue sur ${serverName}.`;
    actions = (
      <Button onClick={close} block={phone}>
        Fermer
      </Button>
    );
  }

  const stepperIndex = step === 'clonage' && outcome === 'succeeded' ? 3 : STEP_INDEX[step];
  const title = 'Ajouter un projet';
  const description = `Le dépôt est cloné sur ${serverName}, là où Claude Code travaille.`;

  if (phone) {
    const heading =
      step === 'depot'
        ? { title: 'Choisir un dépôt', text: "Les dépôts que l'application GitHub de Nuera Dev peut lire." }
        : step === 'configuration'
          ? { title: 'Configurer le projet', text: description }
          : outcome === 'running'
            ? { title: 'Clonage', text: `Vous pouvez fermer : le clonage continue sur ${serverName}.` }
            : null;
    return (
      <PhoneShell
        title={title}
        stepNumber={STEP_INDEX[step] + 1}
        leading={
          step === 'configuration' ? (
            <IconButton icon="arrow-left" label="Retour" size="md" onClick={() => (conflict ? setConflict(null) : setStep('depot'))} />
          ) : (
            <IconButton icon="x" label={step === 'depot' ? 'Annuler' : 'Fermer'} size="md" onClick={close} />
          )
        }
        heading={heading}
        footer={actions}
        onDismiss={() => !submitting && close()}
      >
        {body}
      </PhoneShell>
    );
  }

  const header = <Stepper steps={STEPS} current={stepperIndex} />;
  if (mode === 'modal') {
    return (
      <Dialog open onOpenChange={(open) => !open && !submitting && close()}>
        <DialogContent
          title={title}
          description={description}
          header={header}
          footer={actions}
          footerNote={note}
          dismissible={!submitting}
          bodyClassName="gap-4"
        >
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <DesktopCard title={title} description={description} header={header} footer={actions} footerNote={note} onClose={close}>
      {body}
    </DesktopCard>
  );
}

/** Hard load of /projets/nouveau on desktop: the D03 modal card, in the page (no veil). */
function DesktopCard({
  title,
  description,
  header,
  footer,
  footerNote,
  onClose,
  children,
}: {
  title: string;
  description: string;
  header: ReactNode;
  footer: ReactNode;
  footerNote: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="ajout-projet-titre" className="mx-auto flex w-full max-w-[640px] flex-col overflow-hidden rounded-xl bg-bg shadow-float">
      <div className="flex flex-col gap-4 border-b border-border px-7 pt-6 pb-5">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="m-0 font-sans text-app-22 font-semibold text-text">
              {title}
            </h1>
            <p className="m-0 font-sans text-app-14 text-muted">{description}</p>
          </div>
          <IconButton icon="x" label="Fermer" size="sm" iconClassName="text-muted" onClick={onClose} />
        </div>
        {header}
      </div>
      <div className="flex flex-col gap-4 px-7 py-6">{children}</div>
      <div className="flex items-center gap-3 border-t border-border px-7 py-4">
        <p className="m-0 min-w-0 flex-1 font-sans text-app-12 text-muted">{footerNote}</p>
        <div className="flex flex-wrap items-center justify-end gap-3">{footer}</div>
      </div>
    </section>
  );
}

/** M03: full screen, top bar (leading · title · « n / 3 »), 3-segment progress, sticky action bar. */
function PhoneShell({
  title,
  stepNumber,
  leading,
  heading,
  footer,
  onDismiss,
  children,
}: {
  title: string;
  stepNumber: number;
  leading: ReactNode;
  heading: { title: string; text: string } | null;
  footer: ReactNode;
  /** Échap (same as the leading « Annuler » / « Fermer »). */
  onDismiss: () => void;
  children: ReactNode;
}) {
  // Radix Dialog, not portalled: focus trapped in the full-screen flow, Échap closes, the page under it
  // (the list, for the intercepted route) is inert; it stays inside <main>, which keeps its landmark.
  return (
    <RadixDialog.Root open modal onOpenChange={(open) => !open && onDismiss()}>
      <RadixDialog.Content aria-describedby={undefined} onInteractOutside={(event) => event.preventDefault()} className="fixed inset-0 z-40 flex flex-col bg-bg outline-none">
        <div className="pt-[env(safe-area-inset-top)]">
          <div className="flex h-[52px] items-center gap-2 px-2">
            <div className="w-11 shrink-0">{leading}</div>
            <RadixDialog.Title asChild>
              <h1 className="m-0 min-w-0 flex-1 truncate text-center font-sans text-app-16 font-semibold text-text">
                {title}
              </h1>
            </RadixDialog.Title>
            <span className="w-11 shrink-0 text-center font-mono text-app-12 text-muted">{`${stepNumber} / 3`}</span>
          </div>
          <StepProgress total={3} current={stepNumber} className="px-4" label="Étapes de l'ajout" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-4">
          {heading ? (
            <div className="flex flex-col gap-1">
              <h2 className="m-0 font-sans text-app-22 font-semibold text-text">{heading.title}</h2>
              <p className="m-0 font-sans text-app-13 text-muted">{heading.text}</p>
            </div>
          ) : null}
          {children}
        </div>
        <div className={cn('border-t border-border bg-bg px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]')}>
          <div className="flex w-full flex-col items-stretch gap-2 [&>*]:w-full">{footer}</div>
        </div>
      </RadixDialog.Content>
    </RadixDialog.Root>
  );
}
