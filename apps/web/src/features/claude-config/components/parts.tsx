'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { formatDateTimeShort } from '@nuera/shared/format';
import { ClaudeMarkdown } from '@/components/dev/conversation/ClaudeMarkdown';
import { Badge, Button, Dialog, DialogContent, LinkButton, SegmentedControl, Textarea, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { VersionDetail, VersionView } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { ACTION_LABELS, KIND_LABELS } from '../lib/copy';

/** « Imposé » / « Par défaut », « Administrateurs seulement », « Désactivé ». */
export function ItemBadges({ locked, admins, disabled, extra }: { locked: boolean; admins?: boolean; disabled?: boolean; extra?: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={locked ? 'accent' : 'neutral'} icon={locked ? 'lock' : undefined}>
        {locked ? 'Imposé' : 'Par défaut'}
      </Badge>
      {admins ? <Badge tone="warn" icon="shield">Administrateurs seulement</Badge> : null}
      {disabled ? <Badge tone="neutral">Désactivé</Badge> : null}
      {extra}
    </span>
  );
}

export function InlineError({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="m-0 font-sans text-app-12 text-danger">
      {children}
    </p>
  );
}

/** Markdown text area with a « Aperçu » toggle (rendered like Claude's messages, raw HTML escaped). */
export function MarkdownEditor({
  value,
  onChange,
  label,
  rows = 12,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  rows?: number;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-sans text-app-13 font-medium text-text">{label}</span>
        <SegmentedControl
          aria-label={`${label} : affichage`}
          value={view}
          onValueChange={setView}
          items={[
            { value: 'edit', label: 'Markdown', icon: 'edit' },
            { value: 'preview', label: 'Aperçu', icon: 'eye' },
          ]}
        />
      </div>
      {view === 'edit' ? (
        <Textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} rows={rows} mono invalid={invalid} placeholder={placeholder} />
      ) : (
        <div className="max-h-[50dvh] min-h-24 overflow-auto rounded-md border border-border bg-surface px-4 py-3">
          {value.trim() ? <ClaudeMarkdown>{value}</ClaudeMarkdown> : <p className="m-0 font-sans text-app-13 text-muted">Rien à afficher.</p>}
        </div>
      )}
    </div>
  );
}

/** Lines added / removed between a version and the previous one. */
export function DiffView({ diff }: { diff: VersionDetail['diff'] }) {
  if (diff.length === 0) return <p className="m-0 font-sans text-app-13 text-muted">Aucune différence.</p>;
  return (
    <pre className="m-0 max-h-[50dvh] overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-app-11 leading-[18px] whitespace-pre-wrap break-words">
      {diff.map((part, index) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, lineIndex) => (
            <span
              key={`${index}-${lineIndex}`}
              className={cn('block px-1', part.added ? 'bg-success-pale text-success' : part.removed ? 'bg-danger-pale text-danger' : 'text-muted')}
            >
              {part.added ? '+ ' : part.removed ? '- ' : '  '}
              {line}
            </span>
          )),
      )}
    </pre>
  );
}

export function versionLine(version: VersionView, now: string): string {
  return `v${version.version} · ${ACTION_LABELS[version.action]} · ${formatDateTimeShort(version.createdAt, now)}${version.author ? ` · ${version.author}` : ''}`;
}

/**
 * Versions of an item (or of the whole configuration when `itemId` is absent): each one opens its
 * diff with the previous version and « Revenir à cette version » (recorded as a new version).
 */
export function VersionsDialog({
  open,
  onOpenChange,
  title,
  kind,
  itemId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  kind?: VersionView['kind'];
  itemId?: string;
  onRestored: () => void;
}) {
  const [items, setItems] = useState<VersionView[] | null>(null);
  const [selected, setSelected] = useState<VersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => new Date().toISOString());

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '50', ...(kind ? { kind } : {}), ...(itemId ? { itemId } : {}) });
    const result = await claudeApi<{ items: VersionView[] }>('GET', `/api/admin/claude/history?${query.toString()}`);
    if (result.ok) setItems(result.data.items);
    else setError(errorText(result.error));
  }, [kind, itemId]);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setError(null);
    void load();
  }, [open, load]);

  async function show(version: VersionView) {
    setError(null);
    const result = await claudeApi<VersionDetail>('GET', `/api/admin/claude/versions/${version.id}`);
    if (result.ok) setSelected(result.data);
    else setError(errorText(result.error));
  }

  async function restore(version: VersionView) {
    setBusy(true);
    setError(null);
    const result = await claudeApi<{ version: number }>('POST', `/api/admin/claude/versions/${version.id}/rollback`);
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: `« ${version.label} » revient à la version ${version.version} (nouvelle version ${result.data.version})` });
    onRestored();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description="Chaque modification garde une version. Revenir à une version en crée une nouvelle : l'historique n'est jamais réécrit."
        size="lg"
        footer={
          <Button variant="default" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        }
      >
        <div className="flex min-w-0 flex-col gap-3">
          {items === null && !error ? <p className="m-0 font-sans text-app-13 text-muted">Lecture…</p> : null}
          {items?.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">Aucune version pour le moment.</p> : null}
          {selected ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="m-0 font-sans text-app-13 font-semibold text-text">
                  {KIND_LABELS[selected.version.kind]} « {selected.version.label} » · {versionLine(selected.version, now)}
                </p>
                <LinkButton size={13} onClick={() => setSelected(null)}>
                  Toutes les versions
                </LinkButton>
              </div>
              <p className="m-0 font-sans text-app-12 text-muted">
                {selected.previous ? `Différences avec la version ${selected.previous.version}.` : 'Première version.'}
              </p>
              <DiffView diff={selected.diff} />
              {selected.version.action !== 'deleted' || selected.version.kind !== 'mcp' ? (
                <Button variant="accent" className="self-start" loading={busy} loadingLabel="Restauration…" onClick={() => void restore(selected.version)}>
                  {selected.version.action === 'deleted' ? 'Restaurer cet élément' : 'Revenir à cette version'}
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {(items ?? []).map((version) => (
                <li key={version.id} className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                  <span className="min-w-0 font-sans text-app-13 text-text">
                    {itemId ? null : <span className="font-medium">{KIND_LABELS[version.kind]} « {version.label} » · </span>}
                    <span className="font-mono text-app-12 text-muted">{versionLine(version, now)}</span>
                  </span>
                  <LinkButton size={13} onClick={() => void show(version)}>
                    Voir
                  </LinkButton>
                </li>
              ))}
            </ul>
          )}
          <InlineError>{error}</InlineError>
        </div>
      </DialogContent>
    </Dialog>
  );
}
