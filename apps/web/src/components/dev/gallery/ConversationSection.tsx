'use client';

/** DEV-ONLY: Workspace thread composites in every state (D05, W1–W3, S1, M05). */
import { useState } from 'react';
import { useDemo } from './demo-log';
import { CompactButton } from '@/components/ui';
import { ClaudeMessage } from '../conversation/ClaudeMessage';
import { CommandOutput } from '../conversation/CommandOutput';
import { InstructionMessage } from '../conversation/InstructionMessage';
import { NotificationItem } from '../conversation/NotificationItem';
import { PermissionRequestCard } from '../conversation/PermissionRequestCard';
import { PlanCard, type PlanStep } from '../conversation/PlanCard';
import { SessionEmptyState, newSessionDescription, type SessionSuggestion } from '../conversation/SessionEmptyState';
import { SessionSummaryCard, sessionSummaryMeta } from '../conversation/SessionSummaryCard';
import { ToolLine } from '../conversation/ToolLine';
import { Composer } from '../composer/Composer';
import { PhoneComposer } from '../composer/PhoneComposer';
import { persistenceText } from '../composer/SessionPersistenceLine';
import { formatLineDelta } from '../lib/format';
import {
  defaultPermissionOptions,
  permissionModeLabel,
  permissionTitle,
  type PermissionOption,
  type PermissionRequestStatus,
} from '../lib/permission';
import { GallerySection, Grid, PhoneFrame, Specimen } from './GalleryLayout';
import { CLAUDE_MARKDOWN, FAILED_OUTPUT, MIN, TEST_OUTPUT } from './samples';

const MODE = permissionModeLabel('manual');
const OPTIONS = defaultPermissionOptions('npm run test');
const TITLE = permissionTitle('Bash');
const EXPLANATION = 'Lance la suite Vitest du module CRM dans le worktree crm-core. Lecture et écriture limitées au dépôt.';

const PLAN: PlanStep[] = [
  { content: 'Lire CLAUDE.md et la structure du module', status: 'completed' },
  { content: 'Créer PipelineBoard.tsx avec colonnes glissables', status: 'completed' },
  { content: 'Calculer le total par étape', status: 'completed' },
  { content: 'Écrire les tests de pipeline-totals.ts', status: 'in_progress' },
  { content: 'Lancer la suite de tests du module', status: 'pending' },
];

const SUGGESTIONS: SessionSuggestion[] = [
  { icon: 'book', label: "Explique la structure du module CRM avant d'y toucher" },
  { icon: 'list-checks', label: 'Lance les tests du projet et résume les échecs' },
  { icon: 'github', label: "Reprends l'issue #128 : export CSV du pipeline" },
];

const DECISION_STATUS: Record<PermissionOption['kind'], PermissionRequestStatus> = {
  allow: 'allowed',
  allow_always: 'allowed_always',
  deny: 'denied',
};

/** Pending card whose buttons resolve it locally (the real page sends the decision to the CLI). */
function DemoPermission({ variant }: { variant: 'desktop' | 'phone' }) {
  const [status, setStatus] = useState<PermissionRequestStatus>('pending');
  const [pending, setPending] = useState<string | null>(null);
  const decide = (option: PermissionOption) => {
    setPending(option.id);
    window.setTimeout(() => {
      setPending(null);
      setStatus(DECISION_STATUS[option.kind]);
    }, 600);
  };
  return (
    <div className="flex flex-col gap-2">
      <PermissionRequestCard
        status={status}
        title={TITLE}
        target="npm run test -- crm"
        toolName="Bash"
        explanation={variant === 'phone' ? 'Lance la suite Vitest du module CRM dans le worktree crm-core.' : EXPLANATION}
        options={OPTIONS}
        modeLabel={MODE}
        variant={variant}
        onDecide={decide}
        pendingOptionId={pending}
      />
      {status !== 'pending' ? (
        <div>
          <CompactButton variant="discret" icon="refresh" onClick={() => setStatus('pending')}>
            Rejouer la demande (galerie)
          </CompactButton>
        </div>
      ) : null}
    </div>
  );
}

function DemoComposer() {
  const [sent, setSent] = useState<string[]>([]);
  // Simulated round trip (the real page awaits the instruction route): text typed meanwhile is kept.
  const submit = (text: string) =>
    new Promise<void>((resolve) => {
      window.setTimeout(() => {
        setSent((prev) => [...prev, text]);
        resolve();
      }, 800);
    });
  return (
    <div className="flex flex-col gap-2">
      <Composer
        state="ready"
        modeLabel={MODE}
        onSubmit={submit}
        persistence={persistenceText({ kind: 'live', host: 'VPS-3' })}
      />
      {sent.length > 0 ? (
        <p className="m-0 font-mono text-app-11 text-muted">{`Envoyé (galerie) : ${sent.at(-1)}`}</p>
      ) : null}
    </div>
  );
}

function DemoRunningComposer() {
  const demo = useDemo();
  const [interrupts, setInterrupts] = useState(0);
  return (
    <div className="flex flex-col gap-2">
      <Composer
        state="running"
        modeLabel={MODE}
        onSubmit={(text) => demo(`Mettre en file : ${text}`)()}
        onInterrupt={() => setInterrupts((n) => n + 1)}
        persistence={persistenceText({ kind: 'live', host: 'VPS-3' })}
      />
      {interrupts > 0 ? (
        <p className="m-0 font-mono text-app-11 text-muted">{`Échap transmis (galerie) × ${interrupts}`}</p>
      ) : null}
    </div>
  );
}

function DemoEmptyState() {
  const [picked, setPicked] = useState<string>('');
  return (
    <div className="flex flex-col gap-6 rounded-xl border border-dashed border-border px-6 py-10">
      <SessionEmptyState
        repoName="nuera-os"
        description={newSessionDescription({ worktreeName: 'pipeline-export', baseBranch: 'main', claudeMdRead: true })}
        suggestions={SUGGESTIONS}
        onSuggestion={(s) => setPicked(s.label)}
      />
      <Composer
        state="ready"
        modeLabel={MODE}
        value={picked}
        onValueChange={setPicked}
        onSubmit={() => setPicked('')}
        persistence={persistenceText({ kind: 'new' })}
        className="mx-auto max-w-[720px]"
      />
    </div>
  );
}

export function ConversationSection({ now }: { now: number }) {
  const at = (minutesAgo: number) => now - minutesAgo * MIN;
  const demo = useDemo();
  return (
    <>
      <GallerySection id="fil" title="Workspace · fil de session" note="D05 · W2 · W3 · S1 · M05 — 720 px dans le Workspace, 680 dans la bibliothèque.">
        <Grid className="max-w-[720px]">
          <Specimen label="InstructionMessage · bureau" figma="203:318">
            <InstructionMessage
              text="Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires. Respecte CLAUDE.md."
              at={at(9)}
            />
          </Specimen>
          <Specimen label="InstructionMessage · en file (envoyée pendant une étape)">
            <InstructionMessage text="Ajoute aussi un test pour une étape vide" at={at(1)} queued />
          </Specimen>
          <Specimen label="ClaudeMessage" figma="203:329">
            <ClaudeMessage markdown="Je lis d'abord les conventions du dépôt et la structure du module CRM." at={at(9)} />
          </Specimen>
          <Specimen label="ClaudeMessage · Markdown sûr (code, liste, lien, HTML brut échappé)">
            <ClaudeMessage markdown={CLAUDE_MARKDOWN} at={at(2)} />
          </Specimen>
          <Specimen label="ToolLine · Terminé (Read, Glob, Edit, Write)" figma="203:338">
            <div className="flex flex-col gap-3.5">
              <ToolLine tool="Read" target="CLAUDE.md" status="done" meta="212 lignes" />
              <ToolLine tool="Glob" target="src/modules/crm/**/*.tsx" status="done" meta="14 fichiers" />
              <ToolLine tool="Edit" target="src/modules/crm/PipelineBoard.tsx" status="done" meta={formatLineDelta(46, 12)} />
              <ToolLine tool="Write" target="src/modules/crm/__tests__/pipeline-totals.test.ts" status="done" meta={formatLineDelta(54, 0)} />
            </div>
          </Specimen>
          <Specimen label="ToolLine · En cours (durée vivante)" figma="203:348">
            <ToolLine tool="Edit" target="src/modules/crm/PipelineBoard.tsx" status="running" startedAt={now - 38_000} />
          </Specimen>
          <Specimen label="ToolLine · Erreur, dépliable" figma="203:358">
            <ToolLine tool="Bash" target="npm run test -- crm" status="error" meta="code 1 · 2 échecs">
              <CommandOutput command="npm run test -- crm" output={FAILED_OUTPUT} exitCode={1} />
            </ToolLine>
          </Specimen>
          <Specimen label="ToolLine · Refusé" figma="203:368">
            <ToolLine tool="Edit" target="src/modules/crm/PipelineBoard.tsx" status="denied" />
          </Specimen>
          <Specimen label="ToolLine · Terminé, sortie dépliée (W3)" figma="229:3316">
            <ToolLine tool="Bash" target="npm run test -- crm" status="done" meta="10 réussis · 3,2 s" defaultExpanded>
              <CommandOutput command="npm run test -- crm" output={TEST_OUTPUT} exitCode={0} />
            </ToolLine>
          </Specimen>
          <Specimen label="CommandOutput · sortie tronquée, code de sortie" figma="203:373">
            <CommandOutput command="npm run build" output={'> nuera-os@0.1.0 build\n> next build\n\nFailed to compile.'} exitCode={1} truncated />
          </Specimen>
          <Specimen label="PlanCard · 3 / 5" figma="203:455">
            <PlanCard steps={PLAN} />
          </Specimen>
          <Specimen label="SessionSummaryCard · Résumé de fin de session (W3)" figma="229:3622">
            <SessionSummaryCard
              durationMs={18 * MIN}
              badge="Prête pour un commit"
              points={[
                'Tableau du pipeline à colonnes glissables (PipelineBoard.tsx)',
                'Total par étape calculé dans pipeline-totals.ts',
                '6 tests unitaires ajoutés · 10 / 10 réussis',
              ]}
              meta={sessionSummaryMeta({ files: 4, additions: 152, deletions: 12, allowedCommands: 2, commits: 0 })}
              actions={
                <>
                  <CompactButton variant="principal" icon="git-commit" onClick={demo('Préparer le commit')}>
                    Préparer le commit
                  </CompactButton>
                  <CompactButton variant="secondaire" icon="file-diff" onClick={demo('Voir le diff')}>
                    Voir le diff
                  </CompactButton>
                  <CompactButton variant="discret" onClick={demo('Continuer la conversation')}>
                    Continuer la conversation
                  </CompactButton>
                </>
              }
            />
          </Specimen>
        </Grid>
        <Specimen label="SessionEmptyState · Session vierge + suggestions (W1, la suggestion remplit le compositeur)" figma="227:3075">
          <DemoEmptyState />
        </Specimen>
      </GallerySection>

      <GallerySection id="decisions" title="Workspace · décisions et saisie" note="Demande d'autorisation (bureau, téléphone, replis), compositeur dans chacun de ses états.">
        <Grid className="max-w-[720px]">
          <Specimen label="PermissionRequestCard · En attente (cliquer : décision simulée)" figma="203:405">
            <DemoPermission variant="desktop" />
          </Specimen>
          <Specimen label="PermissionRequestCard · Autorisée" figma="203:413">
            <PermissionRequestCard status="allowed" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} />
          </Specimen>
          <Specimen label="PermissionRequestCard · Toujours autorisée">
            <PermissionRequestCard status="allowed_always" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} />
          </Specimen>
          <Specimen label="PermissionRequestCard · Refusée" figma="203:422">
            <PermissionRequestCard status="denied" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} />
          </Specimen>
          <Specimen label="PermissionRequestCard · Délai écoulé → Répondre dans le terminal">
            <PermissionRequestCard
              status="expired"
              title={TITLE}
              target="npm run test -- crm"
              toolName="Bash"
              explanation={EXPLANATION}
              options={OPTIONS}
              modeLabel={MODE}
              onAnswerInTerminal={demo('Répondre dans le terminal')}
            />
          </Specimen>
          <Specimen label="PermissionRequestCard · Répondue dans le terminal / annulée">
            <div className="flex flex-col gap-3.5">
              <PermissionRequestCard status="answered_in_terminal" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} />
              <PermissionRequestCard status="cancelled" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} />
            </div>
          </Specimen>
          <Specimen label="PermissionRequestCard · Connexion perdue (W7, boutons inactifs) + erreur de transmission">
            <PermissionRequestCard
              status="pending"
              title={TITLE}
              target="npm run test -- crm"
              toolName="Bash"
              explanation={EXPLANATION}
              options={OPTIONS}
              modeLabel={MODE}
              onDecide={(o) => demo(o.label)()}
              disabledReason="Connexion au serveur perdue : la réponse sera possible dès la reconnexion."
              error="La réponse n'a pas pu être transmise au CLI : la demande attend toujours."
            />
          </Specimen>
          <Specimen label="PermissionRequestCard · Modification de fichier (Edit)">
            <PermissionRequestCard
              status="pending"
              title={permissionTitle('Edit')}
              target="src/modules/crm/PipelineBoard.tsx"
              isCommand={false}
              toolName="Edit"
              options={defaultPermissionOptions(null)}
              modeLabel={permissionModeLabel('acceptEdits')}
              onDecide={(o) => demo(o.label)()}
            />
          </Specimen>
        </Grid>

        <div className="flex flex-wrap gap-8">
          <Specimen label="Téléphone · En attente (cliquer)" figma="222:2731">
            <PhoneFrame label="Demande d'autorisation au téléphone">
              <div className="flex flex-col gap-3 px-4 py-3">
                <DemoPermission variant="phone" />
              </div>
            </PhoneFrame>
          </Specimen>
          <Specimen label="Téléphone · Autorisée (S1, 2 lignes) · délai écoulé">
            <PhoneFrame label="Demandes tranchées au téléphone">
              <div className="flex flex-col gap-3 px-4 py-3">
                <PermissionRequestCard status="allowed" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} variant="phone" />
                <PermissionRequestCard
                  status="expired"
                  title={TITLE}
                  target="npm run test -- crm"
                  toolName="Bash"
                  options={OPTIONS}
                  modeLabel={MODE}
                  variant="phone"
                  onAnswerInTerminal={demo('Répondre dans le terminal')}
                />
              </div>
            </PhoneFrame>
          </Specimen>
        </div>

        <Grid className="max-w-[720px]">
          <Specimen label="Composer · Prêt (Entrée envoie, Maj+Entrée = ligne ; « / » et « @ » s'insèrent)" figma="203:467">
            <DemoComposer />
          </Specimen>
          <Specimen label="Composer · En cours (envoi en file, Interrompre · Échap)" figma="203:484">
            <DemoRunningComposer />
          </Specimen>
          <Specimen label="Composer · Attente d'autorisation" figma="203:496">
            <Composer
              state="waiting_permission"
              modeLabel={MODE}
              onSubmit={(text) => demo(`Envoyer : ${text}`)()}
              persistence={persistenceText({ kind: 'live', host: 'VPS-3' })}
            />
          </Specimen>
          <Specimen label="Composer · Reconnexion (W7)" figma="231:4206">
            <Composer
              state="reconnecting"
              modeLabel={MODE}
              onSubmit={(text) => demo(`Envoyer : ${text}`)()}
              persistence={persistenceText({ kind: 'reconnecting', lastSignalSeconds: 12, permissionPending: true })}
            />
          </Specimen>
          <Specimen label="Composer · Session terminée (reprise) / indisponible avec la raison">
            <div className="flex flex-col gap-4">
              <Composer state="ready" modeLabel={MODE} onSubmit={(text) => demo(`Reprendre avec : ${text}`)()} persistence={persistenceText({ kind: 'ended' })} />
              <Composer
                state="unavailable"
                modeLabel={MODE}
                onSubmit={(text) => demo(`Envoyer : ${text}`)()}
                disabledReason="Reprise impossible : le worktree de cette session a été supprimé."
                persistence={null}
              />
            </div>
          </Specimen>
        </Grid>

        <div className="flex flex-wrap gap-8">
          <Specimen label="PhoneComposer · Attente (M05) · texte saisi (S1) · correction (S2)" figma="238:5434">
            <PhoneFrame label="Saisie au téléphone">
              <div className="flex flex-col gap-4 py-4">
                <PhoneComposer state="waiting_permission" onSubmit={(text) => demo(`Envoyer : ${text}`)()} keyboardAware={false} />
                <PhoneComposer
                  state="running"
                  onSubmit={(text) => demo(`Mettre en file : ${text}`)()}
                  defaultValue="Ajoute aussi un test pour une étape vide"
                  keyboardAware={false}
                />
                <PhoneComposer
                  state="ready"
                  onSubmit={(text) => demo(`Envoyer : ${text}`)()}
                  placeholder="Demander une correction à Claude…"
                  keyboardAware={false}
                />
              </div>
            </PhoneFrame>
          </Specimen>
          <Specimen label="NotificationItem · non lue avec action · lue · intégration expirée">
            <div className="flex w-[420px] max-w-full flex-col gap-1 rounded-lg bg-bg p-2 shadow-soft">
              <NotificationItem
                kind="permission_request"
                title="Tests e2e du devis attend votre accord"
                body="npm run test -- e2e · Nuera OS"
                at={now - 20_000}
                action={{ label: 'Répondre', onClick: demo('Répondre à la demande') }}
              />
              <NotificationItem
                kind="session_finished"
                title="Module CRM · pipeline est terminée"
                body="4 fichiers · +152 −12 · prête pour un commit"
                at={at(42)}
                read
              />
              <NotificationItem
                kind="integration_expired"
                title="Coolify : autorisation expirée"
                body="Les sessions continuent, sans accès aux environnements de développement."
                at={at(130)}
                read
              />
            </div>
          </Specimen>
        </div>
      </GallerySection>
    </>
  );
}
