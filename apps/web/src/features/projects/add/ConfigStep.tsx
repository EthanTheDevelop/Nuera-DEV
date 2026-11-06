'use client';

import { useId, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Badge, Banner, CompactButton, ErrorPanel, Field, Input, Select, Skeleton, Switch } from '@/components/ui';
import { joinParts } from '@/components/dev/lib/format';
import { cn } from '@/lib/cn';
import type { AddRepoSource, DestinationView, RepoPreview } from '@/server/projects/types';
import type { Failure } from '../FailureBanner';
import { freeSpaceText, sizeText, updatedAgo } from '../format';

export const COMMAND_FIELDS = [
  { key: 'install', label: 'Installation' },
  { key: 'dev', label: 'Lancement' },
  { key: 'build', label: 'Build' },
  { key: 'test', label: 'Tests' },
  { key: 'lint', label: 'Lint' },
] as const;
export type CommandKey = (typeof COMMAND_FIELDS)[number]['key'];

export interface ConfigForm {
  branch: string;
  name: string;
  destination: string;
  installDeps: boolean;
  worktreePerSession: boolean;
  commands: Record<CommandKey, string>;
}

export type PreviewState = { status: 'loading' } | { status: 'ready'; data: RepoPreview } | { status: 'error'; failure: Failure };

export type DestinationState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; check: DestinationView }
  | { status: 'error'; message: string };

/** A4: the destination the server refused on submit (`DESTINATION_NOT_EMPTY` data). */
export interface DestinationConflict {
  path: string;
  fileCount: number;
  suggestedPath: string | null;
  existingClone: { fullName: string | null; branch: string | null; sameRepository: boolean } | null;
  existingProject: { id: string; name: string; archived: boolean } | null;
}

export interface ConfigStepProps {
  fullName: string;
  preview: PreviewState;
  form: ConfigForm;
  onChange: (patch: Partial<ConfigForm>) => void;
  onCommand: (key: CommandKey, value: string) => void;
  destination: DestinationState;
  conflict: DestinationConflict | null;
  /** Other submit failure (T4), shown above the actions. */
  failure: Failure | null;
  onChangeRepo: () => void;
  onRetryPreview: () => void;
  onUseSuggested: (path: string) => void;
  onOpenExisting: (project: NonNullable<DestinationConflict['existingProject']>) => void;
  openingExisting: boolean;
  variant: 'desktop' | 'phone';
  now: number;
  serverName: string;
  /** GitHub sources of the space reaching the repository (the selector shows from two). */
  sources: AddRepoSource[];
  /** Source used to read and clone it (null = resolved by the server). */
  sourceId: string | null;
  onSource: (sourceId: string) => void;
}

const fileCountText = (n: number) => `${n} ${n >= 2 ? 'fichiers' : 'fichier'}`;

/**
 * D03 « Configuration » (+ A4 « Erreur récupérable » when the server refused the destination):
 * chosen repository, starting branch, display name, destination on the server (checked live by the
 * runner), options, detected commands (editable), GitHub access note.
 */
export function ConfigStep(props: ConfigStepProps) {
  const { fullName, preview, form, onChange, onCommand, destination, conflict, failure, variant, now, serverName, sources, sourceId } = props;
  const phone = variant === 'phone';
  const ids = { branch: useId(), name: useId(), destination: useId(), commands: useId(), source: useId() };
  const source = sources.find((item) => item.id === sourceId) ?? null;

  if (conflict) return <ConflictView {...props} conflict={conflict} />;

  const data = preview.status === 'ready' ? preview.data : null;
  const inspection = data?.inspection ?? null;
  const branches = data?.branches ?? (form.branch ? [form.branch] : []);
  const check = destination.status === 'ready' ? destination.check : null;
  const destinationError =
    check && !check.available
      ? check.exists && !check.empty
        ? `Ce dossier contient déjà ${fileCountText(check.fileCount)}.`
        : 'Ce dossier ne peut pas recevoir le clone.'
      : destination.status === 'error'
        ? destination.message
        : undefined;

  const installCommand = form.commands.install.trim() || inspection?.commands.install || null;
  const installHint = inspection
    ? inspection.lockfile && installCommand
      ? `Lance ${installCommand} : le gestionnaire est détecté depuis ${inspection.lockfile}.`
      : installCommand
        ? `Lance ${installCommand} : aucun fichier de verrouillage trouvé.`
        : 'Aucun package.json à la racine : rien à installer.'
    : 'Le gestionnaire est détecté après le clonage, depuis le fichier de verrouillage.';

  return (
    <div className="flex flex-col gap-5">
      {/* Dépôt choisi */}
      <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface-raised px-4 py-3">
        <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm bg-accent-pale text-accent">
          <Icon name="github" size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="m-0 truncate font-mono text-app-14 font-medium text-text">{fullName}</p>
          {data ? (
            <p className="m-0 truncate font-sans text-app-12 text-muted">
              {joinParts(data.private ? 'Privé' : 'Public', data.language, updatedAgo(data.pushedAt, now), sizeText(data.sizeBytes))}
            </p>
          ) : preview.status === 'loading' ? (
            <Skeleton width={220} height={10} />
          ) : null}
        </div>
        <CompactButton variant="discret" onClick={props.onChangeRepo}>
          Changer
        </CompactButton>
      </div>

      {sources.length > 1 ? (
        <Field id={ids.source} label="Source GitHub" hint="Ce dépôt est accessible par plusieurs sources GitHub de votre espace : le projet utilisera celle-ci.">
          <Select
            options={sources.map((item) => ({ value: item.id, label: item.label }))}
            value={sourceId ?? sources[0]!.id}
            onValueChange={props.onSource}
            icon="github"
            size={phone ? 'lg' : 'md'}
          />
        </Field>
      ) : null}

      {preview.status === 'error' ? (
        <ErrorPanel
          title="Le dépôt n'a pas pu être lu sur GitHub"
          excerpt={joinParts(preview.failure.message, preview.failure.detail)}
          untouched="Rien n'a été cloné."
          raw={preview.failure.raw ?? null}
          onRetry={props.onRetryPreview}
        />
      ) : null}

      <div className={cn('grid gap-4', phone ? 'grid-cols-1' : 'grid-cols-2')}>
        <Field id={ids.branch} label="Branche de départ">
          <Select
            options={branches.map((branch) => ({ value: branch, label: branch }))}
            value={form.branch}
            onValueChange={(branch) => onChange({ branch })}
            icon="git-branch"
            size={phone ? 'lg' : 'md'}
            disabled={branches.length === 0}
            className="font-mono"
          />
        </Field>
        <Field id={ids.name} label="Nom dans Nuera Dev" error={form.name.trim() ? undefined : 'Nom requis.'}>
          <Input value={form.name} onChange={(event) => onChange({ name: event.target.value })} size={phone ? 'lg' : 'md'} maxLength={120} autoComplete="off" />
        </Field>
      </div>

      <Field
        id={ids.destination}
        label={`Destination sur ${serverName}`}
        hint={destinationError ? undefined : destination.status === 'checking' ? 'Vérification du dossier…' : freeSpaceText(data?.disk ?? null)}
        error={destinationError}
      >
        <Input
          mono
          leadingIcon="folder"
          value={form.destination}
          onChange={(event) => onChange({ destination: event.target.value })}
          size={phone ? 'lg' : 'md'}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {check && !check.available && check.suggestedPath ? (
        <button
          type="button"
          onClick={() => props.onUseSuggested(check.suggestedPath!)}
          className="nu-hit relative -mt-3 self-start text-left font-sans text-app-13 font-medium break-all text-accent hover:underline"
        >
          {`Utiliser ${check.suggestedPath}`}
        </button>
      ) : null}

      {/* Options */}
      <div className="flex flex-col overflow-hidden rounded-md border border-border bg-bg">
        <OptionRow
          title="Installer les dépendances après le clonage"
          description={installHint}
          control={<Switch checked={form.installDeps} onCheckedChange={(installDeps) => onChange({ installDeps })} aria-label="Installer les dépendances après le clonage" />}
        />
        <OptionRow
          title="Un worktree par nouvelle session"
          description="Deux sessions ne modifient jamais le même dossier."
          control={
            <Switch checked={form.worktreePerSession} onCheckedChange={(worktreePerSession) => onChange({ worktreePerSession })} aria-label="Un worktree par nouvelle session" />
          }
        />
        <OptionRow
          title="CLAUDE.md du dépôt"
          description={
            inspection
              ? inspection.claudeMd
                ? 'Trouvé à la racine. Claude Code le lit à chaque session.'
                : 'Absent à la racine : vous pourrez le créer depuis le projet.'
              : 'Vérifié après le clonage. Claude Code le lit à chaque session.'
          }
          control={
            inspection ? (
              <Badge tone={inspection.claudeMd ? 'success' : 'neutral'}>{inspection.claudeMd ? 'Détecté' : 'Absent'}</Badge>
            ) : (
              <Badge tone="neutral">À vérifier</Badge>
            )
          }
        />
      </div>

      {/* Detected commands (editable) */}
      <details className="group rounded-md border border-border">
        <summary className="nu-hit relative flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <Icon name="terminal" size={16} className="text-muted" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-sans text-app-14 font-medium text-text">Commandes du projet</span>
            <span className="font-sans text-app-12 text-muted">
              {inspection
                ? joinParts(...COMMAND_FIELDS.filter((f) => form.commands[f.key].trim()).map((f) => f.label.toLowerCase())) || 'Aucune détectée dans package.json.'
                : 'Laissées vides, elles sont détectées après le clonage depuis package.json.'}
            </span>
          </span>
          <Icon name="chevron-down" size={16} className="text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div id={ids.commands} className="flex flex-col gap-3 border-t border-border px-4 py-3">
          {COMMAND_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <Input
                mono
                value={form.commands[field.key]}
                onChange={(event) => onCommand(field.key, event.target.value)}
                placeholder="détectée après le clonage"
                size={phone ? 'lg' : 'md'}
                maxLength={1000}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ))}
        </div>
      </details>

      <p className="m-0 flex items-start gap-2 font-sans text-app-12 leading-4 text-muted">
        <Icon name="shield" size={16} className="shrink-0 text-success" />
        {sources.length > 1 && source
          ? `Accès GitHub : lecture et écriture du contenu, pull requests. Accordé à la source GitHub « ${source.label} », jamais par jeton collé à la main.`
          : "Accès GitHub : lecture et écriture du contenu, pull requests. Accordé à l'application GitHub de Nuera Dev, jamais par jeton collé à la main."}
      </p>

      {failure ? (
        <ErrorPanel title={failure.message} excerpt={failure.detail} untouched={failure.untouched ?? "Rien n'a été cloné."} raw={failure.raw ?? null} />
      ) : null}
    </div>
  );
}

function OptionRow({ title, description, control }: { title: string; description: string; control: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="m-0 font-sans text-app-14 font-medium text-text">{title}</p>
        <p className="m-0 font-sans text-app-12 text-muted">{description}</p>
      </div>
      {control}
    </div>
  );
}

/** A4 — destination not empty: banner, field in error, suggestions (only what really exists). */
function ConflictView({ conflict, form, onChange, onUseSuggested, onOpenExisting, openingExisting, variant, serverName }: ConfigStepProps & { conflict: DestinationConflict }) {
  const fieldId = useId();
  const phone = variant === 'phone';
  const existing = conflict.existingProject;
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="danger" title="Le dossier de destination n'est pas vide" live>
        {`${conflict.path} contient déjà ${fileCountText(conflict.fileCount)}. Rien n'a été écrasé.`}
      </Banner>
      <Field id={fieldId} label={`Destination sur ${serverName}`} error="Choisissez un dossier vide, ou ouvrez le projet qui s'y trouve déjà.">
        <Input
          mono
          leadingIcon="folder"
          value={form.destination}
          onChange={(event) => onChange({ destination: event.target.value })}
          size={phone ? 'lg' : 'md'}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <div className="flex flex-col gap-2">
        {conflict.suggestedPath ? (
          <SuggestionCard
            title={`Utiliser ${conflict.suggestedPath}`}
            description="Dossier libre, proposé automatiquement"
            onClick={() => onUseSuggested(conflict.suggestedPath!)}
          />
        ) : null}
        {existing ? (
          <SuggestionCard
            title={existing.archived ? 'Restaurer le projet archivé' : 'Ouvrir le projet existant'}
            description={
              conflict.existingClone?.sameRepository
                ? `Le dossier contient déjà un clone de ce dépôt${conflict.existingClone.branch ? ` (${conflict.existingClone.branch})` : ''}`
                : `Le dossier appartient au projet « ${existing.name} »`
            }
            onClick={() => onOpenExisting(existing)}
            busy={openingExisting}
          />
        ) : null}
      </div>
    </div>
  );
}

function SuggestionCard({ title, description, onClick, busy }: { title: string; description: string; onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex min-h-11 w-full flex-col gap-0.5 rounded-md border border-border px-3.5 py-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-hover disabled:cursor-progress disabled:opacity-60"
    >
      <span className="font-sans text-app-14 font-medium break-all text-accent">{title}</span>
      <span className="font-sans text-app-12 text-muted">{description}</span>
    </button>
  );
}
