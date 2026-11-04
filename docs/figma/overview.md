# Nuera Dev — Figma overview, navigation, flows and master inventory

Source of truth: Figma file `nlvRWAtD1x2fKf8gVgcM0g`, page **NUERA DEV — WEB APP** (`199:3`).
Captured 2026-11-04 through the Figma MCP (`get_design_context`, `get_screenshot`, `get_variable_defs`, page metadata dump).

This document covers:

1. Section **00 — Cover & Product Overview** (`199:4`): the three frames, documented in full with verbatim copy.
2. The **product principles** and **points to validate** (product decisions), plus the cross-cutting UX rules written on the canvas.
3. The **navigation model** and the four **prototyped flows** (parcours A–D).
4. The **master inventory** of every frame of the page (sections 01–04) with a proposed route or UI state.
5. A **proposed Next.js route map** and the overview-level domain model.

Per-screen specs (D01–D08, M01–M08, W/A/D/T/S states, section 04 components) live in their own files next to this one (at capture time: `screens-desktop-a.md`, `screens-desktop-b.md`, `screens-mobile.md`, `states-workspace.md`, plus the other state/extension files); this file is the index and the decision log.

| Artifact | Path |
|---|---|
| Cover screenshot (1440 × 734) | `.design-refs/screens/00-cover.png` |
| Navigation screenshot (1440 × 679) | `.design-refs/screens/00-navigation.png` |
| Principles screenshot (900 × 754, natural size — Figma does not upscale) | `.design-refs/screens/00-principes.png` |
| Raw design-context code | `.design-refs/code/00-cover.tsx`, `00-navigation.tsx`, `00-principes.tsx`, `00-page-labels.tsx` |
| SVG assets (exported with their instance colours) | `.design-refs/assets/00-cover/*.svg` |

---

## 0. Read me first

### 0.1 Frame codes used everywhere

| Prefix | Meaning | Count | Section |
|---|---|---|---|
| `D01`–`D08` | Desktop screens, 1440 px wide | 8 | 01 (`199:5`) |
| `M01`–`M08` | Mobile screens, 390 × 844 | 8 | 02 (`199:6`) |
| `W1`–`W7` | Workspace (desktop) session states | 7 | 03 (`199:7`) |
| `A1`–`A4` | Add-project flow steps (parcours A) | 4 | 03 |
| `D1`, `D2` | MCP connection states on Intégrations (parcours D) | 2 | 03 |
| `T1`–`T8` | Cross-cutting ("transversaux") states | 8 | 03 |
| `S1`–`S5` | Phone states | 5 | 03 |

7 + 4 + 2 + 8 + 5 = **26 states/flow steps**, matching the cover figure `26` / `états et étapes de parcours`.

> **Collision warning:** `D1`/`D2` (MCP drawer states) vs `D01`/`D02` (desktop screens). In code, tests and tickets, always keep the zero-padding for screens (`D01`) and consider aliasing the MCP states as `D1-mcp-figma` / `D2-mcp-coolify`.

### 0.2 Copy rules observed in the file

- All UI copy is French. Keep it verbatim.
- Apostrophes are **straight** (`'`, U+0027) everywhere on this page — no U+2019 was found in any layer.
- Spaces before `:` `;` `?` `%` and inside `« »` are **regular spaces** (U+0020) — no U+00A0 / U+202F anywhere on the page. If the implementation wants French non-breaking spaces (recommended to avoid orphaned `:` on wrap), apply them consistently and accept a sub-pixel width difference vs. Figma (see §8, Q3).
- Separators: middle dot `·` (U+00B7) with spaces on both sides; em dash `—` (U+2014) only in section titles; ellipsis `…` (U+2026) in menu items that open a dialog (e.g. layer `Option · Archiver le projet…`); minus sign `−` (U+2212) in diff counts (`+152 −12`); `›` (U+203A) appears in some layers.
- **Layer names are not copy.** `get_metadata` names can be stale: text `214:1526` is named "La vue Conversation met en forme la sortie du CL…" but actually reads `Même session, deux lectures du flux du CLI.`. Every string quoted as verbatim in this file comes from `get_design_context`. Strings marked *(layer)* are layer names and must be re-checked in the per-screen specs before use.

### 0.3 Themes

- App screens are **light** (`--bg` / `--surface-raised` = `#ffffff`, `--text` `#233353`, `--border` `#d9dade`).
- Terminal areas use the **Dark mode of the Color collection** (from the note `240:5890`, see §2.4).
- The cover frame (`241:5880`) is **dark** (`--near-black` `#141830`) — it is a presentation frame, not an app screen.

---

## 1. Section 00 — Cover & Product Overview

Section `199:4`, 4200 × 1400, name `00 — Cover & Product Overview`. Three frames, all documentation (none maps to a route).

### 1.1 `00-cover` — Couverture · Nuera Dev

| Field | Value |
|---|---|
| Frame | `Couverture · Nuera Dev` — node `241:5880` |
| Size | 1440 × 733.655 |
| Route | None (presentation frame). Its copy can seed the PWA manifest `description`, the login/empty state hero, or an "À propos" block. |
| Screenshot / code | `.design-refs/screens/00-cover.png` · `.design-refs/code/00-cover.tsx` |

**Layout skeleton** (single column, auto-layout vertical):

- Frame: background `--near-black` `#141830`, radius `--radius-xl` 28, padding 80 top/bottom (`--space-20`) × 96 left/right, gap 40 (`--space-10`), `overflow: clip`.
- Children, top to bottom:
  1. **Logo** — instance `Logo Nuera Dev · papier` (`241:5881`, component `201:41`), scaled ×1.4 to 245.8 × 38.655 (base component 176 × 27.6). Inside: wordmark `Logo Nuera · papier` (190.4 × 38.655, white fills) + pill `DEV` (bg `--accent-on-dark` `#a6b9dd`, text `--near-black`, JetBrains Mono Bold 16.8 px, tracking 1.344 px, padding 2.8 × 5.6, radius 11.2, gap 11.2 — all ×1.4 of the 12 px / 0.96 / 2 × 4 / 8 / 8 base values).
  2. **Titre** (`241:5895`) — vertical, gap 20 (`--space-5`), full width 1248.
  3. **Trois actions** (`241:5899`) — horizontal row, gap 20, three equal cards (`flex: 1 0 0`, 402.67 wide each).
  4. **Contenu de la page** (`241:5922`) — horizontal row of four figures, gap 32 (`--space-8`).

**Verbatim copy**

| Node | Text | Style |
|---|---|---|
| `I241:5881;201:30` | `DEV` | JetBrains Mono Bold (logo pill) |
| `241:5896` | `NUERA STUDIO · APPLICATION INTERNE · NOVEMBRE 2026` | `Mono/Eyebrow`: JetBrains Mono Regular 12 / 1.25, letter-spacing 20 % (2.4 px), uppercase, `--accent-on-dark` |
| `241:5897` | `Nuera Dev` | `Display/Hero`: Outfit Bold 104 / 1.06, letter-spacing −4 % (−4.16 px), `--paper` |
| `241:5898` | `Retrouver, depuis n'importe quel appareil, les projets du VPS-3 et les sessions Claude Code qui y travaillent.` | `Text/Lead`: Outfit Regular 20 / 1.25, `--accent-on-dark` |

Action cards (bg `--surface-raised-dark` `#ffffff0d` = rgba(255,255,255,.05), radius `--radius-lg` 20, padding 24 (`--space-6`), vertical gap 12 (`--space-3`); header row = 20 px icon + number, gap 10; icon stroke `#A6B9DD`, width 1.8):

| # | Icon | Number (JetBrains Mono Regular 12, `--accent-on-dark`) | Title (Outfit SemiBold 20, `--paper`) | Body (Outfit Regular 14 / 20, `--accent-on-dark`) |
|---|---|---|---|---|
| 1 | `icon/projets` | `01` | `Ouvrir un projet` | `Un dépôt GitHub cloné sur VPS-3, sa branche, son environnement, son CLAUDE.md.` |
| 2 | `icon/terminal` | `02` | `Travailler avec Claude Code` | `Une vraie session du CLI, persistante, lisible en conversation ou en terminal brut, pilotable au pouce.` |
| 3 | `icon/check` | `03` | `Vérifier et livrer` | `Le diff, le commit, la pull request : rien ne part sur GitHub sans confirmation.` |

Figures (number Outfit SemiBold 40 `--paper`; label Outfit Regular 13 `--accent-on-dark`; gap 2):

| Number | Label |
|---|---|
| `8` | `écrans bureau · 1440 px` |
| `8` | `écrans téléphone · 390 px` |
| `26` | `états et étapes de parcours` |
| `4` | `parcours prototypés` |

**Component description** (Figma, `201:41`): "Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction que la pastille OS de Nuera OS)."

**Product meaning.** The three cards are the product's three jobs, in order: (1) open a project = a GitHub repo cloned on VPS-3 with its branch, environment and `CLAUDE.md`; (2) work with Claude Code = a real, persistent CLI session readable either as a conversation or as a raw terminal, operable with a thumb; (3) verify and ship = diff, commit, pull request, and **nothing reaches GitHub without an explicit confirmation**. The audience is one internal user ("APPLICATION INTERNE").

**Interactions / states:** none (static frame).

### 1.2 `00-navigation` — Navigation et parcours

| Field | Value |
|---|---|
| Frame | `Navigation et parcours` — node `241:5935` |
| Size | 1440 × 679 |
| Route | None (documentation of the nav model and the prototype flows) |
| Screenshot / code | `.design-refs/screens/00-navigation.png` · `.design-refs/code/00-navigation.tsx` |

**Layout skeleton**

- Frame: bg `--bg` white, 1 px border `--border` `#d9dade`, radius 28, padding 64 (`--space-16`) × 72, vertical gap 32.
- Title `Navigation et parcours` (`241:5936`) — `Display/H4`: Outfit Bold 32 / 1.06, letter-spacing −2 % (−0.64 px), `--text`.
- **Deux colonnes** (`241:5937`): gap 48 (`--space-12`).
  - Left column **Navigation** (`241:5938`): fixed 360 wide, vertical gap 8.
  - Right column **Parcours** (`241:5981`): `flex: 1`, vertical gap 20.

**Left column — global navigation (in this exact order)**

Section label `241:5939`: `NAVIGATION GLOBALE · 5 ENTRÉES` (JetBrains Mono Regular 11, letter-spacing 0.88 px, `--muted` `#645e78`).

Entry card: bg `--surface-raised` white, 1 px `--border`, radius `--radius-md` 12, padding 12 × 14, gap 12; 18 px icon stroked `--accent` `#4368B1` (stroke 1.8); title Outfit SemiBold 15 `--text`; subtitle Outfit Regular 12 `--muted`; title/subtitle gap 2.

| Order | Icon | Label | Subtitle (what the destination contains) | Node |
|---|---|---|---|---|
| 1 | `icon/home` | `Accueil` | `serveur, Claude, reprise rapide` | `241:5940` |
| 2 | `icon/projets` | `Projets` | `bibliothèque, ajout, détail` | `241:5947` |
| 3 | `icon/terminal` | `Sessions` | `en cours, historique, capacité` | `241:5953` |
| 4 | `icon/plug` | `Intégrations` | `GitHub, serveurs MCP` | `241:5960` |
| 5 | `icon/reglages` | `Paramètres` | `compte, Claude, serveur` | `241:5969` |

Workspace callout (`241:5978`): bg `--accent-pale` `#dee5f2`, radius 12, padding 14 × 16, gap 6.

- Title `241:5979`: `Workspace · contextuel` (Outfit SemiBold 15, `--accent` `#4368b1`).
- Body `241:5980` (Outfit Regular 13 / 19, `--text`):
  > `Ouvert depuis un projet ou une session, jamais depuis la navigation. Au bureau, la barre se replie en rail ; au téléphone, la barre d'onglets disparaît.`

**Right column — prototyped flows**

Section label `241:5982`: `PARCOURS PROTOTYPÉS · DÉPART MARQUÉ DANS LE MODE PRÉSENTATION` (same style as the left label). Meaning: each flow has a starting point defined in Figma's presentation (prototype) mode.

Flow block: title row (gap 10) = 28 px circle bg `--accent`, letter in JetBrains Mono Bold 13 `--paper` + title Outfit SemiBold 18 `--text`; then a wrapping row of step chips (gap 8 vertical × 6 horizontal). Chip: bg `--surface-raised`, 1 px `--border`, radius `--radius-sm` 8, padding 6 × 10, JetBrains Mono Regular 12 `--text`. Separator: `icon/chevron` 14 px stroked `--muted` `#645E78`.

| Flow | Title | Steps (verbatim chip labels, in order) |
|---|---|---|
| A | `Premier projet` | `D02 Projets` › `A1 Dépôt` › `D03 Configuration` › `A2 Clonage` › `A3 Réussi` › `D04 Détail` › `W1 Workspace` |
| B | `Travail quotidien` | `D01 Accueil` › `D05 Autorisation` › `W3 Terminée` › `W4 Diff` › `W5 Commit et PR` |
| C | `Mobilité` | `S5 Notification` › `M05 Workspace` › `S1 Réponse` › `S2 Diff` › `S3 Git` |
| D | `Connexion MCP` | `D07 Intégrations` › `D1 Figma` › `D2 Coolify` |

(The `›` above is notation; in Figma the separator is the `icon/chevron` SVG.) Detailed flow mapping in §4.

### 1.3 `00-principes` — Principes et points à valider

| Field | Value |
|---|---|
| Frame | `Principes et points à valider` — node `241:6079` |
| Size | 900 × 754 |
| Route | None. These are product constraints (see §2) — they must shape the backend, not just the UI. |
| Screenshot / code | `.design-refs/screens/00-principes.png` · `.design-refs/code/00-principes.tsx` |

**Layout skeleton:** bg white, 1 px `--border`, radius 28, padding 64 × 72, vertical gap 28 (`--space-7`). Title `Principes et points à valider` (`Display/H4`). Two labelled lists; each row = 18 px icon + paragraph (Outfit Regular 14 / 21, `--text`), gap 10, paragraph width 726.

- Label `241:6081`: `CE QUE LES MAQUETTES S'INTERDISENT` (JetBrains Mono 11, tracking 0.88, `--muted`). Rows use `icon/check` stroked `success` `#2F6F4F`.
- Label `241:6098`: `À VALIDER TECHNIQUEMENT` (same style, colour `warn` `#8a6516`). Rows use `icon/alert` stroked `warn` `#8A6516`.

Full verbatim content is in §2.1 and §2.2.

### 1.4 Tokens observed in section 00

From `get_variable_defs` on the three frames:

| Kind | Tokens |
|---|---|
| Colour | `--near-black` `#141830` · `--accent-on-dark` `#a6b9dd` · `--paper` `#ffffff` · `--surface-raised-dark` `#ffffff0d` · `--bg` `#ffffff` · `--surface-raised` `#ffffff` · `--text` `#233353` · `--muted` `#645e78` · `--accent` `#4368b1` · `--accent-pale` `#dee5f2` · `--border` `#d9dade` · `success` `#2f6f4f` · `warn` `#8a6516` |
| Spacing | `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-7` 28 · `--space-8` 32 · `--space-10` 40 · `--space-12` 48 · `--space-16` 64 · `--space-20` 80 |
| Radius | `--radius-sm` 8 · `--radius-md` 12 · `--radius-lg` 20 · `--radius-xl` 28 · `--radius-full` 999 |
| Type styles | `Mono/Eyebrow` (JetBrains Mono Regular 12 / 1.25, +20 %) · `Display/Hero` (Outfit Bold 104 / 1.06, −4 %) · `Text/Lead` (Outfit Regular 20 / 1.25) · `Display/H4` (Outfit Bold 32 / 1.06, −2 %) |
| Fonts | Outfit (Regular, SemiBold, Bold) · JetBrains Mono (Regular, Bold) |
| Icons | 24 px grid drawn with stroke 1.8, round caps; exported here at 14/18/20 px with stroke 1.8 kept |

Note that `success` and `warn` come back without the `var(--…)` code syntax, unlike the other variables — name them `--success` / `--warn` in CSS for consistency.

---

## 2. Product principles and decisions

### 2.1 What the mockups forbid themselves — `CE QUE LES MAQUETTES S'INTERDISENT`

These are hard constraints. Each row: verbatim text, what it means for the implementation, and the UI copy elsewhere on the page that enforces it.

| # | Verbatim (node) | Implementation consequence | Where it shows in the UI (verbatim) |
|---|---|---|---|
| P1 | `Aucune API de chat privée sur l'abonnement Max : l'écran pilote une vraie session du CLI, la vue Conversation n'est qu'une mise en forme de son flux.` (`241:6085`) | The backend never calls a chat API with the Max subscription. Each session is an official `claude` CLI process (in a PTY / tmux) on VPS-3. The "Conversation" view is a **renderer of the CLI stream**; "Terminal brut" shows the same stream raw. Both views read one source. | D05 view switch `Vue · Conversation` / `Vue · Terminal brut` *(layers)* with helper `Même session, deux lectures du flux du CLI.` (`214:1526`) |
| P2 | `Aucun formulaire de jeton Claude : la connexion passe par la procédure du CLI, dans un terminal.` (`241:6089`) | No input field for Claude tokens/API keys anywhere. "Connect / reconnect Claude" opens a terminal on VPS-3 running the CLI login procedure. Nuera Dev stores no Claude credential. | T6 annotation: `« Se reconnecter » ouvre un terminal sur VPS-3 qui lance la procédure de connexion du CLI (claude /login). Aucun formulaire de jeton dans Nuera Dev.` (`236:5400`) · M08: `Nuera Dev ne stocke aucun identifiant Claude et n'estime aucun coût.` (`226:3043`) |
| P3 | `Aucune métrique de coût, de quota ou de jetons inventée : seulement ce que le CLI affiche.` (`241:6093`) | No cost/quota/token counters computed by Nuera Dev. Only pass through what the CLI itself prints (e.g. its own status/usage output). "Capacité" in Sessions is **server** capacity (parallel sessions, RAM/CPU of VPS-3), not tokens. | M08 note above (`n'estime aucun coût`); D06 capacity tile *(layers)*: "2 sessions actives sur 4 autorisées", "Mémoire libre : 10,9 Go sur 16 · processeur 23 %" |
| P4 | `Aucune action de production Coolify à portée de Claude.` (`241:6097`) | The Coolify MCP given to Claude must not be able to act on production (scoped token / non-production scope). The UI never offers a production action to Claude. | D07 guardrail card *(layer)* `Garde-fou · Production hors de portée`; M07 guardrail *(layer)* "Les actions de production Coolify ne passent jam…"; D2 drawer guardrail *(layer)* "Après reconnexion, chaque projet garde son propr…" |

### 2.2 To validate technically — `À VALIDER TECHNIQUEMENT`

Open technical questions the design depends on. Each needs a spike before the corresponding screen is built; the fallback is stated where Figma gives one.

| # | Verbatim (node) | What to prove | Fallback / design impact |
|---|---|---|---|
| V1 | `Rendu Conversation : lire la sortie du CLI dans un format exploitable (mode non interactif, sortie structurée) tout en gardant la session interactive. Repli : la vue Terminal brut seule.` (`241:6103`) | That a structured event stream (messages, tool calls, plans, permission prompts) can be obtained for a session that stays interactive (user can type mid-run, `Échap · interrompre`). Candidates to evaluate against current CLI docs: the CLI's structured output modes (non-interactive print mode with a streaming JSON format), the session transcript files the CLI writes, CLI hooks. | **Fallback written in Figma:** ship only the raw Terminal view (xterm-style terminal attached to the session). Conversation-only components (`Dev · Message · Instruction`, `Dev · Message · Claude`, `Dev · Ligne d'outil`, `Dev · Plan de travail`) then become optional. |
| V2 | `Demandes d'autorisation : les capter et y répondre depuis le navigateur sans contourner le mode de permission du CLI.` (`241:6108`) | That permission prompts can be detected and answered from the browser (desktop card and phone card, push notification S5) while the CLI's own permission mode stays in charge. Never run with permission bypass. Candidates: CLI hooks around tool use / notifications, a permission-prompt tool, or answering the TUI prompt through the PTY. | Without it, flows B and C break (D05 "Autorisation", S5 notification, S1 reply). Minimum viable: detect the prompt in the terminal stream and let the user answer in Terminal view. |
| V3 | `Persistance : une session par processus tmux et par worktree ; reprise par claude --resume après un redémarrage.` (`241:6113`) | One tmux session per Claude process **and** per git worktree; closing the browser never stops a session; after a VPS reboot, sessions are resumed with `claude --resume`. | Matches D05 copy `Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas.` + `Échap · interrompre` (`214:1661`) and D06 note `Reprendre rouvre la conversation enregistrée par Claude Code (claude --resume) dans son worktree. Une reprise devient impossible quand ce worktree a été supprimé ; l'historique reste lisible.` (`215:2141`). D05 header shows the tmux session name *(layer)*: "tmux nuera-os-crm-core · démarrée il y a 12 min". |
| V4 | `Notifications au téléphone : application web installable et notifications push, ou relais par un service tiers.` (`241:6118`) | Installable PWA (manifest + service worker + Web Push; on iOS push requires the app to be installed to the home screen) **or** a third-party relay. | S5 shows a system notification `Notification · Nuera Dev` *(layer)* with source "NUERA DEV", time "maintenant", title "Tests e2e du devis attend votre accord" *(layers)*. M08 has a `Réglage · Notifications` row *(layer)*. |
| V5 | `Conditions d'usage de l'abonnement Claude pour un usage personnel hébergé sur son propre serveur.` (`241:6123`) | Legal/ToS check: running the official CLI with a personal Claude subscription on a self-hosted server for one person. | Blocking for go-live, not for development. |

### 2.3 Cross-cutting UX rules written on the canvas (section 03 annotations)

Verbatim annotations under the T-state frames — they apply to every screen:

| State | Rule (verbatim) | Node |
|---|---|---|
| T1 Chargement | `Silhouettes à la place des lignes tant que la liste arrive ; le bandeau dit ce qui se synchronise. En mouvement réduit, pas de miroitement : les silhouettes restent fixes.` | `235:5306` |
| T2 Listes vides | `Une liste vide dit pourquoi elle l'est et propose la seule action utile. Jamais d'illustration décorative : la pastille reprend l'icône de la section.` | `235:5345` |
| T3 Succès | `Le bandeau reste dans la page tant qu'il y a une suite à donner ; le toast disparaît seul après 6 s et reste lisible au survol.` | `235:5366` |
| T4 Erreur récupérable | `Toute erreur dit ce qui a échoué, ce qui n'a pas été touché, et propose l'action pour réessayer. La sortie brute reste à un clic.` | `235:5405` |
| T5 Serveur indisponible | `Remplace le contenu de toutes les pages tant que le serveur ne répond pas. L'Accueil et la barre latérale passent en rouge, sans masquer la navigation.` | `236:5371` |
| T6 Claude Code déconnecté | `« Se reconnecter » ouvre un terminal sur VPS-3 qui lance la procédure de connexion du CLI (claude /login). Aucun formulaire de jeton dans Nuera Dev.` | `236:5400` |
| T7 Autorisation expirée | `Même logique pour GitHub, Figma ou Coolify : prévenir avant, dire ce qui s'arrête après, et renvoyer vers le service qui délivre l'accès.` | `236:5431` |
| T8 Actions sensibles | `Une confirmation liste ce qui change et ce qui est conservé, puis nomme l'action sur son bouton. Le système de design n'a pas de variante destructive du Button : à arbitrer (voir 04).` | `236:5566` |

Implementation translation: skeleton rows (no shimmer under `prefers-reduced-motion: reduce`); empty states = icon pill + reason + single CTA; toasts auto-dismiss at 6 s and pause on hover; banners persist while an action is pending; errors expose a "raw output" toggle; a global "server down" state replaces page content but keeps the nav; Claude reconnection = terminal, never a form; integration expiry warns before and explains after; confirmations list what changes vs. what is kept and the confirm button names the action.

### 2.4 Design-system extensions and gaps to arbitrate (note `240:5890`, section 04)

Verbatim from `Note · Extensions et lacunes` (1400 × 534):

- Title: `Extensions au système de design`
- Intro: `Tout ce qui est ici est local à cette page et construit uniquement avec les variables existantes (Color, Spacing, Radius, App · statuts) et les styles Shadow/Soft et Shadow/Float. Aucun composant maître de Nuera OS ou du Design System n'a été modifié.`
- `RÉUTILISÉS TELS QUELS` — `Button (Default, Accent) · Bouton compact (Principal, Secondaire, Discret) · Badge (les 6 tons, sauf ChatGPT) · Avatar · En-tête de tuile · 25 icônes de Nuera OS · Logo Nuera · mode Dark de la collection Color pour les zones de terminal.`
- `DÉRIVÉS DE NUERA OS` — `Dev · Barre latérale (instance détachée de la Barre latérale de Nuera OS, entrées et carte serveur remplacées) · Logo Nuera Dev (pastille DEV, construction de la pastille OS) · Dev · Interrupteur (dessin de l'interrupteur des Réglages, passé à l'accent).`
- `CRÉÉS POUR NUERA DEV` — `Barre latérale repliée, Barre d'onglets, Barre d'état, Indicateur d'accueil, Point de statut, Champ · Message (instruction, Claude), Ligne d'outil, Sortie de commande, Demande d'autorisation (bureau et téléphone), Plan de travail, Compositeur, Ligne de diff, Fichier modifié, Carte de session, Ligne de projet, Ligne d'historique, Bandeau, Toast.`
- `LACUNES À ARBITRER` (label in `warn`; in Figma each item is a separate paragraph of node `240:5900` that starts with its own number, e.g. `1. Pas de variante…`, line-height 22):
  1. `Pas de variante destructive du Button : les confirmations (arrêter, archiver, supprimer) utilisent Accent. Proposer une variante Danger avec les jetons danger / danger-pale.`
  2. `Pas de jeton danger-on-dark : les erreurs dans le terminal (mode Dark) utilisent danger-pale. À créer à côté de warn-on-dark et success-on-dark.`
  3. `surface et surface-raised valent toutes deux paper en mode Light : les fonds de champs et de blocs se distinguent par une bordure, pas par une teinte.`
  4. `Aucun style de texte n'est appliqué dans les écrans de Nuera OS (tailles posées à la main) : Nuera Dev suit la même échelle (28, 22, 18, 16, 14, 13, 12, 11) ; une rampe de styles « App » serait à formaliser.`
  5. `Le Badge ChatGPT est propre à ChatGPT ; il n'est jamais utilisé pour Claude.`

Recommended defaults for implementation (to confirm with the designer): (1) build confirmations with the Accent button as designed, but give the `Button` a `tone="danger"` prop ready to switch; (2) use `danger-pale` for terminal errors as designed; (3) separate surfaces with borders, not tints; (4) define an app type ramp 28 / 22 / 18 / 16 / 14 / 13 / 12 / 11 in CSS; (5) never render the ChatGPT badge.

Component description captured on the way (`202:478`, `Dev · Point de statut`): "Pastille de 8 px qui précède un libellé d'état. Ne porte jamais seule l'information : toujours avec un texte."

---

## 3. Navigation model

### 3.1 Global navigation (5 entries, fixed order)

`Accueil` (`icon/home`) → `Projets` (`icon/projets`) → `Sessions` (`icon/terminal`) → `Intégrations` (`icon/plug`) → `Paramètres` (`icon/reglages`). Subtitles in §1.2. The Workspace is **not** a nav entry.

| Context | Component (section 04) | Size | Variants | Used in |
|---|---|---|---|---|
| Desktop, normal pages | `Dev · Barre latérale` (`201:732`) | 248 × 1120 | `Actif=Accueil` `201:431` · `Actif=Projets` `201:432` · `Actif=Sessions` `201:478` · `Actif=Intégrations` `201:524` · `Actif=Paramètres` `201:570` | D01–D04, D06–D08, D1, D2 (content area starts at x = 248, width 1192, content padding 32 left/right, 28 top) |
| Desktop, Workspace | `Dev · Barre latérale repliée` (`201:893`) — rail | 72 × 1120 | same 5 `Actif=` variants (`201:764`, `201:796`, `201:828`, `201:860`, `201:892`) | D05, W1–W7 (workspace area starts at x = 72, width 1368) |
| Phone, normal pages | `Dev · Barre d'onglets` (`202:452`) | 390 × 91 (bottom; presumably includes the 34 px home-indicator zone — confirm in the section 04 spec) | same 5 `Actif=` variants (`202:291`, `202:331`, `202:371`, `202:411`, `202:451`) | M01, M02, M04, M06, M07, M08, S5 |
| Phone, Workspace and full-screen flows | none (tab bar hidden) | — | — | M03 (add project), M05, S1–S4 |
| Phone chrome | `Dev · Barre d'état` (`202:248`) 390 × 47 on top; `Dev · Indicateur d'accueil` (`202:251`) 390 × 34 at the bottom when no tab bar | — | — | all M/S frames |

Section 04 marker labels: `NAVIGATION · bureau`, `NAVIGATION · Workspace`, `NAVIGATION · téléphone`.

Expected active item per screen: D01/M01/S5 → Accueil; D02/D03/D04/M02/M04 → Projets; D06/M06 → Sessions; D07/D1/D2/M07 → Intégrations; D08/M08 → Paramètres. Workspace rail active item: not stated in the frames read for this file — check the D05 spec (see §8, Q5).

### 3.2 The Workspace is contextual

Rule (verbatim, `241:5980`): `Ouvert depuis un projet ou une session, jamais depuis la navigation. Au bureau, la barre se replie en rail ; au téléphone, la barre d'onglets disparaît.`

Entry points found on the page (instance/layer names — verify labels in the per-screen specs):

| From | Element *(layer)* | Opens |
|---|---|---|
| D01 Accueil | `Bouton · Nouvelle session` (header); `Tuile · Reprise rapide` → compact button; `Dev · Carte de session` ×2; Claude Code tile alert "Tests e2e du devis attend votre autorisation" | new session / existing session (W1 / D05) |
| M01 Accueil | `Demande en attente` → `Bouton · Répondre`; `Reprise rapide` → `Bouton · Reprendre la session`; `Rail · sessions actives` cards | M05 |
| D02 Projets | row menu `Menu · Atelier Lune` → `Option · Nouvelle session ici` | W1 |
| D04 / M04 Détail du projet | `Bouton · Ouvrir le Workspace`; `Tuile · Sessions de ce projet` rows | W1 (flow A) / D05 |
| D06 / M06 Sessions | `Bouton · Nouvelle session`; `Nouvelle session` card ("Démarrer une session"); `Dev · Carte de session`; history rows (resume) | W1 / D05 |
| S5 push notification | `Notification · Nuera Dev` | M05 (flow C) |
| Inside the Workspace | W6 selector `Sélecteur ouvert · sessions de Nuera OS` (sessions of the same project + `Nouvelle session`); S4 sheet `Feuille · Sessions de Nuera OS` (+ `Toutes les sessions` → `/sessions`) | another session of the same project |

Leaving the Workspace: desktop through the rail (72 px, all 5 entries remain reachable); phone through `Bouton · Retour` in `En-tête de session`.

### 3.3 Phone patterns (summary)

- Top: status bar 47; regular pages scroll in `Contenu défilant` (y 47 → 753, 706 high, 16 px side padding) above the 91 px tab bar.
- Sub-pages: M03 and M04 add `Barre du haut` (52 high, 44 × 44 touch targets: cancel/back, title, step/sync/more) and a sticky bottom `Barre d'action` with one full-width primary button (`Bouton · Continuer`, `Bouton · Ouvrir le Workspace`; 358 × 44).
- M03 adds a 4 px `Progression` bar with 3 segments (`Étape 1`, `Étape 2`, `Étape 3`).
- Workspace (M05, S1–S4): `En-tête de session` 52 (back, identity, `Bouton · Changer de session`, `Bouton · Actions de session`), `État de la session` 39 (badge + "12 min · vit sur VPS-3" *(layer)*), `Onglets du Workspace` 55 with 4 tabs *(layers)* `Onglet · Session`, `Onglet · Fichiers`, `Onglet · Diff · 4`, `Onglet · Git`, then the tab content (564), then `Saisie` 87 (composer 44 + home indicator). With the keyboard open (S1) the thread shrinks to 307 and the composer sits on the system keyboard (291).
- Session switching on the phone is a bottom sheet (S4, 350 high, with grab handle `Poignée`, scrim `Voile`).
- Permission request on the phone is a dedicated large card `Dev · Demande d'autorisation · téléphone` (358 × 358) built for thumb reach.

### 3.4 Desktop ↔ phone equivalence

| Concept | Desktop | Phone |
|---|---|---|
| Home | D01 | M01 (S5 = M01 + push notification) |
| Projects library | D02 (+ row menu) | M02 |
| Add a project | D03 modal over D02 + A1–A4 | M03 full-screen 3-step flow |
| Project detail | D04 | M04 |
| Workspace | D05 + W1–W7 | M05 + S1–S4 |
| Conversation / raw terminal | `Barre de vue` switch in D05 | `Onglet · Session` *(layer)* (terminal access on phone: see §8, Q6) |
| Multi-file diff | W4 (right panel) | S2 (`Onglet · Diff`) |
| Commit & PR | W5 modal `Modale · Préparer le commit` | S3 (`Onglet · Git`) |
| Switch session | W6 popover | S4 bottom sheet |
| Permission request | `Dev · Demande d'autorisation` (680 wide, states En attente / Autorisée / Refusée) | `Dev · Demande d'autorisation · téléphone` (358 × 358) |
| Sessions | D06 | M06 |
| Integrations | D07 + D1/D2 drawers | M07 (inline `Alerte Coolify` + `Bouton · Reconnecter`) |
| Settings | D08 (tabs + 2-column grid) | M08 (grouped list) |

---

## 4. Prototyped flows (parcours)

Each step: chip label (verbatim) → frame → node → route/state. Triggers are inferred from the frames' content (layer names) and must be confirmed in the per-screen specs.

### Flow A — `Premier projet` (first project)

| # | Chip | Frame | Node | Route / state | Trigger to next step |
|---|---|---|---|---|---|
| 1 | `D02 Projets` | D02 · Projets | `210:675` | `/projets` | `Bouton · Ajouter un projet` *(layer)* in the header (phone: 44 × 44 `Bouton · Ajouter un projet` in the M02 header) → opens the add-project modal |
| 2 | `A1 Dépôt` | A1 · Ajouter un projet · Choix du dépôt | `233:4846` | `/projets/nouveau` step 1 (`?etape=depot`) | pick a repo in `Dépôts` (search field + account filter badges) → continue |
| 3 | `D03 Configuration` | D03 · Ajouter un projet | `211:933` | `/projets/nouveau` step 2 (`?etape=configuration`) | fields `Champ · Branche`, `Champ · Nom`, `Champ · Destination sur VPS-3`, 3 options (install deps, one worktree per new session, read CLAUDE.md) *(layers)* → confirm |
| 4 | `A2 Clonage` | A2 · Ajouter un projet · Clonage en cours | `233:4944` | step 3 (`?etape=clonage`), job running: progress bar, 3 sub-steps, live `Journal` | automatic on job success |
| 5 | `A3 Réussi` | A3 · Ajouter un projet · Clonage réussi | `233:5004` | step 3, job done: recap (folder, branch, detected commands, CLAUDE.md) | footer button → project detail |
| 6 | `D04 Détail` | D04 · Détail du projet | `213:1233` | `/projets/[projectId]` | `Bouton · Ouvrir le Workspace` *(layer)* |
| 7 | `W1 Workspace` | W1 · Workspace · Nouvelle session | `227:3075` | `/workspace/[sessionId]` (new, empty session) | — |

Alternate (not on the prototyped path): **A4** `Erreur récupérable` (`233:5075`) — destination conflict with a `Dev · Bandeau`, editable destination and two suggestions *(layers)* "Utiliser /srv/dev/roux-conseil-landing" / "Ouvrir le projet existant". Phone version: M03 (step 1 only is drawn).

### Flow B — `Travail quotidien` (daily work)

| # | Chip | Frame | Node | Route / state | Trigger |
|---|---|---|---|---|---|
| 1 | `D01 Accueil` | D01 · Accueil | `205:422` | `/` | Claude Code tile alert "… attend votre autorisation" / session card → open session |
| 2 | `D05 Autorisation` | D05 · Workspace Claude Code | `214:1424` | `/workspace/[sessionId]`, pending permission (`Dev · Demande d'autorisation`, `État=En attente`, at the end of the thread) | answer the request; session continues |
| 3 | `W3 Terminée` | W3 · Workspace · Session terminée | `229:3316` | same route, session finished | open the diff |
| 4 | `W4 Diff` | W4 · Workspace · Diff multi-fichiers | `229:3676` | same route, right panel on the multi-file diff | Git actions in the panel → prepare commit |
| 5 | `W5 Commit et PR` | W5 · Workspace · Commit et pull request | `231:3754` | same route + modal `Préparer le commit` (files, message, push / open PR options, PR title) | confirm → commit (+ push + PR) — nothing goes to GitHub without this confirmation |

### Flow C — `Mobilité` (phone)

| # | Chip | Frame | Node | Route / state | Trigger |
|---|---|---|---|---|---|
| 1 | `S5 Notification` | S5 · Mobile · Notification d'autorisation | `239:5757` | push notification over `/` (M01) | tap the notification |
| 2 | `M05 Workspace` | M05 · Workspace Claude Code | `222:2732` | `/workspace/[sessionId]` (phone), permission card in the thread | answer, then type |
| 3 | `S1 Réponse` | S1 · Workspace mobile · Clavier ouvert | `238:5434` | same, composer focused, keyboard open; the permission now appears as the compact `Dev · Demande d'autorisation` (358 × 50, probably `État=Autorisée` — check the S1 spec) followed by a new Claude message | switch to the Diff tab |
| 4 | `S2 Diff` | S2 · Workspace mobile · Onglet Diff | `238:5634` | same, `?onglet=diff`: current-file pager (previous/next) + diff lines | switch to the Git tab |
| 5 | `S3 Git` | S3 · Workspace mobile · Onglet Git | `238:5863` | same, `?onglet=git`: branch, "4 fichiers à committer", files, message, push / PR options, primary compact button | confirm commit |

### Flow D — `Connexion MCP` (MCP connection)

| # | Chip | Frame | Node | Route / state | Trigger |
|---|---|---|---|---|---|
| 1 | `D07 Intégrations` | D07 · Intégrations | `216:2035` | `/integrations` | click an MCP card (`Grille MCP`) |
| 2 | `D1 Figma` | D1 · Intégrations · MCP Figma connecté | `234:4927` | drawer `/integrations/mcp/figma` (480 wide, right, over a scrim): state, "activé dans" projects, granted permissions, configuration file | close / open Coolify |
| 3 | `D2 Coolify` | D2 · Intégrations · MCP Coolify à reconnecter | `234:5127` | drawer `/integrations/mcp/coolify`: warning banner, "reconnecter" block with a new-token field limited in scope, perimeter, guardrail | reconnect |

Note: D2 asks for a **Coolify** token in a field; that does not contradict P2, which only forbids a **Claude** token form.

---

## 5. Master inventory (page `199:3`)

Columns: code · frame name (verbatim layer name of the frame) · node · size · proposed route / UI state · key regions (from metadata; *layer* names).

### 5.1 Section 01 — Desktop Screens (`199:5`, 12 700 × 1 500)

Section title (`241:6124`): `01 — Desktop Screens · 1440 px · 8 écrans, dans l'ordre du tableau`

| Code | Frame | Node | Size | Route / state | Key regions |
|---|---|---|---|---|---|
| D01 | `D01 · Accueil` | `205:422` | 1440 × 1120 | `/` | Sidebar `Actif=Accueil`; header (greeting, date line, bell button, `Bouton · Nouvelle session`); row `Disponibilité` (tiles Serveur VPS-3 with CPU/RAM/disk gauges, Claude Code, Reprise rapide); row `Activité` (2 session cards + Projets récents); row `Git et intégrations` (Dernières modifications, Intégrations) |
| D02 | `D02 · Projets` | `210:675` | 1440 × 1120 | `/projets` (+ row overflow menu open on "Atelier Lune") | header (title, subtitle "5 dépôts clonés sur VPS-3 · 41 Go utilisés sur 1…", `Bouton · Ajouter un projet`); `Barre d'outils` (search field 360, 3 filter badges, second field 230); `Tableau des projets` (`Dev · Ligne de projet` rows); `Note · Archivage`; popover `Menu · Atelier Lune` 248 × 192 with options *(layers)* Retirer des favoris / Synchroniser maintenant / Nouvelle branche… / Nouvelle session ici / Archiver le projet… |
| D03 | `D03 · Ajouter un projet` | `211:933` | 1440 × 1120 | `/projets/nouveau` step 2 "Configuration" — modal 640 × 771 over `/projets` with scrim `Voile` | modal header (title, close, 3-step stepper), body (chosen repo, branch + name, destination on VPS-3 with free-space hint, 3 option toggles, GitHub access note), footer 87 |
| D04 | `D04 · Détail du projet` | `213:1233` | 1440 × 1158 | `/projets/[projectId]` | header (breadcrumb, name + badge, repo link, branch selector, path + last sync, `Bouton · Synchroniser`, `Bouton · Ouvrir le Workspace`); 7 tab badges; grid: main column 688 (Environnement de développement commands, Branches, Sessions de ce projet) + side column 420 (CLAUDE.md, Outils MCP du projet, Variables d'environnement) |
| D05 | `D05 · Workspace Claude Code` | `214:1424` | 1440 × 1120 | `/workspace/[sessionId]` — running session with a pending permission (flow B "Autorisation") | rail 72; `En-tête de session` 81 (title, context chips repo/branch/worktree, tmux line, session selector "2 sessions sur ce projet", 2 compact buttons, more, panel toggle); body: `Session Claude Code` 908 (view bar Conversation/Terminal brut, thread, composer + persistence line) + `Panneau contextuel` 460 (5 local tabs, `Modifications` with file list and diff, `Actions Git`) |
| D06 | `D06 · Sessions` | `215:1792` | 1440 × 1120 | `/sessions` | header + `Bouton · Nouvelle session`; `Capacité` (4-slot gauge, free memory/CPU); `Sessions en cours` (2 session cards + "Démarrer une session" card); `Note worktrees`; filters (4 fields); `Tableau de l'historique` (6 columns *(layers)*: SESSION / PROJET / BRANCHE / DÉBUT · DURÉE / STATUT / ACTION; 5 `Dev · Ligne d'historique` rows); resume note |
| D07 | `D07 · Intégrations` | `216:2035` | 1440 × 1120 | `/integrations` | header + `Bouton · Ajouter un serveur MCP`; GitHub card (accessible repos, rights, last check, actions, expiry line); MCP title + `Grille MCP` (Figma, GitHub, Coolify, Navigateur Playwright, "Ajouter un MCP"); `Diagnostic Coolify` alert row; `Garde-fous` (3 cards) |
| D08 | `D08 · Paramètres` | `217:2179` | 1440 × 1157 | `/parametres` | header; 5 tab badges; 2-column grid — left: Claude Code · compte Claude, Compte et sécurité; right: Serveur VPS-3, Maintenance, Préférences |

### 5.2 Section 02 — Mobile Screens (`199:6`, 4 200 × 1 300)

Section title (`241:6125`): `02 — Mobile Screens · 390 px · les 8 mêmes écrans, composés pour le téléphone`

| Code | Frame | Node | Size | Route / state | Key regions |
|---|---|---|---|---|---|
| M01 | `M01 · Accueil` | `220:2366` | 390 × 844 | `/` | status bar; header + notifications button; status chips (VPS-3, Claude Code); `Demande en attente` card + `Bouton · Répondre`; `Reprise rapide` + `Bouton · Reprendre la session`; horizontal rail of active sessions + pager dots; Projets récents; Dernières modifications; tab bar |
| M02 | `M02 · Projets` | `220:2575` | 390 × 844 | `/projets` | header; search `Champ`; filter chips; 5 project cards (Nuera OS, Atelier Lune, Kiné Rive Gauche, Site Nuera Studio, Nuera Dev); tab bar |
| M03 | `M03 · Ajouter un projet` | `221:2587` | 390 × 844 | `/projets/nouveau` step 1 (full screen, no tab bar) | top bar (cancel, title "Ajouter un projet", step indicator); 3-segment progress; search field; repo list; note; sticky action bar `Bouton · Continuer` |
| M04 | `M04 · Détail du projet` | `221:2661` | 390 × 844 | `/projets/[projectId]` | top bar (back, sync, more); identity + branch selector; scrollable tabs (6 badges); Environnement; CLAUDE.md; Outils MCP; sticky `Bouton · Ouvrir le Workspace`; tab bar |
| M05 | `M05 · Workspace Claude Code` | `222:2732` | 390 × 844 | `/workspace/[sessionId]` (`?onglet=session`), pending permission | session header; state row; 4 tabs; thread (instruction, 2 tool rows, Claude message, phone permission card); composer |
| M06 | `M06 · Sessions` | `223:2787` | 390 × 844 | `/sessions` | header; capacity; "En cours · 2" rail + dots; history header + filters + list; tab bar |
| M07 | `M07 · Intégrations` | `223:2966` | 390 × 844 | `/integrations` | header; GitHub card; `Alerte Coolify` + `Bouton · Reconnecter`; "Serveurs MCP · 4" list (Figma, GitHub, Coolify, Playwright, add); guardrail; tab bar |
| M08 | `M08 · Paramètres` | `226:2985` | 390 × 844 | `/parametres` | header ("Un seul propriétaire : Nezar" *(layer)*); groups Claude Code (compte, modèle par défaut, mode de permission, utilisation) + credential note; Sécurité (double facteur, accès ouverts, journal); Serveur VPS-3 (état, journaux, nettoyer les worktrees inactifs); Préférences (notifications); tab bar |

### 5.3 Section 03 — UI States & Flows (`199:7`, 12 700 × 5 300)

Section title (`241:6126`): `03 — UI States & Flows · Workspace, parcours, états transversaux, téléphone`

Canvas markers (verbatim): `WORKSPACE · ÉTATS DE SESSION · W1 À W7` (`241:6127`) · `PARCOURS A · AJOUT DE PROJET (A1 À A4)   ·   PARCOURS D · CONNEXION MCP (D1, D2)` (`241:6128`, three spaces around the central dot) · `ÉTATS TRANSVERSAUX · T1 À T8` (`241:6129`) · `ÉTATS DU TÉLÉPHONE · S1 À S5` (`241:6130`).

| Code | Frame | Node | Size | Route / state | Key regions |
|---|---|---|---|---|---|
| W1 | `W1 · Workspace · Nouvelle session` | `227:3075` | 1440 × 1120 | `/workspace/[sessionId]` status *new* (no instruction yet) | same shell as D05 |
| W2 | `W2 · Workspace · Tâche longue` | `227:3523` | 1440 × 1120 | same route, status *running* (long task, plan progress) | same shell |
| W3 | `W3 · Workspace · Session terminée` | `229:3316` | 1440 × 1120 | same route, status *finished* | same shell |
| W4 | `W4 · Workspace · Diff multi-fichiers` | `229:3676` | 1440 × 1120 | same route, context panel on the multi-file diff | same shell |
| W5 | `W5 · Workspace · Commit et pull request` | `231:3754` | 1440 × 1120 | same route + modal `Modale · Préparer le commit` 680 × 778 over scrim | modal: header ("Préparer le commit" + branch), files "Fichiers inclus · 4 sur 4" `+152 −12`, message + description, options push / open PR to main, PR title, footer |
| W6 | `W6 · Workspace · Sessions parallèles` | `231:4011` | 1440 × 1120 | same route + popover `Sélecteur ouvert · sessions de Nuera OS` 400 × 277 | 2 sessions, separator, `Nouvelle session`, note |
| W7 | `W7 · Workspace · Connexion perdue` | `231:4206` | 1440 × 1120 | same route, browser ↔ server stream lost (session keeps running on VPS-3) | same shell |
| A1 | `A1 · Ajouter un projet · Choix du dépôt` | `233:4846` | 720 × 725 | `/projets/nouveau` step 1 (modal 640 × 645) | search, account badges, repo list (5) |
| A2 | `A2 · Ajouter un projet · Clonage en cours` | `233:4944` | 720 × 656 | step 3, job running (modal 640 × 576) | title + badge, progress bar, 3 sub-steps (clone, `npm ci`, read CLAUDE.md and detect commands), log |
| A3 | `A3 · Ajouter un projet · Clonage réussi` | `233:5004` | 720 × 651 | step 3, success (modal 640 × 571) | check pill, "… est prêt", recap (folder, branch, commands, CLAUDE.md) |
| A4 | `A4 · Ajouter un projet · Erreur récupérable` | `233:5075` | 720 × 647 | step 2/3, recoverable error (modal 640 × 567) | error banner, destination field + hint, 2 suggestions |
| D1 | `D1 · Intégrations · MCP Figma connecté` | `234:4927` | 1440 × 1120 | `/integrations/mcp/figma` — drawer 480 × 1120 over D07 + scrim | drawer header (pill, title, close, badge), blocks ÉTAT / ACTIVÉ DANS / PERMISSIONS ACCORDÉES / CONFIGURATION, footer 87 |
| D2 | `D2 · Intégrations · MCP Coolify à reconnecter` | `234:5127` | 1440 × 1120 | `/integrations/mcp/coolify` — drawer, needs reconnection | banner, RECONNECTER (token field), PÉRIMÈTRE, guardrail, footer |
| T1 | `T1 · Chargement et synchronisation` | `235:5273` | 720 × 461 | any list while loading/syncing | `Dev · Bandeau` + `Tableau en chargement` (4 skeleton rows) + annotation |
| T2 | `T2 · Listes vides` | `235:5307` | 1240 × 377 | empty Projets / Sessions en cours / Serveurs MCP | 3 empty states (pill, title, text, one CTA) + annotation |
| T3 | `T3 · Succès d'une opération` | `235:5346` | 720 × 306 | any mutation success | success banner + 2 `Dev · Toast` + annotation |
| T4 | `T4 · Erreur récupérable` | `235:5367` | 720 × 351 | any failed command/operation | error banner + `Commande échouée` card (title "npm run build a échoué", error excerpt, 3 actions) + annotation |
| T5 | `T5 · Serveur indisponible` | `236:5335` | 720 × 491 | global: VPS-3 unreachable, replaces all page content | card `VPS-3 ne répond pas` (wifi-off pill, last contact, "Ce qui est sûr", `Bouton · Réessayer maintenant`, `Bouton · État du serveur chez OVH`) + annotation |
| T6 | `T6 · Claude Code déconnecté` | `236:5372` | 720 × 451 | global: CLI logged out | card `Claude Code n'est plus connecté à votre compte Claude` ("Ce qui est sûr", 2 actions incl. reconnect) + annotation |
| T7 | `T7 · Autorisation expirée` | `236:5401` | 1520 × 195 | integration access soon expired / expired (GitHub, Figma, Coolify) | `Deux cas`: AVANT L'EXPIRATION (banner) · APRÈS L'EXPIRATION ("Accès GitHub révoqué") + annotation |
| T8 | `T8 · Actions sensibles à confirmer` | `236:5432` | 2200 × 521 | confirm dialogs (520 wide) | stop session "Arrêter « Module CRM · pipeline » ?", archive project "Archiver Atelier Lune ?" (+ option), delete worktrees "Supprimer 2 worktrees inactifs ?" (+ list) + annotation |
| S1 | `S1 · Workspace mobile · Clavier ouvert` | `238:5434` | 390 × 844 | `/workspace/[sessionId]` phone, composer focused | thread 307 + composer + system keyboard 291 |
| S2 | `S2 · Workspace mobile · Onglet Diff` | `238:5634` | 390 × 844 | `?onglet=diff` | file pager + 13 diff lines + tip "Une ligne coupée s'ouvre en entier au toucher…" *(layer)* |
| S3 | `S3 · Workspace mobile · Onglet Git` | `238:5863` | 390 × 844 | `?onglet=git` | branch + badge, "4 fichiers à committer" `+152 −12`, 4 changed files, message, options push / PR, compact button in the bottom bar |
| S4 | `S4 · Workspace mobile · Changer de session` | `239:5667` | 390 × 844 | bottom sheet over M05 | sheet 350: handle, title, 2 sessions, `Nouvelle session`, `Toutes les sessions` |
| S5 | `S5 · Mobile · Notification d'autorisation` | `239:5757` | 390 × 844 | system push over `/` (M01) | notification 358 × 98 (app icon, "NUERA DEV", "maintenant", title, body) |

### 5.4 Section 04 — Extensions to Existing Components (`199:8`, 7 600 × 2 300)

No section title node; markers (verbatim): `ICÔNES · 37 ajouts, même dessin que les icônes de Nuera OS (24 px, trait 1,8, extrémités rondes, jeton ink)` · `LOGO` · `NAVIGATION · bureau` · `NAVIGATION · Workspace` · `NAVIGATION · téléphone` · `PRIMITIVES` · `WORKSPACE · fil de session` · `WORKSPACE · décisions et saisie` · `WORKSPACE · Git et lignes` · `SESSIONS`.

These map to shared components, not routes.

| Group | Frame / component set | Node | Size | Variants | Proposed component | Used in |
|---|---|---|---|---|---|---|
| ICÔNES | 37 symbols: `icon/terminal` `199:13`, `icon/git-branch` `199:20`, `icon/git-commit` `199:26`, `icon/git-pull-request` `199:33`, `icon/worktree` `199:41`, `icon/file` `199:46`, `icon/file-diff` `199:53`, `icon/folder` `199:57`, `icon/play` `199:61`, `icon/stop` `199:65`, `icon/pause` `199:70`, `icon/refresh` `199:77`, `icon/github` `199:82`, `icon/figma` `199:90`, `icon/star` `199:94`, `icon/archive` `199:100`, `icon/key` `199:106`, `icon/cpu` `199:112`, `icon/lock` `199:117`, `icon/x` `199:122`, `icon/arrow-left` `199:127`, `icon/chevron-down` `199:131`, `icon/more` `199:137`, `icon/plug` `199:144`, `icon/history` `199:150`, `icon/wifi-off` `199:160`, `icon/eye` `199:165`, `icon/monitor` `199:171`, `icon/smartphone` `199:176`, `icon/trash` `199:182`, `icon/upload` `199:188`, `icon/pull` `199:194`, `icon/panel-right` `199:199`, `icon/external` `199:205`, `icon/filter` `199:209`, `icon/list-checks` `199:217`, `icon/home` `199:222` | — | 24 × 24 each | — | `<Icon name="…" size={14\|16\|18\|20\|24} />` (stroke 1.8, `currentColor`) | everywhere |
| ICÔNES (reused from Nuera OS, seen on this page) | `icon/projets`, `icon/reglages`, `icon/check`, `icon/alert`, `icon/chevron`, `icon/bell`, `icon/clock`, `icon/plus`, `icon/messages`, `icon/shield`, `icon/search`, `icon/send`, `icon/paperclip`, `icon/rocket`, `icon/server`, `icon/book`, `icon/edit`, `icon/globe2`, `icon/minus` | (Nuera OS page) | 24 | — | same `<Icon>` set | everywhere |
| LOGO | `Logo Nuera Dev · papier` / `Logo Nuera Dev · encre` | `201:41` / `201:80` | 176 × 27.6 | paper (light, for dark bg) / ink (dark, for light bg) | `<LogoNueraDev tone="papier\|encre" />` | sidebar, cover |
| NAVIGATION · bureau | `Dev · Barre latérale` | `201:732` | 248 × 1120 per variant | `Actif=` ×5 | `<Sidebar active>` | D01–D04, D06–D08, D1, D2 |
| NAVIGATION · Workspace | `Dev · Barre latérale repliée` | `201:893` | 72 × 1120 | `Actif=` ×5 | `<Sidebar collapsed>` (rail) | D05, W1–W7 |
| NAVIGATION · téléphone | `Dev · Barre d'onglets` | `202:452` | 390 × 91 | `Actif=` ×5 | `<TabBar active>` | M01, M02, M04, M06–M08, S5 |
| PRIMITIVES | `Dev · Barre d'état` | `202:248` | 390 × 47 | — | mock only (real device status bar → safe-area-inset-top) | all phone frames |
| PRIMITIVES | `Dev · Indicateur d'accueil` | `202:251` | 390 × 34 | — | safe-area-inset-bottom spacer | phone frames without tab bar |
| PRIMITIVES | `Dev · Interrupteur` | `202:459` | 36 × 20 | `Actif=Oui` `202:455` · `Actif=Non` `202:458` | `<Switch>` | D03 options, D08/M08 settings |
| PRIMITIVES | `Dev · Point de statut` | `202:478` | 8 × 8 | `Ton=` Succès `202:462` · En cours `202:465` · Alerte `202:468` · Danger `202:471` · Neutre `202:474` · Accent `202:477` | `<StatusDot tone>` (always followed by a text label) | lists, headers |
| PRIMITIVES | `Dev · Champ` | `202:503` | 320 × 40 | `État=` Repos `202:486` · Focus `202:494` · Erreur `202:502` | `<Field state>` | forms, filters, search |
| WORKSPACE · fil de session | `Dev · Message · Instruction` | `203:318` | 680 × 83 | — | `<InstructionMessage>` | thread |
| WORKSPACE · fil de session | `Dev · Message · Claude` | `203:329` | 680 × 40 | — | `<ClaudeMessage>` | thread |
| WORKSPACE · fil de session | `Dev · Ligne d'outil` | `203:369` | 680 × 34 | `Statut=` Terminé `203:338` · En cours `203:348` · Erreur `203:358` · Refusé `203:368` | `<ToolRow status>` | thread |
| WORKSPACE · fil de session | `Dev · Sortie de commande` | `203:373` | 680 × 132 | — | `<CommandOutput>` (Dark terminal tokens) | thread, T4 |
| WORKSPACE · fil de session | `Dev · Plan de travail` | `203:455` | 680 × 182 | — | `<WorkPlan>` | thread (D05, W2) |
| WORKSPACE · décisions et saisie | `Dev · Demande d'autorisation` | `203:423` | 680 × 211 / 34 | `État=` En attente `203:405` · Autorisée `203:413` · Refusée `203:422` | `<PermissionRequest state>` | D05, S1 |
| WORKSPACE · décisions et saisie | `Dev · Demande d'autorisation · téléphone` | `222:2731` | 358 × 358 | — | `<PermissionRequest variant="phone">` | M05, S4 |
| WORKSPACE · décisions et saisie | `Dev · Compositeur` | `203:497` | 680 × 92 | `État=` Prêt `203:467` · En cours `203:484` · Attente `203:496` | `<Composer state>` | Workspace |
| WORKSPACE · Git et lignes | `Dev · Ligne de diff` | `203:534` | 640 × 22 | `Type=` Bloc `203:506` · Contexte `203:515` · Ajout `203:524` · Suppression `203:533` | `<DiffLine type>` | W4, S2, D05 panel |
| WORKSPACE · Git et lignes | `Dev · Fichier modifié` | `203:554` | 400 × 32 | `Statut=` Modifié `203:541` · Ajouté `203:547` · Supprimé `203:553` | `<ChangedFile status>` | D05 panel, W5, S3 |
| WORKSPACE · Git et lignes | `Dev · Ligne de projet` | `210:674` | 1088 × 65 | — | `<ProjectRow>` | D02 |
| WORKSPACE · Git et lignes | `Dev · Ligne d'historique` | `215:1791` | 1088 × 61 | — | `<HistoryRow>` | D06 |
| WORKSPACE · Git et lignes | `Dev · Bandeau` | `203:703` | 640 × 60 | `Ton=` Info `203:663` · Succès `203:674` · Alerte `203:686` · Erreur `203:702` | `<Banner tone>` | T1, T3, T4, T7, A4, D2 |
| WORKSPACE · Git et lignes | `Dev · Toast` | `203:709` | 442 × 42 | — | `<Toast>` (auto-dismiss 6 s, pause on hover) | T3 |
| SESSIONS | `Dev · Carte de session` | `203:655` | 320 × 203 (221 for Interrompue) | `Statut=` En cours `203:579` · Autorisation `203:604` · Terminée `203:629` · Interrompue `203:654` | `<SessionCard status>` | D01, D06, M01, M06 |
| — | `Note · Extensions et lacunes` | `240:5890` | 1400 × 534 | — | documentation (see §2.4) | — |

(The placement of `Ligne de projet`, `Ligne d'historique`, `Bandeau` and `Toast` under "Git et lignes" follows their canvas position, x = 4900; the `Dev · Carte de session` set is under `SESSIONS`.)

### 5.5 The 26 states grouped by owning screen

| Owning screen / route | States | Notes |
|---|---|---|
| Workspace desktop — D05, `/workspace/[sessionId]` | W1 new · W2 long task · W3 finished · W4 multi-file diff · W5 commit & PR modal · W6 parallel sessions selector · W7 connection lost | D05 itself = running + pending permission |
| Workspace phone — M05, same route | S1 keyboard open · S2 Diff tab · S3 Git tab · S4 switch-session sheet | M05 itself = Session tab + pending permission |
| Accueil phone — M01, `/` | S5 push notification | entry of flow C |
| Ajouter un projet — D03 / M03, `/projets/nouveau` | A1 repo choice · (D03 = configuration) · A2 cloning · A3 success · A4 recoverable error | flow A |
| Intégrations — D07 / M07, `/integrations` | D1 Figma connected (drawer) · D2 Coolify to reconnect (drawer) · T7 access expiring/expired | flow D |
| Cross-cutting (all pages) | T1 loading/sync · T2 empty lists (Projets, Sessions en cours, Serveurs MCP) · T3 success · T4 recoverable error · T5 server unavailable · T6 Claude Code disconnected · T8 sensitive confirmations (stop session, archive project, delete worktrees) | T5/T6 are app-level states, rendered by the shell layout |

---

## 6. Proposed route map (Next.js App Router)

```
app/
├─ (shell)/                              layout: <Sidebar> 248 (desktop) · <TabBar> (phone) · global states T5/T6
│  ├─ page.tsx                           /                              D01 · M01 (S5 = push over M01)
│  ├─ projets/
│  │  ├─ layout.tsx                      renders {children} + {modal}
│  │  ├─ page.tsx                        /projets                       D02 · M02
│  │  ├─ @modal/default.tsx              null
│  │  ├─ @modal/(.)nouveau/page.tsx      modal over /projets            D03 · A1–A4 (full screen < md = M03)
│  │  ├─ nouveau/page.tsx                /projets/nouveau (hard load)   M03 · same <AddProjectFlow>
│  │  └─ [projectId]/page.tsx            /projets/[projectId]           D04 · M04
│  ├─ sessions/page.tsx                  /sessions                      D06 · M06
│  ├─ integrations/
│  │  ├─ layout.tsx                      renders {children} + {drawer}
│  │  ├─ page.tsx                        /integrations                  D07 · M07
│  │  ├─ @drawer/default.tsx             null
│  │  ├─ @drawer/(.)mcp/[serverId]/page.tsx  drawer 480 over list       D1 (figma) · D2 (coolify)
│  │  └─ mcp/[serverId]/page.tsx         /integrations/mcp/[serverId]   hard-load / phone fallback
│  └─ parametres/page.tsx                /parametres                    D08 · M08
└─ (workspace)/                          layout: <Sidebar collapsed> 72 (desktop) · no TabBar (phone)
   └─ workspace/[sessionId]/page.tsx     /workspace/[sessionId]         D05 · M05 · W1–W7 · S1–S4
```

The tab bar must also hide on `/projets/nouveau` (M03 is full screen); either move that page into a route group without the tab bar or hide `<TabBar>` by pathname.

**URL state conventions** (proposal):

| Where | Param | Values | Frames |
|---|---|---|---|
| `/projets/nouveau` | `etape` | `depot` → `configuration` → `clonage` | A1 → D03 → A2/A3/A4 (A2–A4 are job states, not URL states) |
| `/projets/[projectId]` | `onglet` | the D04 tab names (7 on desktop, 6 scrollable on phone — see the D04/M04 specs) | D04, M04 |
| `/workspace/[sessionId]` (desktop) | `vue` | `conversation` (default) · `terminal` | D05 view switch |
| `/workspace/[sessionId]` (desktop) | `panneau` | one of the 5 context-panel tabs, or `ferme` | D05, W4 |
| `/workspace/[sessionId]` (phone) | `onglet` | `session` (default) · `fichiers` · `diff` · `git` | M05, S2, S3 |
| `/sessions` | filter params | the 4 history filters | D06 |
| `/parametres` | `onglet` | the 5 D08 tab names | D08 |

**Overlays without their own URL** (component state): W5 commit modal (or `?commit=1` if deep links are wanted), W6 session popover, S4 bottom sheet, D02 row menu, T8 confirmation dialogs, session "more" menu, toasts and banners.

**Session lifecycle vs. routes:** "Nouvelle session" / "Ouvrir le Workspace" should create the session server-side (worktree + tmux + `claude` process), then `router.push('/workspace/<id>')`; W1 is that session before the first instruction. Live output needs a streaming channel (WebSocket or SSE); W7 is the UI when that channel drops while the session keeps running on VPS-3 (different from T5, where VPS-3 itself is unreachable).

---

## 7. Overview-level domain model

Derived from the overview frames plus layer names across the page (field lists, not final schemas; verbatim copy and exact formats belong to the per-screen specs).

| Entity | Fields implied | Format examples seen *(layers)* |
|---|---|---|
| Server (VPS-3) | name, provider/location, online since, CPU %, memory used/total, storage used/total, last contact, status | "23 %", "5,1 / 16 Go", "61 / 160 Go", "OVH Gravelines · en ligne depuis 18 j", "Dernier contact il y a 3 min" |
| Claude Code (CLI) | connection status, connected Claude account, plan, default model ("défaut du CLI"), permission mode, active sessions / max | "2 sessions actives sur 4 possibles" |
| Project | name, GitHub repo `owner/repo`, local path, current/default branch, favourite, status badge, last sync, archived, env commands (install, launch, build, tests) with last result, env variables (names only), CLAUDE.md (preview, last modified, commit), enabled MCP tools | "nuera-studio/nuera-os", "/srv/dev/nuera-os · synchronisé il y a 4 min", "npm ci", "Modifié le 28 oct. · commit 4c1d0e2" |
| Branch / worktree | name, worktree name, ahead/behind main, protected, merged, session attached | "worktree crm-core · 2 commits d'avance sur main", "branche protégée · à jour avec origin", "fusionnée dans main il y a 3 jours" |
| Session | id, title, project, branch, worktree, tmux name, status (new, running, waiting for permission, finished, interrupted), started at, duration, last instruction, plan progress, resumable | "Module CRM · pipeline", "tmux nuera-os-crm-core · démarrée il y a 12 min", "12 min · vit sur VPS-3", "Plan 3 / 5" |
| Session event (stream) | kind (instruction, Claude message, tool call, command output, plan, permission request), tool name + target, status, timestamps | "Read CLAUDE.md", "Glob src/modules/crm/**/*.tsx", "Edit src/modules/crm/PipelineBoard.tsx" |
| Permission request | session, tool, command/target, state (pending, allowed, refused), requested at | "npm run test -- e2e · Nuera OS", "maintenant" |
| Diff / changes | files (path, status modified/added/deleted, +/−), hunks, lines (hunk header, context, addition, deletion) | "+152 −12", "4 fichiers à committer" |
| Git activity | commit sha (7), message, project, branch, author ("par Claude Code"), time; PR number, title, target | "a3f9c12", "#42" |
| Integration | GitHub App (accessible repos, rights, last check, token renewal); MCP server (name, status connected / to reconnect, enabled per project, granted permissions, config file, scope) | "12 dépôts", "il y a 6 min" |
| Owner / settings | single owner, 2FA, open accesses, security log, server limits, maintenance, notification preferences | "Un seul propriétaire : Nezar" |

Formats: French locale (comma decimal, `Go`, relative times "il y a 4 min" / "il y a 3 jours", long dates "Mercredi 4 novembre 2026", short dates "28 oct."), 7-char SHAs, `#` PR numbers.

---

## 8. Open questions and decisions to make

| # | Question | Default proposed here |
|---|---|---|
| Q1 | All of §2.2 (V1–V5) need spikes before building the Workspace. | Start with Terminal-brut-only (V1 fallback), add Conversation when the stream parsing is proven. |
| Q2 | Destructive button variant (gap 1, T8). | Ship Accent as designed, keep a `tone="danger"` switch. |
| Q3 | French non-breaking spaces: Figma uses regular spaces before `:` `;` `%` and inside `« »`; `Intl.NumberFormat('fr-FR')` outputs U+202F before `%` and in thousands. | Accept Intl output for numbers; keep static copy byte-identical to Figma. |
| Q4 | "Autorisation" means two things: Claude Code **permission requests** (D05, S5, `Dev · Demande d'autorisation`) and **integration access expiry** (T7). | Keep distinct domain names in code: `PermissionRequest` vs `IntegrationAccess`. |
| Q5 | Active item of the collapsed rail inside the Workspace (Projets? Sessions?). | Check D05 design context; otherwise highlight `Sessions`. |
| Q6 | Raw terminal access on the phone (M05 tabs are Session / Fichiers / Diff / Git). | Check the M05 spec for a view toggle inside the Session tab. |
| Q7 | "Ouvrir le Workspace" on a project that already has running sessions: new session or most recent? | Open the most recent active session; offer "Nouvelle session" in the W6 selector. |
| Q8 | Closing the add-project modal during cloning (A2): does the clone job continue? | Yes (server job), surfaced through T1/T3 banners. |
| Q9 | Code collision `D1`/`D2` vs `D01`/`D02`. | Use zero-padded screen codes and `D1-mcp-figma` / `D2-mcp-coolify`. |

---

## 9. Capture log

- Design context fetched for `241:5880`, `241:5935`, `241:6079` (full), the three section titles, the four section-03 markers, the ten section-04 markers, the note `240:5890`, the eight T-state annotations and four principle-related UI strings (`214:1526`, `214:1661`, `215:2141`, `226:3043`).
- Variables fetched for the three cover frames.
- Screenshots: `00-cover.png` and `00-navigation.png` at 1440 px; `00-principes.png` at its natural 900 px (the MCP did not upscale beyond the node size even with `maxDimension` 1800).
- Assets saved under `.design-refs/assets/00-cover/` with the instance colours baked in (cover icons `#A6B9DD`, nav icons `#4368B1`, chevrons `#645E78`, check `#2F6F4F`, alert `#8A6516`). For the app, use one `currentColor` icon set rather than these coloured exports.
- The inventory (§5) was built from the metadata dump of page `199:3`; region descriptions use layer names and are not verbatim copy.
- Rate limits were hit twice during capture; every planned node was eventually fetched.
