'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LiveTime } from '@/components/dev';
import { Icon } from '@/components/icons';
import { Badge, CompactButton, Dialog, DialogContent, EmptyState, ErrorPanel, SectionLabel, SkeletonList } from '@/components/ui';
import { plural } from '@nuera/shared/format';
import { integrationsApi, toApiError, type IntegrationsApiError } from '../api';
import type { AccessibleReposResult } from '../types';

type State = { kind: 'loading' } | { kind: 'ready'; data: AccessibleReposResult } | { kind: 'error'; error: IntegrationsApiError };

/**
 * « Voir les N dépôts » (D07, not designed): the repositories the GitHub App can reach, grouped by
 * account with their count (`GET /api/integrations/github/repos`), « Déjà cloné » linking to the project.
 */
export function ReposDialog({ open, onOpenChange, sourceId = null }: { open: boolean; onOpenChange: (open: boolean) => void; sourceId?: string | null }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // eslint-disable-next-line react/set-state-in-effect -- synchronous « loading » state of the fetch this effect starts (external data)
    setState({ kind: 'loading' });
    integrationsApi
      .githubRepos(controller.signal, sourceId)
      .then((data) => setState({ kind: 'ready', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', error: toApiError(error) });
      });
    return () => controller.abort();
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- attempt reloads the list on « Réessayer »
  }, [open, attempt, sourceId]);

  const description =
    state.kind === 'ready'
      ? `${plural(state.data.total, 'dépôt')} ${state.data.total > 1 ? 'accessibles' : 'accessible'} par l'application GitHub de Nuera Dev.`
      : "Dépôts accessibles par l'application GitHub de Nuera Dev.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Dépôts accessibles"
        description={description}
        footer={
          state.kind === 'ready' && state.data.manageAccessUrl ? (
            <CompactButton variant="secondaire" icon="external" href={state.data.manageAccessUrl} external>
              Gérer l'accès sur GitHub
            </CompactButton>
          ) : null
        }
      >
        {state.kind === 'loading' ? <SkeletonList rows={4} label="Chargement des dépôts" /> : null}
        {state.kind === 'error' ? (
          <ErrorPanel
            title="Les dépôts n'ont pas pu être lus"
            excerpt={[state.error.message, state.error.detail].filter(Boolean).join(' · ')}
            untouched="Rien n'a été modifié sur GitHub."
            raw={state.error.raw}
            onRetry={() => setAttempt((value) => value + 1)}
            retryLabel="Réessayer"
          />
        ) : null}
        {state.kind === 'ready' && state.data.total === 0 ? (
          <EmptyState icon="github" title="Aucun dépôt accessible" variant="plain">
            Choisissez les dépôts sur GitHub, dans les réglages de l'installation.
          </EmptyState>
        ) : null}
        {state.kind === 'ready' && state.data.total > 0 ? (
          <div className="flex flex-col gap-5">
            {state.data.accounts.map((account) => (
              <section key={account.login} aria-label={account.login} className="flex flex-col gap-1">
                <SectionLabel
                  as="h3"
                  action={
                    account.manageUrl ? (
                      <a href={account.manageUrl} target="_blank" rel="noopener noreferrer" className="font-sans text-app-13 font-medium text-accent hover:underline">
                        Configurer
                      </a>
                    ) : undefined
                  }
                >
                  {`${account.login} · ${account.count}`}
                </SectionLabel>
                <ul className="m-0 flex list-none flex-col p-0">
                  {account.repos.map((repo) => (
                    <li key={repo.id} className="flex min-w-0 items-center gap-3 border-b border-border py-2.5 last:border-b-0">
                      <Icon name={repo.private ? 'lock' : 'github'} size={16} className="shrink-0 text-muted" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <a href={repo.htmlUrl} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-app-13 font-medium text-text hover:underline">
                          {repo.fullName}
                        </a>
                        <p className="m-0 truncate font-sans text-app-12 text-muted">
                          {[repo.private ? 'privé' : 'public', repo.language, repo.defaultBranch].filter(Boolean).join(' · ')}
                          {repo.pushedAt ? (
                            <>
                              {' · '}
                              <LiveTime value={repo.pushedAt} format="relative" prefix="poussé " />
                            </>
                          ) : null}
                        </p>
                      </div>
                      {repo.clonedProject ? (
                        <Link href={`/projets/${repo.clonedProject.id}`} className="shrink-0" aria-label={`Ouvrir le projet ${repo.clonedProject.name}`}>
                          <Badge tone="success">Déjà cloné</Badge>
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
