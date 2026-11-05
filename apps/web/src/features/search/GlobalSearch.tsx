'use client';

import { useMemo, useState } from 'react';
import { sessionStatusMeta } from '@/components/dev';
import { useRegisterCommands, useRegisterSearchProvider, type CommandGroupDef, type CommandItem, type CommandSearchProvider } from '@/components/shell';
import { NewSessionDialog } from '@/features/sessions';
import { createSearchClient, type SearchClient } from './client';
import type { SearchResults } from './contract';

function projectItems(results: SearchResults): CommandItem[] {
  return results.projects.map((p) => ({
    id: `projet-${p.id}`,
    label: p.name,
    description: [p.fullName, p.path, p.status === 'archived' ? 'archivé' : p.status === 'cloning' ? 'clonage en cours' : p.status === 'error' ? 'en erreur' : null]
      .filter(Boolean)
      .join(' · '),
    icon: 'projets',
    keywords: [p.fullName, p.path],
    href: p.href,
  }));
}

function sessionItems(results: SearchResults): CommandItem[] {
  return results.sessions.map((s) => ({
    id: `session-${s.id}`,
    label: s.title,
    description: [s.projectName, s.branch, sessionStatusMeta(s.status).label].filter(Boolean).join(' · '),
    icon: 'terminal',
    keywords: [s.projectName, ...(s.branch ? [s.branch] : [])],
    href: s.href,
  }));
}

function actionItems(results: SearchResults): CommandItem[] {
  return results.actions.map((a) => ({
    id: `action-${a.id}`,
    label: a.label,
    description: a.description,
    icon: a.icon,
    keywords: [...a.keywords],
    href: a.href,
  }));
}

function provider(id: string, heading: string, client: SearchClient, pick: (results: SearchResults) => CommandItem[]): CommandSearchProvider {
  return { id, heading, minQueryLength: 1, search: async (query, signal) => pick(await client(query, signal)) };
}

/**
 * Global search of the command palette, mounted once by the `(shell)` and `(workspace)` layouts:
 * projects (name, repository, path) and sessions (title, project, branch) from GET /api/search, the
 * navigation actions it returns, and « Nouvelle session » (opens the Sessions lot dialog). One request
 * per query feeds the three groups. Renders only the dialog.
 */
export function GlobalSearch() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const client = useMemo(() => createSearchClient(), []);
  const providers = useMemo(
    () => [
      provider('recherche-projets', 'Projets', client, projectItems),
      provider('recherche-sessions', 'Sessions', client, sessionItems),
      provider('recherche-actions', 'Actions', client, actionItems),
    ],
    [client],
  );
  const commands = useMemo<CommandGroupDef>(
    () => ({
      id: 'actions-rapides',
      heading: 'Actions rapides',
      items: [
        {
          id: 'nouvelle-session',
          label: 'Nouvelle session',
          description: 'Démarrer Claude Code dans un projet',
          icon: 'plus',
          keywords: ['session', 'claude', 'demarrer', 'lancer'],
          perform: () => setDialogOpen(true),
        },
      ],
    }),
    [],
  );
  useRegisterSearchProvider(providers[0]!);
  useRegisterSearchProvider(providers[1]!);
  useRegisterSearchProvider(providers[2]!);
  useRegisterCommands(commands);
  return dialogOpen ? <NewSessionDialog open={dialogOpen} onOpenChange={setDialogOpen} /> : null;
}
