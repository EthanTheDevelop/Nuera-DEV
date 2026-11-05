'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Command } from 'cmdk';
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { Spinner } from '@/components/ui/Spinner';
import { NAV_ITEMS } from './nav-items';

/* =================================================================================================
   Command palette (« Rechercher… ⌘K » of the sidebar — the palette itself is not drawn in Figma).
   Features contribute static groups and async search providers through context:

     useRegisterCommands({ id: 'projets', heading: 'Projets', items: [...] });
     useRegisterSearchProvider({ id: 'sessions', heading: 'Sessions', search: async (q, signal) => [...] });

   Navigation entries (the 5 sections) are always present. Every item either navigates (`href`) or
   runs `perform` — no item without an effect.
   ================================================================================================= */

export interface CommandItem {
  id: string;
  label: string;
  /** Second line (repository, branch, status…). */
  description?: string;
  icon?: IconName;
  /** Extra words matched by the filter (slug, path). */
  keywords?: string[];
  href?: string;
  external?: boolean;
  perform?: () => void;
}

export interface CommandGroupDef {
  id: string;
  heading: string;
  items: readonly CommandItem[];
}

export interface CommandSearchProvider {
  id: string;
  heading: string;
  /** Do not call before N characters (default 2). */
  minQueryLength?: number;
  /** Must honour `signal` (a newer query aborts the previous one). Throwing shows « Recherche indisponible ». */
  search: (query: string, signal: AbortSignal) => Promise<readonly CommandItem[]>;
}

interface Registry {
  groups: readonly CommandGroupDef[];
  providers: readonly CommandSearchProvider[];
  registerGroup: (group: CommandGroupDef) => () => void;
  registerProvider: (provider: CommandSearchProvider) => () => void;
}

const RegistryContext = createContext<Registry | null>(null);

export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<readonly CommandGroupDef[]>([]);
  const [providers, setProviders] = useState<readonly CommandSearchProvider[]>([]);
  const registerGroup = useCallback((group: CommandGroupDef) => {
    setGroups((list) => [...list.filter((g) => g.id !== group.id), group]);
    return () => setGroups((list) => list.filter((g) => g !== group));
  }, []);
  const registerProvider = useCallback((provider: CommandSearchProvider) => {
    setProviders((list) => [...list.filter((p) => p.id !== provider.id), provider]);
    return () => setProviders((list) => list.filter((p) => p !== provider));
  }, []);
  const value = useMemo(() => ({ groups, providers, registerGroup, registerProvider }), [groups, providers, registerGroup, registerProvider]);
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

/** Adds a static group to the palette while the calling component is mounted. Memoise `group`. */
export function useRegisterCommands(group: CommandGroupDef | null): void {
  // Depends on the stable register function, not on the registry value (which changes with every
  // registration: depending on it would unregister / register again in a loop).
  const registerGroup = useContext(RegistryContext)?.registerGroup;
  useEffect(() => (registerGroup && group ? registerGroup(group) : undefined), [registerGroup, group]);
}

/** Adds an async search provider while mounted. Memoise `provider`. */
export function useRegisterSearchProvider(provider: CommandSearchProvider | null): void {
  const registerProvider = useContext(RegistryContext)?.registerProvider;
  useEffect(() => (registerProvider && provider ? registerProvider(provider) : undefined), [registerProvider, provider]);
}

type ProviderResult = { status: 'loading' } | { status: 'done'; items: readonly CommandItem[] } | { status: 'error' };

function useProviderResults(providers: readonly CommandSearchProvider[], query: string, open: boolean) {
  const [results, setResults] = useState<Record<string, ProviderResult>>({});
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const controller = new AbortController();
    const eligible = providers.filter((p) => q.length >= (p.minQueryLength ?? 2));
    const timer = setTimeout(() => {
      setResults(Object.fromEntries(eligible.map((p) => [p.id, { status: 'loading' } as ProviderResult])));
      for (const provider of eligible) {
        provider
          .search(q, controller.signal)
          .then((items) => {
            if (!controller.signal.aborted) setResults((r) => ({ ...r, [provider.id]: { status: 'done', items } }));
          })
          .catch(() => {
            if (!controller.signal.aborted) setResults((r) => ({ ...r, [provider.id]: { status: 'error' } }));
          });
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [providers, query, open]);
  return results;
}

const itemClasses = cn(
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 font-sans text-app-14 text-text outline-none select-none',
  'data-[selected=true]:bg-accent-pale aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
);

const groupClasses =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-app-11 [&_[cmdk-group-heading]]:tracking-label [&_[cmdk-group-heading]]:text-muted [&_[cmdk-group-heading]]:uppercase';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Extra static groups (in addition to the navigation and the registered ones). Memoise. */
  groups?: readonly CommandGroupDef[];
  /** Extra async providers (in addition to the registered ones). Memoise. */
  providers?: readonly CommandSearchProvider[];
}

const NO_GROUPS: readonly CommandGroupDef[] = [];
const NO_PROVIDERS: readonly CommandSearchProvider[] = [];

/** The dialog. Mounted once by the shell; opened by ⌘K / Ctrl+K and the sidebar search field. */
export function CommandPalette({ open, onOpenChange, groups: extraGroups = NO_GROUPS, providers: extraProviders = NO_PROVIDERS }: CommandPaletteProps) {
  const router = useRouter();
  const registry = useContext(RegistryContext);
  const [query, setQuery] = useState('');
  const providers = useMemo(
    () => [...(registry?.providers ?? NO_PROVIDERS), ...extraProviders],
    [registry?.providers, extraProviders],
  );
  const results = useProviderResults(providers, query, open);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigation: CommandGroupDef = useMemo(
    () => ({
      id: 'navigation',
      heading: 'Navigation',
      items: NAV_ITEMS.map((item) => ({
        id: `nav-${item.key}`,
        label: item.label,
        description: item.description,
        icon: item.icon,
        href: item.href,
      })),
    }),
    [],
  );
  const groups = [navigation, ...(registry?.groups ?? NO_GROUPS), ...extraGroups];

  const run = (item: CommandItem) => {
    onOpenChange(false);
    setQuery('');
    if (item.perform) item.perform();
    if (item.href) {
      if (item.external) window.open(item.href, '_blank', 'noopener,noreferrer');
      else router.push(item.href);
    }
  };

  const renderItem = (item: CommandItem, extraKeyword?: string) => (
    <Command.Item
      key={item.id}
      value={`${item.id} ${item.label}`}
      keywords={[...(item.keywords ?? []), ...(item.description ? [item.description] : []), ...(extraKeyword ? [extraKeyword] : [])]}
      onSelect={() => run(item)}
      className={itemClasses}
    >
      <Icon name={item.icon ?? 'chevron'} size={18} className="text-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{item.label}</span>
        {item.description ? <span className="truncate font-sans text-app-12 text-muted">{item.description}</span> : null}
      </span>
      {item.external ? <Icon name="external" size={14} className="text-muted" /> : null}
    </Command.Item>
  );

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="nu-scrim fixed inset-0 z-50 bg-scrim" />
        <RadixDialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="nu-pop fixed top-[12dvh] left-1/2 z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-bg text-text shadow-float outline-none"
        >
          <VisuallyHidden.Root>
            <RadixDialog.Title>Recherche</RadixDialog.Title>
          </VisuallyHidden.Root>
          <Command label="Recherche" loop>
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Icon name="search" size={16} className="text-muted" />
              <Command.Input
                ref={inputRef}
                value={query}
                onValueChange={setQuery}
                placeholder="Rechercher…"
                className="h-12 min-w-0 flex-1 bg-transparent font-sans text-app-15 text-text outline-none placeholder:text-muted"
              />
              <kbd className="font-mono text-app-11 font-medium text-muted">Échap</kbd>
            </div>
            <Command.List className="max-h-[min(60dvh,400px)] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center font-sans text-app-13 text-muted">
                {query.trim() ? `Aucun résultat pour « ${query.trim()} »` : 'Aucun résultat'}
              </Command.Empty>
              {groups.map((group) =>
                group.items.length > 0 ? (
                  <Command.Group key={group.id} heading={group.heading} className={groupClasses}>
                    {group.items.map((item) => renderItem(item))}
                  </Command.Group>
                ) : null,
              )}
              {providers.map((provider) => {
                const result = results[provider.id];
                if (!result) return null;
                return (
                  <Command.Group key={provider.id} heading={provider.heading} className={groupClasses} forceMount>
                    {result.status === 'loading' ? (
                      <Command.Loading>
                        <div className="flex items-center gap-2 px-3 py-2 font-sans text-app-13 text-muted">
                          <Spinner size={14} /> Recherche…
                        </div>
                      </Command.Loading>
                    ) : result.status === 'error' ? (
                      <p className="m-0 px-3 py-2 font-sans text-app-13 text-danger">Recherche indisponible.</p>
                    ) : (
                      result.items.map((item) => renderItem(item, query))
                    )}
                  </Command.Group>
                );
              })}
            </Command.List>
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 font-mono text-app-11 text-muted">
              <span>Entrée pour choisir · Échap pour fermer</span>
            </div>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** ⌘K / Ctrl+K toggles the palette from anywhere (except inside the terminal, which owns the keyboard). */
export function useCommandPaletteShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.xterm, [data-terminal]')) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}
