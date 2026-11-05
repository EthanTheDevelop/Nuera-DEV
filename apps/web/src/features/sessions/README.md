# `features/sessions` — cycle de vie des sessions Claude Code

Lot SESSIONS : la fenêtre « Nouvelle session » utilisée partout, les actions d'une session (reprendre, arrêter,
archiver, renommer) et la page `/sessions` (D06 / M06). Côté serveur : `@/server/sessions` (`server-only`).

## Navigateur — `@/features/sessions`

| Export | Rôle |
|---|---|
| `NewSessionButton` | `projectId?`, `variant?` (`accent` déf. · `default` · `principal` / `secondaire` / `discret` · `icon` (+ 44 px, M06) · `card` (tuile « Démarrer une session » D06) · `bare`), `size?` (`md` / `lg`), `className?`, `children?` (libellé), `icon?`, `disabledReason?` (désactivé, raison en infobulle / texte de la tuile), `onCreated?` (retourner `false` pour rester sur la page). Ouvre la fenêtre ; au succès `router.push('/workspace/<id>')`. |
| `NewSessionDialog` | `open`, `onOpenChange`, `defaultProjectId?`, `onCreated?` — Dialog au bureau, feuille au téléphone (mise en page figée pendant l'ouverture). Projet, titre, branche (nouvelle depuis une base · existante · worktree principal, selon `projects.options.worktreePerSession`), mode de permission (sans autorisation refusé tant qu'il est bloqué), options du CLI (modèle, effort, Remote Control ; défauts de Paramètres, « Défaut du CLI » si vide), première instruction facultative ; capacité affichée et appliquée ; erreurs T4 en ligne. |
| `StopSessionDialog` | `open`, `onOpenChange`, `session: { id, title, worktree? }`, `onStopped?` — confirmation T8 « Arrêter « … » ? » → `POST /api/sessions/[id]/stop` (toast T3 par défaut). |
| `useSessionActions({ onChanged? })` | `{ resume, requestStop, requestArchive, requestRename, explainResume, pending, dialogs, errorPanel }` — rendre `dialogs` une fois, `errorPanel` (T4) près de la liste ; `router.refresh()` après chaque action (ou `onChanged`). |
| `createSessionRequest`, `resumeSessionRequest`, `stopSessionRequest`, `archiveSessionRequest`, `renameSessionRequest`, `fetchSessionSummary`, `SessionApiError` | appels des routes (erreurs : message français, `untouched`, `raw`). |
| `workspaceUrl(id, permissionId?)` | `/workspace/<id>` (+ `#demande-<permission>` pour « Répondre »). |

```tsx
// Accueil D01 / Projets D04 / A3 « Démarrer une session »
<NewSessionButton projectId={project.id} variant="accent" />
// Workspace W6 « Nouvelle session dans un nouveau worktree »
const [open, setOpen] = useState(false);
<SessionSwitcherNewItem onSelect={() => setOpen(true)} … /> <NewSessionDialog open={open} onOpenChange={setOpen} defaultProjectId={projectId} />
// Workspace « … » → Arrêter la session (T8)
<StopSessionDialog open={stopOpen} onOpenChange={setStopOpen} session={{ id, title, worktree }} onStopped={() => router.refresh()} />
```

## Serveur — `@/server/sessions`

`createSession(input, actor)` → `{ sessionId, workspaceUrl, instruction, instructionError }` · `resumeSession(id, actor)` ·
`stopSession(id, actor, { force? })` (409 si rien ne tourne) · `archiveSession(id, actor)` (409 si vivante) ·
`renameSession(id, title, actor)` · `getCapacity()` → `{ active, max, source }` · `listSessions({ status: 'active' | 'history',
projectId?, filter?, period?, q?, cursor?, limit? })` → `{ items: SessionListItem[], nextCursor, verified }` ·
`getSessionSummary(id)` → `SessionSummary` · `getNewSessionOptions()`, `getProjectBranchOptions(projectId)` ·
`buildLaunchOptions(projectId)` (MCP + variables du projet déchiffrées, noms protégés écartés + limites de Paramètres).
Toutes les actions sont auditées (`session.create|resume|stop|archive|rename`). Contrats (Zod, types) :
`lib/contract.ts` (pur, aussi utilisé par le navigateur).

## Routes

`POST /api/sessions` (création, 201) · `GET /api/sessions?statut=active|history&projet=&filtre=&periode=&q=&curseur=&limite=` ·
`GET /api/sessions/[id]` (résumé) · `PATCH /api/sessions/[id]` `{ title }` · `DELETE /api/sessions/[id]` (archive, aussi
`POST …/archive`) · `POST /api/sessions/[id]/resume` · `POST /api/sessions/[id]/stop` `{ force? }`.

## Page `/sessions`

État d'URL : `?filtre=terminees|reprise-possible|reprise-impossible|archivees`, `?periode=7j|90j|tout` (déf. 30 j),
`?projet=<uuid>`, `?q=`. Temps réel : `session.status` met à jour les cartes « EN COURS » sur place ;
`session.permission`, `stream.reset` et toute entrée / sortie de la liste relisent les données serveur. Tests :
`lib/lib.test.ts`, `server/sessions/*.test.ts` (base `nuera_sessions_service`), `e2e/sessions.spec.ts`.
