'use client';

import {
  Banner,
  CompactButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorPanel,
  IconButton,
  Input,
  SegmentedControl,
  SkeletonList,
  Spinner,
  StatusDot,
  Switch,
  type StatusTone,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useWorkspace } from '../WorkspaceContext';
import { usePreview, type PreviewController, type PreviewViewport, type ServerState } from './usePreview';

/**
 * « Aperçu » (not designed in Figma; built with the design-system primitives): live preview of the
 * worktree's dev server, served from the preview origin (never the application's). Three placements:
 * the context panel tab (`?panneau=apercu`), the main view (`?vue=apercu`, « Inverser » : the conversation moves to the side column) and the
 * phone tab (`?onglet=apercu`).
 */

export type PreviewVariant = 'panel' | 'main' | 'phone';

const STATE_TONE: Record<ServerState, StatusTone> = {
  loading: 'neutral',
  unavailable: 'warn',
  stopped: 'neutral',
  starting: 'running',
  online: 'success',
  error: 'danger',
};

function stateLabel(preview: PreviewController): string {
  switch (preview.state) {
    case 'loading':
      return 'Lecture du serveur…';
    case 'unavailable':
      return 'État inconnu';
    case 'stopped':
      return 'Serveur arrêté';
    case 'starting':
      return 'Démarrage…';
    case 'online':
      return `En ligne · port ${preview.run?.port ?? ''}`;
    case 'error':
      return preview.run?.exitCode !== null && preview.run?.exitCode !== undefined ? `Erreur · code ${preview.run.exitCode}` : 'Erreur';
  }
}

/** Why « Démarrer le serveur » cannot be used right now (null = it can). */
function startBlocker(preview: PreviewController): string | null {
  if (!preview.worktreePresent) return 'Worktree supprimé : aucun serveur ne peut y être lancé.';
  if (!preview.devCommand) return "Aucune commande de développement n'est configurée pour ce projet.";
  return preview.serverDisabledReason;
}

const isRunning = (state: ServerState) => state === 'starting' || state === 'online';

function ServerButton({ preview, size = 'md' }: { preview: PreviewController; size?: 'md' | 'lg' }) {
  if (isRunning(preview.state)) {
    return (
      <CompactButton variant="secondaire" size={size} icon="stop" loading={preview.stopping} disabled={Boolean(preview.serverDisabledReason)} onClick={() => void preview.stop()}>
        Arrêter
      </CompactButton>
    );
  }
  const blocker = startBlocker(preview);
  return (
    <CompactButton
      variant="principal"
      size={size}
      icon="play"
      loading={preview.starting}
      disabled={Boolean(blocker) || preview.state === 'loading'}
      title={blocker ?? undefined}
      onClick={() => void preview.start()}
    >
      Démarrer le serveur
    </CompactButton>
  );
}

function ServerStatus({ preview, className }: { preview: PreviewController; className?: string }) {
  return (
    <p className={cn('m-0 flex min-w-0 items-center gap-2 font-sans text-app-13 font-medium text-text', className)} aria-live="polite">
      <StatusDot tone={STATE_TONE[preview.state]} />
      <span className="truncate">{stateLabel(preview)}</span>
    </p>
  );
}

function PathForm({ preview, size }: { preview: PreviewController; size: 'md' | 'lg' }) {
  const [draft, setDraft] = useState(preview.path);
  const [editing, setEditing] = useState(false);
  // The field follows the page shown in the frame, unless it is being edited.
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- mirrors the frame position (posted by the preview page)
    if (!editing) setDraft(preview.path);
  }, [editing, preview.path]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    preview.navigate(draft);
    setEditing(false);
  };
  return (
    <form onSubmit={submit} className="min-w-0 flex-1" role="search" aria-label="Adresse de l'aperçu">
      <Input
        mono
        size={size}
        value={draft}
        onChange={(event) => {
          setEditing(true);
          setDraft(event.target.value);
        }}
        onBlur={() => setEditing(false)}
        aria-label="Chemin de la page"
        placeholder="/"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="go"
        disabled={preview.state !== 'online'}
        shellClassName="w-full"
      />
    </form>
  );
}

/** Shown when the frame stays without a page of the dev server (see `usePreview` STALL_MS). */
function StallHint({ preview }: { preview: PreviewController }) {
  if (preview.state !== 'online' || !preview.stalled) return null;
  return (
    <p role="status" className="m-0 font-sans text-app-12 text-muted">
      La page ne s&apos;affiche toujours pas : rechargez-la, ou ouvrez-la dans un nouvel onglet pour voir ce que renvoie le serveur de développement.
    </p>
  );
}

function AutoReloadSwitch({ preview }: { preview: PreviewController }) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Switch id={id} checked={preview.autoReload} onCheckedChange={preview.setAutoReload} aria-describedby={`${id}-aide`} />
      <label htmlFor={id} className="min-w-0 font-sans text-app-13 text-text">
        Recharger après chaque modification de Claude
      </label>
      <span id={`${id}-aide`} className="sr-only">
        Le rechargement à chaud du serveur de développement ne traverse pas l&apos;aperçu.
      </span>
    </div>
  );
}

function DesktopToolbar({ preview, variant }: { preview: PreviewController; variant: 'panel' | 'main' }) {
  const ws = useWorkspace();
  const online = preview.state === 'online';
  const main = variant === 'main';
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerStatus preview={preview} className="flex-1" />
        <ServerButton preview={preview} />
        {main ? (
          <CompactButton variant="secondaire" icon="panel-right" onClick={() => ws.url.set({ vue: null, panneau: 'apercu' })}>
            Inverser
          </CompactButton>
        ) : (
          <CompactButton variant="discret" icon="panel-right" onClick={() => ws.url.set({ vue: 'apercu', panneau: 'apercu' })}>
            Inverser
          </CompactButton>
        )}
      </div>
      {online ? (
        <>
          <div className="flex min-w-0 items-center gap-1">
            <PathForm preview={preview} size="md" />
            <IconButton icon="refresh" label="Recharger" size="sm" onClick={() => preview.reload()} />
            <IconButton icon="external" label="Ouvrir dans un nouvel onglet" size="sm" onClick={() => void preview.openInNewTab()} />
          </div>
          <StallHint preview={preview} />
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <AutoReloadSwitch preview={preview} />
            <SegmentedControl<PreviewViewport>
              aria-label="Largeur de l'aperçu"
              value={preview.viewport}
              onValueChange={preview.setViewport}
              items={[
                { value: 'bureau', label: 'Bureau', icon: 'monitor' },
                { value: 'telephone', label: 'Téléphone', icon: 'smartphone' },
              ]}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function PhoneToolbar({ preview }: { preview: PreviewController }) {
  const running = isRunning(preview.state);
  const blocker = startBlocker(preview);
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-bg px-3 py-2">
      <div className="flex min-w-0 items-center gap-1">
        <ServerStatus preview={preview} className="flex-1 pl-1" />
        <IconButton icon="refresh" label="Recharger" onClick={() => preview.reload()} disabled={preview.state !== 'online'} />
        <IconButton icon="external" label="Ouvrir dans un nouvel onglet" onClick={() => void preview.openInNewTab()} disabled={preview.state !== 'online'} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon="more" label="Actions de l'aperçu" />
          </DropdownMenuTrigger>
          <DropdownMenuContent width={280}>
            {running ? (
              <DropdownMenuItem icon="stop" disabled={preview.stopping || Boolean(preview.serverDisabledReason)} onSelect={() => void preview.stop()}>
                Arrêter le serveur
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon="play" disabled={preview.starting || Boolean(blocker) || preview.state === 'loading'} onSelect={() => void preview.start()}>
                Démarrer le serveur
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              icon={preview.autoReload ? 'check' : 'refresh'}
              onSelect={() => preview.setAutoReload(!preview.autoReload)}
              aside={<span className="font-sans text-app-12 text-muted">{preview.autoReload ? 'activé' : 'désactivé'}</span>}
            >
              Recharger après chaque modification de Claude
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {preview.state === 'online' ? <PathForm preview={preview} size="lg" /> : null}
      <StallHint preview={preview} />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-4 text-center">{children}</div>;
}

function Body({ preview, variant }: { preview: PreviewController; variant: PreviewVariant }) {
  const ws = useWorkspace();
  const phone = variant === 'phone';
  if (!preview.enabled) {
    return (
      <Centered>
        <EmptyState icon="eye" title="Aperçu indisponible" variant="plain">
          {preview.disabledReason}
        </EmptyState>
      </Centered>
    );
  }
  if (!preview.worktreePresent) {
    return (
      <Centered>
        <EmptyState icon="eye" title="Worktree supprimé" variant="plain">
          Le worktree de cette session n&apos;existe plus : aucun serveur de développement ne peut y être lancé.
        </EmptyState>
      </Centered>
    );
  }
  if (!preview.devCommand) {
    return (
      <Centered>
        <EmptyState
          icon="eye"
          title="Aucune commande de développement"
          variant="plain"
          action={
            <CompactButton variant="secondaire" icon="projets" size={phone ? 'lg' : 'md'} href={`/projets/${encodeURIComponent(preview.projectId)}?onglet=environnement`}>
              Ouvrir l&apos;onglet Environnement
            </CompactButton>
          }
        >
          Renseignez la commande qui lance le serveur de développement du projet (par exemple npm run dev) dans l&apos;onglet Environnement :
          l&apos;aperçu l&apos;utilise dans ce worktree.
        </EmptyState>
      </Centered>
    );
  }
  switch (preview.state) {
    case 'loading':
      return (
        <div className="p-4">
          <SkeletonList rows={4} card={false} label="Lecture du serveur de développement" />
        </div>
      );
    case 'unavailable':
      return (
        <div className="p-4">
          <ErrorPanel title="L'état du serveur de développement est indisponible" excerpt={preview.loadError} onRetry={preview.retryLoad} />
        </div>
      );
    case 'stopped':
      return (
        <Centered>
          <EmptyState icon="eye" title="Serveur de développement arrêté" variant="plain" action={phone ? <ServerButton preview={preview} size="lg" /> : undefined}>
            {`Démarrez ${preview.devCommand} dans ce worktree : le site s'affiche ici dès que son port apparaît dans la sortie.`}
          </EmptyState>
        </Centered>
      );
    case 'error':
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <ErrorPanel
            title="Le serveur de développement s'est arrêté"
            exitCode={preview.run?.exitCode ?? null}
            excerpt={preview.outputLines ? <span className="whitespace-pre-wrap">{preview.outputLines}</span> : undefined}
            raw={preview.output || null}
            {...(phone ? { onRetry: () => void preview.start(), retryLabel: 'Redémarrer le serveur', retrying: preview.starting } : {})}
          />
        </div>
      );
    case 'starting':
      return (
        <Centered>
          <Spinner size={20} label="Démarrage du serveur de développement" />
          <p className="m-0 font-sans text-app-14 text-text">{`Démarrage de ${preview.run?.command || preview.devCommand}…`}</p>
          <p className="m-0 font-sans text-app-12 text-muted">L&apos;aperçu s&apos;ouvre dès que le port apparaît dans la sortie.</p>
          {preview.outputLines ? (
            <pre data-tone="dark" className="m-0 max-h-48 w-full max-w-xl overflow-auto rounded-md bg-bg px-3 py-2.5 text-left font-mono text-app-11 leading-[17px] whitespace-pre-wrap text-muted">
              {preview.outputLines}
            </pre>
          ) : null}
        </Centered>
      );
    case 'online':
      return <Frame preview={preview} variant={variant} title={`Aperçu du site · ${ws.data.project.name}`} />;
  }
}

function Frame({ preview, variant, title }: { preview: PreviewController; variant: PreviewVariant; title: string }) {
  const { attachFrame, frameSrc, opening, reopen, viewport } = preview;
  const framed = variant !== 'phone' && viewport === 'telephone';
  return (
    <div className={cn('relative flex min-h-0 flex-1 bg-surface-raised', framed && 'justify-center overflow-auto p-4')}>
      {frameSrc ? (
        // The frame is on the preview origin, never the application's: allow-same-origin keeps the
        // previewed site's own origin (its storage, its cookies), not ours.
        <iframe
          ref={attachFrame}
          src={frameSrc}
          title={title}
          // oxlint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads"
          className={cn('block min-h-0 border-0 bg-paper', framed ? 'h-full w-[390px] max-w-full shrink-0 rounded-lg border border-border shadow-soft' : 'h-full w-full')}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Spinner size={20} label="Ouverture de l'aperçu" />
          <p className="m-0 font-sans text-app-13 text-muted">{opening ? "Ouverture de l'aperçu…" : "L'aperçu n'a pas pu être ouvert."}</p>
          {!opening ? (
            <CompactButton variant="secondaire" icon="refresh" onClick={() => reopen()}>
              Réessayer
            </CompactButton>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The preview with its toolbar, for one placement. */
export function PreviewPanel({ variant }: { variant: PreviewVariant }) {
  const preview = usePreview();
  const ready = preview.enabled && preview.worktreePresent && Boolean(preview.devCommand);
  return (
    <section aria-label="Aperçu du site" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {ready ? variant === 'phone' ? <PhoneToolbar preview={preview} /> : <DesktopToolbar preview={preview} variant={variant} /> : null}
      {preview.actionError ? (
        <Banner
          tone="danger"
          title="Aperçu"
          className={variant === 'phone' ? 'mx-3 mt-2 shrink-0' : 'mx-4 mt-3 shrink-0'}
          action={
            <CompactButton variant="discret" onClick={preview.clearActionError}>
              Fermer
            </CompactButton>
          }
        >
          {preview.actionError}
        </Banner>
      ) : null}
      <Body preview={preview} variant={variant} />
    </section>
  );
}
