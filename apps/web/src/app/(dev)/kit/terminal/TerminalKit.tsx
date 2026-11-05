'use client';

import { useState } from 'react';
import { LogoNueraDev } from '@/components/brand';
import { Icon } from '@/components/icons';
import { useOptionalShellData } from '@/components/shell/ShellContext';
import {
  TerminalView,
  claudeLoginTerminal,
  claudeStatusTerminal,
  closeTerminalRequest,
  createTerminal,
  fetchTerminal,
  shellTerminal,
  TerminalApiError,
  useTerminalLauncher,
  type TerminalViewState,
} from '@/components/terminal';
import { Banner, CompactButton, LinkButton, SectionLabel } from '@/components/ui';
import type { ShellWorktree } from '@/server/terminals';

const STATE_LABELS: Record<TerminalViewState, string> = {
  connecting: 'connexion',
  live: 'en direct',
  reconnecting: 'reconnexion',
  exited: 'terminé',
  error: 'erreur',
};

/** /kit/terminal (development only): real runner terminals, no sample data. */
export function TerminalKit({ worktrees, worktreesError }: { worktrees: ShellWorktree[]; worktreesError: string | null }) {
  const serverName = useOptionalShellData()?.server.name ?? 'VPS-3';
  const launcher = useTerminalLauncher();
  const [inline, setInline] = useState<{ id: string } | null>(null);
  const [inlineState, setInlineState] = useState<TerminalViewState | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openInline = async () => {
    setBusy(true);
    setError(null);
    try {
      const terminal = await createTerminal({ kind: 'claude-status' });
      setInline({ id: terminal.id });
      setInfo(null);
    } catch (err) {
      setError(err instanceof TerminalApiError ? err.message : "Le terminal n'a pas pu s'ouvrir.");
    } finally {
      setBusy(false);
    }
  };

  const closeInline = async () => {
    if (!inline) return;
    const id = inline.id;
    setInline(null);
    setInlineState(null);
    setInfo(null);
    await closeTerminalRequest(id).catch(() => undefined);
  };

  const readInfo = async () => {
    if (!inline) return;
    try {
      const terminal = await fetchTerminal(inline.id);
      setInfo(`${terminal.kind} · ${terminal.cols} × ${terminal.rows} · ${terminal.alive ? 'vivant' : `terminé (code ${terminal.exitCode ?? '?'})`} · ${terminal.private ? 'privé' : 'non privé'}`);
    } catch (err) {
      setInfo(err instanceof TerminalApiError ? err.message : 'Lecture impossible.');
    }
  };

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-10 px-4 py-8 nav:px-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <LogoNueraDev tone="encre" />
          <h1 className="m-0 font-sans text-app-28 font-semibold text-text">Terminal</h1>
        </div>
        <p className="m-0 max-w-[760px] font-sans text-app-14 leading-5 text-muted">
          Terminal partagé (components/terminal) sur de vrais terminaux du runner de développement — le faux CLI de test
          quand NUERA_CLAUDE_BIN le désigne. Autres galeries :{' '}
          <LinkButton href="/kit" size={14}>
            /kit
          </LinkButton>{' '}
          ·{' '}
          <LinkButton href="/kit/composites" size={14}>
            /kit/composites
          </LinkButton>
        </p>
      </header>

      <section aria-labelledby="kit-inline" className="flex flex-col gap-4 border-t border-border pt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="kit-inline" className="m-0 font-sans text-app-22 font-semibold text-text">
            Terminal intégré
          </h2>
          <span className="font-mono text-app-11 text-muted">W2 227:3801 · Terminal brut · JetBrains Mono 13 / 21</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {inline ? (
            <>
              <CompactButton variant="secondaire" icon="x" onClick={() => void closeInline()}>
                Fermer ce terminal
              </CompactButton>
              <CompactButton variant="discret" onClick={() => void readInfo()}>
                Lire l'état (GET)
              </CompactButton>
              <span className="font-mono text-app-12 text-muted" data-testid="kit-inline-state">
                {inlineState ? STATE_LABELS[inlineState] : ''}
              </span>
            </>
          ) : (
            <CompactButton icon="terminal" loading={busy} onClick={() => void openInline()}>
              Ouvrir /status ici
            </CompactButton>
          )}
        </div>
        {error ? (
          <Banner tone="danger" title="Le terminal n'a pas pu s'ouvrir.">
            {error}
          </Banner>
        ) : null}
        {info ? <p className="m-0 font-mono text-app-12 text-muted" data-testid="kit-inline-info">{info}</p> : null}
        <div className="flex h-[560px] max-w-[908px] flex-col gap-3.5 rounded-lg border border-border bg-bg px-4 py-4 nav:px-6 nav:py-5">
          {inline ? (
            <TerminalView
              terminalId={inline.id}
              label="Terminal Claude Code"
              className="flex-1"
              onStateChange={setInlineState}
            />
          ) : (
            <div data-tone="dark" className="flex flex-1 items-center justify-center rounded-md bg-bg px-6 text-center font-mono text-app-12 text-muted">
              Aucun terminal ouvert : « Ouvrir /status ici » lance le CLI sur {serverName}.
            </div>
          )}
          <p className="m-0 flex items-center gap-2 font-sans text-app-12 text-muted">
            <Icon name="terminal" size={14} />
            Flux exact du processus Claude Code, sans mise en forme. Clavier relié au terminal : Échap interrompt, Ctrl+C aussi.
          </p>
        </div>
      </section>

      <section aria-labelledby="kit-windows" className="flex flex-col gap-4 border-t border-border pt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="kit-windows" className="m-0 font-sans text-app-22 font-semibold text-text">
            Fenêtres
          </h2>
          <span className="font-mono text-app-11 text-muted">TerminalDialog · fenêtre au bureau, feuille au téléphone</span>
        </div>
        <div className="flex flex-col gap-3">
          <SectionLabel>Paramètres · Claude Code (T6, D08)</SectionLabel>
          <div className="flex flex-wrap items-center gap-3">
            <CompactButton variant="discret" icon="refresh" onClick={() => launcher.open(claudeLoginTerminal({ serverName }))}>
              Se reconnecter dans un terminal
            </CompactButton>
            <CompactButton variant="secondaire" icon="terminal" onClick={() => launcher.open(claudeStatusTerminal({ serverName }))}>
              Ouvrir /status
            </CompactButton>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <SectionLabel>Workspace · shell d'un worktree</SectionLabel>
          {worktreesError ? <p className="m-0 font-sans text-app-13 text-muted">{worktreesError}</p> : null}
          {worktrees.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              {worktrees.map((worktree) => (
                <CompactButton
                  key={worktree.id}
                  variant="secondaire"
                  icon="terminal"
                  onClick={() => launcher.open(shellTerminal({ id: worktree.id, name: worktree.name }, { serverName }))}
                >
                  {`Shell · ${worktree.name}`}
                </CompactButton>
              ))}
            </div>
          ) : worktreesError ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <CompactButton variant="secondaire" icon="terminal" disabled aria-describedby="kit-no-worktree">
                Shell d'un worktree
              </CompactButton>
              <span id="kit-no-worktree" className="font-sans text-app-13 text-muted">
                Aucun worktree actif en base : ajoutez un projet pour ouvrir un shell.
              </span>
            </div>
          )}
        </div>
      </section>
      {launcher.dialog}
    </div>
  );
}
