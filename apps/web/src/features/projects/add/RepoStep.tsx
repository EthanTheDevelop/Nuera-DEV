'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import { Icon } from '@/components/icons';
import { Badge, Banner, ChipGroup, CompactButton, ErrorPanel, SearchField, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { AddRepoAccount, AddRepoItem, AddReposResult } from '@/server/projects/types';
import type { Failure } from '../FailureBanner';
import { repoMeta } from '../format';

export type ReposState = { status: 'loading' } | { status: 'ready'; data: AddReposResult } | { status: 'error'; failure: Failure };

export interface RepoStepProps {
  repos: ReposState;
  selected: string | null;
  onSelect: (repo: AddRepoItem) => void;
  /** Double click / Enter on a row: select and continue. */
  onConfirm: () => void;
  search: string;
  onSearch: (value: string) => void;
  account: string;
  onAccount: (value: string) => void;
  onRetry: () => void;
  variant: 'desktop' | 'phone';
  now: number;
  serverName: string;
}

/**
 * Does `repo` belong to the account chip `key` (`<sourceId>:<login>`, or `tous`)? An account is
 * listed once even when several sources reach it (the source is chosen in D03).
 */
export function repoInAccount(repo: Pick<AddRepoItem, 'owner'>, key: string): boolean {
  if (key === 'tous') return true;
  return repo.owner.toLowerCase() === key.slice(key.indexOf(':') + 1);
}

/**
 * Label of an account chip: « nuera-studio · 11 » (Figma), plus the source when the space has
 * several GitHub sources and its label differs from the account (« ethan · Application perso · 2 »).
 */
export function accountChipLabel(account: AddRepoAccount, severalSources: boolean): string {
  const source = severalSources && account.sourceLabel.toLowerCase() !== account.login.toLowerCase() ? ` · ${account.sourceLabel}` : '';
  return `${account.login}${source} · ${account.count}`;
}

/** Repositories matching the search and account chip (A1 « Comptes », M03 search only). */
export function visibleRepos(data: Extract<AddReposResult, { connected: true }>, search: string, account: string): AddRepoItem[] {
  const q = search.trim().toLowerCase();
  const matching = data.repos.filter((repo) => (!q || repo.fullName.toLowerCase().includes(q)) && repoInAccount(repo, account));
  // Selectable repositories first (most recent push first, as served), « Déjà cloné » at the end (A1).
  const blocked = (repo: AddRepoItem) => Boolean(repo.clonedProject) || repo.archived;
  return [...matching.filter((repo) => !blocked(repo)), ...matching.filter(blocked)];
}

/**
 * A1 « Choix du dépôt » (desktop) / M03 step 1 (phone): search, account chips (per GitHub source
 * when the space has several), radio list of the repositories the space's GitHub sources can read
 * (« Déjà cloné » rows disabled: projects of the space), T1 skeleton while GitHub answers,
 * T7-style call to action when GitHub is not connected.
 */
export function RepoStep({ repos, selected, onSelect, onConfirm, search, onSearch, account, onAccount, onRetry, variant, now, serverName }: RepoStepProps) {
  const phone = variant === 'phone';
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  if (repos.status === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton height={phone ? 44 : 40} shape="pill" className="rounded-md" />
        <div className="flex flex-col gap-3 rounded-md border border-border p-4" aria-label="Chargement des dépôts GitHub" role="status">
          {[180, 160, 200, 140].map((width) => (
            <div key={width} className="flex items-center gap-3">
              <Skeleton width={20} height={20} shape="circle" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton width={width} height={12} />
                <Skeleton width={width - 40} height={10} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (repos.status === 'error') {
    return (
      <ErrorPanel
        title="La liste des dépôts GitHub n'a pas pu être lue"
        excerpt={[repos.failure.message, repos.failure.detail].filter(Boolean).join(' · ')}
        untouched="Rien n'a été cloné."
        raw={repos.failure.raw ?? null}
        onRetry={onRetry}
      />
    );
  }

  const data = repos.data;
  if (!data.connected) {
    return (
      <Banner
        tone="warn"
        icon="github"
        title="GitHub n'est pas connecté à Nuera Dev"
        dense="relaxed"
        action={
          <CompactButton variant="secondaire" href="/integrations" icon="plug">
            Ouvrir Intégrations
          </CompactButton>
        }
      >
        {[data.message, data.detail ?? `Connectez l'application GitHub de Nuera Dev pour choisir un dépôt à cloner sur ${serverName}.`].join(' ')}
      </Banner>
    );
  }

  const items = visibleRepos(data, search, account);
  const severalSources = data.sources.length > 1;
  const chips = [{ value: 'tous', label: `Tous · ${data.total}` }, ...data.accounts.map((a) => ({ value: a.key, label: accountChipLabel(a, severalSources) }))];
  const selectable = items.filter((repo) => !repo.clonedProject && !repo.archived);
  const failures = data.failures.length ? (
    <Banner tone="warn" icon="github" title="Une source GitHub n'a pas pu être lue" dense="relaxed">
      {data.failures.map((failure) => `${failure.label} : ${failure.message}`).join(' ')}
    </Banner>
  ) : null;

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (selectable.length === 0) return;
    const index = selectable.findIndex((repo) => repo.fullName === selected);
    const next = event.key === 'ArrowDown' ? Math.min(selectable.length - 1, index + 1) : Math.max(0, index - 1);
    const repo = selectable[index === -1 ? 0 : next]!;
    onSelect(repo);
    listRef.current?.querySelector<HTMLElement>(`[data-repo="${CSS.escape(repo.fullName)}"]`)?.focus();
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <SearchField
        aria-label="Rechercher un dépôt"
        placeholder="Rechercher un dépôt…"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        size={phone ? 'lg' : 'md'}
      />
      {failures}
      {!phone && data.accounts.length > 1 ? (
        <ChipGroup items={chips} value={account} onValueChange={onAccount} aria-label="Filtrer par compte GitHub" />
      ) : null}
      {items.length === 0 ? (
        <p className="m-0 rounded-md border border-border px-4 py-6 text-center font-sans text-app-14 text-muted">
          {data.total === 0 ? "L'application GitHub n'a accès à aucun dépôt pour l'instant." : `Aucun dépôt ne contient « ${search.trim()} ».`}
        </p>
      ) : (
        <div
          ref={listRef}
          id={listId}
          role="radiogroup"
          tabIndex={-1}
          aria-label="Dépôts accessibles"
          onKeyDown={moveSelection}
          className={cn(
            'flex flex-col overflow-y-auto rounded-md border border-border',
            phone ? 'rounded-lg px-4 py-1' : 'max-h-[280px] p-1',
          )}
        >
          {items.map((repo) => {
            const disabled = Boolean(repo.clonedProject) || repo.archived;
            const isSelected = repo.fullName === selected;
            const meta = repo.clonedProject
              ? phone
                ? `Déjà cloné sur ${serverName}`
                : `Déjà cloné sur ${serverName} · ${repo.clonedProject.name}`
              : repo.archived
                ? 'Archivé sur GitHub · lecture seule'
                : repoMeta(repo, now, phone ? 'short' : 'long');
            const tabbable = isSelected || (!selected && repo === selectable[0]);
            return (
              <div
                key={repo.fullName}
                data-repo={repo.fullName}
                role="radio"
                aria-checked={isSelected}
                aria-disabled={disabled || undefined}
                tabIndex={disabled ? -1 : tabbable ? 0 : -1}
                onClick={() => !disabled && onSelect(repo)}
                onDoubleClick={() => {
                  if (disabled) return;
                  onSelect(repo);
                  onConfirm();
                }}
                onKeyDown={(event) => {
                  if (disabled) return;
                  if (event.key === ' ') {
                    event.preventDefault();
                    onSelect(repo);
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onSelect(repo);
                    onConfirm();
                  }
                }}
                className={cn(
                  'flex min-w-0 items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  phone ? 'min-h-[60px] border-b border-border px-2 py-3 last:border-b-0' : 'min-h-[54px] px-3 py-2.5',
                  isSelected && 'bg-accent-pale',
                  disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-hover',
                  isSelected && 'hover:bg-accent-pale',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center rounded-full',
                    phone ? 'size-[22px]' : 'size-5',
                    isSelected ? 'bg-accent text-on-accent' : 'border border-border bg-bg',
                  )}
                >
                  {isSelected ? <Icon name="check" size={phone ? 14 : 12} /> : null}
                </span>
                {!phone ? <Icon name="github" size={16} className="text-muted" /> : null}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn('truncate font-mono text-app-13 font-medium', disabled ? 'text-muted' : 'text-text')}>{repo.fullName}</span>
                  <span className="truncate font-sans text-app-12 text-muted">{meta}</span>
                </span>
                {!phone && repo.clonedProject ? (
                  <Badge tone="neutral" className="bg-transparent">
                    Déjà cloné
                  </Badge>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {phone ? (
        <p className="m-0 flex items-center gap-2 font-sans text-app-12 text-muted">
          <Icon name="github" size={16} className="text-muted" />
          {data.manageAccessUrl ? (
            <a href={data.manageAccessUrl} target="_blank" rel="noopener noreferrer" className="nu-hit relative text-muted underline-offset-2 hover:underline">
              Un dépôt manque ? Ajoutez-le à l'application sur GitHub.
            </a>
          ) : (
            <span>Un dépôt manque ? Ajoutez-le à l'application sur GitHub.</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
