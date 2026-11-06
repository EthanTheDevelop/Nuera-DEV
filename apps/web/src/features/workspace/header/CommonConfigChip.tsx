'use client';

import { useState, type ReactNode } from 'react';
import { formatDateTimeShort } from '@nuera/shared/format';
import { Icon } from '@/components/icons';
import { Badge, Button, Dialog, DialogContent } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useWorkspace } from '../WorkspaceContext';

/**
 * « Configuration commune · 3 règles · 4 skills · 2 MCP » (lot K1): what this session received from
 * the instance at its last start / resume, and whether it changed since (it then applies at the next
 * resume: the CLI reads rules, permissions and MCP servers at start-up; skills are reloaded live).
 */
export function CommonConfigChip({ compact = false }: { compact?: boolean }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [now] = useState(() => new Date().toISOString());
  const config = ws.data.commonConfig;
  if (!config?.applied) return null;
  const { applied } = config;
  const empty = applied.rules.length + applied.skills.length + applied.mcp.length + applied.permissions.allow + applied.permissions.ask + applied.permissions.deny === 0;
  if (empty && !config.changedSince) return null;
  const label = `Configuration commune · ${applied.summary}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={config.changedSince ? `${label} · modifiée depuis le démarrage` : label}
        data-testid="configuration-commune"
        className={cn(
          'nu-hit inline-flex h-[23px] min-w-0 shrink items-center gap-1.5 rounded-sm border border-border bg-surface-raised px-2 py-[3px] hover:border-accent',
          compact ? 'max-w-[180px]' : 'max-w-[320px]',
        )}
      >
        <Icon name="sparkle" size={13} className={cn('shrink-0', config.changedSince ? 'text-warn' : 'text-muted')} />
        <span className="truncate font-mono text-app-11 text-text">{compact ? applied.summary : label}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Configuration commune de la session"
          description={`Révision ${applied.revision}, reçue au démarrage ou à la reprise du ${formatDateTimeShort(applied.appliedAt, now)}.`}
          footer={
            <Button variant="default" onClick={() => setOpen(false)}>
              Fermer
            </Button>
          }
        >
          <div className="flex min-w-0 flex-col gap-4">
            {config.changedSince ? (
              <p className="m-0 rounded-md bg-warn-pale px-3 py-2 font-sans text-app-13 text-text">
                La configuration commune a changé depuis (révision {config.currentRevision}) : elle s'appliquera à la prochaine reprise de cette
                session. Les skills sont déjà rechargés par le CLI.
              </p>
            ) : null}
            <Group title="Règles" empty="Aucune règle commune.">
              {applied.rules.map((rule) => (
                <Line key={rule.id} label={rule.title} locked={rule.locked} meta={`v${rule.version}`} />
              ))}
            </Group>
            <Group title="Skills" empty="Aucun skill commun.">
              {applied.skills.map((skill) => (
                <Line key={skill.id} label={`/${skill.name}`} mono locked={skill.locked} meta={`v${skill.version}`} />
              ))}
            </Group>
            <Group title="Serveurs MCP" empty="Aucun serveur MCP commun.">
              {applied.mcp.map((server) => (
                <Line key={server.id} label={server.label} locked={server.locked} meta={server.admins ? 'administrateurs' : `mcp__${server.name}`} />
              ))}
            </Group>
            <p className="m-0 font-sans text-app-13 text-muted">
              Permissions : {applied.permissions.deny} refus · {applied.permissions.ask} demandes · {applied.permissions.allow} autorisations
              {applied.env.length ? ` · variables ${applied.env.join(', ')}` : ''}
              {applied.model.value ? ` · modèle ${applied.model.value}${applied.model.locked ? ' (imposé)' : ''}` : ''}.
            </p>
            {applied.skipped.length ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {applied.skipped.map((entry) => (
                  <li key={entry.name} className="font-sans text-app-12 text-muted">
                    {entry.name} non transmis : {entry.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 font-sans text-app-14 font-semibold text-text">{title}</h3>
      {children.length === 0 ? <p className="m-0 font-sans text-app-13 text-muted">{empty}</p> : <ul className="m-0 flex list-none flex-col gap-1 p-0">{children}</ul>}
    </section>
  );
}

function Line({ label, locked, meta, mono }: { label: string; locked: boolean; meta: string; mono?: boolean }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2">
      <span className={cn('min-w-0 truncate text-app-13 text-text', mono ? 'font-mono' : 'font-sans')}>{label}</span>
      <Badge tone={locked ? 'accent' : 'neutral'} icon={locked ? 'lock' : undefined}>
        {locked ? 'Imposé' : 'Par défaut'}
      </Badge>
      <span className="font-mono text-app-11 text-muted">{meta}</span>
    </li>
  );
}
