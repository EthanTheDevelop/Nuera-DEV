'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { formatDateTimeShort } from '@nuera/shared/format';
import { Badge, Banner, Card, CompactButton, Tabs, TabsContent, TabsList, TabsTrigger, TileHeader } from '@/components/ui';
import type { ClaudeAdminOverview, ServerCopyView } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { APPLY_NOTE, CLAUDE_SECTIONS, parseClaudeSection, plural, type ClaudeSection } from '../lib/copy';
import { InlineError } from './parts';
import { HistorySection } from './HistorySection';
import { McpSection } from './McpSection';
import { PermissionsSection } from './PermissionsSection';
import { ProposalsPanel } from './ProposalsPanel';
import { RulesSection } from './RulesSection';
import { SkillsSection } from './SkillsSection';

interface ClaudeAdminContextValue {
  overview: ClaudeAdminOverview;
  reload: () => Promise<void>;
}

const ClaudeAdminContext = createContext<ClaudeAdminContextValue | null>(null);

export function useClaudeAdmin(): ClaudeAdminContextValue {
  const value = useContext(ClaudeAdminContext);
  if (!value) throw new Error('useClaudeAdmin() hors de <AdminClaudeTab>.');
  return value;
}

function writeSection(section: ClaudeSection): void {
  const url = new URL(window.location.href);
  url.searchParams.set('onglet', 'claude');
  if (section === 'regles') url.searchParams.delete('section');
  else url.searchParams.set('section', section);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', next);
}

/**
 * Administration › Claude (lot K1): the configuration of Claude Code shared by every account, server
 * and session — « Règles · Skills · MCP · Permissions · Historique » (`?section=`), plus the proposals
 * of the members. Read from /api/admin/claude when the tab opens; every change goes through the
 * /api/admin/claude/** routes (owner and administrators, Origin, Zod, rate limit, instance journal),
 * then the whole tab is read again.
 */
export function AdminClaudeTab({ initialSection }: { initialSection: string | null }) {
  const [overview, setOverview] = useState<ClaudeAdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<ClaudeSection>(() => parseClaudeSection(initialSection));

  const reload = useCallback(async () => {
    const result = await claudeApi<ClaudeAdminOverview>('GET', '/api/admin/claude');
    if (result.ok) {
      setOverview(result.data);
      setError(null);
    } else setError(errorText(result.error));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = (value: string) => {
    const next = parseClaudeSection(value);
    setSection(next);
    writeSection(next);
  };

  if (!overview) {
    return error ? (
      <Card as="section" aria-label="Configuration Claude commune" className="gap-3">
        <p role="alert" className="m-0 font-sans text-app-14 font-semibold text-text">
          La configuration Claude commune n'a pas pu être lue
        </p>
        <p className="m-0 font-sans text-app-13 text-muted">{error}</p>
        <CompactButton variant="secondaire" icon="refresh" className="self-start" onClick={() => void reload()}>
          Réessayer
        </CompactButton>
      </Card>
    ) : (
      <p className="m-0 font-sans text-app-13 text-muted">Lecture de la configuration commune…</p>
    );
  }

  const { rows, pendingProposals } = overview;
  const tabValue = section === 'propositions' ? 'regles' : section;

  return (
    <ClaudeAdminContext.Provider value={{ overview, reload }}>
      <div className="flex min-w-0 flex-col gap-5">
        <Card as="section" aria-label="Configuration Claude commune" className="gap-3">
          <TileHeader icon="sparkle" title="Configuration Claude commune" action={<Badge tone="neutral">Révision {rows.policy.revision}</Badge>} />
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
            Règles, skills, serveurs MCP et permissions donnés à Claude Code dans toutes les sessions de l'instance, avant le CLAUDE.md
            du projet. « Imposé » s'applique partout ; « Par défaut » peut être désactivé par chaque espace. {APPLY_NOTE}
          </p>
          <ServerCopies />
        </Card>
        {pendingProposals > 0 ? (
          <Banner tone="warn" icon="messages" title={`${plural(pendingProposals, 'proposition', 'propositions')} en attente`}>
            Des membres proposent des règles ou des skills : rien ne s'applique avant votre décision.
          </Banner>
        ) : null}
        <ProposalsPanel highlighted={section === 'propositions'} />
        <Tabs value={tabValue} onValueChange={select} activationMode="manual" className="flex flex-col gap-5">
          <TabsList aria-label="Sections de la configuration Claude" variant="segmented">
            {CLAUDE_SECTIONS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="regles" tabIndex={-1}>
            <RulesSection />
          </TabsContent>
          <TabsContent value="skills" tabIndex={-1}>
            <SkillsSection />
          </TabsContent>
          <TabsContent value="mcp" tabIndex={-1}>
            <McpSection />
          </TabsContent>
          <TabsContent value="permissions" tabIndex={-1}>
            <PermissionsSection />
          </TabsContent>
          <TabsContent value="historique" tabIndex={-1}>
            <HistorySection />
          </TabsContent>
        </Tabs>
      </div>
    </ClaudeAdminContext.Provider>
  );
}

/** Copy written on each server in service (revision, date, conflicts by skill name), and « Synchroniser ». */
function ServerCopies() {
  const { overview } = useClaudeAdmin();
  const [servers, setServers] = useState<ServerCopyView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = overview.rows.policy.revision;

  const read = useCallback(async (sync: boolean) => {
    setBusy(true);
    setError(null);
    const result = await claudeApi<{ servers: ServerCopyView[] }>(sync ? 'POST' : 'GET', '/api/admin/claude/servers');
    setBusy(false);
    if (result.ok) setServers(result.data.servers);
    else setError(errorText(result.error));
  }, []);

  useEffect(() => {
    void read(false);
  }, [read, revision]);

  const [now] = useState(() => new Date().toISOString());
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-sans text-app-13 font-semibold text-text">Serveurs</p>
        <CompactButton variant="secondaire" icon="refresh" loading={busy} onClick={() => void read(true)}>
          Synchroniser les serveurs
        </CompactButton>
      </div>
      {servers === null && !error ? <p className="m-0 font-sans text-app-12 text-muted">Lecture des serveurs…</p> : null}
      {servers?.length === 0 ? <p className="m-0 font-sans text-app-12 text-muted">Aucun serveur en service.</p> : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {(servers ?? []).map((server) => (
          <li key={server.key} className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-app-13 font-medium text-text">{server.name}</span>
              <Badge tone={server.upToDate ? 'success' : server.error ? 'danger' : 'warn'}>
                {server.upToDate ? 'À jour' : server.appliedRevision === null ? 'Jamais synchronisé' : 'À synchroniser'}
              </Badge>
              {server.appliedAt ? (
                <span className="font-mono text-app-11 text-muted">
                  révision {server.appliedRevision} · {formatDateTimeShort(server.appliedAt, now)}
                </span>
              ) : null}
            </div>
            {server.error ? <p className="m-0 font-sans text-app-12 text-muted">{server.error}</p> : null}
            {server.conflicts.map((conflict) => (
              <p key={conflict.name} className="m-0 font-sans text-app-12 text-warn">
                {conflict.name} : {conflict.reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
      <InlineError>{error}</InlineError>
    </div>
  );
}

export function SectionIntro({ children }: { children: ReactNode }) {
  return <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{children}</p>;
}
