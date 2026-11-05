/**
 * Ready-made terminal windows for `useTerminalLauncher().open(…)` / `<TerminalDialog {...} />`:
 * one wording for every page that opens the same kind of terminal (Paramètres, T6, Intégrations,
 * Workspace). Pass the server name of the shell (`useOptionalShellData()?.server.name`).
 *
 *   launcher.open(claudeLoginTerminal({ serverName, onExit: () => router.refresh() }));
 */

import type { ReactNode } from 'react';
import { createTerminal, startMcpLoginTerminal } from './api';

export interface TerminalLaunch {
  title: string;
  description?: ReactNode;
  privacyNote?: ReactNode;
  create: () => Promise<{ terminalId: string }>;
  onExit?: (code: number | null) => void;
  /** Accessible name of the terminal (default: the title). */
  label?: string;
}

export interface PresetOptions {
  /** app_settings.serverName (default « VPS-3 »). */
  serverName?: string;
  onExit?: (code: number | null) => void;
}

/** Login and /status terminals are private on the runner: output never logged nor kept. */
export const TERMINAL_PRIVACY_NOTE =
  "Rien de ce qui s'affiche ou se tape ici n'est enregistré : ni journal, ni historique, tout est effacé à la fermeture.";

const withExit = (launch: TerminalLaunch, onExit: PresetOptions['onExit']): TerminalLaunch => (onExit ? { ...launch, onExit } : launch);

/** « Se reconnecter dans un terminal » (Paramètres · Claude Code, T6): `claude auth login`. */
export function claudeLoginTerminal(options: PresetOptions = {}): TerminalLaunch {
  const server = options.serverName ?? 'VPS-3';
  return withExit(
    {
      title: 'Connexion à Claude Code',
      description: `Procédure officielle du CLI (claude auth login) sur ${server} : ouvrez le lien affiché, autorisez l'accès, puis collez ici le code si le CLI le demande.`,
      privacyNote: TERMINAL_PRIVACY_NOTE,
      label: 'Terminal de connexion à Claude Code',
      create: async () => ({ terminalId: (await createTerminal({ kind: 'claude-login' })).id }),
    },
    options.onExit,
  );
}

/** « Ouvrir /status » (Paramètres · Utilisation et limites): the CLI itself, the owner types /status. */
export function claudeStatusTerminal(options: PresetOptions = {}): TerminalLaunch {
  const server = options.serverName ?? 'VPS-3';
  return withExit(
    {
      title: 'Claude Code · /status',
      description: `CLI officiel ouvert sur ${server} : tapez /status puis Entrée. Le compte, l'utilisation et les limites s'affichent tels que le CLI les donne ; rien n'est envoyé à Claude tant que vous ne tapez pas d'instruction.`,
      privacyNote: TERMINAL_PRIVACY_NOTE,
      label: 'Terminal Claude Code',
      create: async () => ({ terminalId: (await createTerminal({ kind: 'claude-status' })).id }),
    },
    options.onExit,
  );
}

/** Intégrations « Reconnecter » an OAuth MCP server: `claude mcp login <name> --no-browser`. */
export function mcpLoginTerminal(server: { name: string; label: string }, options: PresetOptions = {}): TerminalLaunch {
  const host = options.serverName ?? 'VPS-3';
  return withExit(
    {
      title: `Connexion MCP · ${server.label}`,
      description: `Procédure officielle du CLI (claude mcp login) sur ${host} : ouvrez le lien affiché et autorisez l'accès. L'autorisation reste dans Claude Code, Nuera Dev n'en garde rien.`,
      privacyNote: TERMINAL_PRIVACY_NOTE,
      label: `Terminal de connexion MCP · ${server.label}`,
      create: async () => ({ terminalId: (await startMcpLoginTerminal(server.name)).terminalId }),
    },
    options.onExit,
  );
}

/** A shell (bash/zsh, PowerShell on a Windows dev machine) in an active worktree. */
export function shellTerminal(worktree: { id: string; name: string }, options: PresetOptions = {}): TerminalLaunch {
  const server = options.serverName ?? 'VPS-3';
  return withExit(
    {
      title: `Terminal · ${worktree.name}`,
      description: `Shell du worktree ${worktree.name} sur ${server}. Il se ferme avec cette fenêtre.`,
      label: `Terminal du worktree ${worktree.name}`,
      create: async () => ({ terminalId: (await createTerminal({ kind: 'shell', worktreeId: worktree.id })).id }),
    },
    options.onExit,
  );
}
