'use client';

/** DEV-ONLY: list rows and cards (D01, D02, D04, D06, D07, W6, M01, M02, M04, M06, M07, S4). */
import { useState } from 'react';
import { CompactButton, IconButton, TileHeader } from '@/components/ui';
import { BranchRow } from '../lists/BranchRow';
import { CommandRow } from '../lists/CommandRow';
import { EnvVarRow } from '../lists/EnvVarRow';
import { GitActivityRow } from '../lists/GitActivityRow';
import { HistoryRow, HistoryTableHeader } from '../lists/HistoryRow';
import { IntegrationRow } from '../lists/IntegrationRow';
import { AddMcpServerCard, McpServerCard } from '../lists/McpServerCard';
import { McpToolRow } from '../lists/McpToolRow';
import { NewSessionCard } from '../lists/NewSessionCard';
import { ProjectRow, ProjectTableHeader } from '../lists/ProjectRow';
import { RecentProjectRow } from '../lists/RecentProjectRow';
import { SessionCard } from '../lists/SessionCard';
import {
  SessionSwitcherAllLink,
  SessionSwitcherHeader,
  SessionSwitcherItem,
  SessionSwitcherNewItem,
  SessionSwitcherNote,
} from '../lists/SessionSwitcher';
import { integrationStatusBadge, mcpStatusBadge } from '../lib/integrations';
import { projectSessionsSummary } from '../lib/projects';
import type { SessionStatus } from '../lib/session-status';
import { SessionStatusBadge } from '../status/SessionStatusBadge';
import { useDemo } from './demo-log';
import { GallerySection, Grid, PhoneFrame, Specimen } from './GalleryLayout';
import { DAY, HOUR, MIN } from './samples';

const ALL_STATUSES: SessionStatus[] = [
  'new',
  'running',
  'waiting_permission',
  'waiting_input',
  'stopped',
  'interrupted',
  'failed',
  'finished',
  'archived',
];

/** In-gallery anchor used as the `href` of link specimens (keeps navigation on this page). */
const HERE = '/kit/composites#listes';

export function ListsSection({ now }: { now: number }) {
  const demo = useDemo();
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => new Set(['Nuera OS', 'Atelier Lune']));
  const [tools, setTools] = useState<Record<string, boolean>>({ Figma: true, GitHub: true, Coolify: false });
  const [revealed, setRevealed] = useState(false);
  const toggleFavorite = (name: string) => () =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const projects = [
    { name: 'Nuera OS', repo: 'nuera-studio/nuera-os', branch: 'feature/crm-core', sync: { state: 'up_to_date' as const }, sessions: projectSessionsSummary({ active: 2 }), at: now - 3 * MIN },
    { name: 'Atelier Lune', repo: 'nuera-studio/atelier-lune', branch: 'feature/galerie-photos', sync: { state: 'behind' as const, behind: 2 }, sessions: projectSessionsSummary({ active: 0, finished: 1 }), at: now - DAY },
    { name: 'Kiné Rive Gauche', repo: 'nuera-studio/kine-rive-gauche', branch: 'fix/tarifs-mobile', sync: { state: 'up_to_date' as const }, sessions: projectSessionsSummary({ active: 0, interrupted: 1 }), at: now - 3 * DAY },
    { name: 'Site Nuera Studio', repo: 'ethanthedevelop/nuera-studio', branch: 'main', sync: { state: 'diverged' as const, ahead: 1, behind: 3, conflict: true }, sessions: projectSessionsSummary({ active: 0 }), at: now - 6 * DAY },
    { name: 'Nuera Dev', repo: 'nuera-studio/nuera-dev', branch: 'main', sync: { state: 'up_to_date' as const, syncing: true }, sessions: projectSessionsSummary({ active: 0 }), at: now - 8 * DAY },
  ];

  return (
    <>
      <GallerySection id="sessions" title="Sessions" note="Cartes (D01 · D06 · M01), historique (D06 · M06), sélecteur (W6 · S4), badges de statut.">
        <Specimen label="SessionCard · En cours / Autorisation / Terminée / Interrompue / En attente d'instruction" figma="203:655">
          <div className="flex flex-wrap items-stretch gap-6">
            <SessionCard
              status="running"
              title="Module CRM · pipeline"
              projectName="Nuera OS"
              branch="feature/crm-core"
              worktreeName="crm-core"
              time={{ kind: 'elapsed', since: now - 12 * MIN }}
              activity="Écrit les tests de pipeline-totals.ts"
              action={{ href: HERE }}
              className="w-[320px]"
            />
            <SessionCard
              status="waiting_permission"
              title="Tests e2e du devis"
              projectName="Nuera OS"
              branch="feature/devis-pdf"
              worktreeName="devis-pdf"
              time={{ kind: 'elapsed', since: now - 2 * MIN }}
              activity="Attend votre accord pour npm run test -- crm"
              action={{ href: HERE }}
              className="w-[320px]"
            />
            <SessionCard
              status="finished"
              title="Galerie photos"
              projectName="Atelier Lune"
              branch="feature/galerie-photos"
              time={{ kind: 'at', date: now - DAY }}
              activity="3 fichiers modifiés · prête pour un commit"
              action={{ onClick: demo('Voir le résumé') }}
              className="w-[320px]"
            />
            <SessionCard
              status="interrupted"
              resumable
              title="Correctif tarifs mobile"
              projectName="Kiné Rive Gauche"
              branch="fix/tarifs-mobile"
              time={{ kind: 'at', date: now - 3 * DAY }}
              activity="Connexion du navigateur perdue, la session a continué"
              action={{ onClick: demo('Reprendre') }}
              className="w-[320px]"
            />
            <SessionCard
              status="waiting_input"
              title="Export CSV du pipeline"
              projectName="Nuera OS"
              branch="feature/pipeline-export"
              worktreeName="pipeline-export"
              time={{ kind: 'elapsed', since: now - 41 * MIN }}
              activity="Tour terminé : attend votre prochaine instruction"
              action={{ href: HERE }}
              className="w-[320px]"
            />
          </div>
        </Specimen>
        <div className="flex flex-wrap items-stretch gap-6">
          <Specimen label="NewSessionCard · Démarrer une session" figma="215:1941" className="w-[400px]">
            <NewSessionCard onClick={demo('Démarrer une session')} />
          </Specimen>
          <Specimen label="NewSessionCard · capacité atteinte (désactivée, avec la raison)" className="w-[400px]">
            <NewSessionCard disabledReason="4 sessions sur 4 en cours : arrêtez-en une pour en démarrer une autre (limite réglable dans Paramètres · Serveur)." />
          </Specimen>
          <Specimen label="SessionCard · téléphone (rail, 290 px)">
            <PhoneFrame label="Rail des sessions actives (M01)">
              <div className="nu-scroll-x flex snap-x snap-mandatory gap-3 px-4 py-4">
                <SessionCard
                  status="waiting_permission"
                  title="Tests e2e du devis"
                  projectName="Nuera OS"
                  branch="feature/devis-pdf"
                  worktreeName="devis-pdf"
                  time={{ kind: 'elapsed', since: now - 2 * MIN }}
                  activity="Attend votre accord pour npm run test -- crm"
                  action={{ href: HERE }}
                  className="w-[290px] shrink-0 snap-start"
                />
                <SessionCard
                  status="running"
                  title="Module CRM · pipeline"
                  projectName="Nuera OS"
                  branch="feature/crm-core"
                  worktreeName="crm-core"
                  time={{ kind: 'elapsed', since: now - 12 * MIN }}
                  activity="Écrit les tests de pipeline-totals.ts"
                  action={{ href: HERE }}
                  className="w-[290px] shrink-0 snap-start"
                />
              </div>
            </PhoneFrame>
          </Specimen>
        </div>
        <Specimen label="SessionStatusBadge · tous les statuts (+ W7 Reconnexion…)">
          <div className="flex flex-wrap items-center gap-2">
            {ALL_STATUSES.map((status) => (
              <SessionStatusBadge
                key={status}
                status={status}
                since={status === 'running' ? now - 7 * MIN : null}
                durationMs={status === 'finished' ? 18 * MIN : null}
              />
            ))}
            <SessionStatusBadge status="waiting_permission" reconnecting />
          </div>
        </Specimen>
        <Specimen label="HistoryRow · tableau (D06)" figma="215:1791" surface="tile">
          <HistoryTableHeader />
          <HistoryRow title="Galerie photos" projectName="Atelier Lune" branch="feature/galerie-photos" status="finished" resumable={false} startedAt={now - DAY} durationMs={48 * MIN} action={{ onClick: demo('Voir le résumé') }} />
          <HistoryRow title="Correctif tarifs mobile" projectName="Kiné Rive Gauche" branch="fix/tarifs-mobile" status="interrupted" resumable startedAt={now - 3 * DAY} durationMs={72 * MIN} action={{ onClick: demo('Reprendre') }} />
          <HistoryRow title="Migration Next 16" projectName="Site Nuera Studio" branch="chore/next-16" status="archived" resumable={false} startedAt={now - 8 * DAY} durationMs={160 * MIN} action={{ onClick: demo('Voir') }} />
          <HistoryRow title="Audit des contrastes" projectName="Site Nuera Studio" branch="fix/contrastes" status="interrupted" resumable={false} startedAt={now - 15 * DAY} durationMs={35 * MIN} action={{ onClick: demo('Pourquoi ?') }} />
          <HistoryRow title="Devis PDF · première version" projectName="Nuera OS" branch="feature/devis-pdf" status="finished" resumable={false} startedAt={now - 17 * DAY} durationMs={65 * MIN} action={{ onClick: demo('Voir le résumé') }} />
        </Specimen>
        <div className="flex flex-wrap items-start gap-8">
          <Specimen label="HistoryRow · liste (M06)">
            <PhoneFrame label="Historique au téléphone (M06)">
              <div className="mx-4 my-4 rounded-lg bg-bg px-4 py-1 shadow-soft">
                <HistoryRow variant="list" href={HERE} title="Galerie photos" projectName="Atelier Lune" branch="feature/galerie-photos" status="finished" resumable={false} startedAt={now - DAY} durationMs={48 * MIN} />
                <HistoryRow variant="list" href={HERE} title="Correctif tarifs mobile" projectName="Kiné Rive Gauche" branch="fix/tarifs-mobile" status="interrupted" resumable startedAt={now - 3 * DAY} durationMs={72 * MIN} />
                <HistoryRow variant="list" href={HERE} title="Audit des contrastes" projectName="Site Nuera Studio" branch="fix/contrastes" status="interrupted" resumable={false} startedAt={now - 15 * DAY} durationMs={35 * MIN} />
              </div>
            </PhoneFrame>
          </Specimen>
          <Specimen label="SessionSwitcher · popover (W6)" figma="231:4159">
            <div className="flex w-[400px] max-w-full flex-col gap-1 rounded-md border border-border bg-bg p-2 shadow-float">
              <SessionSwitcherHeader projectName="Nuera OS" active={2} max={4} />
              <SessionSwitcherItem current title="Module CRM · pipeline" status="waiting_permission" branch="feature/crm-core" worktreeName="crm-core" />
              <SessionSwitcherItem title="Tests e2e du devis" status="running" branch="feature/devis-pdf" worktreeName="devis-pdf" since={now - 7 * MIN} href={HERE} />
              <div className="my-1 h-px bg-border" />
              <SessionSwitcherNewItem onClick={demo('Nouvelle session dans un nouveau worktree')} description="Créé depuis main · 10,9 Go de mémoire libre" />
              <SessionSwitcherNote />
            </div>
          </Specimen>
          <Specimen label="SessionSwitcher · feuille (S4) + capacité atteinte" figma="239:5710">
            <PhoneFrame label="Feuille des sessions (S4)">
              <div className="flex flex-col gap-1 rounded-t-[28px] bg-bg px-4 pt-2 pb-4">
                <div className="flex justify-center pb-2">
                  <span className="h-[5px] w-9 rounded-[3px] bg-border" />
                </div>
                <SessionSwitcherHeader variant="sheet" projectName="Nuera OS" active={2} max={4} />
                <SessionSwitcherItem variant="sheet" current title="Module CRM · pipeline" status="waiting_permission" branch="feature/crm-core" worktreeName="crm-core" />
                <SessionSwitcherItem variant="sheet" title="Tests e2e du devis" status="running" branch="feature/devis-pdf" worktreeName="devis-pdf" href={HERE} />
                <SessionSwitcherNewItem variant="sheet" onClick={demo('Nouvelle session dans un worktree')} />
                <SessionSwitcherNewItem variant="sheet" disabledReason="4 sessions sur 4 en cours : limite atteinte." />
                <SessionSwitcherAllLink href={HERE} />
              </div>
            </PhoneFrame>
          </Specimen>
        </div>
      </GallerySection>

      <GallerySection id="listes" title="Projets" note="Bibliothèque (D02 · M02), projets récents (D01 · M01), détail du projet (D04 · M04).">
        <Specimen label="ProjectRow · tableau (D02 : favori, dépôt, synchronisation, sessions, activité, actions)" figma="210:674" surface="tile">
          <ProjectTableHeader />
          {projects.map((p) => (
            <ProjectRow
              key={p.name}
              name={p.name}
              repoFullName={p.repo}
              branch={p.branch}
              sync={p.sync}
              sessions={p.sessions}
              lastActivityAt={p.at}
              favorite={favorites.has(p.name)}
              onToggleFavorite={toggleFavorite(p.name)}
              href={HERE}
              actions={
                <>
                  <CompactButton variant="secondaire" href={HERE}>
                    Ouvrir
                  </CompactButton>
                  <IconButton icon="more" label={`Actions du projet ${p.name}`} size="sm" iconClassName="text-muted" onClick={demo(`Menu de ${p.name}`)} />
                </>
              }
            />
          ))}
        </Specimen>
        <div className="flex flex-wrap items-start gap-8">
          <Specimen label="ProjectRow · carte (M02)">
            <PhoneFrame label="Projets au téléphone (M02)">
              <div className="flex flex-col gap-3 px-4 py-4">
                {projects.slice(0, 4).map((p) => (
                  <ProjectRow
                    key={p.name}
                    variant="card"
                    name={p.name}
                    repoFullName={p.repo}
                    branch={p.branch}
                    sync={p.sync}
                    sessions={p.sessions}
                    lastActivityAt={p.at}
                    favorite={favorites.has(p.name)}
                    onToggleFavorite={toggleFavorite(p.name)}
                    href={HERE}
                  />
                ))}
              </div>
            </PhoneFrame>
          </Specimen>
          <Grid className="w-[440px] max-w-full">
            <Specimen label="RecentProjectRow · tuile Projets récents (D01)" figma="205:422">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="projets" title="Projets récents" />
                {projects.slice(0, 4).map((p) => (
                  <RecentProjectRow
                    key={p.name}
                    name={p.name}
                    branch={p.branch}
                    sync={{ ...p.sync, syncing: false, conflict: false, state: p.sync.state === 'diverged' ? 'up_to_date' : p.sync.state }}
                    lastActivityAt={p.at}
                    favorite={favorites.has(p.name)}
                    onToggleFavorite={toggleFavorite(p.name)}
                    href={HERE}
                  />
                ))}
              </div>
            </Specimen>
            <Specimen label="RecentProjectRow · téléphone (M01)">
              <div className="rounded-lg bg-bg px-4 py-1 shadow-soft">
                {projects.slice(0, 3).map((p) => (
                  <RecentProjectRow key={p.name} variant="phone" name={p.name} branch={p.branch} sync={{ ...p.sync, syncing: false, conflict: false }} href={HERE} />
                ))}
              </div>
            </Specimen>
          </Grid>
        </div>
        <div className="flex flex-wrap items-start gap-8">
          <Grid className="w-[688px] max-w-full">
            <Specimen label="CommandRow · Environnement de développement (D04)" figma="213:1233">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="terminal" title="Environnement de développement" />
                <CommandRow kind="install" command="npm ci" lastRun={{ status: 'succeeded', at: now - 2 * HOUR }} onRun={demo('Lancer Installation')} />
                <CommandRow kind="dev" command="npm run dev" lastRun={{ status: 'running', at: now - 20 * MIN, port: 3000 }} onRun={demo('Lancer Lancement')} onStop={demo('Arrêter Lancement')} />
                <CommandRow kind="build" command="npm run build" lastRun={{ status: 'succeeded', at: now - DAY }} onRun={demo('Lancer Build')} />
                <CommandRow kind="test" command="npm run test" lastRun={{ status: 'succeeded', at: now - 9 * MIN, passed: 10, total: 10 }} onRun={demo('Lancer Tests')} />
                <CommandRow kind="lint" command={null} disabledReason="Aucune commande de lint configurée pour ce projet." onRun={demo('Lancer Lint')} />
              </div>
            </Specimen>
            <Specimen label="BranchRow · Branches (D04)">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="git-branch" title="Branches" />
                <BranchRow name="feature/crm-core" detail="worktree crm-core · 2 commits d'avance sur main" badge="current" />
                <BranchRow name="feature/devis-pdf" detail="worktree devis-pdf · une session y travaille" badge="session" />
                <BranchRow name="main" detail="branche protégée · à jour avec origin" badge="protected" protectedBranch />
                <BranchRow name="fix/pipeline-scroll" detail="fusionnée dans main il y a 3 jours" badge="merged" />
              </div>
            </Specimen>
          </Grid>
          <Grid className="w-[420px] max-w-full">
            <Specimen label="McpToolRow · Outils MCP du projet (D04, interrupteurs)">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="plug" title="Outils MCP du projet" />
                <McpToolRow name="Figma" icon="figma" description="maquettes Nuera OS · lecture" enabled={tools.Figma!} onToggle={(v) => setTools((t) => ({ ...t, Figma: v }))} />
                <McpToolRow name="GitHub" icon="github" description="issues et pull requests du dépôt" enabled={tools.GitHub!} onToggle={(v) => setTools((t) => ({ ...t, GitHub: v }))} />
                <McpToolRow name="Coolify" icon="rocket" description="environnement de développement" warning="à reconnecter" enabled={tools.Coolify!} onToggle={(v) => setTools((t) => ({ ...t, Coolify: v }))} />
              </div>
            </Specimen>
            <Specimen label="EnvVarRow · Variables d'environnement (D04)">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="key" title="Variables d'environnement" />
                <EnvVarRow name="DATABASE_URL" secret onEdit={demo('Remplacer DATABASE_URL')} />
                <EnvVarRow name="AUTH_SECRET" secret onEdit={demo('Remplacer AUTH_SECRET')} />
                <EnvVarRow name="NEXT_PUBLIC_SITE_URL" secret={false} value="https://os.nuera.studio" onEdit={demo('Modifier NEXT_PUBLIC_SITE_URL')} />
                <EnvVarRow
                  name="CAL_PUBLIC_EMBED"
                  secret
                  value={revealed ? 'cal.com/nuera/30min' : null}
                  revealed={revealed}
                  onReveal={() => setRevealed(true)}
                  onHide={() => setRevealed(false)}
                />
              </div>
            </Specimen>
            <Specimen label="CommandRow + McpToolRow · téléphone (M04)">
              <PhoneFrame label="Détail du projet au téléphone (M04)">
                <div className="flex flex-col gap-4 px-4 py-4">
                  <div className="flex flex-col gap-0.5 rounded-lg bg-bg p-4 shadow-soft">
                    <CommandRow variant="phone" kind="install" command="npm ci" lastRun={{ status: 'succeeded', at: now - 2 * HOUR }} onRun={demo('Lancer Installation')} />
                    <CommandRow variant="phone" kind="dev" command="npm run dev" lastRun={{ status: 'running', at: now - 20 * MIN, port: 3000 }} onRun={demo('Lancer Lancement')} onStop={demo('Arrêter Lancement')} />
                    <CommandRow variant="phone" kind="test" command="npm run test" lastRun={{ status: 'succeeded', at: now - 9 * MIN, passed: 10, total: 10 }} onRun={demo('Lancer Tests')} />
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-lg bg-bg p-4 shadow-soft">
                    <McpToolRow variant="phone" name="Figma" icon="figma" description="maquettes Nuera OS" enabled={tools.Figma!} onToggle={(v) => setTools((t) => ({ ...t, Figma: v }))} />
                    <McpToolRow variant="phone" name="Coolify" icon="rocket" warning="à reconnecter" enabled={tools.Coolify!} onToggle={(v) => setTools((t) => ({ ...t, Coolify: v }))} />
                  </div>
                </div>
              </PhoneFrame>
            </Specimen>
          </Grid>
        </div>
      </GallerySection>

      <GallerySection id="integrations" title="Intégrations et activité Git" note="Grille MCP (D07), tuile Intégrations (D01), liste MCP (M07), dernières modifications (D01 · M01).">
        <Specimen label="McpServerCard · Connecté / expiré (bordure danger) / désactivé + AddMcpServerCard" figma="216:2166">
          <div className="grid max-w-[1128px] grid-cols-1 items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_160px]">
            <McpServerCard name="Figma" icon="figma" description="Maquettes et composants nécessaires au développement." status="connected" projectCount={3} action={{ label: 'Configurer', onClick: demo('Configurer Figma') }} />
            <McpServerCard name="GitHub" icon="github" description="Issues et pull requests, dans le périmètre de l'application." status="connected" projectCount={2} action={{ label: 'Configurer', onClick: demo('Configurer GitHub') }} />
            <McpServerCard name="Coolify" icon="rocket" description="Environnements de développement. Production exclue." status="expired" projectCount={1} action={{ label: 'Reconnecter', variant: 'principal', icon: 'refresh', onClick: demo('Reconnecter Coolify') }} />
            <McpServerCard name="Playwright" icon="globe2" description="Tests de bout en bout pilotés par Claude." status="disabled" projectCount={0} action={{ label: 'Activer', onClick: demo('Activer Playwright') }} />
            <AddMcpServerCard onClick={demo('Ajouter un serveur MCP')} />
          </div>
        </Specimen>
        <div className="flex flex-wrap items-start gap-8">
          <Grid className="w-[360px] max-w-full">
            <Specimen label="IntegrationRow · tuile Intégrations (D01)">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="plug" title="Intégrations" />
                <IntegrationRow name="GitHub" icon="github" detail="12 dépôts accessibles" badge={integrationStatusBadge('connected')} href={HERE} />
                <IntegrationRow name="Figma" icon="figma" detail="serveur MCP" badge={mcpStatusBadge('connected', 'short')} href={HERE} />
                <IntegrationRow name="Coolify" icon="rocket" detail="serveur MCP · développement" badge={mcpStatusBadge('expired', 'short')} href={HERE} />
              </div>
            </Specimen>
          </Grid>
          <Specimen label="IntegrationRow · liste MCP (M07)">
            <PhoneFrame label="Serveurs MCP au téléphone (M07)">
              <div className="mx-4 my-4 rounded-lg bg-bg px-4 py-1 shadow-soft">
                <IntegrationRow variant="phone" name="Figma" icon="figma" detail="Maquettes et composants" badge={mcpStatusBadge('connected', 'short')} href={HERE} />
                <IntegrationRow variant="phone" name="GitHub" icon="github" detail="Issues et pull requests" badge={mcpStatusBadge('connected', 'short')} href={HERE} />
                <IntegrationRow variant="phone" name="Coolify" icon="rocket" detail="Développement uniquement" badge={mcpStatusBadge('expired', 'short')} href={HERE} />
                <IntegrationRow variant="phone" name="Playwright" icon="globe2" detail="Tests de bout en bout" badge={mcpStatusBadge('disabled', 'short')} href={HERE} />
              </div>
            </PhoneFrame>
          </Specimen>
          <Grid className="w-[744px] max-w-full">
            <Specimen label="GitActivityRow · Dernières modifications (D01)">
              <div className="flex flex-col gap-1 rounded-xl bg-bg p-5 shadow-soft">
                <TileHeader icon="git-commit" title="Dernières modifications" />
                <GitActivityRow kind="commit" sha="a3f9c12e8d" message="crm : ajoute les colonnes glissables du pipeline" projectName="Nuera OS" branch="feature/crm-core" author="Claude Code" at={now - 6 * MIN} href="https://github.com/nuera-studio/nuera-os" />
                <GitActivityRow kind="commit" sha="7b21e0414c" message="crm : calcule le total de chaque étape" projectName="Nuera OS" branch="feature/crm-core" author="Claude Code" at={now - 9 * MIN} />
                <GitActivityRow kind="pull_request" number={42} message="Galerie photos : pull request ouverte vers main" projectName="Atelier Lune" branch="feature/galerie-photos" at={now - DAY} />
                <GitActivityRow kind="commit" sha="e19d5aa301" message="galerie : grille de photos sur trois colonnes" projectName="Atelier Lune" branch="feature/galerie-photos" at={now - DAY - HOUR} />
              </div>
            </Specimen>
            <Specimen label="GitActivityRow · téléphone (M01, S5)">
              <div className="w-[358px] rounded-lg bg-bg px-4 py-1 shadow-soft">
                <GitActivityRow variant="phone" kind="commit" sha="a3f9c12e8d" message="crm : ajoute les colonnes glissables" projectName="Nuera OS" at={now - 6 * MIN} />
                <GitActivityRow variant="phone" kind="commit" sha="7b21e0414c" message="crm : calcule le total de chaque étape" projectName="Nuera OS" at={now - 9 * MIN} />
              </div>
            </Specimen>
          </Grid>
        </div>
      </GallerySection>
    </>
  );
}
