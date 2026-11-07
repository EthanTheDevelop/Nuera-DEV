# `features/workspace` — Workspace Claude Code

Lot WORKSPACE : `/workspace/[sessionId]` — D05 (bureau), M05 (téléphone), états W1–W7 et S1–S4. Côté serveur :
`@/server/workspace` (`server-only`) ; contrats Zod / types / URL : `lib/contract.ts` (pur).

## Page

- `app/(workspace)/workspace/[sessionId]/page.tsx` : `requireContext()` + `getWorkspaceData(ctx, id)` (le même 404 pour
  une session inconnue, archivée, d'un projet archivé ou d'un autre espace) ; `loading.tsx` (T1), `error.tsx` (T4), `not-found.tsx` (T2).
- `WorkspaceView` choisit la composition (≥ 900 px : `DesktopWorkspace`, sinon `PhoneWorkspace` ; premier rendu
  deviné par l'agent utilisateur). Un seul état vivant (`WorkspaceProvider`) nourrit les deux.
- État d'URL : `?vue=terminal|apercu` (Terminal brut, Aperçu agrandi), `?panneau=fichiers|modifications|tests|apercu|terminal|projet|ferme`,
  `?onglet=fichiers|diff|git|apercu` (téléphone), `?revue=1` (W4), `?fichier=<chemin>`, `?affichage=unifie`.

## Temps réel

`useWorkspaceState` : flux `/api/stream/sessions/<id>` (`useSessionStream`, `?lastEventId=` à la recréation),
`session.event` (upsert par `key` / `version`), `session.status`, `session.permission` ; `stream.reset` ⇒ fil relu
(`GET /api/sessions/[id]/events?afterVersion=0`) + `router.refresh()` ; retour après W7 ⇒ rattrapage depuis la
dernière version. Modifications du worktree relues après un outil d'écriture, une fin d'étape ou une action Git
(jamais d'interrogation périodique). W7 = flux global du shell en reconnexion depuis 1,5 s.

## Aperçu (`preview/`, non dessiné dans Figma)

Site du serveur de développement du worktree, servi par l'origine d'aperçu (`PREVIEW_HOST`, jamais l'origine de
l'application ; `docs/SECURITY.md` §8 bis). `usePreview` : dernier lancement `dev` du worktree (`GET /api/runs`,
`GET /api/runs/[id]`), suivi par `/api/stream/runs/<id>` (`run.status`, `run.output`) et les `run.status` du flux
global (serveur lancé ailleurs) — jamais d'interrogation ; « Démarrer le serveur » / « Arrêter » = `POST /api/runs
{ kind: 'dev' }` / `DELETE /api/runs/[id]` ; port détecté ⇒ `POST /api/previews { runId, path }` puis l'iframe charge
l'URL d'entrée à usage unique. La page prévisualisée publie son chemin (`postMessage`, script ajouté par le relais) :
le champ de chemin et « Recharger » (`contentWindow.location.replace`) suivent la page affichée. Pas de rechargement
à chaud (aucun WebSocket ne traverse un route handler) : « Recharger après chaque modification de Claude » (préférence
du navigateur, activée par défaut) recharge après chaque outil d'écriture terminé (`ctl.claudeWrites`). Bureau :
onglet du panneau, « Inverser » (`?vue=apercu` : le rendu au centre, la conversation et la saisie dans la colonne de droite ; une seule iframe à la fois), largeur Bureau / Téléphone (390 px,
préférence du navigateur). Téléphone : onglet « Aperçu », barre compacte (état, Recharger, menu ⋯ : démarrer/arrêter,
nouvel onglet, rechargement automatique), compositeur gardé dessous.

**Plusieurs serveurs** : un projet peut déclarer plusieurs « Lancement » nommés (onglet Environnement, « Ajouter un
serveur de développement » ; `commands.devName` / `devServers`). Bureau : onglets « client · 3001 », « admin · 3002 »,
« + Lancer… » au-dessus de la barre ; téléphone : menu compact « client · 3001 ▾ » dans la barre. Chacun démarre et
s'arrête seul (`POST /api/runs { kind: 'dev', name }`), l'iframe montre celui choisi (passage de main par lancement ;
un seul aperçu à la fois par navigateur : le cookie de l'hôte d'aperçu désigne un lancement).

**Serveur qui ne démarre pas** : un serveur lancé depuis cet Aperçu qui s'arrête en erreur, ou reste sans port une
minute avec des erreurs dans sa sortie (`lib/preview-autodebug.ts`), part à Claude dans la session (« Demander à Claude
de corriger automatiquement », menu ✦ / ⋯, activé par défaut ; sinon bouton « Demander à Claude » sous l'erreur) :
`POST /api/previews/autodebug { runId, sessionId, trigger }` — fin de la sortie (80 lignes, variables du projet et
jetons masqués, 8 000 caractères au plus), une seule fois par lancement (409 `AUTODEBUG_ALREADY_SENT`), audit
`preview.autodebug`. Claude au travail : l'instruction attend la fin de son étape (« en file ») ; autorisation en
attente : rien n'est envoyé, le navigateur réessaie après la réponse. « Relancer après correction » (désactivé par
défaut) relance le serveur une fois quand le tour de Claude se termine.

## Routes (toutes `apiRoute` : session, Origin sur les mutations, Zod, limites)

| Route | Rôle |
|---|---|
| `POST /api/sessions/[id]/instruction { text }` | saisie ; reprend une session terminée (lot SESSIONS) ; 409 `SESSION_BUSY_PERMISSION` |
| `POST /api/sessions/[id]/interrupt` | Échap |
| `POST /api/sessions/[id]/auto-resume { enabled: true\|false\|null }` · `{ resumeNow: true }` | reprise automatique après la limite pour cette session (null = défaut de l'espace ; audit `session.auto_resume_changed`) · « Reprendre maintenant » (audit `session.auto_resume_now`, 409 sans limite) |
| `GET /api/sessions/[id]/events?afterVersion=` | fil (rechargement) |
| `GET /api/sessions/[id]/terminal` | `{ terminalId, live }` du PTY de la session |
| `POST /api/previews { runId, path? }` | passage de main vers l'aperçu (URL d'entrée à usage unique, 60 s) |
| `POST /api/previews/autodebug { runId, sessionId, trigger: auto\|manual, output? }` | sortie d'un serveur de développement qui ne démarre pas → Claude dans la session (une fois par lancement, audit `preview.autodebug`) |
| `POST /api/permissions/[id]/decision { optionId, message? }` | autoriser / toujours / refuser (audit `permission.decision`) |
| `GET /api/worktrees/[id]/tree?path=` · `file?path=` · `changes` · `diff?path=` · `status` | lecture (`file` : contenu des fichiers de secrets — `.env`, `.env.local`, clés privées — jamais renvoyé, `secret: true`) |
| `POST /api/worktrees/[id]/stage` · `unstage { paths }` | index |
| `POST …/commit { message, body?, paths, sessionId? }` · `push { sessionId? }` · `pull-request { title, body?, base?, draft? }` | W5 (audit `git.commit`, `git.push`, `github.pull_request`) ; `sessionId` doit être une session de ce worktree (422 sinon) |

Les erreurs gardent `reason` (sous-code du runner) et la copie Figma (`server/workspace/errors.ts`).

## Décisions sur ce qui n'est pas dessiné

- Suggestions W1 : bâties sur ce que le projet a (CLAUDE.md, commande de test), elles remplissent la saisie (Q1).
- Demande expirée (`answered_in_terminal` pendant que le CLI attend) : carte ouverte « Répondre dans le terminal ».
- Panneau « Terminal » : shell du worktree ouvert à la demande, fermé en quittant la page. « Projet » : dépôt,
  branches, options du CLI, commandes du projet.
- W5 : libellé selon les options (Q5) ; sans fichier modifié, seuls les commits déjà faits partent (« Pousser ») ;
  pull request déjà ouverte ⇒ interrupteur bloqué, le push la met à jour. Aucun message « proposé par Claude » (Q13).
  Session sur le clone principal (branche par défaut) : interrupteur « Pousser » désactivé avec sa raison (le serveur
  refuse aussi ce push). Téléphone (S3) : bouton « Committer et pousser » même avec la pull request, comme Figma.
- Indexer / Retirer de l'index : sous la liste des modifications (non dessiné).
- Limite d'utilisation (`session/UsageLimitBanner.tsx`, `Dev · Bandeau` Alerte) : bandeau au-dessus du fil tant que
  `session.limit.active` — heure de levée annoncée par le CLI (`formatClockDay`), heure de la reprise prévue, compte à
  rebours à la seconde et « tentative n sur 5 », interrupteur « Reprise automatique » de la session et « Reprendre
  maintenant » ; badge « Limite atteinte · reprise à 15 h 02 » dans l'en-tête (texte d'état sur téléphone) ; entrée
  « Reprise automatique après la limite » dans le menu « … » et la feuille « Actions de session ». La valeur de
  l'interrupteur est celle de la session, sinon celle de l'espace (Paramètres › Claude Code) ; revenir à la valeur
  de l'espace enregistre `null`. Aucune heure n'est inventée : levée inconnue ⇒ « Le CLI n'a pas indiqué l'heure de
  levée de la limite. » (libellés : `components/dev/lib/usage-limit.ts`).
