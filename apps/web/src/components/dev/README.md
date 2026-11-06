# `components/dev` — composites Nuera Dev

Composants de la section 04 de Figma (« CRÉÉS POUR NUERA DEV ») et des parties d'écrans construites avec eux
(D01–D07, W1–W7, M01–M07, S1–S5). **Présentation uniquement** : des props en entrée, des callbacks en sortie,
aucun accès aux données, aucune donnée d'exemple (sauf dans `gallery/`, réservé à `/kit/composites`).

- Import : `import { ToolLine, Composer, … } from '@/components/dev'` (jamais `gallery/`).
- Primitives : `@/components/ui` et `@/components/icons` (UI kit) — aucune primitive n'est redéfinie ici.
- Dates et nombres : toujours `@nuera/shared/format` (fr-FR, Europe/Paris), via `LiveTime` pour les durées vivantes.
- Copie : texte français identique à Figma (apostrophe ASCII `'` comme dans les maquettes, `·` U+00B7, `−` U+2212,
  `…` U+2026). Les états non dessinés ont une copie sobre, signalée dans le tableau.
- Rien de mort : un bouton n'est rendu que si son action existe (`href` ou `onClick`) ; sinon il est absent ou
  désactivé avec la raison affichée (`disabledReason`).
- Galerie : `/kit/composites` (développement uniquement ; compte connecté, ou `NUERA_KIT_PUBLIC=1`).

## Inventaire

### Fil de session (Workspace)

| Composant | Props principales | Figma |
|---|---|---|
| `InstructionMessage` | `text`, `at`, `author='Vous'`, `queued` (« · en file »), `variant: 'desktop'\|'phone'` | `Dev · Message · Instruction` 203:318 · D05, S1, M05 |
| `ClaudeMessage` / `ClaudeMarkdown` | `markdown` (GFM sûr : HTML brut échappé, seuls les liens `http(s)`/`mailto` sont suivis — `_blank` sans referrer —, cible relative laissée en texte, pas d'image), `at`, `author='Claude Code'` | `Dev · Message · Claude` 203:329 |
| `ToolLine` | `tool`, `target`, `status: 'done'\|'running'\|'error'\|'denied'`, `meta` (`212 lignes`, `formatLineDelta(46, 12)`, `code 1 · 2 échecs`), `startedAt` (« en cours · 38 s » vivant), `children` = détail dépliable, `expanded`/`defaultExpanded`/`onExpandedChange` | `Dev · Ligne d'outil` 203:369 (Terminé 338, En cours 348, Erreur 358, Refusé 368) |
| `CommandOutput` | `command`, `output` (séquences ANSI retirées, `\r` résolus, texte jamais reformulé), `exitCode` (≠ 0 → `code 1`), `truncated`, `maxHeight` | `Dev · Sortie de commande` 203:373 · W3 |
| `PlanCard` | `steps: { content, status: 'completed'\|'in_progress'\|'pending' }[]` (TodoWrite), compteur terminées / total | `Dev · Plan de travail` 203:455 |
| `PermissionRequestCard` | `status` (`PermissionRequestStatus` : `pending`, `expired`, `allowed`, `allowed_always`, `denied`, `answered_in_terminal`, `cancelled`), `title` (`permissionTitle(tool)`), `target`, `isCommand`, `explanation`, `options` (`defaultPermissionOptions(prefix)`, ordre du CLI, ≤ 3), `modeLabel` (`permissionModeLabel(mode)`), `variant: 'desktop'\|'phone'`, `onDecide`, `pendingOptionId`, `disabledReason` (W7 : bloque aussi « Répondre dans le terminal »), `error`, `onAnswerInTerminal` (repli « Répondre dans le terminal »), `id` (ancre `#demande-…`) | `Dev · Demande d'autorisation` 203:423 (En attente 405, Autorisée 413, Refusée 422) · `· téléphone` 222:2731 · S1 (repli 358 × 50) |
| `SessionSummaryCard` | `durationMs`, `points` (verbatim du message final), `badge`, `meta` (`sessionSummaryMeta(…)`), `actions` | W3 `Résumé de fin de session` 229:3622 |
| `SessionEmptyState` | `repoName`, `description` (`newSessionDescription(…)`), `suggestions`, `onSuggestion` (remplit le compositeur, n'envoie jamais) | W1 `Session vierge` 227:3075 |
| `NotificationItem` | `kind` (`NotificationKind`), `title`, `body`, `at`, `read`, `href`, `action` | centre de notifications (non dessiné) bâti sur la bannière S5 239:5839 |

### Saisie

| Composant | Props principales | Figma |
|---|---|---|
| `Composer` (bureau) | `state: 'ready'\|'running'\|'waiting_permission'\|'reconnecting'\|'unavailable'`, `onSubmit` (promesse → brouillon gardé jusqu'au succès ; le texte tapé pendant l'envoi reste, `draftAfterSend`), `modeLabel`, `value`/`defaultValue`/`onValueChange`, `placeholder`, `disabledReason`, `sending`, `onInterrupt` (« Interrompre · Échap » + touche Échap), `onAttach` (absent → pas de trombone), `persistence` (`persistenceText(…)`), `persistenceHint` | `Dev · Compositeur` 203:497 (Prêt 467, En cours 484, Attente 496) · D05 `Saisie` 214:1649 · W7 |
| `PhoneComposer` | idem + `keyboardAware` (S1 : la zone de sécurité basse disparaît clavier ouvert), placeholder court | M05/S1/S2 `Saisie` |
| `SessionPersistenceLine` / `persistenceText` | `tone`, `text`, `hint` — contextes `new`, `live` (hôte), `ended`, `reconnecting` | D05 214:1661 · W1 · W3 · W7 |

Comportement : Entrée envoie, Maj+Entrée = nouvelle ligne (sûr pendant une composition IME) ; « / commandes » et
« @ fichiers » insèrent `/` ou `@` au curseur (le CLI les interprète) ; pendant une demande d'autorisation ou une
reconnexion la saisie est en lecture seule et la raison reste visible. Le bouton Envoyer reprend l'aspect désactivé
Figma (fond `--border`, icône blanche). Clavier mobile : `useKeyboardInset()` (visualViewport) ; la page met
`interactive-widget=resizes-content` dans la balise viewport et un conteneur `100dvh`.

### Modifications et diff

| Composant | Props principales | Figma |
|---|---|---|
| `ChangedFileRow` / `ChangeStatusChip` | `status: 'M'\|'A'\|'D'\|'R'`, `path`, `label`, `oldPath`, `additions`, `deletions` (omis si 0), `binary`, `selected`, `onSelect`\|`href`, `leading` (case W5) | `Dev · Fichier modifié` 203:554 |
| `DiffView` | `file` (`DiffFile` de `parseUnifiedDiff`, ou `FileDiff` du runner avec `additions: insertions` ; `truncated` → note « Diff tronqué », `tooLarge` → « trop volumineux », jamais « aucune ligne modifiée »), `layout: 'unified'\|'split'`, `header: 'panel'\|'review'\|'none'`, `onBeforeAfter`/`beforeAfterActive` (« Avant / après »), `baseLabel`/`headLabel` (`AVANT · main`), `activeHunk` (J/K), `expandOnTap` (ligne coupée ouverte au toucher), `framed`, `bodyClassName` | `Dev · Ligne de diff` 203:534 · D05 214:1706 · W4 229:3676 · S2 |
| `DiffFilePager` + `DIFF_PHONE_HINT` | `path`, `index`, `total`, `additions`, `deletions`, `onPrevious`, `onNext` (désactivés aux extrémités) | S2 `Fichier courant` 238:5634 |
| `BranchStatusBar` | `branch`, `status` (`describeBranchStatus(…)`), `badge`, `actions`, `actionsDisabled` (W1, 40 %), `variant: 'panel'\|'card'` | D05 `Actions Git` 214:1850 · S3 `Branche` |

### Listes et cartes

| Composant | Props principales | Figma |
|---|---|---|
| `SessionCard` | `status`, `title`, `projectName`, `branch`, `worktreeName`, `time` (`elapsed` depuis / `at`), `activity`, `action` (libellé et style par défaut selon le statut), `resumable` | `Dev · Carte de session` 203:655 · D01, D06, M01 (rail 290) |
| `NewSessionCard` | `href`\|`onClick`, `disabledReason` (capacité), `title`, `description` | D06 215:1941 |
| `SessionStatusBadge` | `status`, `since` (vivant), `durationMs`, `short`, `reconnecting` (W7 « Reconnexion… ») | en-têtes D05/W1–W7, W6, S4 |
| `ProjectRow` + `ProjectTableHeader` | `name`, `repoFullName`, `branch`, `sync` (`SyncBadgeInput`), `sessions` (`projectSessionsSummary`), `lastActivityAt`, `favorite`/`onToggleFavorite`, `href`, `actions`, `variant: 'table'\|'card'` | `Dev · Ligne de projet` 210:674 · D02 · M02 |
| `RecentProjectRow` | `name`, `branch`, `sync`, `lastActivityAt`, `favorite`, `href`, `variant` | D01 `Projets récents` · M01 |
| `HistoryRow` + `HistoryTableHeader` | `title`, `projectName`, `branch`, `status`, `resumable`, `startedAt`, `durationMs`, `action`, `href`, `variant: 'table'\|'list'` | `Dev · Ligne d'historique` 215:1791 · D06 · M06 |
| `GitActivityRow` | `kind: 'commit'\|'pull_request'`, `sha`\|`number`, `message`, `projectName`, `branch`, `author` (« par Claude Code »), `at`, `href` (GitHub, nouvel onglet), `variant` | D01 `Dernières modifications` · M01 · S5 |
| `BranchRow` | `name`, `detail`, `badge: 'current'\|'session'\|'protected'\|'merged'`, `protectedBranch`, `actions` | D04 `Branches` |
| `CommandRow` | `kind`, `command`, `lastRun` (`CommandRunSummary`, badge `commandRunBadge`), `onRun`, `onStop`, `pending`, `disabledReason`, `variant` | D04 `Environnement de développement` · M04 |
| `McpToolRow` | `name`, `icon`, `description`, `enabled`, `onToggle`, `pending`, `warning` (« à reconnecter » : ligne en `warn`, interrupteur bloqué à Non), `variant` | D04 `Outils MCP du projet` · M04 |
| `EnvVarRow` + `SECRET_MASK` | `name`, `secret`, `value`, `revealed`, `onReveal`/`onHide` (œil), `onEdit` (crayon) | D04 `Variables d'environnement` |
| `McpServerCard` / `AddMcpServerCard` | `name`, `icon`, `description`, `status` (`McpStatus`), `projectCount`, `action` ; bordure danger si expiré / en erreur | D07 `Grille MCP` 216:2166…2242 |
| `IntegrationRow` | `name`, `icon`, `detail`, `badge` (`integrationStatusBadge` / `mcpStatusBadge(…, 'short')`), `href`, `variant` | D01 `Intégrations` · M07 |
| `SessionSwitcherHeader` / `SessionSwitcherItem` / `SessionSwitcherNewItem` / `SessionSwitcherNote` / `SessionSwitcherAllLink` | `variant: 'popover'\|'sheet'` ; item : `title`, `status`, `branch`, `worktreeName`, `since`, `current`, `href`\|`onSelect` ; nouveau : `description`, `disabledReason` (capacité) | W6 231:4159 · S4 239:5710 |
| `FavoriteToggle`, `RowActionButton`, `LiveTime` | utilitaires partagés (étoile bouton `aria-pressed`, action de ligne, `<time>` vivant : `relative`, `activity` (D02 « lun. 2 nov. »), `age`, `elapsed`, `time`, `datetime`, `day` ; date invalide → rien) | — |

## Aides pures (testées : `lib/*.test.ts`)

`sessionStatusMeta`, `sessionBadgeLabel`, `defaultSessionAction`, `historyStatusMeta`, `mostUrgentStatus` (point du
sélecteur : le plus urgent l'emporte) · `permissionTitle`, `permissionSummary`, `permissionModeLabel`,
`defaultPermissionOptions` · `describeBranchStatus`, `syncBadge` (`long` D02 / `short` D01–M02), `toChangeStatus` ·
`integrationStatusBadge`, `mcpStatusBadge`, `projectCountLabel` · `commandRunBadge`, `testCountsMeta` ·
`projectSessionsSummary` · `parseUnifiedDiff` (git diff multi-fichiers, ajout / suppression / renommage / binaire,
chemins cités), `toSplitRows`, `diffTotals` · `stripAnsi`, `terminalText` · `formatLineDelta` (`+46 −12`),
`formatHunkCount`, `joinParts`.

## Choix sur les états non dessinés

- `waiting_input` (tour terminé, processus vivant) : « En attente d'instruction », ton Accent (le ton Accent du
  `Point de statut` existe mais n'est utilisé dans aucun écran).
- Demande d'autorisation expirée : la carte reste ouverte, badge « Dans le terminal », bouton Principal
  « Répondre dans le terminal » ; répondue dans le terminal / annulée → ligne repliée.
- Variables d'environnement : `docs/ARCHITECTURE.md` §9 — une valeur secrète n'est jamais envoyée au navigateur ;
  la page ne passe `onReveal` que pour les variables qu'elle a le droit d'afficher, sinon `onEdit` (remplacer).
- Une instruction envoyée pendant une étape reste marquée « · en file » jusqu'à sa remise au CLI.
