'use client';

import { permissionModeLabel } from '@/components/dev';
import { CompactButton, KeyValueList, SectionLabel } from '@/components/ui';
import { useWorkspace } from '../WorkspaceContext';
import { useModelLabel } from '../session/SessionColumn';

const COMMAND_LABEL = { install: 'Installation', dev: 'Développement', build: 'Build', test: 'Tests', lint: 'Lint' } as const;

/**
 * Context panel « Projet » (not designed): what the session works on — repository, branches,
 * worktree, CLI options and the project's commands — with a link to the project page.
 */
export function ProjectPanel() {
  const ws = useWorkspace();
  const { project, worktree } = ws.data;
  const { session } = ws.ctl.state;
  const model = useModelLabel();
  const commands = (Object.keys(COMMAND_LABEL) as Array<keyof typeof COMMAND_LABEL>).filter((k) => project.commands[k]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <section className="flex flex-col gap-2">
        <SectionLabel>Session</SectionLabel>
        <KeyValueList
          items={[
            { label: 'Dépôt GitHub', value: project.fullName, mono: true },
            { label: 'Branche par défaut', value: project.defaultBranch, mono: true },
            ...(worktree
              ? [
                  { label: 'Branche de la session', value: worktree.branch, mono: true },
                  { label: 'Worktree', value: worktree.isPrimary ? 'clone principal' : worktree.name, mono: true },
                  ...(worktree.baseBranch ? [{ label: 'Créé depuis', value: worktree.baseBranch, mono: true }] : []),
                ]
              : []),
            { label: 'Mode de permission', value: permissionModeLabel(session.permissionMode) },
            { label: 'Modèle', value: model },
            ...(session.tmuxName ? [{ label: 'Session tmux', value: session.tmuxName, mono: true }] : []),
          ]}
        />
      </section>
      <section className="flex flex-col gap-2">
        <SectionLabel>Commandes du projet</SectionLabel>
        {commands.length > 0 ? (
          <KeyValueList items={commands.map((k) => ({ label: COMMAND_LABEL[k], value: project.commands[k] ?? '', mono: true }))} />
        ) : (
          <p className="m-0 font-sans text-app-13 text-muted">Aucune commande configurée pour ce projet.</p>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <CompactButton variant="secondaire" icon="projets" href={`/projets/${encodeURIComponent(project.id)}`}>
          Ouvrir le projet
        </CompactButton>
        <CompactButton variant="discret" icon="external" href={project.htmlUrl} external>
          Voir sur GitHub
        </CompactButton>
      </div>
    </div>
  );
}
