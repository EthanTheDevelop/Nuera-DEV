# Workspace states W1 to W7 (section 03 · UI States & Flows)

Implementation spec for the seven 1440 px desktop states of the Claude Code Workspace. They are variations of the base Workspace screen **D05 · Workspace Claude Code** (node `214:1424`, documented in `docs/figma/screens-desktop-b.md`). This file describes, for each state, what differs from D05, the exact copy, the controls and the runtime behaviour the state implies.

- Figma file `nlvRWAtD1x2fKf8gVgcM0g`, page `NUERA DEV — WEB APP` (`199:3`), section `03 — UI States & Flows` (`199:7`).
- Section heading (text `241:6126`, Outfit SemiBold 32, `--text`), verbatim: `03 — UI States & Flows · Workspace, parcours, états transversaux, téléphone`
- Row marker above W1 to W7 (text `241:6127`, JetBrains Mono Regular 14, `--muted`, tracking 1.12 px), verbatim: `WORKSPACE · ÉTATS DE SESSION · W1 À W7`

| Code | Frame name (verbatim) | Node | Size | Screenshot | Raw design-context code |
|---|---|---|---|---|---|
| W1 | W1 · Workspace · Nouvelle session | `227:3075` | 1440 × 1120 | `.design-refs/screens/W1.png` | `.design-refs/code/W1.tsx` (whole frame) |
| W2 | W2 · Workspace · Tâche longue | `227:3523` | 1440 × 1120 | `.design-refs/screens/W2.png` | `.design-refs/code/W2.tsx` (whole frame) |
| W3 | W3 · Workspace · Session terminée | `229:3316` | 1440 × 1120 | `.design-refs/screens/W3.png` | `W3-header.tsx` (`229:3319`), `W3-session.tsx` (`229:3347`) |
| W4 | W4 · Workspace · Diff multi-fichiers | `229:3676` | 1440 × 1120 | `.design-refs/screens/W4.png` | `W4-header.tsx` (`229:3679`), `W4-revue.tsx` (`229:3707`) |
| W5 | W5 · Workspace · Commit et pull request | `231:3754` | 1440 × 1120 | `.design-refs/screens/W5.png` | `W5-header.tsx` (`231:3757`), `W5-voile.tsx` (`231:3903`), `W5-modale.tsx` (`231:3904`) |
| W6 | W6 · Workspace · Sessions parallèles | `231:4011` | 1440 × 1120 | `.design-refs/screens/W6.png` | `W6-selecteur.tsx` (`231:4031`), `W6-menu.tsx` (`231:4159`) |
| W7 | W7 · Workspace · Connexion perdue | `231:4206` | 1440 × 1120 | `.design-refs/screens/W7.png` | `W7-header.tsx` (`231:4209`), `W7-session.tsx` (`231:4237`), `W7-bandeau.tsx` (`231:4370`) |

Parts that are not saved separately are pixel-identical to D05 (same instance names, sizes and positions in the metadata, confirmed on the screenshots). Reuse `.design-refs/code/D05.tsx` for them: the rail in all frames, the context panel in W3, W5, W6 and W7, and the session column under the overlays in W5 and W6.

SVG assets referenced by the saved code are in `.design-refs/assets/states-workspace/<part>/`, one folder per code file. Each folder has a `manifest.json` that maps the code constant (for example `imgIconWifiOff`) to its local file and to the original Figma URL, which expires after 7 days.

---

## 0. Conventions for copy and data

- All UI copy below is verbatim. In code spans, keep every character as written:
  - Apostrophes are straight ASCII `'` everywhere (`d'agir`, `l'instant`, `n'est`). There is no typographic `’` in these frames.
  - The middle dot `·` (U+00B7) separates segments, always with one regular space on each side.
  - The ellipsis is the single character `…` (U+2026): `Écrire une instruction à Claude…`, `Reconnexion…`.
  - Deletions use the minus sign `−` (U+2212), not a hyphen: `+46 −12`, `+152 −12`.
  - The arrow `→` (U+2192) appears in the commit modal. The separator `›` (U+203A) appears in Playwright test names.
  - The raw terminal uses the glyphs `●` U+25CF, `⎿` U+23BF, `✓` U+2713, `✘` U+2718 and `✻` U+273B. W3 uses the bullet `•` U+2022, followed by two spaces.
  - These frames contain no non-breaking or narrow non-breaking spaces. All spaces are U+0020, including in `3,1 s`, `10,9 Go` and `2 600 €`.
  - Several strings contain two consecutive spaces: `Nuera OS  /`, `/ commandes  ·  @ fichiers`, `•  Tableau…`, `Sous-total  2 600 €`, `Test Files  2 passed (2)`. Render them with `white-space: pre` (or `pre-wrap`) or with `&nbsp;`.
  - The copy follows French typography, with a space before `:` and `;` (`Mode : demander avant d'agir`, `pipeline-totals.ts ; je lance`).
- Number and time formats:
  - The decimal separator is a comma: `3,1 s`, `4,1 Ko`, `0,6 Ko`, `10,9 Go`.
  - Durations use `N min` (`7 min`, `18 min`) or `N s` (`4 s`, `12 s`).
  - Clock times are 24 h `HH:MM` (`10:42`, `11:00`).
  - Counts use `X sur N` and `X / N` (`Fichier 1 sur 4`, `2 / 4`, `3 / 5`, `10 / 10 réussis`).
  - Exception: the raw terminal keeps the CLI's own formatting (`(3.1s)` with a dot). Only parsed UI (the Tests panel) uses French formatting.
- **No canvas annotations exist in W1 to W7.** A plugin-API read of every node found no Dev Mode annotations and no annotation text boxes. The only hidden layer is W4's `Panneau contextuel` (`229:3735`). The `Expected …` strings in W2 are test-runner output, not notes. Design intent is carried by:
  - the component descriptions, quoted verbatim in §6;
  - the prototype links, read from Figma reactions in §5;
  - the cross-cutting principles in `docs/figma/overview.md`. Relevant here: no invented cost or token metrics, the Conversation view is only a formatting of the CLI stream, and one session per tmux process and per worktree, resumable with `claude --resume`.

---

## 1. Base Workspace layout (D05), shared by all seven states

The values below come from the design context. In Tailwind fallbacks, `var(--space-3,12px)` means token `--space-3` = 12 px.

```
┌──────┬─────────────────────────────────────────────────────────────────────────────────────┐
│ Rail │ En-tête de session (h 81, full width of the workspace, border-bottom)                 │
│ 72px ├───────────────────────────────────────────────┬─────────────────────────────────────┤
│      │ Session Claude Code (flex 1 → 908 px @1440)   │ Panneau contextuel (460 px, border-l) │
│      │  Barre de vue (h 55)                          │  Navigation locale (h 48, tabs)       │
│      │  Fil de la session (flex 1, scroll, 841 px)   │  Tab content (flex 1, p 16, gap 12)   │
│      │  Saisie (compositeur 720 + persistance)       │  Actions Git (h 91, border-top)       │
└──────┴───────────────────────────────────────────────┴─────────────────────────────────────┘
```

- **Frame**: background `--surface-raised` (#ffffff), horizontal flex.
- **Rail `Dev · Barre latérale repliée`** (instance of `201:893`):
  - Container: width 72, `--near-black` (#141830), padding 20 / 12 / 16 (top, sides, bottom), column gap 8, items centred.
  - Tag `DEV`: background `--accent-on-dark` #a6b9dd, JetBrains Mono Bold 12, tracking 0.96 px, `--near-black` text, padding 2 / 4, radius `--radius-sm` 8. A 16 px spacer follows.
  - Nav links: 48 × 40, radius 8, 20 px icons stroked #A6B9DD. In order:
    1. `Nav/Accueil` (icon/home)
    2. `Nav/Projets` (icon/projets)
    3. `Nav/Sessions` (icon/terminal), **active**: background `--hairline-on-dark` `#ffffff1a`
    4. a 32 × 1 separator in `--hairline-on-dark`
    5. `Nav/Intégrations` (icon/plug)
    6. `Nav/Paramètres` (icon/reglages)
  - Below the links: a flexible spacer, then an `Avatar` (36, radius full, `--accent-pale` background) with initials `NZ` (Outfit SemiBold 13, `--ink`).
  - The labels are not visible. Expose them as `aria-label`, per the component description.
- **En-tête de session**:
  - Container: background `--bg` (#fff), border-bottom 1 `--border` #d9dade, padding 14 / 20 / 14 / 24, row gap 12, items centred.
  - `Identité` (flex 1, column gap 6):
    - `Titre` row, gap 10:
      - `Nuera OS  /`: Outfit Medium 18, `--muted` #645e78, two spaces before the slash.
      - Session title: Outfit SemiBold 18, `--text` #233353.
      - Status `Badge`: padding 4 / 8, radius full, Outfit Medium 12.
    - `Contexte` row, gap 8:
      - Three chips: `--surface-raised` background, 1 px `--border`, radius 8, padding 3 / 8, gap 6, 13 px icon, JetBrains Mono 11. The repo chip (icon/github) uses `--muted` text. The branch chip (icon/git-branch) and the worktree chip (icon/worktree) use `--text`.
      - A meta text, JetBrains Mono 11, `--muted`.
  - `Sélecteur de session`: 1 px `--border`, radius `--radius-md` 12, padding 8 / 12, gap 8. Contents: `Dev · Point de statut` (8 px), label (Outfit Medium 13, `--text`), icon/chevron-down 16.
  - `Bouton compact` Secondaire `Interrompre`, with a stop (square) icon.
  - `Bouton compact` Principal `Commit et push`, with an upload icon.
  - `Bouton icône` 36 × 36 (1 px border, radius 12) with icon/more 18. It opens an overflow menu that is not designed.
  - `Bouton icône` 36 × 36 with icon/panel-right 18, stroked in accent. It toggles the context panel.
- **Barre de vue**:
  - Container: border-bottom, padding 10 / 24, gap 12.
  - Segmented control `Vue`: background `--bg`, 1 px border, radius 12, padding 3, gap 2. Each item has padding 5 / 10, radius 8, gap 6, a 14 px icon and an Outfit 13 label.
    - Active item: `--accent-pale` #dee5f2 background, Outfit SemiBold, `--accent` #4368b1 text and icon.
    - Inactive item: Outfit Medium, `--muted`.
    - Items: `Conversation` (icon/messages) and `Terminal brut` (icon/terminal).
  - Helper text `Même session, deux lectures du flux du CLI.` (Outfit 12, `--muted`, flex 1).
  - Model text `Modèle : défaut du CLI` (JetBrains Mono 11, `--muted`). The app never picks a model; it shows the CLI default.
- **Fil de la session**:
  - Flex 1, column, gap 14, items centred, `justify-content: flex-end`, padding 20 / 32, clipped.
  - The content is a vertical scroll container anchored to the bottom, so the latest event stays visible. In W3, W5, W6 and W7, older items sit above the viewport (negative y in Figma).
  - Feed items are 720 px wide, centred.
- **Saisie**:
  - Container: column, gap 8, padding 12 / 32 / 16 (top, sides, bottom), items centred.
  - `Dev · Compositeur`, width 720: background `--bg`, 1 px border, radius `--radius-lg` 20, padding 12 / 12 / 12 / 16, gap 10.
    - Placeholder: Outfit 14, line height 20, `--muted`.
    - `Barre`: icon/paperclip 18; `Badge` Neutre `Mode : demander avant d'agir`; hint `/ commandes  ·  @ fichiers` (JetBrains Mono 11, `--muted`, two spaces around the dot); `Envoyer` (36 × 36, radius 12, icon/send 18).
    - `Envoyer` uses an `--accent` background when it can send and `--border` #d9dade when it cannot.
  - `Persistance`, width 720, gap 8: `Dev · Point de statut` 8 px, text (Outfit 12, `--muted`, flex 1), and the right hint `Échap · interrompre` (JetBrains Mono 11, `--muted`).
- **Panneau contextuel**:
  - Container: width 460, `--bg`, border-left 1.
  - `Navigation locale`: padding 12 / 16, gap 4, border-bottom. Five `Badge` tabs: the active tab uses tone Accent (`--accent-pale` background, `--accent` text), the others tone Neutre (`--surface-raised` background, `--muted` text). Labels: `Fichiers`, `Modifications` (with ` · N` when N > 0), `Tests`, `Terminal`, `Projet`.
  - Tab content: flex 1, padding 16, gap 12.
  - `Actions Git`: border-top, padding 14 / 16, gap 10.
    - `Branche` row, gap 8: icon/git-branch 16; branch name (JetBrains Mono Medium 12, `--text`); status text (Outfit 12, `--muted`, single line, ellipsis).
    - `Boutons` row, gap 8: Principal `Préparer le commit` (git-commit icon) and Secondaire `Préparer la pull request` (git-pull-request icon).
- **Bouton compact** (`168:6952`), 36 px tall, radius 12, padding 0 14 0 12 (left 12 with icon), gap 6, Outfit Medium 14, 16 px icon:
  - Principal: `--accent` background, `--paper` white text.
  - Secondaire: `--paper` background, 1 px `--border-on-light` #d9dade, `--ink` #233353 text.
  - Discret: transparent background, `--accent` text, no horizontal padding.
  - Disabled: **opacity 0.4** on the button, or on its whole group.
  - The hit area must be 44 px in code (component description).
- **Dev · Point de statut** tones (8 px dot SVG):
  - `Succès` #2f6f4f (`--success`)
  - `En cours` #e0a10f (`en-cours`)
  - `Alerte` #8a6516 (`--warn`)
  - `Neutre` #645e78 (`--muted`)
- **Badge** tones, all with padding 4 / 8, radius full, Outfit Medium 12:

  | Tone | Background | Text |
  |---|---|---|
  | `Accent` | `--accent-pale` | `--accent` |
  | `Neutre` | `--surface-raised` #fff | `--muted` |
  | `Succes` | `--success-pale` #e4f1ea | `--success` |
  | `Alerte` | `--warn-pale` #fbf1dc | `--warn` |

  On a white header, `Neutre` reads as plain grey text with no visible pill (`Prête`, `Reconnexion…`).

### 1.1 Tokens used by these frames (from `get_variable_defs`)

| Token | Value | Token | Value |
|---|---|---|---|
| `--near-black` | #141830 | `--accent` | #4368b1 |
| `--ink` | #233353 | `--accent-pale` | #dee5f2 |
| `--text` | #233353 | `--accent-on-dark` | #a6b9dd |
| `--muted` | #645e78 | `--hairline-on-dark` | #ffffff1a |
| `--border` | #d9dade | `--success` / `success-pale` | #2f6f4f / #e4f1ea |
| `--border-on-light` | #d9dade | `danger` / `danger-pale` | #b4451f / #f8e6de |
| `--bg` | #ffffff | `warn` / `warn-pale` | #8a6516 / #fbf1dc |
| `--surface-raised` | #ffffff | `en-cours` | #e0a10f |
| `--paper` | #ffffff | `--btn-edge` | #141830 |
| `--space-1 … --space-8` | 4, 8, 12, 16, 20, 24, 28, 32 | `--space-10` | 40 (file-tree indent) |
| `--radius-sm/md/lg/xl/full` | 8 / 12 / 20 / 28 / 999 | `Shadow/Float` | drop shadow 0 24 50 −18 `#1418308C` (rgba(20,24,48,.55)) |
| `Text/UI` | Outfit Bold 15 / line-height 1.25 / 0 tracking | | |

**Dark blocks** use the *Dark* mode of the Color collection, the equivalent of `.on-dark`. That mode sets `--bg` #233353, `--text` #ffffff, `--muted` rgba(255,255,255,.62), `--accent` #a6b9dd, and uses `danger-pale` #f8e6de as the error text colour. These blocks are:
- the raw terminal (W2);
- `Dev · Sortie de commande` (W3);
- the `$ npm run test -- crm` command box in the permission card;
- the CLAUDE.md preview (W1);
- the test failure detail (W2).

Fonts are **Outfit** (Regular 400, Medium 500, SemiBold 600, Bold 700) and **JetBrains Mono** (Regular, Medium, Bold).

---

## 2. State matrix: what changes from D05

D05 is the reference column. "=" means identical to D05. "disabled" means opacity 0.4.

| Region | D05 (base) | W1 Nouvelle session | W2 Tâche longue | W3 Session terminée | W4 Diff multi-fichiers | W5 Commit et PR | W6 Sessions parallèles | W7 Connexion perdue |
|---|---|---|---|---|---|---|---|---|
| Title | `Module CRM · pipeline` | `Nouvelle session` | `Tests e2e du devis` | = | = | = | = | = |
| Status badge | Alerte `Autorisation demandée` | Neutre `Prête` | Accent `En cours · 7 min` | Succes `Terminée · 18 min` | Succes `Terminée · 18 min` | Succes `Terminée · 18 min` | = | Neutre `Reconnexion…` |
| Branch / worktree chips | `feature/crm-core` / `worktree crm-core` | `feature/pipeline-export` / `worktree pipeline-export` | `feature/devis-pdf` / `worktree devis-pdf` | = | = | = | = | = |
| Context meta | `tmux · 12 min · vit sur VPS-3` | `pas encore démarrée` | `tmux · 7 min · vit sur VPS-3` | `tmux · terminée à 11:00` | `tmux · terminée à 11:00` | `tmux · terminée à 11:00` | = | = |
| Selector (dot · label) | Alerte · `2 sessions sur ce projet` | Alerte · `3 sessions sur ce projet` | En cours · `2 sessions…` | Succès · `2 sessions…` | Alerte · `2 sessions…` | Alerte · `2 sessions…` | Alerte, **open** (`--accent-pale` background) + popover | Alerte · `2 sessions…` |
| `Interrompre` | enabled | disabled | enabled | disabled | disabled | enabled (Figma copy of D05, see §7) | enabled | disabled |
| `Commit et push` | enabled | disabled | enabled | enabled | enabled | enabled | enabled | disabled |
| Active view | Conversation | Conversation | **Terminal brut** | Conversation | (session column replaced) | Conversation | Conversation | Conversation |
| Thread | conversation + pending permission card | empty state `Session vierge` + 3 suggestions | raw terminal + legend | conversation + resolved permission + output + **end-of-session summary** | — | = D05 (behind veil) | = D05 | = D05 at **opacity 0.5**, with a **banner** above it |
| Composer variant · placeholder | `Attente` · `Répondez d'abord à la demande d'autorisation ci-dessus…`, send off | `Prêt` · `Écrire une instruction à Claude…`, send on | `En cours` · `Ajouter une précision pour Claude, elle sera lue à la fin de l'étape en cours…` + `Interrompre · Échap`, send off | `Prêt` · `Écrire une instruction à Claude…` | — | = D05 | = D05 | `Attente` with placeholder `Saisie suspendue pendant la reconnexion…`, send off |
| Persistence dot · text | Succès · `Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas.` | Succès · `La session démarre au premier envoi et continuera sans ce navigateur.` | = D05 | Neutre · `Conversation enregistrée par Claude Code : reprenable plus tard depuis Sessions.` | — | = | = | Alerte · `Dernier signe du serveur il y a 12 s · la demande d'autorisation attend toujours.` |
| Panel tab | `Modifications · 4` | `Fichiers` (no count on `Modifications`) | `Tests` (`Modifications · 1`) | = | panel **hidden** | = | = | = |
| Git status line | `feature/crm-core` · `2 commits d'avance · 4 fichiers non commités` | `feature/pipeline-export` · `à jour avec main · aucune modification` | `feature/devis-pdf` · `1 fichier modifié · non commité` | = | hidden | = | = | = |
| Git buttons | enabled | disabled (group) | enabled | enabled | hidden | enabled (behind veil) | enabled | enabled |
| Overlay | — | — | — | — | — | veil 55 % + modal | anchored popover | inline banner (not an overlay) |

---

## 3. Per-state specifications

### W1 · Workspace · Nouvelle session (`227:3075`)

**Suggested route**: `/sessions/[sessionId]` with status `ready`.

The rail highlights `Nav/Sessions` in every Workspace frame, so the Workspace lives under Sessions. W1 is reached from three buttons, each of which creates a session and its worktree before navigating:
- D01 `Bouton · Nouvelle session`;
- D04 `Bouton · Ouvrir le Workspace`;
- A3 `Bouton · Démarrer une session`.

**Purpose**: a session record and git worktree exist, but the Claude Code CLI has not run yet.

**Changes from D05**

- **Header**
  - Title `Nouvelle session` is the default session title until the user or the first instruction names it. Status Badge Neutre `Prête`.
  - Chips: `nuera-studio/nuera-os`, `feature/pipeline-export`, `worktree pipeline-export`. Meta: `pas encore démarrée`.
  - Selector: Alerte dot, `3 sessions sur ce projet`. The new session counts, and another session of the project awaits permission.
  - `Interrompre` and `Commit et push` are disabled (opacity 0.4): nothing is running and nothing has changed.
- **Barre de vue**: `Conversation` active.
- **Fil de la session**: the content is centred vertically (`justify-content: center`, no gap) instead of bottom-anchored. It holds the block `Session vierge`:
  - Container: width 560, column, gap 16, centred.
  - `Pastille`: 56 × 56, `--accent-pale`, radius 20, icon/terminal 28 stroked in accent.
  - Title `Claude Code est prêt dans nuera-os`: Outfit SemiBold 22, `--text`. The pattern is `Claude Code est prêt dans {repo name}`.
  - Text `Worktree pipeline-export créé depuis main · CLAUDE.md lu · aucune instruction envoyée pour l'instant.`: Outfit 14, line height 20, `--muted`, centred, wraps on two lines.
  - `Suggestions`: column, gap 8, full width. Each row is 560 × 44: `--bg` background, 1 px border, radius 12, padding 12 / 14, gap 10; a 16 px leading icon in accent; text Outfit 14 `--text`, flex 1; icon/chevron 14 `--muted`. The three rows are:
    1. icon/book: `Explique la structure du module CRM avant d'y toucher`
    2. icon/list-checks: `Lance les tests du projet et résume les échecs`
    3. icon/github: `Reprends l'issue #128 : export CSV du pipeline`
- **Composer**: variant `Prêt`. Placeholder `Écrire une instruction à Claude…`, accent `Envoyer` button.
- **Persistence**: Succès dot, `La session démarre au premier envoi et continuera sans ce navigateur.`, hint `Échap · interrompre`.
- **Context panel, tab `Fichiers`** (Badge Accent). The other tabs are `Modifications` (no count, because there are no changes), `Tests`, `Terminal`, `Projet`. The content is `Explorateur de fichiers` (padding 16, gap 12).
  - `Arborescence`: rows with padding 5 / 8, gap 6, radius 8.
    - Indentation is left padding 8 / 24 / 40 / 56 / 72 px for depths 0 to 4, so +16 per level (`--space-6`, `--space-10`).
    - Folder rows: chevron 12 (`chevron-down` when open, `chevron` when closed), folder icon (`icon/projets`) 15 stroked in accent, name in JetBrains Mono 12 `--text`.
    - File rows: a 12 px empty `Retrait` in place of the chevron, icon/file 15, name, and on the right a size in JetBrains Mono 11 `--muted`.
  - The tree, verbatim:

```
v nuera-os
  > .claude
  v src
    > app
    v modules
      v crm
          PipelineBoard.tsx        4,1 Ko
          Pipeline.module.css      1,2 Ko
          types.ts                 0,6 Ko
      > devis
    CLAUDE.md                      212 lignes   ← selected: --accent-pale background, JetBrains Mono Medium
    package.json                   2,3 Ko
    README.md                      1,8 Ko
```

  - CLAUDE.md shows a line count (`212 lignes`). The other files show a size in `Ko`.
  - `Aperçu · CLAUDE.md`: a card with 1 px border and radius 12 that fills the remaining height.
    - Header: padding 8 / 12, gap 8, border-bottom. File name `CLAUDE.md` (JetBrains Mono Medium 12), Badge Neutre `Lecture seule`, and a Discret `Bouton compact` `Modifier`.
    - Content: dark block (`--bg` #233353), padding 12 / 14, JetBrains Mono 12, line height 19, muted-on-dark. The file text is verbatim (blank lines are zero-width-space paragraphs in Figma):

```
# Nuera OS

CRM et espace client de Nuera Studio.
Next.js 16, TypeScript, Postgres, Drizzle.

## Commandes
- npm run dev    serveur de développement
- npm run test   Vitest
- npm run e2e    Playwright

## Règles
- Commentaires en français, sans tiret cadratin
- Aucune valeur en dur : passer par les tokens
- Un composant monté une fois va dans le layout
```

- **Actions Git**: `feature/pipeline-export` · `à jour avec main · aucune modification`. The `Boutons` group (`Préparer le commit`, `Préparer la pull request`) is disabled at opacity 0.4.

**Data**

- Session: id, title (default `Nouvelle session`), status `ready`, branch, worktree name (= branch suffix), base branch (`main`), `createdFrom: 'main'`, CLAUDE.md present (boolean), linked GitHub issue (#128 matches branch `feature/pipeline-export`).
- Project: name `Nuera OS`, repo slug `nuera-os`, `owner/repo` (`nuera-studio/nuera-os`).
- Project session count: `3`.
- Worktree tree: entries with name, kind, depth, expanded state, `sizeBytes` formatted in Ko with a decimal comma, and the line count for CLAUDE.md.

**Interactions**

- Suggestion row: puts its text in the composer, or sends it directly. The design does not say which; see Q1. In either case the first send starts the CLI in the worktree's tmux session.
- `Envoyer`, or Enter: starts the session. The status becomes `running` and the view becomes W2-like or a streaming conversation.
- `/` opens the slash-command picker and `@` opens the file-mention picker, as the composer hint says. The paperclip attaches files.
- Tree: click a folder to expand or collapse it, click a file to preview it read-only.
- `Modifier`: switches the preview to editing. Not designed here.

**Prototype**: only the rail links are wired. Suggestions and send are not.

### W2 · Workspace · Tâche longue (`227:3523`)

**Suggested route**: `/sessions/[sessionId]?vue=terminal&panneau=tests`. The view and the tab can also be local UI state that persists per session.

**Purpose**: a long-running CLI task, shown in raw terminal view, with live test results parsed in the side panel.

**Changes from D05**

- **Header**
  - Title `Tests e2e du devis`. Badge Accent `En cours · 7 min` shows elapsed time and updates live.
  - Chips: `feature/devis-pdf`, `worktree devis-pdf`. Meta: `tmux · 7 min · vit sur VPS-3`.
  - Selector: dot `En cours` (#e0a10f), `2 sessions sur ce projet`.
  - `Interrompre` and `Commit et push` are enabled.
- **Barre de vue**: `Terminal brut` active. `Conversation` is inactive (Outfit Medium, `--muted`).
- **Fil de la session**: padding 20 / **24**, gap 14, `justify-content: flex-end`.
  - **`Terminal brut · tmux nuera-os-devis-pdf`** (`227:3801`): flex 1 (fills the height, 860 wide), dark `--bg` #233353, radius 12, padding 16 / 20, JetBrains Mono 13, line height 21. The lines are verbatim; the colour column gives the dark-mode token:

```
> Lance la suite e2e du devis et corrige les échecs                    text   (#fff)
                                                                        muted
● Bash(npx playwright test devis)                                       text
  ⎿ Running 24 tests using 4 workers                                    muted (rgba 255,255,255,.62)
    ✓ devis › création d'un devis (3.1s)                                muted
    ✓ devis › ajout d'une ligne (2.4s)                                  muted
    ✓ devis › remise globale (2.0s)                                     muted
    ✘ devis › export PDF (12.0s)                                        danger-pale (#f8e6de)
      Error: expect(received).toContain(expected)                       danger-pale
      Expected substring: "Total"                                       muted
    … 20 autres tests réussis                                           muted
                                                                        muted
● Le PDF n'affiche pas la ligne Total : le gabarit lit total            text
  au lieu de totals.net. Je corrige render.ts.                          text
                                                                        muted
● Read(src/modules/devis/pdf/render.ts)                                 text
● Edit(src/modules/devis/pdf/render.ts)                                 text
  ⎿ 4 lignes ajoutées, 2 supprimées                                     muted
                                                                        muted
● Bash(npx playwright test devis -g "export PDF")                       text
  ⎿ Running 1 test using 1 worker                                       muted
                                                                        muted
✻ En cours… 7 min · Échap pour interrompre                              accent-on-dark (#a6b9dd)
```

  - The layer name gives the tmux session naming convention: `{project-slug}-{worktree}`, here `nuera-os-devis-pdf`. In other frames the context-text layer is named `tmux nuera-os-crm-core · …`.
  - `Légende`, under the terminal, full width, gap 8: icon/terminal 14 `--muted`, then `Flux exact du processus Claude Code, sans mise en forme. Clavier relié au terminal : Échap interrompt, Ctrl+C aussi.` (Outfit 12, `--muted`).
- **Composer**: variant `En cours` (`203:484`).
  - Placeholder: `Ajouter une précision pour Claude, elle sera lue à la fin de l'étape en cours…`
  - The bar adds a Secondaire `Bouton compact` `Interrompre · Échap` (stop icon) before `Envoyer`.
  - `Envoyer` is grey (`--border` background) while the field is empty.
- **Persistence**: Succès dot, `Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas.`, hint `Échap · interrompre`.
- **Context panel, tab `Tests`** (Accent). The other tabs are `Fichiers`, `Modifications · 1`, `Terminal`, `Projet`. The content is `Résultats des tests` (padding 16, gap 12).
  - `Résumé` row, gap 8: `npx playwright test devis` (JetBrains Mono Medium 12, `--text`, flex 1) and Badge Accent `En cours`.
  - `Avancement`, column gap 6:
    - `Compteurs` row, gap 12. Each counter is a baseline row with gap 4: the number in Outfit SemiBold 20, then the label in Outfit 12 `--muted`. Counters: `22` `réussis` (`--success`), `1` `échec` (`danger`), `1` `en cours` (`en-cours`).
    - `Barre`: 8 px tall, radius full, 1 px border, `--surface-raised` background. Segments are proportional to the counts: success 384 px, danger 18 px, en-cours 18 px, and the remainder stays empty. With 24 tests, each test is worth about 17.5 px.
  - `Tests` list: card with 1 px border and radius 12. Rows have padding 8 / 12, gap 10 and a bottom border (except the last). Each row has a 15 px status icon, the name (JetBrains Mono 12 `--text`, ellipsis) and the duration or state (JetBrains Mono 11 `--muted`). The failed row has a `danger-pale` background.

| Icon | Name | Right |
|---|---|---|
| icon/check (success) | `devis › création d'un devis` | `3,1 s` |
| icon/check | `devis › ajout d'une ligne` | `2,4 s` |
| icon/check | `devis › remise globale` | `2,0 s` |
| icon/x (danger) | `devis › export PDF` | `12,0 s` |
| icon/clock (en-cours) | `devis › export PDF (relance)` | `en cours` |
| icon/check | `devis › signature DocuSeal` | `4,8 s` |
| icon/check | `devis › envoi par e-mail` | `3,3 s` |

  - `Détail de l'échec`: dark block, radius 12, padding 10 / 12, JetBrains Mono 11, line height 17, muted-on-dark. Verbatim:

```
export PDF · tests/e2e/devis.spec.ts:84
Expected substring: "Total"
Received: "Sous-total  2 600 €"
```

  - Footnote: `Résultats lus en direct dans la sortie de la commande lancée par Claude, rien n'est simulé.` (Outfit 12, line height 16, `--muted`).
- **Actions Git**: `feature/devis-pdf` · `1 fichier modifié · non commité`. Both buttons are enabled.

**Data**

- Session: `startedAt` (drives `7 min` in three places: the header badge, the context meta and the CLI spinner line), `status: running`, tmux session name, host `VPS-3`.
- Terminal stream: ordered PTY chunks with sequence numbers. ANSI colours are mapped to the dark tokens above.
- Test run, parsed from the command's output:
  - command string;
  - status: `En cours`, or done;
  - counts: `passed 22`, `failed 1`, `running 1`, total 24;
  - tests: name, status `passed | failed | running`, `durationMs` displayed as `3,1 s`. A re-run is a separate row with the suffix ` (relance)`;
  - failure: test title, `file:line`, expected and received.
- Git: 1 modified uncommitted file.

**Interactions and runtime**

- Streaming. The server owns the PTY (the tmux pane of the session) and pushes output to every connected client (WebSocket or SSE).
  - Terminal view renders the raw bytes with an xterm-compatible renderer.
  - Conversation view renders events parsed from the same stream.
  - Switching views never restarts anything; the helper text says "two readings of the same CLI stream".
- Keyboard. When the terminal has focus, keystrokes go to the pane (`tmux send-keys`). `Échap` sends Escape and Ctrl+C sends SIGINT, as the legend says.
- `Interrompre` (header) and `Interrompre · Échap` (composer) both send Escape to the CLI process. Component description of `Dev · Compositeur`: `Saisie envoyée au CLI. En cours, l'envoi passe en file et Interrompre envoie Échap au processus. En attente d'autorisation, la saisie est suspendue.`
- Queued input. While the task runs, sending a message queues it; it is delivered at the end of the current step (see the placeholder). Show the queued message as pending; this state is not designed.
- Elapsed time: a client-side ticker from `startedAt`. Re-render each minute; the format is `N min`. Formats for under a minute and over an hour are not designed (Q4).
- Tests panel: updated live from the command output. The footnote forbids simulated or estimated values. The failure row expands into the dark detail block.
- `Commit et push` stays available during the run. Its target is the W5 modal (from D05's wiring).

**Prototype**: W2 is reached from W6's menu row `Session · Tests e2e du devis`. Inside W2, only the rail is wired.

### W3 · Workspace · Session terminée (`229:3316`)

**Suggested route**: `/sessions/[sessionId]` with status `completed`.

**Purpose**: Claude Code has finished the task. A summary card invites the user to review, commit or continue.

**Changes from D05**

- **Header**
  - Status Badge Succes `Terminée · 18 min`, the total duration.
  - Meta: `tmux · terminée à 11:00`, the end time as `HH:MM`.
  - Selector: Succès dot, `2 sessions sur ce projet`.
  - `Interrompre` is disabled. `Commit et push` is enabled.
- **Fil de la session**: same items as D05 up to the three tool rows; the list is scrolled to the bottom. After them, in order:
  1. `Dev · Demande d'autorisation`, collapsed variant `Autorisée`.
     - Row: `--bg` background, 1 px border, radius 12, padding 8 / 12, gap 10.
     - icon/shield 16 `--muted`, then `Commande autorisée une fois · npm run test -- crm` (JetBrains Mono 12 `--muted`, flex 1), then icon/check 16 in success.
     - Per the component description, once decided the card collapses to one line and stays in the history.
  2. `Dev · Ligne d'outil`: icon/check (success), tool `Bash` (JetBrains Mono Medium 12), target `npm run test -- crm` (JetBrains Mono 12 `--muted`, ellipsis), meta `10 réussis · 3,2 s` (JetBrains Mono 11 `--muted`), icon/chevron 14. Its output is expanded just below.
  3. `Dev · Sortie de commande`: dark block, radius 12, padding 12 / 16, gap 2, JetBrains Mono 12. The first line is white and the next lines are muted with line height 18. Verbatim:

```
$ npm run test -- crm
 ✓ pipeline-totals.test.ts (6 tests) 41 ms
 ✓ PipelineBoard.test.tsx (4 tests) 212 ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

  4. `Dev · Message · Claude`, time `11:00`: `C'est terminé : les dix tests du module passent. Voici ce qui a changé.`
  5. **`Résumé de fin de session`** (`229:3622`):
     - Card: width 720, `--bg` background, **1.5 px border `--success`**, radius 20, padding 16, column gap 12.
     - `En-tête`, gap 10: `Pastille` 28 × 28 (`--success-pale` background, radius 8, icon/check 16 in success); title `Session terminée · 18 min` (Outfit SemiBold 15, `--text`, flex 1); Badge Succes `Prête pour un commit`.
     - Three bullet lines in Outfit 14 `--text` (bullet `•` followed by two spaces):
       - `•  Tableau du pipeline à colonnes glissables (PipelineBoard.tsx)`
       - `•  Total par étape calculé dans pipeline-totals.ts`
       - `•  6 tests unitaires ajoutés · 10 / 10 réussis`
     - Meta line (JetBrains Mono 12, `--muted`): `4 fichiers · +152 −12 · 2 commandes autorisées · aucun commit encore`
     - `Actions`, gap 8:
       - Principal `Préparer le commit` (git-commit icon) → W5
       - Secondaire `Voir le diff` (file-diff icon) → W4
       - Discret `Continuer la conversation`
- **Composer**: variant `Prêt` (`Écrire une instruction à Claude…`, accent send).
- **Persistence**: **Neutre** dot, `Conversation enregistrée par Claude Code : reprenable plus tard depuis Sessions.` The hint `Échap · interrompre` is still shown.
- **Context panel**: identical to D05. Tab `Modifications · 4`, `4 fichiers modifiés` `+152` `−12`, four `Dev · Fichier modifié` rows, unified diff card `PipelineBoard.tsx` · `2 blocs` · Discret `Avant / après`, Git line `feature/crm-core` · `2 commits d'avance · 4 fichiers non commités`, both Git buttons enabled.

**Earlier feed items present in W3** (scrolled out of view at the top, same content as D05):
- `Dev · Message · Instruction`: right-aligned accent bubble 520 wide, radius 20, padding 12 / 16, Outfit 14/20 white text: `Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires. Respecte CLAUDE.md.` Meta (JetBrains Mono 11, `--accent-on-dark`): `Vous · 10:42`.
- Claude `10:42`: `Je lis d'abord les conventions du dépôt et la structure du module CRM.`
- Tools `Read` `CLAUDE.md` `212 lignes` and `Glob` `src/modules/crm/**/*.tsx` `14 fichiers`.
- `Dev · Plan de travail`: card with radius 20 and padding 16. Header icon/list-checks with `Plan de travail` and `3 / 5`. Steps:
  - three done steps, line-through and muted: `Lire CLAUDE.md et la structure du module`, `Créer PipelineBoard.tsx avec colonnes glissables`, `Calculer le total par étape`;
  - the current step with a clock icon and Medium weight: `Écrire les tests de pipeline-totals.ts`;
  - a pending step with a minus icon: `Lancer la suite de tests du module`.
- Claude `10:51`: `Le tableau et le calcul des totaux sont en place. J'ai écrit les tests de pipeline-totals.ts ; je lance maintenant la suite du module pour les vérifier.`
- Tools `Edit` `src/modules/crm/PipelineBoard.tsx` `+46 −12`, `Write` `src/modules/crm/pipeline-totals.ts` `+38`, `Write` `src/modules/crm/__tests__/pipeline-totals.test.ts` `+54`.
- The plan keeps its `3 / 5` snapshot in the history.

**Data**

- Session: `endedAt` (`11:00`), duration (`18 min`), `status: completed`.
- Summary: Claude's change bullets come from the CLI's final message; nothing may be invented. The app computes the meta line from git and the permission log: number of changed files, insertions and deletions, number of authorised commands, and whether a commit exists.
- Permission log: entries (command, decision `once | always | refused`, time).

**Interactions**

- `Préparer le commit` → opens W5 (wired).
- `Voir le diff` → W4 (wired).
- `Continuer la conversation` → focuses the composer. Sending resumes the conversation in the same worktree (`claude --resume` or `--continue`), and the session goes back to `running`.
- The tool-row chevron expands or collapses its output (`Dev · Ligne d'outil` description: `Le chevron déplie sa sortie (Dev · Sortie de commande).`). The Figma chevron is not rotated even when the output is open; see Q9.
- Header `Commit et push` → W5 (same as D05).

### W4 · Workspace · Diff multi-fichiers (`229:3676`)

**Suggested route**: `/sessions/[sessionId]/modifications?fichier=src/modules/crm/PipelineBoard.tsx&bloc=1&affichage=cote-a-cote`

**Purpose**: a full-width, read-only review of all session changes, one file at a time, navigated by hunk ("bloc").

**Changes from D05**

- **Header**: same as W3 (`Terminée · 18 min`, `tmux · terminée à 11:00`, `Interrompre` disabled, `Commit et push` enabled), except the selector dot is **Alerte**.
- **Corps**: the session column and the context panel are replaced by `Revue des modifications` (1368 × 1039, column). The panel `229:3735` is hidden; the `panel-right` toggle has nothing to show in this mode.

**`Barre de revue`**: h 57, `--bg`, border-bottom, padding 10 / 24, gap 12, items centred. Left to right:
- Discret `Bouton compact` `Retour à la session` with icon/arrow-left 16 in accent → W3.
- Title `Modifications · 4 fichiers · +152 −12` (Outfit SemiBold 15, `--text`, flex 1).
- Segmented control `Affichage`, same style as `Vue`: `Unifié` (inactive) and `Côte à côte` (active: `--accent-pale`, SemiBold, accent).
- Position `Fichier 1 sur 4 · bloc 1 sur 2` (JetBrains Mono 11, `--muted`).
- Secondaire `Précédent · K` and Secondaire `Suivant · J`, with no icons.

**`Corps de revue`** (row, flex 1) has two columns: the file list and the diff.

**`Fichiers`** column: width 320, `--bg`, border-right, padding 12, column gap 2.
- Label `4 FICHIERS` (JetBrains Mono 11, `--muted`, tracking 0.88 px).
- Four `Dev · Fichier modifié` rows: padding 6 / 8, gap 8, radius 8. The selected row has an `--accent-pale` background.
- Each row has a 20 × 20 radius-8 status square, a path, then the counts in JetBrains Mono 11 (`+N` in success, `−N` in danger).
  - Status `M` (modified): `warn-pale` background, `warn` text, JetBrains Mono Bold 11.
  - Status `A` (added): `success-pale` background, `success` text.
  - Path: JetBrains Mono 12 `--text`, ellipsis at the end.

| Status | Path shown (verbatim) | + | − |
|---|---|---|---|
| M | `crm/PipelineBoard.tsx` | `+46` | `−12` |
| A | `crm/pipeline-totals.ts` | `+38` | |
| A | `__tests__/pipeline-totals.test.ts` | `+54` | |
| M | `crm/Pipeline.module.css` | `+14` | |

Shown paths are the last two segments. The test path is cut by width: `__tests__/pipeline-totals.test…`.

**`Diff côte à côte · PipelineBoard.tsx`** column: flex 1, padding 16 / 20.
- `En-tête du fichier`: `--surface-raised`, 1 px border, radius 12, padding 8 / 12, gap 8. Full path `src/modules/crm/PipelineBoard.tsx` (JetBrains Mono Medium 12) and `+46 −12` (JetBrains Mono 11 `--muted`).
- `Colonnes`: two equal halves, padding 10 / 12, JetBrains Mono 11 `--muted`, tracking 0.88 px. Labels `AVANT · main` and `APRÈS · feature/crm-core`.
- Hunk header rows: height 24, `--accent-pale` background, left padding 12, JetBrains Mono 12 `--accent`. Texts: `@@ -12,6 +12,8 @@ export function PipelineBoard()` and `@@ -41,4 +44,8 @@`.
- Line rows: height 24, two halves, each flex 1 with a 1 px right border.
  - Each half has a 44 px number column (right-aligned, right padding 10, JetBrains Mono 11 `--muted`) and the code (JetBrains Mono 12 `--text`, `white-space: pre`, ellipsis).
  - A deleted half has a `danger-pale` background. An added half has a `success-pale` background.
  - The blank filler half facing an addition has a `--surface-raised` background and no number.
- Exact rows, numbered left | right (`·` = blank filler):

```
@@ -12,6 +12,8 @@ export function PipelineBoard()
12 |   const stages = useStages(projectId);        || 12 |   const stages = useStages(projectId);
13 |   const deals = useDeals(projectId);          || 13 |   const deals = useDeals(projectId);
14 |   const total = deals.reduce(sum, 0);   [del] || 14 |   const totals = computeStageTotals(deals);  [add]
 · |                                     [filler]  || 15 |   const [dragged, setDragged] = useState(null);  [add]
15 |                                               || 16 |
16 |   return (                                    || 17 |   return (
17 |     <DndContext onDragEnd={moveDeal}>         || 18 |     <DndContext onDragEnd={moveDeal}>
@@ -41,4 +44,8 @@
41 |         <StageColumn                          || 44 |         <StageColumn
42 |           stage={stage}                       || 45 |           stage={stage}
43 |           total={total}                 [del] || 46 |           total={totals[stage.id] ?? 0}  [add]
 · |                                     [filler]  || 47 |           onDragStart={setDragged}  [add]
 · |                                     [filler]  || 48 |           isDragging={dragged?.stage === stage.id}  [add]
44 |         />                                    || 49 |         />
```

- In the screenshot, `===` renders as a ligature; JetBrains Mono ligatures are on.
- `Note` (top padding 16): `Lecture seule. Pour corriger, demandez-le à Claude depuis la session ou modifiez le fichier dans le terminal.` (Outfit 12, `--muted`).

**Data**

- Change set: files with status (`M` / `A`, and presumably `D` / `R`), path, insertions and deletions.
- Per file: base ref label (`main`), head label (branch), and hunks. Each hunk has a header (`@@ -a,b +c,d @@ context`) and lines (`context | del | add`) with old and new numbers. Side-by-side pairing aligns deletions with additions and pads with fillers.
- Totals: `4 fichiers`, `+152`, `−12`.
- Navigation state: current file index and current hunk index (`Fichier 1 sur 4 · bloc 1 sur 2`).

**Interactions and runtime**

- `Suivant · J` and `Précédent · K` (buttons and the J/K keys) step hunk by hunk. They cross file boundaries: after the last hunk of file 1, `Suivant` goes to hunk 1 of file 2. The position text updates, and the active hunk scrolls into view.
- Selecting a file in the list shows its diff and resets to its first hunk.
- `Unifié` / `Côte à côte`: toggles the rendering. Unified reuses the D05 panel style (`Diff · Bloc`, `Diff · Contexte`, `Diff · Suppression`, `Diff · Ajout`). Remember the preference.
- Read-only: no inline editing (see the note). Fixes go through Claude or the terminal.
- `Retour à la session` → W3 (wired).
- The header `Commit et push` stays available. It is the natural next step in flow B (W4 → W5).

### W5 · Workspace · Commit et pull request (`231:3754`)

**Suggested route**: `/sessions/[sessionId]/commit`, a modal over the Workspace. In the Next.js App Router, use an intercepting route `@modal/(.)commit` or a local modal state.

**Purpose**: the user confirms what goes to GitHub: which files, the commit message, and whether to push and open a PR. Nothing leaves the VPS without this confirmation.

**Layers**

- **Backdrop**: the Workspace as in D05. Header as in W3 (`Terminée · 18 min`, `tmux · terminée à 11:00`), but in W5 `Interrompre` is not dimmed; see §7. Thread, composer and panel as in D05.
- **`Voile`** (`231:3903`): covers the **whole viewport (1440 × 1120, rail included)**. `--near-black` #141830 at **opacity 0.55**.
- **`Modale · Préparer le commit`** (`231:3904`):
  - Size 680 × 778. It is **centred in the workspace area to the right of the rail**: x = 72 + (1368 − 680) / 2 = 416, y = (1120 − 778) / 2 = 171.
  - Style: `--bg` background, radius `--radius-xl` **28**, effect `Shadow/Float` (0 24 50 −18 #1418308C), clipped.

| Part | Layout | Content (verbatim) |
|---|---|---|
| `En-tête` | padding 22 / 28 / 18, gap 12, border-bottom | `Titre` (column, gap 4): **`Préparer le commit`** (Outfit SemiBold 22, `--text`). Branch row, gap 6: icon/git-branch 14 + `feature/crm-core → origin · worktree crm-core` (JetBrains Mono 12, `--muted`). `Fermer`: 36 × 36, radius 12, no border, icon/x 18 `--muted`. |
| `Corps` | padding 20 / 28, column gap 18 | see below |
| `Pied` | padding 16 / 28, gap 12, border-top | `Rien n'est envoyé sur GitHub sans cette confirmation.` (Outfit 12 `--muted`, flex 1, wraps on 2 lines), then `Bouton · Annuler` and `Bouton · Committer et ouvrir la PR` |

`Corps`, top to bottom:

1. **`Titre fichiers`** row: `Fichiers inclus · 4 sur 4` (Outfit Medium 13 `--text`, flex 1) and `+152 −12` (JetBrains Mono 12 `--muted`).
2. **`Fichiers`** box (1 px border, radius 12, padding 4 / 8). Four `Fichier inclus` rows, gap 8.
   - `Case` checkbox: 18 × 18, `--accent` background, radius 8, white icon/check 12. All four are checked.
   - `Dev · Fichier modifié` row, full paths:
     - `M` `src/modules/crm/PipelineBoard.tsx` `+46` `−12`
     - `A` `src/modules/crm/pipeline-totals.ts` `+38`
     - `A` `src/modules/crm/__tests__/pipeline-totals.test.ts` `+54`
     - `M` `src/modules/crm/Pipeline.module.css` `+14`
3. **`Champ · Message`**, column gap 6.
   - `Libellé` row, gap 8: `Message de commit` (Outfit Medium 13, flex 1) and Badge Accent `Proposé par Claude, modifiable`.
   - `Champ`, subject line, shown **focused**: height 40, padding 8 / 12, radius 12, **1.5 px `--accent` border**, `--bg` background. Text in JetBrains Mono 14 `--text`: `crm : ajoute le tableau glissable et les totaux par étape`.
   - `Description` body: 1 px border, radius 12, padding 10 / 12, gap 4, JetBrains Mono 12 `--text`. Lines:
     - `- PipelineBoard : colonnes glissables (dnd-kit)`
     - `- pipeline-totals : total par étape, en euros`
     - `- 6 tests unitaires, 10 / 10 réussis`
4. **`Options`** box (1 px border, radius 12). Two rows, each with padding 12 / 16 and gap 12; the first has a bottom border. Each row has a text column (gap 2) and a `Dev · Interrupteur` switch.
   - Text style: title in Outfit Medium 14 `--text`, description in Outfit 12 `--muted`.
   - Switch: 36 × 20, `Actif=Oui`, accent track with white knob on the right.
   - Rows:
     - `Pousser sur origin/feature/crm-core` / `Le push part après le commit, avec l'accès GitHub de l'application.`, switch on.
     - `Ouvrir une pull request vers main` / `Titre et description repris du commit, modifiables sur GitHub.`, switch on.
5. **`Champ · Titre de la PR`**, column gap 6.
   - Label `Titre de la pull request` (Outfit Medium 13).
   - Field: height 40, 1 px border, radius 12, padding 8 / 12. Value in Outfit 14 `--text`: `Pipeline CRM : colonnes glissables et totaux par étape`.

**Footer buttons**: site `Button` component (`7:117`), not `Bouton compact`. Structure:
- wrapper with top padding 3;
- `Edge`: `--btn-edge` #141830 background, bottom padding 3, radius 12. This draws a 3 px "pressed" ledge.
- `Face`: 1.5 px `--btn-edge` border, radius 12, padding 13 / 26, text style `Text/UI` (Outfit Bold 15, line height 1.25).

The two buttons:
- `Annuler`: variant Default, `--paper` face, #141830 text. 110 × 54.
- `Committer et ouvrir la PR`: variant Accent, `--accent` face, white text. 229 × 54.

**Data**

- Commit draft:
  - `branch`, `remote` (`origin`), `worktree`;
  - `files[]` with `{status, path, insertions, deletions, included}`;
  - `subject` and `body`, both proposed by Claude and editable;
  - `push: boolean`;
  - `openPr: boolean`, `prBase` (`main`), `prTitle`.
- Totals recompute from the included files: `Fichiers inclus · N sur M` and `+X −Y`.

**Interactions and runtime**

- Checkboxes: include or exclude a file from the commit (staging selection). Disable the CTA when nothing is selected or the subject is empty.
- `Pousser…` switch off → force `Ouvrir une pull request…` off and disable it, because a PR needs the pushed branch.
- `Ouvrir une pull request…` switch off → hide or disable `Titre de la pull request`.
- The CTA label in Figma covers only the both-on case: `Committer et ouvrir la PR`. Labels for the other combinations are not designed (Q5).
- Confirm. Run server-side in the session's worktree, streaming progress and stopping on the first error:
  1. `git add -- <included paths>`
  2. `git commit -m <subject> -m <body>`
  3. If push: `git push origin feature/crm-core`, using the app's GitHub access (switch description).
  4. If PR: create the PR to `main` through the GitHub API, with title = PR title field and body = commit description.
- Errors use the transverse recoverable-error pattern (T4, in `docs/figma/states-flows.md`). Sensitive-action rules are in T8.
- Prototype after success → **D01 · Accueil**. Its `Dernières modifications` card lists commits and PRs.
- `Annuler`, `Fermer` and Escape close the modal and return to W3 (`Annuler` → W3 is wired). Keep the draft in memory for the session.
- Focus trap inside the modal. The initial focus is the commit subject field, which the design shows focused.

### W6 · Workspace · Sessions parallèles (`231:4011`)

**Suggested route**: `/sessions/[sessionId]`, with the session switcher popover open (UI state).

**Purpose**: several Claude Code sessions run in parallel on the same project, each in its own worktree. The switcher lists them, shows capacity, and creates a new one.

**Changes from D05**

- The only changes are the open selector and the popover. Everything else is D05: badge `Autorisation demandée`, meta `tmux · 12 min · vit sur VPS-3`, the pending permission card, and the `Attente` composer.
- **`Sélecteur de session`** (`231:4031`) in the open state: background **`--accent-pale`** (#dee5f2); 1 px border, Alerte dot, `2 sessions sur ce projet` and chevron unchanged.
- **`Sélecteur ouvert · sessions de Nuera OS`** (`231:4159`):
  - Popover 400 × 277, **right-aligned with the selector** (right edge x 1027) and **6 px below it** (y 63; the selector ends at y 57).
  - Style: `--bg` background, 1 px border, radius 12, padding 8, column gap 4, `Shadow/Float`.
  - Contents, top to bottom:
    1. `En-tête`: padding 8 / 10, gap 8, JetBrains Mono 11 `--muted`. `NUERA OS · 2 SESSIONS ACTIVES` (tracking 0.88 px, flex 1) and `2 / 4`.
    2. `Session · Module CRM · pipeline`, the current session. Row: padding 10, gap 10, radius 8, **`--accent-pale` background**.
       - Alerte dot.
       - Text column, gap 3. First line, gap 6: `Module CRM · pipeline` (Outfit SemiBold 14, `--text`) and `· affichée` (Outfit 12, `--muted`). Second line, gap 6: icon/worktree 13 and `feature/crm-core · worktree crm-core` (JetBrains Mono 11 `--muted`, ellipsis; it shows as `feature/crm-core · worktr…`).
       - Badge Alerte `Autorisation demandée`.
    3. `Session · Tests e2e du devis`, a link row with the same layout and a transparent background.
       - `En cours` dot.
       - Title `Tests e2e du devis`. Worktree line `feature/devis-pdf · worktree devis-pdf`, ellipsised.
       - Badge Accent `En cours · 7 min`.
    4. `Séparateur`: 1 px, `--border`.
    5. `Nouvelle session` row: padding 10, gap 10, radius 8.
       - `Pastille`: 24 × 24, radius full, `--accent-pale` background, icon/plus 14 in accent.
       - Text column, gap 2: `Nouvelle session dans un nouveau worktree` (Outfit Medium 14, `--accent`) and `Créé depuis main · 10,9 Go de mémoire libre` (Outfit 12, `--muted`).
    6. `Note`: padding 4 / 10 / 6, Outfit 12 `--muted`, wraps on 2 lines: `Chaque session a son worktree : passer de l'une à l'autre ne déplace aucun fichier.`

**Data**

- Project: name (uppercase in the header), active session count, **capacity** (`2 / 4`). D01 also shows `2 sessions actives sur 4 possibles`, so 4 is a global or settings limit.
- Each session: title, status (`awaiting_permission`, `running` with elapsed time, …), branch, worktree name, `isCurrent`.
- New session: base branch (`main`) and **free memory on VPS-3** (`10,9 Go`; D01 shows `5,1 / 16 Go` used, so free = total − used).

**Interactions and runtime**

- The selector toggles the popover. Close it on outside click, Escape or selection; the arrow keys move between rows.
- A session row switches the Workspace to that session. The prototype goes to **W2**. Each session has its own worktree and tmux session, so switching changes only what the UI shows (see the note); no files move.
- `Nouvelle session dans un nouveau worktree`:
  - creates a branch, a worktree from `main` and a session record, then opens it in the W1 state (not wired in Figma);
  - should be disabled at capacity (`4 / 4`) or when memory is too low. That state is not designed (Q6).
- Selector dot: a project-level status summary. The likely rule is that the most urgent session wins: Alerte (permission) > En cours > Succès > Neutre. The frames do not apply it consistently (Q3). The label pattern is `{n} sessions sur ce projet`.
- Mobile counterpart: `S4 · Workspace mobile · Changer de session` (a bottom sheet; see `docs/figma/states-mobile-and-extensions.md`).

### W7 · Workspace · Connexion perdue (`231:4206`)

**Suggested route**: `/sessions/[sessionId]` (client connection state; no navigation).

**Purpose**: the browser lost its live connection to the Nuera Dev server. The Claude Code session keeps running on VPS-3. The UI freezes the last known state, blocks actions that need the server, and retries automatically.

**Changes from D05**

- **Header**
  - Status Badge **Neutre `Reconnexion…`** replaces the real session status while offline.
  - Meta `tmux · 12 min · vit sur VPS-3`, as last known. Selector unchanged.
  - **`Interrompre` and `Commit et push` are disabled** (opacity 0.4).
- **`Dev · Bandeau`** (`231:4370`, instance of `203:703`): a new **inline** row between `Barre de vue` and `Fil de la session`. It is not an overlay; it pushes the thread down, and the thread height becomes 781.
  - Container: full width of the session column (908 × 60), `warn-pale` background (#fbf1dc), padding 12 / 16, gap 12, items centred.
  - icon/wifi-off 18, stroked `warn` #8A6516. In Figma it sits in the component's `icon/alert` slot.
  - Text column, gap 2: **`Connexion au serveur perdue · nouvel essai dans 4 s`** (Outfit SemiBold 14, `--text`) and `La session continue sur VPS-3 : rien n'est perdu, le fil se recharge à la reconnexion.` (Outfit 13, `--muted`).
  - Secondaire `Bouton compact` **`Réessayer maintenant`** (no icon).
- **`Fil de la session`**: the D05 content at **opacity 0.5**, as a stale snapshot. The pending `Dev · Demande d'autorisation` card is dimmed with it; its dark command box therefore looks grey.
  - The card's buttons (`Autoriser`, `Toujours pour npm run test`, `Refuser`) must not be actionable while offline.
  - Card copy for reference: `Claude demande à exécuter une commande`, Badge Alerte `En attente`, `$ npm run test -- crm`, `Lance la suite Vitest du module CRM dans le worktree crm-core. Lecture et écriture limitées au dépôt.`, footer `Mode : demander avant d'agir · la réponse est transmise au CLI` (JetBrains Mono 11, `warn`).
- **Composer**: variant `Attente` with an overridden placeholder, **`Saisie suspendue pendant la reconnexion…`**. Send is disabled (`--border` background). The field must be read-only.
- **Persistence**: **Alerte** dot, **`Dernier signe du serveur il y a 12 s · la demande d'autorisation attend toujours.`**, hint `Échap · interrompre`.
- **Context panel**: unchanged from D05 and still drawn enabled (Q8).

**Data**

- Client connection: `state` (`connected | reconnecting`), `lastServerSignalAt` (drives `il y a 12 s`), `nextRetryAt` (drives `nouvel essai dans 4 s`), `attempt`.
- Last known session snapshot: status, thread, pending permission.

**Interactions and runtime (reconnection and retry)**

- Detection: the socket closes, or heartbeats stop.
  - Suggested: a server ping every ~5 s; declare loss after 2 missed pings or on `close`.
  - The persistence line ticks every second from `lastServerSignalAt`.
- Retry: automatic, with exponential back-off and jitter (suggested 1 → 2 → 4 → 8 → 16 s, capped at ~30 s).
  - The banner title counts down `nouvel essai dans {n} s` each second.
  - While an attempt is in flight, the countdown can read "…"; that state is not designed.
- `Réessayer maintenant`: cancels the timer and tries at once, then resets back-off on success.
- While reconnecting, nothing is sent to the server:
  - composer suspended;
  - `Interrompre` and `Commit et push` disabled;
  - the thread is not interactive;
  - Escape does nothing. The `Échap · interrompre` hint is still displayed, but cannot work offline.
- On reconnection:
  1. Resubscribe from the last received sequence id. If the server cannot replay, reload the whole thread (the banner promises `le fil se recharge à la reconnexion`).
  2. Restore the real badge and controls.
  3. Remove the banner.
  4. Restore opacity.
- The pending permission is server-side state, and the CLI is still blocked waiting. After reconnecting, the card becomes actionable again (`la demande d'autorisation attend toujours`).
- W7 is distinct from these transverse states, documented in `docs/figma/states-flows.md`:
  - T5 `Serveur indisponible`: the server itself is down;
  - T6 `Claude Code déconnecté`: the CLI login or auth is lost.
- Not wired in the prototype; W7 is a standalone state.

---

## 4. Session lifecycle implied by W1 to W7 (and D05)

| Session status (server) | Header badge | Context meta | Composer variant | Persistence dot · text | Frame |
|---|---|---|---|---|---|
| `ready` (worktree created, CLI not started) | Neutre `Prête` | `pas encore démarrée` | `Prêt` | Succès · `La session démarre au premier envoi et continuera sans ce navigateur.` | W1 |
| `running` | Accent `En cours · {elapsed}` | `tmux · {elapsed} · vit sur VPS-3` | `En cours` (queue + interrupt) | Succès · `Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas.` | W2 |
| `awaiting_permission` | Alerte `Autorisation demandée` | `tmux · {elapsed} · vit sur VPS-3` | `Attente` (`Répondez d'abord à la demande d'autorisation ci-dessus…`) | Succès · same as running | D05, W6 |
| `completed` | Succes `Terminée · {duration}` | `tmux · terminée à {HH:MM}` | `Prêt` (continue) | Neutre · `Conversation enregistrée par Claude Code : reprenable plus tard depuis Sessions.` | W3, W4, W5 |
| client `reconnecting` (overlays any status) | Neutre `Reconnexion…` | last known | `Attente` + `Saisie suspendue pendant la reconnexion…` | Alerte · `Dernier signe du serveur il y a {s} s · la demande d'autorisation attend toujours.` (second clause only if a permission is pending) | W7 |

Header action availability:
- `Interrompre` is enabled only when there is a running CLI process (`running`, `awaiting_permission`).
- `Commit et push` is enabled when the worktree has changes and the client is connected.
- Git panel buttons are disabled when there are no changes (W1).

Transport, minimum contract:
- The server is the single owner of each session's tmux and PTY.
- Clients subscribe per session and receive:
  - raw output chunks (`seq`, bytes);
  - parsed events (message, tool, plan, permission, output, test run, summary);
  - status changes;
  - git status changes;
  - heartbeats.
- Client commands: `send(text)` (queued while running), `interrupt()` (Escape), `respondPermission(choice)`, `resize(cols, rows)`.

---

## 5. Prototype wiring (read from Figma reactions; all ON_CLICK → NAVIGATE)

| From | Element (node) | → Destination |
|---|---|---|
| D01 · Accueil | `Bouton · Nouvelle session` (`205:503`) | W1 |
| D04 · Détail du projet | `Bouton · Ouvrir le Workspace` (`213:1341`) | W1 |
| A3 · Ajouter un projet · Clonage réussi | `Bouton · Démarrer une session` (`233:5069`) | W1 |
| D05 | `Sélecteur de session` (`214:1486`) | W6 |
| D05 | header `Commit et push` (`214:1497`) | W5 |
| D05 | permission card `Autoriser` (`I214:1624;203:386`) | W3 |
| W3 | `Préparer le commit` (`229:3635`) | W5 |
| W3 | `Voir le diff` (`229:3642`) | W4 |
| W4 | `Retour à la session` (`229:3965`) | W3 |
| W5 | `Bouton · Annuler` (`231:4003`) | W3 |
| W5 | `Bouton · Committer et ouvrir la PR` (`231:4007`) | D01 · Accueil |
| W6 | `Session · Tests e2e du devis` (`231:4180`) | W2 |
| W1 to W7 rail | `Nav/Accueil`, `Nav/Projets`, `Nav/Sessions`, `Nav/Intégrations`, `Nav/Paramètres` | D01, D02, D06, D07, D08 |

Flow starting points on the page:
- `Parcours A · Premier projet`: D02 → A1 → D03 → A2 → A3 → D04 → W1 (steps as drawn in `00 · Navigation et parcours`).
- `Parcours B · Travail quotidien`: D01 → D05 → W3 → W4 → W5 → D01.
- `Parcours C · Mobilité`: starts at S5.
- `Parcours D · Connexion MCP`: starts at D07.

Not wired: W1 suggestions and send, everything in W2 and W7, W4 `Précédent`/`Suivant`, W6 `Nouvelle session…`, the `more` and `panel-right` buttons.

---

## 6. Component descriptions (design intent, verbatim from Figma)

- **Dev · Barre latérale repliée** (`201:893`): `Rail de 72 px pour le Workspace : la navigation globale reste à un clic, la session prend la place. Libellés absents à l'écran, à porter en aria-label.`
- **Dev · Point de statut** (`202:478`): `Pastille de 8 px qui précède un libellé d'état. Ne porte jamais seule l'information : toujours avec un texte.`
- **Bouton compact** (`168:6952`): `Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code.`
- **Dev · Compositeur** (`203:497`; variants `Prêt` `203:467`, `En cours` `203:484`, `Attente` `203:496`): `Saisie envoyée au CLI. En cours, l'envoi passe en file et Interrompre envoie Échap au processus. En attente d'autorisation, la saisie est suspendue.`
- **Dev · Message · Instruction** (`203:318`): `Instruction envoyée à la session Claude Code. Même bulle que les messages sortants de Nuera OS.`
- **Dev · Message · Claude** (`203:329`): `Texte produit par Claude Code dans la session. Rendu lisible de la sortie du CLI ; la vue Terminal montre le flux brut.`
- **Dev · Ligne d'outil** (`203:369`): `Une action de Claude Code (Read, Edit, Write, Bash, Glob…), repliée. Le chevron déplie sa sortie (Dev · Sortie de commande).`
- **Dev · Plan de travail** (`203:455`): `Liste de tâches tenue par Claude Code pendant la session, telle que le CLI l'expose. Rien n'est estimé par Nuera Dev.`
- **Dev · Demande d'autorisation** (`203:423`; variants `En attente` `203:405`, `Autorisée` `203:413`): `Demande de permission du CLI. Trois choix au plus, dans l'ordre du CLI. Une fois tranchée, la carte se replie en une ligne et l'historique la garde.`
- **Dev · Sortie de commande** (`203:373`): `Sortie brute d'une commande, sur le mode Dark de la collection Color (l'équivalent de .on-dark). Texte exact du terminal, jamais reformulé.`
- **Dev · Fichier modifié** (`203:554`; variants `Modifié` `203:541`, `Ajouté` `203:547`): `Entrée de la liste des changements Git. Le chemin long se tronque à la fin, le nom complet reste au survol et dans le diff.`
- **Dev · Champ** (`202:503`): `Champ de saisie et liste déroulante. Fond surface et bordure border, comme le compositeur de Nuera OS ; le champ de recherche de Nuera OS, sans bordure, reste réservé aux barres latérales.`
- **Dev · Interrupteur** (`202:459`; `Actif=Oui` `202:455`): `Même dessin que l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y est réservé à ChatGPT. Zone tactile de 44 px à prévoir autour.`
- **Button** (`7:117`, site button used in the W5 footer): `Bouton du site (src/components/ui/Button). Default sur clair neutre, Accent sur fond clair, On dark dans une section sombre. Couper le burst près d'un bord : ses rayons débordent de 26 px.`
- **Dev · Bandeau** (`203:703`): `Message d'état dans une page : chargement, succès, alerte, erreur récupérable avec son action.`

Icons used in these states:
- From the icon set: terminal, git-branch, worktree, github, chevron, chevron-down, more, panel-right, messages, book, list-checks, file, projets, check, x, clock, minus, shield, paperclip, send, plus, wifi-off, home, plug, reglages.
- In `Bouton compact` icon slots: stop (`Interrompre`), upload (`Commit et push`), git-commit (`Préparer le commit`), git-pull-request (`Préparer la pull request`), file-diff (`Voir le diff`), arrow-left (`Retour à la session`).
- The slot icons are exported as `Icône` SVGs. Their names above are inferred from the render and match the section-04 icon set.

---

## 7. Inconsistencies spotted in Figma and decisions to make

- **Q1 (W1)**: does clicking a suggestion send it immediately, or only fill the composer? Recommendation: fill and focus, and let the user send. This is safer under `demander avant d'agir`.
- **Q2 (W1)**: how are suggestions produced? They look like a mix of fixed templates (structure, tests) and a linked GitHub issue (`#128` ↔ branch `feature/pipeline-export`). When is the session title (`Nouvelle session`) replaced, and by what (user input, the first instruction, or the issue title)?
- **Q3 (selector dot)**: the aggregate tone differs between frames for the same two sessions. W3 shows Succès, W4 shows Alerte, W2 shows En cours. Proposed rule: most urgent wins (Alerte > En cours > Succès > Neutre).
- **Q4 (time formats)**: only `N min`, `N s` and `HH:MM` are designed. Formats are needed for under a minute, over 60 min (for example `1 h 05`), and an end time on another day.
- **Q5 (W5 CTA)**: labels when the PR or push switch is off are not designed. Suggestions: `Committer et pousser` and `Committer`. Also, the switch says `Titre et description repris du commit`, but the PR title field (`Pipeline CRM : colonnes glissables et totaux par étape`) differs from the commit subject. Decide whether the PR title is prefilled from the commit or proposed separately.
- **Q6 (W6)**: there is no disabled or capacity-reached state for `Nouvelle session dans un nouveau worktree` (`4 / 4`, or low memory).
- **Q7 (W5 backdrop)**: W5's backdrop mixes W3's header (`Terminée · 18 min`) with D05's thread (pending permission, `Attente` composer) and an enabled `Interrompre`. Render the modal over the real current state, normally W3.
- **Q8 (W7 panel)**: the context panel stays fully enabled while offline (`Préparer le commit`, `Préparer la pull request`). Recommendation: disable server-dependent actions too, as the header does.
- **Q9 (W3)**: the tool row chevron does not change when its output is expanded. Rotate it 90° when open for clarity, or keep it as in Figma.
- **Q10 (W4)**: the diff base label is `AVANT · main`, but the reviewed set equals the uncommitted changes (4 files, `+152 −12`, the same set as the commit modal), while the branch is `2 commits d'avance`. Decide whether the diff is working tree vs `HEAD` (what gets committed) or vs the merge-base with `main` (everything on the branch). Label the base accordingly.
- **Q11 (W3)**: the hint `Échap · interrompre` is still shown when nothing is running (W3, and W7 offline). Keep it as in Figma, or hide it when there is no process.
- **Q12 (W2)**: the Tests list shows 7 rows for 24 tests (the terminal says `… 20 autres tests réussis`). Decide whether the panel lists all tests in a scroll or only notable ones (failed and running first).
- **Q13 (commit message source)**: `Proposé par Claude, modifiable`. Under the principle of no private chat API, the proposal has to come from the CLI itself, for example an instruction sent in the session or a headless `claude -p` run in the worktree. To confirm.
- Demo data is not consistent across frames: D01 shows `Module CRM · pipeline` as En cours and `Tests e2e du devis` as awaiting permission, while W6 shows the reverse. Build from the data model, not from frame copy.

---

## 8. Mobile notes

These seven frames are desktop only (1440). Their phone counterparts are in section 03, row S, documented in `docs/figma/states-mobile-and-extensions.md`:

| Desktop | Phone |
|---|---|
| D05 / W2 typing | `S1 · Workspace mobile · Clavier ouvert` |
| W4 | `S2 · Workspace mobile · Onglet Diff` |
| W5 | `S3 · Workspace mobile · Onglet Git` |
| W6 | `S4 · Workspace mobile · Changer de session` (sheet) |
| permission | `S5 · Mobile · Notification d'autorisation` |

On the phone, the tab bar disappears in the Workspace, as noted in `00 · Navigation et parcours`. Patterns to carry over:
- the W7 banner, inline at the top of the thread;
- the dimmed, read-only thread while reconnecting;
- 44 px hit areas for compact buttons and switches (component descriptions).

---

## 9. Files produced by this extraction

- Spec: `docs/figma/states-workspace.md` (this file).
- Screenshots (1440 × 1120): `.design-refs/screens/W1.png` … `W7.png`.
- Raw design context: `.design-refs/code/W1.tsx`, `W2.tsx`, `W3-header.tsx`, `W3-session.tsx`, `W4-header.tsx`, `W4-revue.tsx`, `W5-header.tsx`, `W5-voile.tsx`, `W5-modale.tsx`, `W6-selecteur.tsx`, `W6-menu.tsx`, `W7-header.tsx`, `W7-session.tsx`, `W7-bandeau.tsx`.
  - Each file starts with a header comment giving the node id, and ends with the Figma component descriptions in a comment block.
- Assets: `.design-refs/assets/states-workspace/<same names>/*.svg` with a `manifest.json` per folder (constant → file → original URL).
