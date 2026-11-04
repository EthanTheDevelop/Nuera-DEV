# Nuera Dev — Desktop screens B (D05 → D08)

Figma file `nlvRWAtD1x2fKf8gVgcM0g`, page **NUERA DEV — WEB APP** (`199:3`), section **01 — Desktop Screens** (`199:5`).
This document covers:

| Code | Frame name | Node | Size | Suggested route |
|---|---|---|---|---|
| D05 | `D05 · Workspace Claude Code` | `214:1424` | 1440 × 1120 | `/sessions/[sessionId]` (Workspace, rail layout) |
| D06 | `D06 · Sessions` | `215:1792` | 1440 × 1120 | `/sessions` |
| D07 | `D07 · Intégrations` | `216:2035` | 1440 × 1120 | `/integrations` |
| D08 | `D08 · Paramètres` | `217:2179` | 1440 × 1157 | `/parametres` |

Reference material written next to this file:

- Screenshots (1×, 1440 wide): `.design-refs/screens/D05.png`, `D06.png`, `D07.png`, `D08.png`.
- Raw `get_design_context` code (React + Tailwind reference, NOT production code): `.design-refs/code/D05.tsx` (complete frame), `D06.tsx`, `D07.tsx`, `D08.tsx` (see "Raw code files" at the end for exact status).
- Assets: `.design-refs/assets/<uuid>.svg`. Every URL `https://www.figma.com/api/mcp/asset/<uuid>.svg` that appears in a raw code file was downloaded to `.design-refs/assets/<uuid>.svg` (same file name). A TSV manifest (`const name → file → size → colours → layer`) is in `.design-refs/assets/manifest-D05-D08.tsv`.
- Workspace states referenced below (W1–W7, T6–T8) live in section **03 — UI States & Flows** (`199:7`) and are documented in depth elsewhere; this file only summarises what is needed to understand the D05 panels.

---

## 0. Conventions shared by D05–D08

### 0.1 Copy rules (verified on the raw export)

- All UI copy is French and must be reproduced **verbatim**.
- Apostrophes are **straight ASCII `'`** (no U+2019 anywhere in D05–D08, including layer names).
- Spaces are **regular U+0020** everywhere, including before `:`, `;`, `%`, `?`, `»` and after `«` (no NBSP/narrow NBSP found in D05–D08). Example: `Mémoire libre : 10,9 Go sur 16 · processeur 23 %`.
- Separator is the **middle dot `·` (U+00B7)**, always surrounded by single spaces (` · `). Three strings use **double spaces** and must be rendered with `white-space: pre` / `pre-wrap`: `Nuera OS  /` (D05 title), `/ commandes  ·  @ fichiers` (composer) and `CPU 23 %  ·  RAM 5,1 / 16 Go` (sidebar).
- Deletions use the **minus sign `−` (U+2212)**, not a hyphen: `+46 −12`, `−12`, diff sign `−`.
- Ellipsis is the single character **`…` (U+2026)**: `Rechercher…`, `Examiner…`, `Répondez d'abord … ci-dessus…`.
- Guillemets `« … »` are used in `hier 10:51 · « toujours autoriser » npm run test · Nuera OS`.
- Number formatting is French: decimal comma (`10,9 Go`, `99,95 %`, `4,1 Ko`, `3,1 s`), space before unit (`23 %`, `2,4 Go`), durations `48 min`, `1 h 12`, `2 h 40`, `1 h 05`, times `10:42`, dates `lun. 2 nov. 21:05`, `28 oct. 09:40`, relative `il y a 6 min`, `il y a 2 h`, `il y a 18 j`, `hier 18:04`, `maintenant`.
- Several Figma **layer names are stale** and differ from the rendered text (e.g. `214:1526` is named "La vue Conversation met en forme…" but renders `Même session, deux lectures du flux du CLI.`; `214:1485` is named "tmux nuera-os-crm-core · démarrée il y a 12 min" but renders `tmux · 12 min · vit sur VPS-3`; overlines are named "Sur-titre"). **Always use the rendered text quoted in this document**, never layer names.

### 0.2 Tokens used on these four screens

Variable names are literally `var(--name)` in Figma (some semantic ones have no `--` prefix in the variable list but are used as `var(--name)` in code).

| Token | Light value | Used for |
|---|---|---|
| `--near-black` | `#141830` | sidebar / rail background, DEV pill text |
| `--btn-edge` | `#141830` | site `Button` edge, border and Default label |
| `--ink` | `#233353` | button labels (Secondaire), avatar initials, tile titles |
| `--text` | `#233353` | primary text |
| `--muted` | `#645e78` | secondary text, meta, mono captions |
| `--accent` | `#4368b1` | primary actions, active tabs/segments, links |
| `--accent-pale` | `#dee5f2` | active segment/tab bg, icon pastilles, selected rows, diff hunk rows |
| `--accent-on-dark` | `#a6b9dd` | sidebar labels & icons, DEV pill bg, meta inside accent bubble |
| `--paper` | `#ffffff` | Secondaire button bg, text on accent |
| `--bg` | `#ffffff` | cards, panels, fields |
| `--surface-raised` | `#ffffff` | page background (frame fill), inner info boxes, Neutre badge bg |
| `--surface-raised-dark` | `#ffffff0d` (white 5 %) | sidebar search, server card, user card |
| `--hairline-on-dark` | `#ffffff1a` (white 10 %) | active sidebar item bg, rail separator |
| `--border` | `#d9dade` | 1 px borders, dividers, disabled send button bg |
| `--border-on-light` | `#d9dade` | Secondaire compact button border |
| `--success` / `--success-pale` | `#2f6f4f` / `#e4f1ea` | additions, success badges, "Ajouté" file status, uptime bars |
| `--success-on-dark` | `#5fc48b` | status dots on the dark sidebar |
| `--warn` / `--warn-pale` | `#8a6516` / `#fbf1dc` | permission card, "Modifié" file status, alerts |
| `--danger` / `--danger-pale` | `#b4451f` / `#f8e6de` | deletions, errors, expired auth |
| `--en-cours` | `#e0a10f` | "in progress" icon/dot/counters |

**Dark mode of the Color collection** (equivalent of an `.on-dark` scope) is applied to every terminal-like block (permission command, raw terminal, command output, file preview, test failure detail). Inside that scope the same variable names resolve to: `--bg #233353`, `--text #ffffff`, `--muted rgba(255,255,255,0.62)`, `--accent #a6b9dd`, `--danger-pale #f8e6de` (used as text colour for failures). Implement as a CSS class that redefines the tokens, not as hard-coded colours.

Spacing: `--space-1 4`, `--space-2 8`, `--space-3 12`, `--space-4 16`, `--space-5 20`, `--space-6 24`, `--space-7 28`, `--space-8 32` (px). Odd values used directly in Figma: 2, 3, 5, 6, 10, 14 px.
Radii: `--radius-sm 8`, `--radius-md 12`, `--radius-lg 20`, `--radius-xl 28`, `--radius-full 999`. Gauge slots use radius 5, uptime bars radius 2.
Effects: **Shadow/Soft** = `0 14px 34px -22px rgba(20,24,48,0.28)` (`#14183047`), used on every "tile". **Shadow/Float** = `0 24px 50px -18px rgba(20,24,48,0.55)` (`#1418308C`), used on popovers and confirmation dialogs.
Type: **Outfit** (Regular 400, Medium 500, SemiBold 600, Bold 700) for UI; **JetBrains Mono** (Regular 400, Medium 500, Bold 700) for code, paths, meta, overlines. Line-height is `normal` unless stated. Style **Text/UI** = Outfit Bold 15 / 1.25 (site Button label). Figma renders JetBrains Mono with ligatures (`===`, `??` appear as ligatures in the diff).

### 0.3 Recurring text styles (names are this document's, not Figma styles)

| Name | Spec |
|---|---|
| Page title | Outfit SemiBold 28, `--text` |
| Page subtitle | Outfit Regular 14, `--muted` (4 px under the title) |
| Overline | JetBrains Mono Regular 11, `--muted`, letter-spacing 0.88 px, uppercase copy |
| Tile title | Outfit SemiBold 14, `--ink` (inside `En-tête de tuile`) |
| Row title | Outfit Medium 14, `--text` |
| Row caption | Outfit Regular 12 / 16, `--muted` |
| Mono meta | JetBrains Mono Regular 11, `--muted` |

### 0.4 Shared components used on these screens

| Component (Figma) | Variants | Spec summary | Designer note (verbatim) |
|---|---|---|---|
| `Dev · Barre latérale` (`201:732`) | `Actif=Accueil/Projets/Sessions/Intégrations/Paramètres` | 248 px, see 0.5 | « Navigation globale de Nuera Dev au bureau. Dérivée de la Barre latérale de Nuera OS (mêmes jetons, mêmes entrées). Ajoute la carte État du serveur. Le Workspace utilise la version repliée. » |
| `Dev · Barre latérale repliée` (`201:893`) | same 5 | 72 px rail, see 1.3 | « Rail de 72 px pour le Workspace : la navigation globale reste à un clic, la session prend la place. Libellés absents à l'écran, à porter en aria-label. » |
| `Bouton compact` (`168:6952`) | Principal / Secondaire / Discret | h 36, `pl 12 pr 14`, gap 6, radius md 12, label Outfit Medium 14, optional 16 px icon on the left. **Principal**: bg `--accent`, label `--paper`. **Secondaire**: bg `--paper`, 1 px `--border-on-light`, label `--ink`. **Discret**: no bg/border, no horizontal padding, label `--accent` (icon `--accent`) | « Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code. » |
| `Button` (site, `7:117`) | Default / Accent / On dark × Rest / Hover / Pressed | 3-layer "edge" button, 54 px tall incl. 3 px top offset: wrapper `pt 3`; **Edge** bg `--btn-edge`, radius md 12, `pb 3`; **Face** 1.5 px `--btn-edge` border, radius md 12, `px 26 py 13`; label Text/UI. Accent: face `--accent`, label `--paper`. Default: face `--paper`, label `--btn-edge` | « Bouton du site (src/components/ui/Button). Default sur clair neutre, Accent sur fond clair, On dark dans une section sombre. Couper le burst près d'un bord : ses rayons débordent de 26 px. » |
| `Badge` (DS, `57:112…57:121`) | Ton = Accent / Succes / Alerte / Danger / Neutre | `px 8 py 4`, radius full, Outfit Medium 12. Accent `--accent-pale`/`--accent`; Succes `--success-pale`/`--success`; Alerte `--warn-pale`/`--warn`; Danger `--danger-pale`/`--danger`; Neutre `--surface-raised`/`--muted` (looks like plain text on white) | — |
| `Dev · Point de statut` (`202:478`) | Ton = Succès / En cours / Alerte / Danger / Neutre / Accent | 8 × 8 dot (SVG) | « Pastille de 8 px qui précède un libellé d'état. Ne porte jamais seule l'information : toujours avec un texte. » |
| `Dev · Champ` (`202:503`) | État = Repos / Focus / Erreur | h 40, bg `--bg`, 1 px `--border`, radius md 12, `px 12 py 8`, gap 8, value Outfit Regular 14 (`--text`, placeholder `--muted`), leading 16 px icon (search) or trailing 16 px chevron (dropdown = "Liste déroulante") | « Champ de saisie et liste déroulante. Fond surface et bordure border, comme le compositeur de Nuera OS ; le champ de recherche de Nuera OS, sans bordure, reste réservé aux barres latérales. » |
| `Dev · Interrupteur` (`202:459`) | Actif = Oui / Non | 36 × 20 SVG, accent when on | « Même dessin que l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y est réservé à ChatGPT. Zone tactile de 44 px à prévoir autour. » |
| `En-tête de tuile` (DS) | — | h 28, gap 8: **Pastille** 28 × 28 bg `--accent-pale` radius sm 8 with a 16 px accent icon + tile title | — |
| `Avatar` (DS, `57:125`) | — | 36 × 36 circle `--accent-pale`, initials Outfit SemiBold 13 `--ink` | — |

**Tile** (Nuera OS card) = bg `--bg`, radius xl 28, Shadow/Soft, padding 20 (24 for the big GitHub card). **Featured tile** adds a 1.5 px `--accent` border (D07 GitHub, D08 Claude Code). **Add tile** = no fill, 1 px **dashed** `--border`, radius xl 28, centred content. **Info box** = bg `--surface-raised`, 1 px `--border`, radius md 12.

### 0.5 Expanded sidebar `Dev · Barre latérale` (D06, D07, D08)

248 × full height, bg `--near-black`, column, gap 16, `pt 20 pb 16 px 16`.

1. **Logo** (`pl 8`): `Logo Nuera Dev · papier` = Nuera wordmark (136 × 27.6, white, SVG made of `imgVector` + masked `imgGroup1`) + **DEV** pill (bg `--accent-on-dark`, radius sm 8, `px 4 py 2`, JetBrains Mono Bold 12, `--near-black`, letter-spacing 0.96 px). Note: « Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction que la pastille OS de Nuera OS). »
2. **Recherche**: bg `--surface-raised-dark`, radius sm 8, `px 12 py 8`, gap 8: `icon/search` 16 · `Rechercher…` (Outfit Regular 13, `--accent-on-dark`, flex 1) · `⌘K` (JetBrains Mono Medium 11, `--accent-on-dark`). Opens global search (⌘K / Ctrl+K).
3. **Navigation** (gap 16), two groups, each with an overline-like label (JetBrains Mono Medium 10, `--accent-on-dark`, **opacity 60 %**, `pl 12 pb 8`):
   - `ESPACE`: `Accueil` (`icon/home`), `Projets` (`icon/projets` = folder), `Sessions` (`icon/terminal`) + count pill `2` (bg `--accent`, radius full, `px 4 py 1`, Outfit SemiBold 11 `--paper`).
   - `CONFIGURATION`: `Intégrations` (`icon/plug`), `Paramètres` (`icon/reglages` = sliders).
   - Item: `px 12 py 8`, gap 12, radius sm 8, icon 18 (`--accent-on-dark`), label Outfit Medium 14 `--accent-on-dark`. **Active**: bg `--hairline-on-dark`, label Outfit SemiBold 14 `--paper`, icon white. Inactive items are links.
4. Flexible spacer.
5. **État du serveur** card: bg `--surface-raised-dark`, radius md 12, p 12, gap 8:
   - dot (8 px, `--success-on-dark`) + `VPS-3 · OVH Gravelines` (Outfit SemiBold 13, `--paper`)
   - `CPU 23 %  ·  RAM 5,1 / 16 Go` (JetBrains Mono 11, `--accent-on-dark`, pre-whitespace)
   - dot + `Claude Code connecté` (Outfit Regular 12, `--accent-on-dark`)
6. **Utilisateur** card: bg `--surface-raised-dark`, radius md 12, p 8, gap 8: Avatar `NZ` + `Nezar` (Outfit SemiBold 13 `--paper`) / `Propriétaire · double facteur actif` (Outfit Regular 11 `--accent-on-dark`).

Data: active sessions count, server name + host, CPU %, RAM used/total (Go), Claude Code connection state, user display name, role, 2FA state. Live values (poll/stream).

### 0.6 Content area template (D06, D07, D08)

`Contenu` = flex 1 (1192 px at 1440), column, `px 32 py 28`, gap 24 (D06, D07) or 20 (D08), clipped (page scrolls). Header row (`En-tête`, gap 12, items centred): title block (flex 1, gap 4: page title + subtitle) + optional site `Button` Accent on the right (top offset 1.5 px).

---

## 1. D05 — Workspace Claude Code (`214:1424`)

The most important screen: one live Claude Code CLI session (a tmux process on VPS-3, in its own git worktree), read as a formatted conversation or as the raw terminal, with the git changes of its worktree side by side. The frame shows the session **waiting for a permission** (prototype flow B step "D05 Autorisation").

Cover annotation (verbatim, `241:5980`): « Ouvert depuis un projet ou une session, jamais depuis la navigation. Au bureau, la barre se replie en rail ; au téléphone, la barre d'onglets disparaît. »

### 1.1 Layout skeleton (1440 × 1120)

```
┌────┬──────────────────────────────────────────────────────────────────────────────┐
│Rail│ En-tête de session  (h 81, full width 1368, border-bottom)                   │
│ 72 ├──────────────────────────────────────────────┬───────────────────────────────┤
│    │ Session Claude Code  (flex 1 → 908)          │ Panneau contextuel (w 460,    │
│    │ ┌ Barre de vue (h 55, border-bottom) ──────┐ │  border-left)                 │
│    │ ├ Fil de la session (flex 1 → 841)          │ │ Navigation locale (h 48)     │
│    │ │   column 720 centred, bottom-anchored     │ │ Modifications (flex 1 → 900) │
│    │ │   scrolls; px 32 py 20 gap 14             │ │   résumé / fichiers / diff   │
│    │ ├ Saisie (h 143): compositeur 720 + ligne   │ │ Actions Git (h 91, pinned)   │
│    │ └   de persistance                           │ │                              │
└────┴──────────────────────────────────────────────┴───────────────────────────────┘
```

- Root: row, bg `--surface-raised`.
- `Espace de travail` (`214:1456`): flex 1, column, full height, clipped.
- `Corps` (`214:1513`): row, flex 1 (1039 px), clipped. Session column = `flex: 1` (min-width 0); context panel = **fixed 460 px** (1 px left border included).
- Fixed regions: header, view bar, composer area (bottom), panel tabs, Git actions. Scrolling regions: the thread (independent scroll, newest at the bottom), the panel body / diff box.
- The thread column (720) and composer (720) are centred in the session column (94 px side margins at 1440). In the library the same components default to 680 wide; instances are stretched to 720.

### 1.2 Session header / toolbar — `En-tête de session` (`214:1457`)

1368 × 81, bg `--bg`, 1 px bottom border `--border`, row, gap 12, items centred, `pl 24 pr 20 py 14`.

1. **Identité** (flex 1, column, gap 6, clipped; 722 wide here)
   - **Titre** (row, gap 10, centred, h 23):
     - `Nuera OS  /` — Outfit Medium 18, `--muted`, `white-space: pre` (two spaces before the slash). Project name; acts as breadcrumb back to the project (assumption: link to project detail D04).
     - `Module CRM · pipeline` — Outfit SemiBold 18, `--text`. Session title.
     - Badge **Alerte** `Autorisation demandée` (session status; see 1.10 for other statuses).
   - **Contexte** (row, gap 8, h 23): three **chips** + a process line. Chip = bg `--surface-raised`, 1 px `--border`, radius sm 8, `px 8 py 3`, gap 6, 13 px icon, text JetBrains Mono Regular 11.
     - `icon/github` + `nuera-studio/nuera-os` (text `--muted`) — GitHub repo `owner/name`.
     - `icon/git-branch` + `feature/crm-core` (text `--text`) — checked-out branch.
     - `icon/worktree` + `worktree crm-core` (text `--text`) — worktree name.
     - `tmux · 12 min · vit sur VPS-3` (JetBrains Mono 11, `--muted`) — **process status**: runtime (tmux), age of the session, host. ("vit sur" = lives on.)
2. **Sélecteur de session** (`214:1486`, prototype hotspot): 197 × 34, 1 px `--border`, radius md 12, `px 12 py 8`, gap 8: `Dev · Point de statut` (Ton=Alerte, the most urgent status among the project's sessions) + `2 sessions sur ce projet` (Outfit Medium 13, `--text`) + `icon/chevron-down` 16 (`--muted`). Opens the session switcher popover (state **W6**, see 1.9.6).
3. **Interrompre** — `Bouton compact` Secondaire with `icon/stop` (16, `--ink`). Sends **Échap** to the CLI process (interrupts the current step; does not kill the session). Keyboard: `Échap`.
4. **Commit et push** (`214:1497`, prototype hotspot) — `Bouton compact` **Principal** with `icon/upload` (white). Opens the "Préparer le commit" modal (state **W5**, see 1.9.5); nothing is pushed without that confirmation.
5. **Bouton icône** `icon/more` — 36 × 36, 1 px `--border`, radius md 12, icon 18 `--ink`. Overflow menu (not designed). The T8 confirmation « Arrêter « Module CRM · pipeline » ? » implies an **Arrêter la session** action is reachable from here (assumption).
6. **Bouton icône** `icon/panel-right` — same box; icon is **`--accent`** = panel currently shown (toggle pressed). Toggles the context panel (in W4 the panel is hidden and the session/review area takes the full width).

Header positions at 1440: Identité x 24 → 746; selector x 758; Interrompre x 967 (127 w); Commit et push x 1106 (146 w); more x 1264; panel x 1312.

### 1.3 Rail — `Dev · Barre latérale repliée`, variant `Actif=Sessions` (`214:1425`)

72 × 1120, bg `--near-black`, column, items centred, gap 8, `pt 20 pb 16 px 12`.
- `DEV` pill (same as logo pill: bg `--accent-on-dark`, radius sm 8, `px 4 py 2`, JetBrains Mono Bold 12, `--near-black`, tracking 0.96 px).
- 16 px spacer.
- Nav buttons 48 × 40, radius sm 8, icon 20 (`--accent-on-dark`): `Nav/Accueil` (`icon/home`), `Nav/Projets` (`icon/projets`), `Nav/Sessions` (`icon/terminal`, **active**: bg `--hairline-on-dark`, icon white), separator 32 × 1 px `--hairline-on-dark`, `Nav/Intégrations` (`icon/plug`), `Nav/Paramètres` (`icon/reglages`).
- Flexible spacer, then Avatar `NZ` (36).
- All five are links (prototype hotspots). No visible labels: provide `aria-label` = `Accueil`, `Projets`, `Sessions`, `Intégrations`, `Paramètres` (and tooltips recommended).

### 1.4 View bar and the Conversation / Terminal brut toggle — `Barre de vue` (`214:1515`)

908 × 55, 1 px bottom border, row, gap 12, items centred, `px 24 py 10`.

- **Vue** segmented control (`214:1516`), 247 × 34: bg `--bg`, 1 px `--border`, radius md 12, padding 3, gap 2. Two segments, each `px 10 py 5`, radius sm 8, gap 6, icon 14 + label 13:
  - **Active** segment (here `Vue · Conversation`): bg `--accent-pale`, `icon/messages` in `--accent`, label `Conversation` Outfit **SemiBold** 13 `--accent`.
  - **Inactive** segment (here `Vue · Terminal brut`): transparent, `icon/terminal` in `--muted`, label `Terminal brut` Outfit **Medium** 13 `--muted`.
  - Implement as a 2-option `radiogroup`/tabs (keyboard arrows), persisted per session (e.g. `?vue=terminal`).
- Helper text (flex 1): `Même session, deux lectures du flux du CLI.` (Outfit Regular 12, `--muted`).
- Right: `Modèle : défaut du CLI` (JetBrains Mono 11, `--muted`) — model used by the session, as reported by the CLI.

**What the toggle switches** (both views read the same CLI stream; composer stays identical underneath):
- **Conversation** (D05): formatted thread (1.5).
- **Terminal brut** (state W2, `227:3554`): the thread area becomes one dark terminal panel (Dark-mode tokens: bg `#233353`, radius md 12, `px 20 py 16`, JetBrains Mono Regular 13 / 21) filling the column; the thread container padding becomes `px 24 py 20`, gap 14. Below it a legend line: `icon/terminal` 14 + `Flux exact du processus Claude Code, sans mise en forme. Clavier relié au terminal : Échap interrompt, Ctrl+C aussi.` (Outfit Regular 12, `--muted`). Line colours of the raw stream: prompts/tool calls/assistant text in `--text` (white), tool results `⎿ …` and test lines in `--muted` (62 % white), failures in `--danger-pale`, the CLI spinner/status line (`✻ En cours… 7 min · Échap pour interrompre`) in `--accent` (#a6b9dd). This is the real PTY stream (render with a terminal emulator themed with these tokens; keyboard input goes to the PTY).
- Cover note « À VALIDER TECHNIQUEMENT » (verbatim): « Rendu Conversation : lire la sortie du CLI dans un format exploitable (mode non interactif, sortie structurée) tout en gardant la session interactive. Repli : la vue Terminal brut seule. » → if structured parsing is not possible, ship Terminal brut only.

### 1.5 Conversation thread — `Fil de la session` (`214:1528`)

908 × 841, column, gap **14**, items centred, **justify-end** (content is bottom-anchored: when the history is short it sits at the bottom; when long, the top is clipped and the area scrolls; auto-stick to bottom while streaming unless the user scrolled up), `px 32 py 20`. Every block is 720 wide.

Blocks in D05, top → bottom (the first one is scrolled partly out of view, only its bottom edge with `Vous · 10:42` is visible):

1. **`Dev · Message · Instruction`** (user prompt). Row, justify-end; bubble **520** wide, bg `--accent`, radius lg 20, `px 16 py 12`, gap 4:
   - `Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires. Respecte CLAUDE.md.` — Outfit Regular 14 / 20, `--paper`.
   - `Vous · 10:42` — JetBrains Mono 11, `--accent-on-dark`.
   - Note: « Instruction envoyée à la session Claude Code. Même bulle que les messages sortants de Nuera OS. »
2. **`Dev · Message · Claude`** (assistant text). Row, gap 12: **Pastille** 28 × 28 bg `--accent-pale` radius sm 8 with `icon/terminal` 16 `--accent`; content column (flex 1, gap 4): header row gap 8 = `Claude Code` (Outfit SemiBold 13 `--text`) + `10:42` (JetBrains Mono 11 `--muted`); body `Je lis d'abord les conventions du dépôt et la structure du module CRM.` (Outfit Regular 14 / 20 `--text`). Note: « Texte produit par Claude Code dans la session. Rendu lisible de la sortie du CLI ; la vue Terminal montre le flux brut. »
3. **`Dev · Ligne d'outil`** Statut=Terminé — `Read` · `CLAUDE.md` · `212 lignes`.
4. **`Dev · Ligne d'outil`** Statut=Terminé — `Glob` · `src/modules/crm/**/*.tsx` · `14 fichiers`.
   - Tool line spec: bg `--bg`, 1 px `--border` (Erreur: `--danger`), radius md 12, `px 12 py 8`, gap 10, h 34: status icon 16 · tool name JetBrains Mono **Medium** 12 `--text` · target JetBrains Mono Regular 12 `--muted` (flex 1, single line, ellipsis) · result summary JetBrains Mono 11 `--muted` · `icon/chevron` 14 `--muted` (rotates/expands).
   - Status variants (`203:369`): **Terminé** `icon/check` `--success` + summary (`212 lignes`, `14 fichiers`, `+46 −12`); **En cours** `icon/clock` `--en-cours` + `en cours · 38 s`; **Erreur** `icon/alert` `--danger`, border `--danger`, summary in `--danger` e.g. `code 1 · 2 échecs`; **Refusé** `icon/x` + `refusé`.
   - Clicking the line (chevron) expands its output as a **`Dev · Sortie de commande`** block under it (see 1.9.3). Note: « Une action de Claude Code (Read, Edit, Write, Bash, Glob…), repliée. Le chevron déplie sa sortie (Dev · Sortie de commande). »
5. **`Dev · Plan de travail`** (todo list exposed by the CLI). bg `--bg`, 1 px `--border`, radius lg 20, p 16, gap 10:
   - Header row gap 8: `icon/list-checks` 16 `--accent` · `Plan de travail` (Outfit SemiBold 14 `--text`, flex 1) · `3 / 5` (JetBrains Mono 12 `--muted`, completed / total).
   - Steps (row, gap 10, icon 16, text 13):
     - done (`icon/check` `--success`, Outfit Regular 13 `--muted`, **line-through**): `Lire CLAUDE.md et la structure du module`, `Créer PipelineBoard.tsx avec colonnes glissables`, `Calculer le total par étape`
     - current (`icon/clock` `--en-cours`, Outfit **Medium** 13 `--text`): `Écrire les tests de pipeline-totals.ts`
     - pending (`icon/minus` `--muted`, Outfit Regular 13 `--text`): `Lancer la suite de tests du module`
   - Note: « Liste de tâches tenue par Claude Code pendant la session, telle que le CLI l'expose. Rien n'est estimé par Nuera Dev. » (Update in place; no Nuera-side estimates.)
6. **`Dev · Message · Claude`** `10:51`: `Le tableau et le calcul des totaux sont en place. J'ai écrit les tests de pipeline-totals.ts ; je lance maintenant la suite du module pour les vérifier.`
7. Tool line `Edit` · `src/modules/crm/PipelineBoard.tsx` · `+46 −12`
8. Tool line `Write` · `src/modules/crm/pipeline-totals.ts` · `+38`
9. Tool line `Write` · `src/modules/crm/__tests__/pipeline-totals.test.ts` · `+54`
10. **Permission prompt** (1.6).

### 1.6 Permission prompt — `Dev · Demande d'autorisation`, État=En attente (`214:1624`)

720 × 211, bg `--warn-pale`, **1 px `--warn` border**, radius lg 20, p 16, gap 12.
- Header (row, gap 10): `icon/shield` 18 `--warn` · `Claude demande à exécuter une commande` (Outfit SemiBold 14 `--text`, flex 1) · Badge Alerte `En attente`.
- **Commande** block (Dark-mode tokens): bg `#233353`, radius md 12, `px 12 py 10`: `$ npm run test -- crm` (JetBrains Mono Regular 13, white).
- Explanation: `Lance la suite Vitest du module CRM dans le worktree crm-core. Lecture et écriture limitées au dépôt.` (Outfit Regular 13 / 18 `--muted`). Human-readable description of the command and its scope.
- Actions (row, gap 8), **in the CLI's order, max 3**:
  - `Autoriser` — Principal, `icon/check` white (prototype hotspot → next step of flow B = W3 « Session terminée »). Allow once.
  - `Toujours pour npm run test` — Secondaire, no icon. Allow and remember the rule for the command prefix (the security log in D08 records it: `hier 10:51 · « toujours autoriser » npm run test · Nuera OS`).
  - `Refuser` — Discret with `icon/x` (`--accent`). Deny; Claude is told.
- Footer: `Mode : demander avant d'agir · la réponse est transmise au CLI` (JetBrains Mono 11, `--warn`) — current permission mode.
- Note: « Demande de permission du CLI. Trois choix au plus, dans l'ordre du CLI. Une fois tranchée, la carte se replie en une ligne et l'historique la garde. »
- **Resolved variants** (one 34 px line, same box as a tool line: bg `--bg`, 1 px `--border`, radius md 12, `px 12 py 8`, gap 10, `icon/shield` 16 + JetBrains Mono 12 `--muted` text + trailing 16 px icon):
  - État=Autorisée: `Commande autorisée une fois · npm run test -- crm` + `icon/check`.
  - État=Refusée: `Commande refusée · Claude a été prévenu` + `icon/x`.
- Cover note (verbatim): « Demandes d'autorisation : les capter et y répondre depuis le navigateur sans contourner le mode de permission du CLI. »
- While a prompt is pending: session status badge = `Autorisation demandée`, selector dot = Alerte, composer is in État=Attente (input suspended), mobile/desktop notification is sent (D08 preference).

### 1.7 Composer and persistence line — `Saisie` (`214:1649`)

908 × 143, column, gap 8, items centred, `pt 12 pb 16 px 32`.

**`Dev · Compositeur`** (720 × 92): bg `--bg`, 1 px `--border`, radius lg 20, `pl 16 pr 12 py 12`, gap 10.
- Text area (Outfit Regular 14 / 20, placeholder `--muted`), auto-growing.
- **Barre** (row, gap 8, centred): `icon/paperclip` 18 `--muted` (attach file) · Badge Neutre `Mode : demander avant d'agir` (current permission mode) · `/ commandes  ·  @ fichiers` (JetBrains Mono 11 `--muted`, pre-wrap, flex 1 — hint: `/` opens slash commands, `@` mentions a file) · **Envoyer** 36 × 36 radius md 12 with `icon/send` 18 white.
- States (`203:497`):
  | État | Placeholder (verbatim) | Envoyer | Extra |
  |---|---|---|---|
  | Prêt | `Écrire une instruction à Claude…` | bg `--accent` (enabled) | — |
  | En cours | `Ajouter une précision pour Claude, elle sera lue à la fin de l'étape en cours…` | bg `--border` (disabled look) | Secondaire `Interrompre · Échap` with `icon/stop`, before Envoyer |
  | **Attente** (D05) | `Répondez d'abord à la demande d'autorisation ci-dessus…` | bg `--border` (disabled) | — |
- Note: « Saisie envoyée au CLI. En cours, l'envoi passe en file et Interrompre envoie Échap au processus. En attente d'autorisation, la saisie est suspendue. » → while running, a sent message is **queued** and delivered at the end of the current step; while waiting for permission, typing/sending is disabled.

**Persistance** line (720, row, gap 8): `Dev · Point de statut` Ton=Succès · `Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas.` (Outfit Regular 12 `--muted`, flex 1) · `Échap · interrompre` (JetBrains Mono 11 `--muted`, keyboard hint).
Cover note (verbatim): « Persistance : une session par processus tmux et par worktree ; reprise par claude --resume après un redémarrage. »

### 1.8 Context panel — `Panneau contextuel` (`214:1666`)

460 × 1039, bg `--bg`, 1 px **left** border `--border`, column.

**Navigation locale** (459 × 48): 1 px bottom border, row, gap 4, `px 16 py 12`. Tabs are rendered with `Badge`: active = Badge **Accent**, others = Badge **Neutre** (text-only look). Tabs: `Fichiers` · `Modifications · 4` (**active**; the count = changed files) · `Tests` · `Terminal` · `Projet`. Implement as `tablist` (`?panneau=fichiers|modifications|tests|terminal|projet`). Designed bodies: Fichiers (W1), Modifications (D05), Tests (W2). `Terminal` and `Projet` bodies are **not designed** (see questions).

**Modifications** body (`214:1678`, flex 1, column, gap 12, p 16):
1. **Résumé** (row, gap 8): `4 fichiers modifiés` (Outfit SemiBold 14 `--text`, flex 1) · `+152` (JetBrains Mono 12 `--success`) · `−12` (JetBrains Mono 12 `--danger`).
2. **Liste des fichiers** (column, gap 2) of `Dev · Fichier modifié` rows (427 × 32): `px 8 py 6`, radius sm 8, gap 8; **status square** 20 × 20 radius sm 8 with a JetBrains Mono Bold 11 letter; path JetBrains Mono 12 `--text` (flex 1, ellipsis at end); `+n` JetBrains Mono 11 `--success`; `−n` JetBrains Mono 11 `--danger` (only if > 0). **Selected** row bg `--accent-pale` (its diff is shown below).
   - `M` (bg `--warn-pale`, `--warn`) `src/modules/crm/PipelineBoard.tsx` `+46` `−12` — selected
   - `A` (bg `--success-pale`, `--success`) `src/modules/crm/pipeline-totals.ts` `+38`
   - `A` `src/modules/crm/__tests__/pipeline-totals.test.ts` `+54`
   - `M` `src/modules/crm/Pipeline.module.css` `+14`
   - Variants: Statut = Modifié (`M`) / Ajouté (`A`) / Supprimé (`D`, `203:553`). Note: « Entrée de la liste des changements Git. Le chemin long se tronque à la fin, le nom complet reste au survol et dans le diff. » → `title` tooltip with full path.
3. **Diff viewer** `Diff · PipelineBoard.tsx` (`214:1706`): flex 1 (fills the rest, 427 × 692), 1 px `--border`, radius md 12, clipped, scrolls vertically; long lines are **truncated with an ellipsis** (no horizontal scroll in this view).
   - **En-tête du diff** (border-bottom, `px 12 py 8`, gap 8): `PipelineBoard.tsx` (JetBrains Mono Medium 12 `--text`, flex 1) · `2 blocs` (JetBrains Mono 11 `--muted`, hunk count) · Discret `Avant / après` (opens the full review mode W4, side-by-side; see 1.9.4).
   - **`Dev · Ligne de diff`** rows, each h 22, row: old line number (40 px, right-aligned, `pr 8`) · new line number (40 px, idem) — both JetBrains Mono 11 `--muted` · sign column 20 px centred, JetBrains Mono **Bold** 12 · code JetBrains Mono 12 `--text`, `white-space: pre`, ellipsis.
     | Type | Row bg | Sign (colour) | Numbers |
     |---|---|---|---|
     | Bloc (hunk header) | `--accent-pale` | none; header text in `--accent` | none |
     | Contexte | none | none | old + new |
     | Suppression | `--danger-pale` | `−` (`--danger`) | old only |
     | Ajout | `--success-pale` | `+` (`--success`) | new only |
     Note: « Ligne de diff unifiée. Le signe double la couleur : la lecture ne dépend jamais du vert et du rouge seuls. »
   - Content shown (verbatim, leading spaces significant):
     ```
     @@ -12,6 +12,8 @@ export function PipelineBoard()
     12 12     const stages = useStages(projectId);
     13 13     const deals = useDeals(projectId);
     14    −   const total = deals.reduce(sum, 0);
        14 +   const totals = computeStageTotals(deals);
        15 +   const [dragged, setDragged] = useState(null);
     15 16
     16 17     return (
     17 18       <DndContext onDragEnd={moveDeal}>
     @@ -41,4 +44,8 @@
     41 44           <StageColumn
     42 45             stage={stage}
     43    −           total={total}
        46 +           total={totals[stage.id] ?? 0}
        47 +           onDragStart={setDragged}
        48 +           isDragging={dragged?.stage === stage.id}
     44 49           />
     ```
     (Code text in Figma: `  const stages = useStages(projectId);`, `    <DndContext onDragEnd={moveDeal}>`, `        <StageColumn`, `          stage={stage}` … the blank line 15/16 contains a zero-width space.)

**Actions Git** (`214:1850`, 459 × 91, pinned at the bottom): 1 px **top** border, column, gap 10, `px 16 py 14`.
- **Branche** row (gap 8): `icon/git-branch` 16 `--ink` · `feature/crm-core` (JetBrains Mono Medium 12 `--text`) · `2 commits d'avance · 4 fichiers non commités` (Outfit Regular 12 `--muted`, ellipsis) — ahead count vs base + uncommitted files.
- **Boutons** (gap 8): Principal `Préparer le commit` (`icon/git-commit`, white) · Secondaire `Préparer la pull request` (`icon/git-pull-request`, `--ink`). Both open the W5 modal (commit form / with PR option pre-checked — assumption). **Disabled state** (W1): whole button row at **opacity 40 %** when there is nothing to commit, branch line then reads e.g. `feature/pipeline-export` + `à jour avec main · aucune modification`.

### 1.9 Workspace panels and states not visible in D05 (summary, see section 03)

#### 1.9.1 Fichiers tab — file explorer + read-only code viewer (W1 `227:3075`, panel `227:3134`)
- **Arborescence** (column): rows `py 5`, `pr 8`, radius sm 8, gap 6; left padding by depth **8 / 24 / 40 / 56 / 72 px** (16 px per level); 12 px chevron (`icon/chevron-down` open, `icon/chevron` closed) or a 12 px blank "Retrait" for files; 15 px icon (`icon/projets` folder, `icon/file` file); name JetBrains Mono 12 `--text` (flex 1); meta JetBrains Mono 11 `--muted` on the right (size `4,1 Ko`, `1,2 Ko`, `0,6 Ko`, `2,3 Ko`, `1,8 Ko`, or `212 lignes` for the open file). Selected/open file row: bg `--accent-pale`, name JetBrains Mono **Medium**.
  Tree shown: `nuera-os` › `.claude`, `src` › `app`, `modules` › `crm` › `PipelineBoard.tsx`, `Pipeline.module.css`, `types.ts`; `devis`; `CLAUDE.md` (selected), `package.json`, `README.md`.
- **Aperçu · CLAUDE.md** (code viewer, flex 1): 1 px border, radius md 12. Header (`px 12 py 8`, gap 8, bottom border): file name (JetBrains Mono Medium 12) · Badge Neutre `Lecture seule` · Discret `Modifier`. Body in Dark-mode tokens: bg `#233353`, `px 14 py 12`, JetBrains Mono 12 / 19, `--muted` (62 % white), `pre-wrap`. No syntax highlighting, no line numbers in this design.

#### 1.9.2 Tests tab — live test results (W2, `227:3589`)
Summary row: command `npx playwright test devis` (JetBrains Mono Medium 12) + Badge Accent `En cours`. Counters (gap 12, baseline): `22` `réussis` (Outfit SemiBold 20 `--success` + Outfit 12 `--muted`), `1` `échec` (`--danger`), `1` `en cours` (`--en-cours`). Stacked progress bar h 8, radius full, 1 px border, segments success / danger / en-cours proportional. Test list (bordered box radius md 12): rows `px 12 py 8` gap 10, bottom border, 15 px icon (`icon/check` / `icon/x` / `icon/clock`), name JetBrains Mono 12 (ellipsis), duration JetBrains Mono 11 `--muted` (`3,1 s`, `en cours`); failed row bg `--danger-pale`. Failure detail (Dark tokens, radius md 12, `px 12 py 10`, JetBrains Mono 11 / 17). Footnote: `Résultats lus en direct dans la sortie de la commande lancée par Claude, rien n'est simulé.`

#### 1.9.3 Expanded tool output — `Dev · Sortie de commande` (`203:373`, used in W3)
Dark-mode block, radius md 12, `px 16 py 12`, gap 2, JetBrains Mono 12: first line = command in `--text` (white) (`$ npm run test -- crm`), then output lines in `--muted` with line-height 18 (pre-wrap). Note: « Sortie brute d'une commande, sur le mode Dark de la collection Color (l'équivalent de .on-dark). Texte exact du terminal, jamais reformulé. »

#### 1.9.4 Review mode — `Revue des modifications` (W4 `229:3676`)
Triggered from `Avant / après` (and/or the panel toggle). Context panel hidden; full-width review. **Barre de revue** (h 57, `px 24 py 10`, gap 12, bottom border): Discret `Retour à la session` (`icon/arrow-left`) · `Modifications · 4 fichiers · +152 −12` (Outfit SemiBold 15, flex 1) · segmented **Affichage** `Unifié` / `Côte à côte` (same control as the view toggle; `Côte à côte` active) · `Fichier 1 sur 4 · bloc 1 sur 2` (JetBrains Mono 11) · Secondaire `Précédent · K` · Secondaire `Suivant · J` (keyboard K/J navigate hunks). Body = file list column (295 px rows) + diff.

#### 1.9.5 Commit modal — `Modale · Préparer le commit` (W5 `231:3904`, 680 × 778 over a `Voile` scrim)
Sections (from the layer tree): title `Préparer le commit` + branch line + close `icon/x`; `Fichiers inclus · 4 sur 4` with `+152 −12` and 4 checkable file rows; commit message field + description; options `Pousser sur origin/feature/crm-core` and `Ouvrir une pull request vers main`; `Titre de la pull request` field; footer note starting « Rien n'est envoyé sur GitHub sans cette confirma… » + site Buttons `Annuler` / `Committer et ouvrir la PR`. Exact copy: see the states document.

#### 1.9.6 Session switcher popover — `Sélecteur ouvert · sessions de Nuera OS` (W6 `231:4159`)
400 wide, anchored under the selector, bg `--bg`, 1 px `--border`, radius md 12, **Shadow/Float**, p 8, gap 4.
- Header (`px 10 py 8`, JetBrains Mono 11 `--muted`): `NUERA OS · 2 SESSIONS ACTIVES` (tracking 0.88) · `2 / 4` (active / max).
- Session rows (p 10, gap 10, radius sm 8): status dot · title Outfit SemiBold 14 (+ `· affichée` Outfit Regular 12 `--muted` for the current one) · worktree line (`icon/worktree` 13 + JetBrains Mono 11 `--muted`, ellipsis) · status badge. Current row bg `--accent-pale`: `Module CRM · pipeline` `· affichée`, `feature/crm-core · worktree crm-core`, Badge Alerte `Autorisation demandée`. Other row (link): `Tests e2e du devis`, `feature/devis-pdf · worktree devis-pdf`, Badge Accent `En cours · 7 min`.
- 1 px separator, then **Nouvelle session**: 24 px accent-pale circle with `icon/plus` 14 · `Nouvelle session dans un nouveau worktree` (Outfit Medium 14 `--accent`) / `Créé depuis main · 10,9 Go de mémoire libre` (Outfit Regular 12 `--muted`).
- Note row: `Chaque session a son worktree : passer de l'une à l'autre ne déplace aucun fichier.`

#### 1.9.7 Connection lost — `Dev · Bandeau` Ton=Alerte (W7 `231:4370`)
Inserted between the view bar and the thread (908 × 60): bg `--warn-pale`, `px 16 py 12`, gap 12: `icon/wifi-off` 18 · `Connexion au serveur perdue · nouvel essai dans 4 s` (Outfit SemiBold 14) / `La session continue sur VPS-3 : rien n'est perdu, le fil se recharge à la reconnexion.` (Outfit Regular 13 `--muted`) · Secondaire `Réessayer maintenant`. Countdown + auto-retry; on reconnect, reload the thread from the server.

#### 1.9.8 Stop confirmation (T8 `236:5442`)
Dialog card radius xl 28, p 24, gap 16, Shadow/Float: pastille 40 `--warn-pale` radius md with `icon/stop` 20 · `Arrêter « Module CRM · pipeline » ?` (Outfit SemiBold 18). Consequences (gap 8, 16 px icons, Outfit 13 / 18): ⚠ `Claude Code reçoit Échap puis s'arrête, même au milieu d'une étape.` ✓ `Les fichiers modifiés et le worktree crm-core sont conservés.` ✓ `La conversation reste reprenable depuis Sessions.` Actions right-aligned: site Button Default `Annuler`, Accent `Arrêter la session`. Annotation (`236:5566`): « Une confirmation liste ce qui change et ce qui est conservé, puis nomme l'action sur son bouton. Le système de design n'a pas de variante destructive du Button : à arbitrer (voir 04). »

### 1.10 Data displayed → entities

```ts
type SessionStatus = 'en_cours' | 'autorisation_demandee' | 'terminee'
  | 'interrompue' /* reprise possible */ | 'archivee' | 'reprise_impossible';

interface Session {
  id: string;
  title: string;                 // "Module CRM · pipeline"
  project: { id: string; name: string /* "Nuera OS" */; repo: string /* "nuera-studio/nuera-os" */ };
  branch: string;                // "feature/crm-core"
  worktree: string;              // "crm-core"
  tmuxName: string;              // e.g. "nuera-os-crm-core" (layer name), displayed as "tmux"
  host: string;                  // "VPS-3"
  startedAt: Date;               // → "12 min"
  status: SessionStatus;
  model: string;                 // "défaut du CLI"
  permissionMode: 'demander_avant_d_agir' | string; // label "demander avant d'agir"
  pendingPermission?: PermissionRequest;
  plan?: { steps: { label: string; state: 'done' | 'current' | 'pending' }[] }; // 3 / 5
  claudeResumeId?: string;       // for `claude --resume`
}

type ThreadEvent =
  | { kind: 'instruction'; text: string; at: Date }                       // "Vous · 10:42"
  | { kind: 'assistant'; text: string; at: Date }                         // "Claude Code 10:42"
  | { kind: 'tool'; tool: 'Read'|'Glob'|'Edit'|'Write'|'Bash'|string; target: string;
      status: 'termine'|'en_cours'|'erreur'|'refuse'; summary: string /* "212 lignes", "+46 −12", "code 1 · 2 échecs" */;
      output?: string /* raw, never reworded */ }
  | { kind: 'plan'; steps: Session['plan'] }
  | { kind: 'permission'; request: PermissionRequest };

interface PermissionRequest {
  title: string;        // "Claude demande à exécuter une commande"
  command: string;      // "npm run test -- crm"
  description: string;  // human explanation
  options: { id: string; label: string }[]; // ≤ 3, CLI order: Autoriser / Toujours pour npm run test / Refuser
  state: 'en_attente' | 'autorisee' | 'refusee';
}

interface WorktreeGitStatus {
  branch: string; base: string /* main */; ahead: number /* 2 */; uncommitted: number /* 4 */;
  files: { path: string; status: 'M'|'A'|'D'; additions: number; deletions: number }[];
  totals: { additions: 152; deletions: 12 };
}
interface FileDiff { path: string; hunks: { header: string; lines: { type: 'context'|'add'|'del'; old?: number; new?: number; text: string }[] }[] }
```
Other data on the screen: sessions count for the project (`2 sessions sur ce projet`) + their worst status; project tree (W1) with file sizes in Ko (French decimals) or line counts; raw PTY stream (Terminal brut).

### 1.11 Interactions (D05)

| Element | Node | Behaviour | Notes |
|---|---|---|---|
| Rail items | `I214:1425;201:801…819` | Navigate to Accueil / Projets / Sessions / Intégrations / Paramètres | Prototype links; aria-labels required |
| `Nuera OS  /` | `214:1460` | Back to project detail (D04) | Assumption (breadcrumb look) |
| Repo / branch / worktree chips | `214:1465/1470/1477` | Static info (optionally copy / open on GitHub) | Not interactive in Figma |
| `2 sessions sur ce projet` | `214:1486` | Opens switcher popover (W6) | Prototype link; Esc / outside click closes |
| `Interrompre` | `214:1492` | Sends Échap to the CLI; current step stops, session stays alive | Shortcut `Échap` (shown in persistence line) |
| `Commit et push` | `214:1497` | Opens commit modal (W5) | Prototype link; nothing pushed without confirmation |
| `…` | `214:1504` | Overflow menu (not designed); likely `Arrêter la session` → T8 confirmation | Assumption |
| Panel toggle | `214:1509` | Show/hide context panel (accent icon = shown) | `aria-pressed` |
| `Conversation` / `Terminal brut` | `214:1517/1521` | Switch rendering of the same stream (1.4) | Persist choice |
| Tool line chevron | e.g. `I214:1543;203:336` | Expand/collapse raw output (`Dev · Sortie de commande`) | |
| `Autoriser` | `I214:1624;203:386` | Answer "allow once" to the CLI; card collapses to `Commande autorisée une fois · …` | Prototype link → W3 |
| `Toujours pour npm run test` | `I214:1624;203:392` | Allow + persistent rule for that command prefix; logged in security journal | |
| `Refuser` | `I214:1624;203:397` | Deny; card collapses to `Commande refusée · Claude a été prévenu` | |
| Composer | `214:1650` | Disabled while a permission is pending; Enter sends (Prêt), queues (En cours) | `/` commands, `@` file mentions, paperclip attaches |
| Envoyer | `I214:1650;203:493` | Send; disabled (bg `--border`) when empty / suspended | |
| Panel tabs | `214:1668…1676` | Switch panel body | `Modifications · 4` count live |
| File row | `214:1684…1700` | Select file → show its diff below | Full path on hover |
| `Avant / après` | `214:1710` | Open review mode (W4) | |
| `Préparer le commit` / `Préparer la pull request` | `214:1860/1867` | Open W5 modal | Disabled at 40 % opacity when nothing to commit |

Feedback & live behaviour: thread, plan, tool statuses, git status and badges update in real time (websocket/SSE from the tmux/CLI bridge); header status badge and selector dot mirror the session status.

### 1.12 States shown / annotated
- D05 = status **Autorisation demandée**, composer **Attente**, panel tab **Modifications**, view **Conversation**, panel visible.
- Related frames: W1 new session / Fichiers tab / disabled Git actions; W2 long task / Terminal brut / Tests tab / composer En cours; W3 session finished (expanded command output); W4 review; W5 commit modal; W6 switcher; W7 connection lost; T8 stop confirmation.
- Header status badge values seen across the file: `Autorisation demandée` (Alerte), `En cours · 7 min` (Accent, in switcher).

### 1.13 Mobile counterpart (for reference)
M05 `222:2732` (390 × 844): no tab bar (cover note), stacked `En-tête de session` (52) · `État de la session` (39) · `Onglets du Workspace` (55, tabs replace the side panel: conversation / diff / git …) · thread · `Saisie` (87). Phone states S1 (keyboard open), S2 (Diff tab), S3 (Git tab), S4 (switcher as bottom sheet `Feuille · Sessions de Nuera OS`), S5 (push notification → permission). Phone permission card component: `Dev · Demande d'autorisation · téléphone` (`222:2731`, 358 × 358). 44 px touch targets for compact buttons and switches.

### 1.14 D05 assets (`.design-refs/assets/`)

| Const in `D05.tsx` | File | Size | Colour | Used for |
|---|---|---|---|---|
| imgIconHome | `80127a8f-493f-4828-9a15-b41221af3dfa.svg` | 20 | `#A6B9DD` | rail Accueil |
| imgIconProjets | `d2143c51-881f-447a-8e58-0f049f9b2e0a.svg` | 20 | `#A6B9DD` | rail Projets |
| imgIconTerminal | `f3af2eca-a15c-44a1-ae52-1dff34ff057d.svg` | 20 | white | rail Sessions (active) |
| imgIconPlug | `5dec78fb-967f-45b6-ad73-0d24f84b0177.svg` | 20 | `#A6B9DD` | rail Intégrations |
| imgIconReglages | `56df5d5c-b5fc-42ce-9463-498882f451fb.svg` | 20 | `#A6B9DD` | rail Paramètres |
| imgIconGithub | `a88ed1ab-6768-49dc-9850-f60153652bf1.svg` | 13 | `#645E78` | repo chip |
| imgIconGitBranch | `b54eed5e-c528-459e-9b68-80e2a91d029f.svg` | 13 | `#645E78` | branch chip |
| imgIconWorktree | `ad3a65b6-ec7e-4049-9d08-30e74f429879.svg` | 13 | `#645E78` | worktree chip |
| imgTonAlerte | `f6b5de6b-8870-4c38-922b-004bbe160478.svg` | 8 | `#8A6516` | selector status dot |
| imgIconChevronDown | `028cc303-073f-4627-af12-da602ddb41df.svg` | 16 | `#645E78` | selector chevron |
| imgIcone | `f1d2374d-dab0-4174-a4e9-5cc622de7754.svg` | 16 | `#233353` | `icon/stop` (Interrompre) |
| imgIcone1 | `3a18da5c-629a-4262-bc3b-efd2ba903bf9.svg` | 16 | white | `icon/upload` (Commit et push) |
| imgIconMore | `a8e408c9-e535-4bb3-a5f2-d9702dd773ad.svg` | 18 | `#233353` | `…` |
| imgIconPanelRight | `c750abf6-7634-4e34-8d48-42782d90e29b.svg` | 18 | `#4368B1` | panel toggle (on) |
| imgIconMessages | `30178985-3d82-4d4f-9360-25509f621dce.svg` | 14 | `#4368B1` | Conversation segment (active) |
| imgIconTerminal1 | `5a86efec-be77-4b61-aef5-cfb78abc29b2.svg` | 14 | `#645E78` | Terminal brut segment (inactive) |
| imgIconTerminal2 | `09d5b951-9d6a-4347-bab3-dead9c5f9493.svg` | 16 | `#4368B1` | Claude message pastille |
| imgIconCheck | `7a3484a7-c3ac-4582-bddc-1e23e51754cb.svg` | 16 | `#2F6F4F` | tool done / plan done |
| imgIconChevron | `8aee3529-9ebb-4b8e-a830-0f2e97bce79b.svg` | 14 | `#645E78` | tool line chevron |
| imgIconListChecks | `9803c7ac-7f4b-4987-b691-f1de1737ef37.svg` | 16 | `#4368B1` | plan header |
| imgIconClock | `a3e83eef-022c-4a85-8841-31adbfda0117.svg` | 16 | `#E0A10F` | plan current step |
| imgIconMinus | `7262fa55-fcde-4e18-855e-711106c290d2.svg` | 16 | `#645E78` | plan pending step |
| imgIconShield | `9a7e77d3-e79d-4f3b-a47f-34026ef9ceff.svg` | 18 | `#8A6516` | permission header |
| imgIconCheck1 | `fd5af3f4-3cef-4023-abe4-b863c26af564.svg` | 16 | white | `Autoriser` |
| imgIcone2 | `dd00f3a4-4722-490b-934d-b46a8686ca77.svg` | 16 | `#4368B1` | `icon/x` (Refuser) |
| imgIconPaperclip | `61fff081-2a00-4e1e-8f74-30513e212e29.svg` | 18 | `#645E78` | composer attach |
| imgIconSend | `0c636265-4843-4235-9ddb-0d8c51b8996e.svg` | 18 | white | composer send |
| imgTonSucces | `a6074985-3eff-4711-baf9-b3dbf4bdfeb1.svg` | 8 | `#2F6F4F` | persistence dot |
| imgIconGitBranch1 | `aac764da-18cb-48ba-ba14-36ae524e79ac.svg` | 16 | `#233353` | Git actions branch |
| imgIcone3 | `5c3463f1-2ab9-47f4-a687-af4f5bbd4d5d.svg` | 16 | white | `icon/git-commit` (Préparer le commit) |
| imgIcone4 | `8f23cccc-36af-4d54-a2a7-f033024d5f86.svg` | 16 | `#233353` | `icon/git-pull-request` |

Icons whose layer is just "Icône" were identified visually (stop / upload / git-commit / git-pull-request / x); the icon set names come from section 04 (`icon/stop`, `icon/upload`, `icon/git-commit`, `icon/git-pull-request`, `icon/x`). Icons are colour-baked SVGs: prefer one icon component with `currentColor` and apply the token colour listed here.

---

## 2. D06 — Sessions (`215:1792`)

Route `/sessions`. Sidebar variant `Actif=Sessions` (the Sessions item is the active, non-link item and shows the count `2`).

### 2.1 Layout skeleton (content 1192 wide, `px 32 py 28`, gap 24)

```
En-tête            [Sessions / subtitle ............................ (Nouvelle session)]
Capacité tile      [cpu pastille | 2 sessions actives… | 4-slot gauge + memory/cpu caption]
EN COURS · 2
Sessions en cours  [card 340][card 340][ dashed "Démarrer une session" tile (flex 1) ]
Note worktrees     [worktree icon + sentence]
HISTORIQUE
Filtres            [search 320][Projet 180][Statut 180][période 200]
Tableau            [tile with header row + 5 history rows]
Footnote
```

### 2.2 Header
- `Sessions` (page title) / `Chaque session est un processus Claude Code sur VPS-3, dans son propre worktree.` (subtitle).
- Site `Button` Accent `Nouvelle session` (168 × 54) → new-session flow (choose project + branch, a dedicated worktree is created).

### 2.3 Capacity tile — `Capacité` (`215:1877`)
Tile (radius xl 28, Shadow/Soft), 1128 × 68, row, gap 24, centred, `px 20 py 16`.
- Pastille 36 × 36 `--accent-pale` radius sm 8 with `icon/cpu` 18.
- Text (300 wide, gap 2): `2 sessions actives sur 4 autorisées` (Outfit SemiBold 15 `--text`) / `Limite réglable dans Paramètres · Serveur` (Outfit Regular 12 `--muted`).
- **Jauge** (flex 1, gap 6): **Piste** h 10, 4 equal slots (flex 1) with 4 px gaps, radius 5; used slots bg `--accent`, free slots bg `--surface-raised` + 1 px `--border`. Caption `Mémoire libre : 10,9 Go sur 16 · processeur 23 %` (JetBrains Mono 11 `--muted`).
- Data: activeSessions (2), maxSessions (4, configurable), freeMemoryGo (10,9), totalMemoryGo (16), cpuPercent (23). One slot per allowed session.

### 2.4 Running sessions
Overline `EN COURS · 2` (count of running sessions). Row `Sessions en cours`, gap 24, 203 tall.

**`Dev · Carte de session`** (instance 340 wide; library 320): tile, p 20, gap 10, column. Note: « Session Claude Code vue de l'extérieur : statut, projet, branche et worktree, dernière activité, action principale. Tuile Nuera OS (rayon xl, Shadow/Soft). »
- **Statut** row (gap 8): 8 px status dot · status label Outfit Medium 12 **`--warn`** (flex 1) · elapsed time JetBrains Mono 11 `--muted`.
- Title Outfit SemiBold 16 `--text`, single line ellipsis.
- **Contexte** (gap 4): `icon/projets` 14 + project name (Outfit Regular 12 `--muted`); `icon/worktree` 14 + `<branch> · worktree <name>` (JetBrains Mono 11 `--muted`, ellipsis).
- Last activity: Outfit Regular 13 / 18 `--text`, ellipsis.
- One `Bouton compact` (the card's single main action).

| | Card 1 (`215:1895`, Statut=En cours) | Card 2 (`215:1918`, Statut=Autorisation) |
|---|---|---|
| Dot / label | en-cours dot · `En cours` | warn dot · `Autorisation demandée` |
| Time | `12 min` | `2 min` |
| Title | `Module CRM · pipeline` | `Tests e2e du devis` |
| Project | `Nuera OS` | `Nuera OS` |
| Branch line | `feature/crm-core · worktree crm-core` | `feature/devis-pdf · worktree devis-pdf` |
| Activity | `Écrit les tests de pipeline-totals.ts` | `Attend votre accord pour npm run test -- crm` |
| Action | Secondaire `Ouvrir` → Workspace (D05) | **Principal** `Répondre` → Workspace scrolled to the pending permission |

Other variants exist: Statut=Terminée (`203:629`), Statut=Interrompue (`203:654`, 221 tall).

**Add tile `Nouvelle session`** (`215:1941`, flex 1 ≈ 400, stretches to row height): dashed add tile, p 20, gap 10, centred: 40 × 40 circle `--accent-pale` with `icon/plus` 20 · `Démarrer une session` (Outfit SemiBold 15 `--accent`) · `Choisir un projet et une branche. Un worktree dédié est créé, la session tourne même navigateur fermé.` (Outfit Regular 13 / 18 `--muted`, centred). Same action as the header button; disable both when capacity is full (assumption).

**Note worktrees** (gap 8): `icon/worktree` 16 + `Les deux sessions de Nuera OS travaillent dans deux worktrees distincts (crm-core, devis-pdf) : elles ne modifient jamais les mêmes fichiers.` (Outfit Regular 13 `--muted`). Contextual: shown when ≥ 2 running sessions share a project.

### 2.5 History
Overline `HISTORIQUE`.

**Filtres** (row, gap 12) — four `Dev · Champ` (h 40):
1. 320 w, leading `icon/search` 16, placeholder `Rechercher une session…` → full-text filter (title, project, branch).
2. 180 w dropdown `Projet : tous` + chevron → project filter.
3. 180 w dropdown `Statut : tous` + chevron → status filter (Terminée, Interrompue · reprise possible, Archivée, Reprise impossible…).
4. 200 w dropdown `30 derniers jours` + chevron → period filter.

**Tableau de l'historique** (`215:1985`): tile, `px 20 py 8`, column.
- Header row (`py 10`, gap 16, bottom border), overline style labels: `SESSION` (flex 1) · `PROJET` (140) · `BRANCHE` (170) · `DÉBUT · DURÉE` (160) · `STATUT` (200) · `ACTION` (120, right-aligned).
- **`Dev · Ligne d'historique`** rows (1088 × 61, `py 12`, gap 16, bottom border except the last): `icon/terminal` 16 + session name (Outfit SemiBold 14 `--text`, ellipsis) · project (Outfit Regular 13 `--text`) · `icon/git-branch` 13 + branch (JetBrains Mono 11 `--muted`, ellipsis) · start + duration (Outfit Regular 13 `--muted`) · status Badge · action button (right). Note: « Ligne de l'historique des sessions : nom, projet, branche, date, durée, statut de reprise, action. »

| Session | Projet | Branche | Début · durée | Statut (badge) | Action |
|---|---|---|---|---|---|
| `Galerie photos` | `Atelier Lune` | `feature/galerie-photos` | `hier 16:20 · 48 min` | Succes `Terminée` | Discret `Voir le résumé` |
| `Correctif tarifs mobile` | `Kiné Rive Gauche` | `fix/tarifs-mobile` | `lun. 2 nov. 21:05 · 1 h 12` | Alerte `Interrompue · reprise possible` | **Secondaire** `Reprendre` |
| `Migration Next 16` | `Site Nuera Studio` | `chore/next-16` | `28 oct. 09:40 · 2 h 40` | Neutre `Archivée` | Discret `Voir` |
| `Audit des contrastes` | `Site Nuera Studio` | `fix/contrastes` | `21 oct. 14:10 · 35 min` | Danger `Reprise impossible` | Discret `Pourquoi ?` |
| `Devis PDF · première version` | `Nuera OS` | `feature/devis-pdf` | `19 oct. 10:02 · 1 h 05` | Succes `Terminée` | Discret `Voir le résumé` |

Action mapping by status: Terminée → `Voir le résumé` (read-only summary/thread); Interrompue · reprise possible → `Reprendre` (re-opens the conversation with `claude --resume` in its worktree, then opens the Workspace); Archivée → `Voir`; Reprise impossible → `Pourquoi ?` (explains: worktree deleted; history still readable).

Footnote (Outfit Regular 12 / 17 `--muted`): `Reprendre rouvre la conversation enregistrée par Claude Code (claude --resume) dans son worktree. Une reprise devient impossible quand ce worktree a été supprimé ; l'historique reste lisible.`

### 2.6 Entities & interactions (D06)
- `Session` (see 1.10) + `endedAt`/`duration`, `resumable: boolean`, `worktreeExists: boolean`, `summary?`.
- Server capacity: `{ activeSessions, maxSessions, freeMemoryGo, totalMemoryGo, cpuPercent }`.
- Interactions: `Nouvelle session` / `Démarrer une session` (create), `Ouvrir` (`I215:1895;203:575`, prototype link), `Répondre` (`I215:1918;203:600`, prototype link), filters (client/server filtering, debounce search), row actions above, sidebar links. Empty states for these lists exist in T2 (`235:5307`): « Une liste vide dit pourquoi elle l'est et propos… ».
- Mobile counterpart: M06 `223:2787`.

---

## 3. D07 — Intégrations (`216:2035`)

Route `/integrations`. Sidebar `Actif=Intégrations`. Content gap 24.

### 3.1 Layout skeleton
```
En-tête         [Intégrations / subtitle .......................... (Ajouter un serveur MCP)]
GitHub tile     [featured tile: header row / 3 detail boxes / actions row]          (h 266)
SERVEURS MCP · 4  Activés projet par projet, dans Détail du projet · Outils MCP.
Grille MCP      [Figma][GitHub][Coolify (danger border)][Playwright][+ add 160]      (h 223, gap 20)
Diagnostic      [danger-pale banner: alert · text · Voir le journal · Reconnecter]  (h 64)
GARDE-FOUS
Garde-fous      [3 bordered cards, gap 20]
```

### 3.2 Header
`Intégrations` / `Les accès que Nuera Dev et Claude Code utilisent sur VPS-3. Aucun secret n'est affiché ici.` + site Button Accent `Ajouter un serveur MCP` (218 × 54).

### 3.3 GitHub tile (`216:2120`)
Featured tile: bg `--bg`, **1.5 px `--accent` border**, radius xl 28, Shadow/Soft, **p 24**, gap 16, column.
- **En-tête** (row, gap 16, centred): Pastille 48 × 48 `--accent-pale` radius md 12 with `icon/github` 20 · text (flex 1, gap 4): `GitHub · import et synchronisation des dépôts` (Outfit SemiBold 18 `--text`) / `Connecté par l'application GitHub de Nuera Dev, installée sur l'organisation nuera-studio et sur le compte ethanthedevelop. Aucun jeton n'est saisi à la main.` (Outfit Regular 13 / 18 `--muted`) · Badge Succes `Connecté` · site Button **Default** `Gérer l'accès` (145 × 54) → GitHub App installation settings on github.com (external).
- **Détails** (row, gap 16, 3 equal info boxes `px 16 py 12`, gap 4): overline / value (Outfit SemiBold 16 `--text`) / caption (Outfit Regular 12 `--muted`):
  - `DÉPÔTS ACCESSIBLES` / `12 dépôts` / `sélectionnés à l'installation`
  - `DROITS` / `Contenu · pull requests` / `lecture et écriture ; issues en lecture`
  - `DERNIÈRE VÉRIFICATION` / `il y a 6 min` / `synchronisation sans erreur`
- **Actions** (row, gap 8, centred): Secondaire `Vérifier la connexion` (`icon/refresh`) → re-check now (spinner, then updates "DERNIÈRE VÉRIFICATION") · Discret `Voir les 12 dépôts` → list of accessible repos (not designed) · `Expiration : jeton d'installation renouvelé automatiquement par GitHub.` (Outfit Regular 12 `--muted`, flex 1).

### 3.4 MCP servers
Title row (gap 8): overline `SERVEURS MCP · 4` + `Activés projet par projet, dans Détail du projet · Outils MCP.` (Outfit Regular 12 `--muted`).

**Grille MCP** (row, gap 20, cards stretch to equal height 223): four MCP cards (flex 1 ≈ 221.5) + add tile (160).
MCP card: tile, p 20, gap 12, column: header (gap 10) = Pastille 32 × 32 `--accent-pale` **radius md 12** + 20 px icon · name (Outfit SemiBold 16 `--text`); description (Outfit Regular 13 / 18 `--muted`); **Statut** (gap 6) = status Badge + Neutre badge with project count; one compact button.

| Card | Icon | Description | Badges | Button |
|---|---|---|---|---|
| `MCP · Figma` (`216:2166`) | `icon/figma` | `Maquettes et composants nécessaires au développement.` | Succes `Connecté`, Neutre `3 projets` | Secondaire `Configurer` (prototype → D1 drawer) |
| `MCP · GitHub` (`216:2186`) | `icon/github` | `Issues et pull requests, dans le périmètre de l'application.` | Succes `Connecté`, Neutre `2 projets` | Secondaire `Configurer` |
| `MCP · Coolify` (`216:2203`) **1 px `--danger` border** | `icon/rocket` | `Environnements de développement. Production exclue.` | Danger `Autorisation expirée`, Neutre `1 projet` | **Principal** `Reconnecter` (`icon/refresh`, prototype → D2 drawer) |
| `MCP · Navigateur Playwright` (`216:2225`) | `icon/globe2` | `Tests de bout en bout pilotés par Claude.` | Neutre `Désactivé`, Neutre `aucun projet` | Secondaire `Activer` |

Add tile `Ajouter un MCP` (`216:2242`, 160 w): dashed, p 20, gap 8, centred: 36 px circle `--accent-pale` + `icon/plus` 18 · `Ajouter un serveur MCP` (Outfit Medium 13 `--accent`, centred, wraps on 2 lines). Same action as the header button.

### 3.5 Diagnostic banner — `Diagnostic Coolify` (`216:2247`)
1128 × 64, bg `--danger-pale`, radius md 12, `px 16 py 14`, gap 12, centred: `icon/alert` 18 (`--danger`) · text (flex 1, gap 2): `Coolify ne répond plus depuis 09:12` (Outfit SemiBold 14 `--text`) / `Le jeton du serveur MCP a expiré. Les sessions de Nuera OS continuent, sans accès aux environnements de développement.` (Outfit Regular 13 `--muted`) · Discret `Voir le journal` (logs of that MCP server) · Secondaire `Reconnecter` (`icon/refresh`). Shown only when a server is failing (one banner per failing server). Annotation from T7 (`236:5431`): « Même logique pour GitHub, Figma ou Coolify : prévenir avant, dire ce qui s'arrête après, et renvoyer vers le service qui délivre l'accès. »

### 3.6 Guardrails
Overline `GARDE-FOUS` (layer still named "Titre prévues"). Row of 3 cards (flex 1, gap 20): bg `--bg`, 1 px `--border`, **radius lg 20**, p 16, row, gap 12, items-start: 18 px icon in `--accent` + text (gap 4): title Outfit SemiBold 14 `--text`, body Outfit Regular 13 / 18 `--muted`. Informational, not interactive. (MCP/GitHub pastille icons are `--accent` too; the diagnostic `icon/alert` is `--danger`.)
1. `icon/shield` — `Production hors de portée` — `Déployer ou redémarrer un service de production ne passe jamais par Claude : ces actions restent dans Coolify, avec votre compte.`
2. `icon/plug` — `Un accès, un projet` — `Un serveur MCP n'est visible que des projets où il est activé. Les autres sessions ne le voient pas.`
3. `icon/refresh` — `Diagnostic automatique` — `Chaque connexion est vérifiée toutes les 15 minutes. Une expiration s'affiche ici et sur l'Accueil.`

### 3.7 Entities & interactions (D07)
- `GitHubInstallation { accounts: ['nuera-studio' (org), 'ethanthedevelop' (user)], repoCount: 12, permissions: { contents: 'rw', pullRequests: 'rw', issues: 'r' }, lastCheckAt, lastCheckOk, status: 'connected' }`.
- `McpServer { id, name, icon, description, status: 'connected' | 'auth_expired' | 'disabled' | 'unreachable', projectCount, failingSince?: '09:12', lastError? }`; enabled per project (Project detail · Outils MCP).
- Health check every 15 min (auto) + manual; expirations surface here and on Accueil.
- Prototype flow D: D07 → D1 `Intégrations · MCP Figma connecté` (drawer `234:5035`, 480 wide on the right) → D2 `Intégrations · MCP Coolify à reconnecter` (drawer `234:5235`).
- Mobile counterpart: M07 `223:2966`.

---

## 4. D08 — Paramètres (`217:2179`)

Route `/parametres` (tabs as `/parametres/[onglet]` or `?onglet=`). Frame is 1157 tall (content overflows 1120 → page scroll). Sidebar `Actif=Paramètres`. Content gap **20**.

### 4.1 Layout skeleton
```
En-tête    [Paramètres / subtitle]                       (no button)
Onglets    [Vue d'ensemble*][Compte et sécurité][Claude Code][Serveur][Préférences]
Grille     2 columns × 554, gap 20 (each column: stack of tiles, gap 20)
  left : Claude Code · compte Claude (featured, 412) / Compte et sécurité (457)
  right: Serveur VPS-3 (433) / Maintenance (250) / Préférences (258)
```

### 4.2 Header & tabs
- `Paramètres` / `Compte, sécurité, Claude Code et serveur. Un seul propriétaire, aucun autre compte.`
- **Onglets** (row, gap 4) rendered with Badges: Accent `Vue d'ensemble` (active) · Neutre `Compte et sécurité` · `Claude Code` · `Serveur` · `Préférences`. Only the overview is designed; other tabs presumably show the corresponding tile(s) in full (assumption).

**Settings row pattern** (used in every tile): row, gap 12, centred, `py 10`, 1 px bottom border except the last row; optional 18 px leading icon (`--muted`: monitor, smartphone, book, refresh, trash) or 8 px status dot; tile-header pastille icons are `--accent` (terminal, shield, server, sliders, bell); the `Dev · Interrupteur` "on" SVG is accent + white knob; text column (flex 1, gap 2) = Row title (Outfit Medium 14 `--text`) + Row caption (Outfit Regular 12 / 16 `--muted`); trailing control (Badge, compact button, switch, dropdown 140 w).

### 4.3 Left column

**Tuile · Claude Code · compte Claude** (`217:2276`) — featured tile (1.5 px `--accent` border), p 20, gap 12.
- Header: `En-tête de tuile` (`icon/terminal` in pastille) `Claude Code · compte Claude` + Badge Succes `Connecté · formule Max` (plan as reported by the CLI).
- `Le CLI officiel est connecté à votre compte Claude par sa propre procédure (claude /login), lancée dans un terminal de VPS-3. Nuera Dev ne lit ni n'enregistre aucun identifiant.` (Outfit Regular 13 / 18 `--muted`).
- **Réglages du CLI** (row, gap 12, two equal columns, gap 6 label→field): label Outfit Medium 13 `--text` + `Liste déroulante` (h 40 field with chevron):
  - `Modèle par défaut` → `Défaut du CLI` (default model for new sessions; options = models the CLI exposes).
  - `Mode de permission` → `Demander avant d'agir` (default permission mode; also shown in the composer badge and permission footer).
- Row **Garde-fou**: `Bloquer le mode sans autorisation` / `Le mode qui contourne toutes les demandes n'est jamais proposé dans Nuera Dev.` + `Dev · Interrupteur` **on**.
- Row **Utilisation** (no border): `Utilisation et limites` / `Celles qu'affiche le CLI : Nuera Dev n'estime ni coût, ni quota, ni jetons.` + Secondaire `Ouvrir /status` (`icon/terminal`) → runs the CLI `/status` command in a terminal and shows its output verbatim.
- Actions: Discret `Se reconnecter dans un terminal` (`icon/refresh`, accent). Annotation T6 (`236:5400`): « « Se reconnecter » ouvre un terminal sur VPS-3 qui lance la procédure de connexion du CLI (claude /login). Aucun formulaire de jeton dans Nuera Dev. »

**Tuile · Compte et sécurité** (`217:2333`) — tile, p 20, gap 4.
- Header `icon/shield` `Compte et sécurité`.
- Row: `Double facteur` / `Application d'authentification · 8 codes de secours restants` + Badge Succes `Actif`.
- Overline `ACCÈS OUVERTS` (open sessions/devices).
- Device rows (18 px device icon):
  - `icon/monitor` `MacBook Pro · Safari` / `Paris · maintenant` + Badge Accent `Cet appareil` (current device, cannot be revoked here).
  - `icon/smartphone` `iPhone · Safari` / `Paris · il y a 2 h` + Discret `Révoquer`.
  - `icon/monitor` `PC emprunté · Chrome` / `Lyon · hier 18:04 · expire dans 6 h` + Discret `Révoquer` (no bottom border).
- Policy note: `Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours.` (Outfit Regular 12 `--muted`).
- **Journal de sécurité** info box (`px 14 py 12`, gap 6): title row (gap 8) `icon/history` 14 · `JOURNAL DE SÉCURITÉ` (overline, flex 1) · `Tout voir` (Outfit Medium 12 `--accent`, link to full log); entries JetBrains Mono 11 `--text`:
  - `hier 18:04 · connexion depuis un nouvel appareil (Lyon)`
  - `hier 10:51 · « toujours autoriser » npm run test · Nuera OS`
  - `2 nov. · codes de secours régénérés`

### 4.4 Right column

**Tuile · Serveur VPS-3** (`217:2399`) — tile, p 20, gap 4.
- Header `icon/server` `Serveur VPS-3` + Badge Succes `En ligne`.
- Status rows (8 px `Dev · Point de statut` instead of an icon):
  - Succès · `Sessions Claude Code` / `2 processus tmux · crm-core, devis-pdf`
  - Succès · `Application Nuera Dev` / `en ligne · redémarrée il y a 18 j`
  - Succès · `Surveillance et redémarrage` / `un service arrêté est relancé seul`
  - **Alerte** · `Mise à jour système` / `2 paquets de sécurité en attente` (no bottom border)
- **Disponibilité** info box (`px 14 py 12`, gap 8): title row `DISPONIBILITÉ · 30 JOURS` (overline, flex 1) + `99,95 %` (JetBrains Mono **Medium** 12 `--text`); **Barres**: 30 bars (one per day), h 28 area, gap 3, bottom-aligned, flex 1 each (~13.2 px), radius 2: healthy day = `--success` at **opacity 55 %**, full height 28; incident day (day 24) = `--warn` 100 %, **half height 14**. Caption `28 oct. · redémarrage automatique après mise à jour, 2 min d'indisponibilité. Les sessions ont repris seules.` (Outfit Regular 12 / 16 `--muted`). Provide per-bar tooltips/aria (date + availability).

**Tuile · Maintenance** (`217:2472`) — header `icon/reglages` `Maintenance`; rows with 18 px icons and Secondaire buttons:
- `icon/book` `Journaux` / `nuera-dev, sessions Claude, synchronisations Git` → `Consulter` (log viewer, not designed).
- `icon/refresh` `Claude Code` / `mis à jour par sa commande officielle, jamais en cours de session` → `Vérifier` (checks for a CLI update; update only when no session is running).
- `icon/trash` `Worktrees inactifs` / `3 worktrees sans session depuis 30 jours · 2,4 Go` → `Examiner…` (opens the T8 confirmation « Supprimer 2 worktrees inactifs ? » with a selectable list; consequences include `Libère 1,8 Go sur VPS-3.` and a warning about uncommitted changes / sessions no longer resumable).

**Tuile · Préférences** (`217:2522`) — header `icon/bell` `Préférences`:
- `Notifications sur ce téléphone` / `Quand Claude demande une autorisation ou termine une session` + Interrupteur **on** (Web Push for this device; cover note: « Notifications au téléphone : application web installable et notifications push, ou relais par un service tiers. »).
- `Thème` / `Suit les modes clair et sombre du système de design` + dropdown (140 w) `Clair`.
- `Langue` / `Interface en français` + dropdown (140 w) `Français` (no bottom border).

### 4.5 Entities & interactions (D08)
- `ClaudeAccount { connected, plan: 'Max', defaultModel, permissionMode, blockBypassMode: true }`.
- `Security { twoFactor: { method: 'totp', backupCodesLeft: 8 }, devices: { id, name, browser, city, lastSeenAt, expiresAt?, current }[], log: { at, text }[] }`.
- `Server { status, services: { name, state: 'ok'|'warn', detail }[], uptime30d: { date, availability, incident? }[], uptimePercent: 99.95 }`.
- `Maintenance { idleWorktrees: { count: 3, sizeGo: 2.4 }, cliVersion?, updateAvailable? }`.
- `Preferences { pushEnabled (per device), theme: 'clair' | 'sombre' | 'systeme'?, language: 'fr' }`.
- Interactions: tabs, two CLI dropdowns (save on change + toast), switches (optimistic toggle), `Ouvrir /status`, `Se reconnecter dans un terminal` (opens a terminal running `claude /login`), `Révoquer` (revoke device session; confirmation recommended), `Tout voir`, `Consulter`, `Vérifier`, `Examiner…` (T8), theme/language dropdowns. No prototype links except the sidebar.
- Mobile counterpart: M08 `226:2985`.

---

## 5. Cross-cutting design intent (verbatim annotations)

From `Principes et points à valider` (`241:6079`):
- « CE QUE LES MAQUETTES S'INTERDISENT »
  - « Aucune API de chat privée sur l'abonnement Max : l'écran pilote une vraie session du CLI, la vue Conversation n'est qu'une mise en forme de son flux. »
  - « Aucun formulaire de jeton Claude : la connexion passe par la procédure du CLI, dans un terminal. »
  - « Aucune métrique de coût, de quota ou de jetons inventée : seulement ce que le CLI affiche. »
  - « Aucune action de production Coolify à portée de Claude. »
- « À VALIDER TECHNIQUEMENT »
  - « Rendu Conversation : lire la sortie du CLI dans un format exploitable (mode non interactif, sortie structurée) tout en gardant la session interactive. Repli : la vue Terminal brut seule. »
  - « Demandes d'autorisation : les capter et y répondre depuis le navigateur sans contourner le mode de permission du CLI. »
  - « Persistance : une session par processus tmux et par worktree ; reprise par claude --resume après un redémarrage. »
  - « Notifications au téléphone : application web installable et notifications push, ou relais par un service tiers. »
  - « Conditions d'usage de l'abonnement Claude pour un usage personnel hébergé sur son propre serveur. »

Prototyped flows touching these screens (`241:5981`): **B · Travail quotidien** `D01 Accueil → D05 Autorisation → W3 Terminée → W4 Diff → W5 Commit et PR`; **D · Connexion MCP** `D07 Intégrations → D1 Figma → D2 Coolify`.

## 6. Open questions / inconsistencies found

1. **Status mismatch D06 vs D05/W6**: D06 shows `Module CRM · pipeline` as `En cours · 12 min` and `Tests e2e du devis` as `Autorisation demandée · 2 min` (« Attend votre accord pour npm run test -- crm »), while D05 and W6 show the CRM session waiting for `npm run test -- crm` and the devis session `En cours · 7 min`. Treat as sample-data inconsistency; the CRM session is the one awaiting permission.
2. "En cours" tone differs: D06 card label uses `--warn` text + en-cours dot; W6 uses an Accent badge `En cours · 7 min`.
3. `Terminal` and `Projet` tabs of the Workspace panel have no designed body on desktop. Is `Terminal` a separate user shell in the worktree (distinct from the Claude raw terminal)?
4. `…` menu content (D05) is not designed; `Arrêter la session` (T8) is assumed to live there.
5. D06 says the session limit is « réglable dans Paramètres · Serveur » but the D08 overview has no limit control (Serveur tab not designed).
6. D08 « Bloquer le mode sans autorisation » is shown as an enabled switch although the copy says the bypass mode is never offered: should it be locked/non-interactive?
7. « Notifications sur ce téléphone » is shown on the desktop frame: the toggle is per-device; desktop wording may need « sur cet appareil ».
8. Theme dropdown implies a dark theme (`Clair` selected) but no dark screens exist; only the Dark token mode is defined.
9. No destructive Button variant exists (annotation T8: « à arbitrer (voir 04) »).
10. Composer `Envoyer` disabled style uses `--border` background with a white icon (low contrast); confirm disabled semantics/aria.

## 7. Raw code files

- `.design-refs/code/D05.tsx` — complete `get_design_context` output for `214:1424` (verified: all metadata node ids present; component instances appear as calls).
- `.design-refs/code/D06.tsx`, `D07.tsx`, `D08.tsx` — `get_design_context` output for `215:1792`, `216:2035`, `217:2179` (sidebar + content). These were transcribed from the tool response (the MCP returned them inline); asset URLs inside map 1:1 to `.design-refs/assets/<uuid>.svg`.
- Treat Tailwind classes as value references only (absolute values, token fallbacks); rebuild the layout with flex/grid as described above.
