# Nuera Dev — Mobile Workspace states (S1–S5) and section 04 extensions

Figma file `nlvRWAtD1x2fKf8gVgcM0g`, page **NUERA DEV — WEB APP** (`199:3`).

- Section **03 — UI States & Flows** (`199:7`), canvas label `ÉTATS DU TÉLÉPHONE · S1 À S5` (section title on canvas: `03 — UI States & Flows · Workspace, parcours, états transversaux, téléphone`).
- Section **04 — Extensions to Existing Components** (`199:8`, 7600 × 2300).

This file is the implementation spec for those two areas. All UI copy is quoted verbatim in French (backticks). Everything else is English.

## Contents

0. [Sources, files and conventions](#0-sources-files-and-conventions)
1. [Tokens used in this part](#1-tokens-used-in-this-part)
2. [Mobile Workspace shell (shared by S1–S4)](#2-mobile-workspace-shell-shared-by-s1s4)
3. [S1 — Workspace mobile · Clavier ouvert](#3-s1--workspace-mobile--clavier-ouvert)
4. [S2 — Workspace mobile · Onglet Diff](#4-s2--workspace-mobile--onglet-diff)
5. [S3 — Workspace mobile · Onglet Git](#5-s3--workspace-mobile--onglet-git)
6. [S4 — Workspace mobile · Changer de session](#6-s4--workspace-mobile--changer-de-session)
7. [S5 — Mobile · Notification d'autorisation](#7-s5--mobile--notification-dautorisation)
8. [Section 04 — Extensions to existing components](#8-section-04--extensions-to-existing-components)
9. [Implied data model](#9-implied-data-model)
10. [Prototype links and behaviour summary](#10-prototype-links-and-behaviour-summary)
11. [Open questions and inconsistencies](#11-open-questions-and-inconsistencies)

---

## 0. Sources, files and conventions

### 0.1 Reference files

| Code | Frame / node | Size | Screenshot | Raw code / spec | Assets |
|---|---|---|---|---|---|
| S1 | `S1 · Workspace mobile · Clavier ouvert` `238:5434` | 390 × 844 | `.design-refs/screens/S1.png` | `.design-refs/code/S1.tsx` | `.design-refs/assets/states-mobile/S1/` |
| S2 | `S2 · Workspace mobile · Onglet Diff` `238:5634` | 390 × 844 | `.design-refs/screens/S2.png` | `.design-refs/code/S2.tsx` | `.design-refs/assets/states-mobile/S2/` |
| S3 | `S3 · Workspace mobile · Onglet Git` `238:5863` | 390 × 844 | `.design-refs/screens/S3.png` | `.design-refs/code/S3.tsx` | `.design-refs/assets/states-mobile/S3/` |
| S4 | `S4 · Workspace mobile · Changer de session` `239:5667` | 390 × 844 | `.design-refs/screens/S4.png` | `.design-refs/code/S4.tsx` | `.design-refs/assets/states-mobile/S4/` |
| S5 | `S5 · Mobile · Notification d'autorisation` `239:5757` | 390 × 844 | `.design-refs/screens/S5.png` | `.design-refs/code/S5.tsx` | `.design-refs/assets/states-mobile/S5/` |
| 04 icons | 37 `icon/*` components (`199:13` … `199:222`) | 24 × 24 | — | `.design-refs/code/EXT-components.json` (not icons) | `.design-refs/assets/icons/<name>.svg` |
| 04 components | 23 components / component sets + logos + note | — | `.design-refs/screens/EXT-*.png` (26 files) | `.design-refs/code/EXT-components.json` | `.design-refs/assets/logos/logo-nuera-dev-{papier,encre}.svg` |

- `S*.tsx` are the raw `get_design_context` outputs (React + Tailwind reference, **not app code**). Temporary Figma asset URLs were rewritten to the local files; the component descriptions and style hints returned by Figma are appended at the end of each file in a comment.
- `EXT-components.json` is a structured dump of every section 04 component (layout, padding, gap, radius, fills/strokes as `$variable(resolved hex)`, text content, fonts, instance props, variable modes). It was read with a **read-only** Plugin API script because the Figma MCP read quota (10 calls/min, 200/day, shared by all agents) was hit. A legend is at the top of the file. It is the most precise source for section 04.
- Screens are 1× (the server does not upscale beyond the node's natural size). Component screenshots are 1× unless the file name says `@2x`/`@3x`.
- Mobile screenshots are 390 × 844 (iPhone 14/15 class). The design breakpoint for mobile is 390.

### 0.2 Copy and character conventions (verified in the source)

- Apostrophes are the **ASCII** apostrophe `'` (U+0027) everywhere (`Répondez d'abord à la demande…`, `s'ouvre`, `d'agir`). There are **no** typographic apostrophes and **no** non-breaking spaces (U+00A0 / U+202F) in these frames; French colons use a normal space before them (`crm : ajoute …`, `Mode : demander avant d'agir`).
- Separator: middle dot `·` (U+00B7) surrounded by normal spaces. Two spaces on each side in `CPU 23 %  ·  RAM 5,1 / 16 Go` and `/ commandes  ·  @ fichiers` (keep the double spaces).
- Ellipsis is the single character `…` (U+2026) in placeholders (`Rechercher…`, `Demander une correction à Claude…`).
- Deletion counts and the diff deletion sign use the **minus sign** `−` (U+2212): `+46 −12`, `−18`. Additions use ASCII `+`.
- Guillemets with normal inner spaces in the note: `« App »`.
- Other symbols: `⌘K` (U+2318), `✓` (U+2713) in command output, `⇧` / `⌫` (keyboard mock only).
- An empty diff line holds a zero-width space (U+200B) in Figma; render an empty line.

---

## 1. Tokens used in this part

### 1.1 Variable collections present in the file

`Primitives` (Value, 12 vars) · `Color` (Light / Dark, 9 vars) · `Spacing` (Value, 15 vars) · `Layout` (Mobile 390 / Desktop 1440, 10 vars) · `Radius` (Value, 5 vars) · `Type` (Mobile 390 / Desktop 1440, 11 vars) · `App · statuts` (Value, 11 vars).

`Layout` and `Type` are **not bound** anywhere in S1–S5 or section 04 (font sizes are set by hand, see the note in §8.10).

### 1.2 Color (semantic, Light and Dark modes)

The CSS custom-property name is the one emitted by `get_design_context` (Figma code syntax). Note that the Figma variable **`surface` is emitted as `--bg`**.

| Figma variable | CSS var in code | Light | Dark |
|---|---|---|---|
| `text` | `--text` | → `ink` `#233353` | → `paper` `#FFFFFF` |
| `accent` | `--accent` | → `blue/accent-on-light` `#4368B1` | → `blue/accent-on-dark` `#A6B9DD` |
| `muted` | `--muted` | → `grey/muted-on-light` `#645E78` | → `white-alpha/62` `rgba(255,255,255,.62)` |
| `border` | `--border` | → `grey/border-on-light` `#D9DADE` | → `white-alpha/14` `rgba(255,255,255,.14)` |
| `surface` | `--bg` | → `paper` `#FFFFFF` | → `ink` `#233353` |
| `surface-raised` | `--surface-raised` | → `paper` `#FFFFFF` | → `white-alpha/5` `rgba(255,255,255,.05)` |
| `accent-pale` | `--accent-pale` | → `blue/accent-pale` `#DEE5F2` | → `blue/accent-pale` `#DEE5F2` |

### 1.3 Primitives used directly

| Figma variable | CSS var | Value |
|---|---|---|
| `ink` | `--ink` | `#233353` |
| `paper` | `--paper` | `#FFFFFF` |
| `near-black` | `--near-black` | `#141830` |
| `blue/accent-on-dark` | `--accent-on-dark` | `#A6B9DD` |
| `grey/border-on-light` | `--border-on-light` | `#D9DADE` |
| `white-alpha/10` | — | `rgba(255,255,255,.10)` |
| `white-alpha/5` | — | `rgba(255,255,255,.05)` |

### 1.4 App · statuts

| Variable | CSS var | Value | Used for |
|---|---|---|---|
| `success` | `--success` | `#2F6F4F` | done, additions, success badge text |
| `success-pale` | `--success-pale` | `#E4F1EA` | success badge/banner bg, added diff line |
| `warn` | `--warn` | `#8A6516` | permission request border/text, "M" chip, alert badge |
| `warn-pale` | `--warn-pale` | `#FBF1DC` | permission request bg, alert badge bg |
| `danger` | `--danger` | `#B4451F` | errors, deletions, interrupted |
| `danger-pale` | `--danger-pale` | `#F8E6DE` | deleted diff line, error banner |
| `en-cours` | `--en-cours` | `#E0A10F` | "running" dot and clock icon |
| `success-on-dark` | `--success-on-dark` | `#5FC48B` | dots/icons on `near-black` (sidebar, toast) |
| `warn-on-dark` | `--warn-on-dark` | `#F2C14E` | (exists; not used in these frames) |

### 1.5 Spacing and radius

| Spacing | px | | Radius | px |
|---|---|---|---|---|
| `space/1` (`--space-1`) | 4 | | `radius/sm` (`--radius-sm`) | 8 |
| `space/2` | 8 | | `radius/md` | 12 |
| `space/3` | 12 | | `radius/lg` | 20 |
| `space/4` | 16 | | `radius/xl` | 28 |
| `space/5` | 20 | | `radius/full` | 999 |
| `space/6` | 24 | | | |
| `space/8` | 32 | | | |

Unbound values that appear: 2, 3, 5, 6, 10, 14 px (paddings/gaps), radius 3 (home indicator, sheet handle, rail dots).

### 1.6 Effect styles

| Style | CSS |
|---|---|
| `Shadow/Soft` | `box-shadow: 0 14px 34px -22px rgba(20,24,48,.28)` (`#14183047`) |
| `Shadow/Float` | `box-shadow: 0 24px 50px -18px rgba(20,24,48,.55)` (`#1418308C`) |

### 1.7 Typography

- **Outfit** Regular 400 / Medium 500 / SemiBold 600 for UI text; **JetBrains Mono** Regular 400 / Medium 500 / Bold 700 for code, paths, branches, hashes, times, overlines.
- Sizes used: 26, 24, 18, 16, 15, 14, 13, 12, 11, 10 (+ 20 and 15 in the keyboard mock).
- Line height is `normal` unless stated: 20 px for 14 px message bodies; 18 px for 13 px explanatory text; 16 px for 12 px helper text; 19 px for the 13 px mono commit message; 21/22 px in the canvas note.
- Mono uppercase overlines use letter-spacing 8 % (`0.88px` at 11 px, `0.96px` at 12 px).

### 1.8 Variable modes

Terminal-like blocks set the **`Color` collection to `Dark`** on the node: `Commande` inside `Dev · Demande d'autorisation · téléphone` (`222:2711`, also inside S4) and the whole `Dev · Sortie de commande` (`203:373`), plus the `Commande` block of the desktop `Dev · Demande d'autorisation` (`203:382`). In Dark mode `surface` = `#233353`, `text` = white, `muted` = white 62 %. Implement as a `.on-dark` scope that remaps the semantic CSS vars (`--bg`, `--text`, `--muted`, `--border`, `--accent`, `--surface-raised`).

The S5 home-screen pending card shows its command in **light** mode (`--bg` + 1 px `--border`, radius sm) — not the dark block.

### 1.9 Icon rendering rule (applies everywhere)

All icons are drawn on a 24 px grid with **stroke 1.8 px, round caps, round joins, no fill**, stroke bound to `ink` in the master. When an instance is resized (20, 18, 16, 14, 13, 12 px), Figma keeps the stroke at **1.8 px absolute** (verified in the exported instance SVGs, e.g. 16 px check: `viewBox="0 0 16 16"`, `stroke-width="1.8"`). Implement with `currentColor` and a non-scaling stroke: `vector-effect: non-scaling-stroke`, or lucide-react `strokeWidth={1.8} absoluteStrokeWidth`, or `stroke-width = 1.8 × 24 / size` in a 24-unit viewBox.

---

## 2. Mobile Workspace shell (shared by S1–S4)

Same shell as M05 (`M05 · Workspace Claude Code`, `222:2732`). Root: 390 wide, full height, flex column, background `surface-raised` (`--surface-raised`, white). **No bottom tab bar** in the Workspace (component description of `Dev · Barre d'onglets`: `Absente du Workspace, qui prend tout l'écran.`).

| # | Region | Height | Spec |
|---|---|---|---|
| 1 | `Dev · Barre d'état` (`202:248`) | 47 | OS status bar mock (`9:41`, signal/wi-fi/battery glyph). In the app: **not rendered**, reserve `env(safe-area-inset-top)`. |
| 2 | `En-tête de session` | 52 | `--bg`, row, gap 2, padding-x 4 (`space/1`), items centered, sticky. |
| 3 | `État de la session` | 39 | `--bg`, row, gap 8, padding 6 16 10 16. |
| 4 | `Onglets du Workspace` | 55 | `--bg`, padding 0 16 10 16, border-bottom 1 `--border`; segmented control 44 high. |
| 5 | Content (tab body) | flex 1 | Scrolls; px 16, py 12. |
| 6 | `Saisie` | 87 (53 with keyboard) | `--bg`, border-top 1 `--border`, padding 8 12 0 12; composer row 44 + home indicator 34. |

Fixed top block = 47 + 52 + 39 + 55 = **193 px**; content = 844 − 193 − 87 = **564 px**.

### 2.1 `En-tête de session`

| Element | Spec | Copy | Behaviour |
|---|---|---|---|
| `Bouton · Retour` | 44 × 44, radius `md` 12, transparent; `icon/arrow-left` 20, stroke `text` | — | Back to where the Workspace was opened from (project detail, sessions list, home). |
| `Identité` | flex 1, column, gap 1, clip | title `Module CRM · pipeline` — Outfit SemiBold 16 `text`, ellipsis; subtitle `Nuera OS · feature/crm-core · worktree crm-core` — JetBrains Mono Regular 11 `muted`, ellipsis (truncated on screen as `worktr…`) | — |
| `Bouton · Changer de session` | 44 × 44, radius 12; `icon/worktree` 20 `text`; badge `Compteur` absolute at left 26 / top 6: bg `accent`, padding 1 5, radius full, `2` Outfit SemiBold 10 `paper` | `2` | Opens the session switcher sheet (S4). Counter = number of sessions of this project. |
| `Bouton · Actions de session` | 44 × 44, radius 12; `icon/more` 20 `text` | — | Session actions menu (overflow; content not designed here — the desktop W screens show stop / archive etc.). |

### 2.2 `État de la session`

- `Badge` (Design System, `Ton` per status, padding 4 8, radius full, Outfit Medium 12).
- Meta text JetBrains Mono 11 `muted`, flex 1, ellipsis: `12 min · vit sur VPS-3` (same string in S1–S4).

| Screen | Badge `Ton` | Badge label |
|---|---|---|
| S1 | Accent (bg `accent-pale`, text `accent`) | `En cours · 13 min` |
| S2, S3 | Succes (bg `success-pale`, text `success`) | `Terminée · 18 min` |
| S4 | Alerte (bg `warn-pale`, text `warn`) | `Autorisation demandée` |

### 2.3 `Onglets du Workspace` (segmented control)

- Container `Onglets`: height 44, bg `surface-raised`, border 1 `border`, radius `md` 12, padding 3, gap 2, four equal tabs (86 × 36 each at 390).
- Tab: radius `sm` 8, centered label 13 px. **Active**: bg `accent-pale`, Outfit SemiBold 13 `accent`. **Inactive**: no bg, Outfit Medium 13 `muted`.
- Labels: `Session`, `Fichiers`, `Diff · 4`, `Git` (the `4` = number of changed files).
- Active tab: S1 `Session`, S2 `Diff · 4`, S3 `Git`, S4 `Session`.
- Use `role="tablist"`/`tab`; each tab is a 44 px touch target (the 36 px pill sits inside the 44 px container).

### 2.4 `Saisie` (mobile composer)

- `Compositeur` row: gap 6, items centered.
  - `Bouton · Joindre un fichier`: 44 × 44, radius 12, transparent, `icon/paperclip` 20 `muted`.
  - `Champ`: flex 1, height 44, bg `surface-raised`, border 1 `border`, **radius full**, padding-x 14, Outfit Regular 14, single line with ellipsis. Placeholder colour `muted`, typed text `text`. **Focused**: border 1.5 px `accent`.
  - `Bouton · Envoyer`: 44 × 44, radius `md` 12, `icon/send` 20 stroke `surface` (white). **Enabled**: bg `accent`. **Disabled** (empty field, or waiting for an answer): bg `border` `#D9DADE`.
- Followed by `Dev · Indicateur d'accueil` (34 px; in the app this is `env(safe-area-inset-bottom)`). It disappears when the keyboard is open (S1).

---

## 3. S1 — Workspace mobile · Clavier ouvert

| | |
|---|---|
| Node | `238:5434`, 390 × 844 |
| Prototype role | Step `S1 Réponse` of path **C · Mobilité** (`S5 Notification › M05 Workspace › S1 Réponse › S2 Diff › S3 Git`) |
| Suggested route | `/sessions/[sessionId]?vue=session` (same URL as M05; the keyboard state is not a route) |

### 3.1 Layout skeleton

Status bar 47 → header 52 → status 39 → tabs 55 (`Session` active) → `Fil de la session` **307 px** (shrunk) → `Saisie` **53 px** (composer only, no home indicator) → `Clavier du système` **291 px** (OS keyboard mock).

`Fil de la session` (`238:5461`): column, gap 12 (`space/3`), **justify-content: flex-end** (bottom-anchored), padding 12 16, overflow hidden. Older items are cut at the top: only the bottom edge of the blue instruction bubble is visible.

### 3.2 Thread content (top → bottom), verbatim

1. `Dev · Message · Instruction` (clipped): `Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires.` meta `Vous · 10:42`.
2. `Dev · Ligne d'outil` `Statut=Terminé`: tool `Edit`, argument `src/modules/crm/PipelineBoard.tsx`, meta `+46 −12`; `icon/check` 16 `success`, `icon/chevron` 14 `muted`.
3. `Dev · Ligne d'outil` `Statut=Terminé`: `Write`, `src/modules/crm/__tests__/pipeline-totals.test.ts` (ellipsis), `+54`.
4. `Dev · Message · Claude`: `Claude Code` · `10:51` — `Les tests sont écrits. Je lance la suite du module pour les vérifier.` (wraps to 2 lines, 60 px).
5. `Dev · Demande d'autorisation` `État=Autorisée` (collapsed one-liner, wraps to 2 lines → 50 px): `icon/shield` 16 `muted` · `Commande autorisée une fois · npm run test -- crm` · `icon/check` 16 `success`.
6. `Dev · Message · Claude`: `10:53` — `Les dix tests passent. Je regarde s'il manque un cas.`

### 3.3 Composer and keyboard

- `Champ` is **focused** (1.5 px `accent` border) and contains the typed text `Ajoute aussi un test pour une étape vide` followed by a caret drawn as `|` (the `|` is the caret, not content). Text colour `text`.
- `Bouton · Envoyer` is **enabled** (bg `accent`).
- `Clavier du système` (`238:5565`): iOS-style French **AZERTY** keyboard mock — bg `border`, keys bg `--bg` 32 × 42 radius 8 (Outfit 20), rows `a z e r t y u i o p` / `q s d f g h j k l m` / `⇧ w x c v b n ⌫` / `123` · `espace` · `envoyer` (bottom keys Outfit 15; `123` and `envoyer` on `surface-raised`), home indicator inside. **Do not build it**; it documents the expected layout when the OS keyboard is up.

### 3.4 Components used

`Dev · Barre d'état`; header icons `icon/arrow-left`, `icon/worktree`, `icon/more` (20, `text`); `Badge` (Accent); `Dev · Message · Instruction`; `Dev · Ligne d'outil` ×2 (`Terminé`); `Dev · Message · Claude` ×2; `Dev · Demande d'autorisation` (`Autorisée`); `icon/paperclip`, `icon/send`; `Dev · Indicateur d'accueil` (inside the keyboard mock).

### 3.5 Data

Session (title, project, branch, worktree, status `En cours`, elapsed `13 min`, host `VPS-3`); thread items with timestamps `HH:MM` (24 h); tool calls (tool name, path argument, diff stats `+a −d`); resolved permission (`autorisée une fois`, command); draft message text.

### 3.6 Interactions

| Element | Behaviour |
|---|---|
| Tab `Diff · 4` | Opens S2 (prototype: dissolve 200 ms ease-out). Tabs are client-side views of the same session. |
| Tool line chevron | Expands the tool output (`Dev · Sortie de commande`). |
| Field focus | Keyboard opens; the composer stays **pinned right above the keyboard**, the home-indicator spacer collapses, header/status/tabs stay, the thread shrinks and stays scrolled to the newest item. Use `100dvh` + `<meta name="viewport" content="…, interactive-widget=resizes-content">`, with a `visualViewport` fallback. |
| `Bouton · Envoyer` | Sends the instruction to the running CLI session. The session is `En cours`, so per `Dev · Compositeur`: `En cours, l'envoi passe en file` — the message is queued and read at the end of the current step. Disabled when the field is empty. |
| `Bouton · Joindre un fichier` | Attach a file to the instruction. |
| Keyboard `envoyer` | Same as the send button (Enter submits; this is a single-line field on mobile). |

### 3.7 Notes

- The instruction bubble keeps the desktop component width (520 px) and overflows the 358 px column in Figma. On mobile implement it right-aligned with a `max-width` (≈ 85 %) and wrapping text.

---

## 4. S2 — Workspace mobile · Onglet Diff

| | |
|---|---|
| Node | `238:5634`, 390 × 844 |
| Prototype role | Step `S2 Diff` of path C |
| Suggested route | `/sessions/[sessionId]?vue=diff` (+ `&fichier=<path or index>` to deep-link a file) |

### 4.1 Layout skeleton

Shell (§2) with `Diff · 4` active; badge `Terminée · 18 min` (Succes). Content `Diff` (`238:5661`): column, gap 12, padding 12 16, 564 px, scrolls vertically. `Saisie` 87 px with home indicator.

### 4.2 Content

**`Fichier courant`** (row, gap 4, 358 × 44):

| Element | Spec | Copy |
|---|---|---|
| `Bouton · Fichier précédent` | 44 × 44, border 1 `border`, radius 12, `icon/arrow-left` 20 `text` | — |
| `Fichier` | flex 1, height 44, border 1 `border`, radius 12, padding 4 12, column gap 2, centered vertically | name `PipelineBoard.tsx` JetBrains Mono Medium 13 `text` (ellipsis); sub `1 sur 4 · +46 −12` Outfit Regular 11 `muted` |
| `Bouton · Fichier suivant` | same as previous, `icon/chevron` 20 `text` | — |

**`Lignes`**: bordered block (1 `border`, radius 12, overflow hidden), 13 × `Dev · Ligne de diff` rows of 22 px (unified diff):

| # | Type | Old | New | Sign | Code (verbatim, leading spaces kept) |
|---|---|---|---|---|---|
| 1 | Bloc | | | | `@@ -12,6 +12,8 @@` |
| 2 | Contexte | 12 | 12 | | `  const stages = useStages(projectId);` |
| 3 | Contexte | 13 | 13 | | `  const deals = useDeals(projectId);` |
| 4 | Suppression | 14 | | `−` | `  const total = deals.reduce(sum, 0);` |
| 5 | Ajout | | 14 | `+` | `  const totals = computeStageTotals(deals);` |
| 6 | Ajout | | 15 | `+` | `  const [dragged, setDragged] = useState(null);` |
| 7 | Contexte | 15 | 16 | | *(empty line)* |
| 8 | Contexte | 16 | 17 | | `  return (` |
| 9 | Bloc | | | | `@@ -41,4 +44,8 @@` |
| 10 | Contexte | 42 | 45 | | `          stage={stage}` |
| 11 | Suppression | 43 | | `−` | `          total={total}` |
| 12 | Ajout | | 46 | `+` | `          total={totals[stage.id] ?? 0}` |
| 13 | Ajout | | 47 | `+` | `          onDragStart={setDragged}` |

Long lines are truncated with an ellipsis (single line).

**Helper** (`238:5861`): `Une ligne coupée s'ouvre en entier au toucher. Le côte à côte reste réservé au bureau.` — Outfit Regular 12 / 16 `muted`.

**`Saisie`**: placeholder `Demander une correction à Claude…` (`muted`), send **disabled** (bg `border`).

### 4.3 Components used

`Badge` (Succes), `Dev · Ligne de diff` (`Bloc`, `Contexte`, `Ajout`, `Suppression`), icons `arrow-left`, `chevron`, `paperclip`, `send`.

### 4.4 Data

Changed-file list of the session (4 files), current index (1-based, `1 sur 4`), per-file `additions`/`deletions`, file basename (full path elsewhere), hunks (header `@@ -a,b +c,d @@`), lines (type, old number, new number, text).

### 4.5 Interactions

| Element | Behaviour |
|---|---|
| Previous / next file | Moves through the 4 changed files (wrap or disable at ends — not specified). Swipe left/right is a natural addition. |
| Tap a truncated line | Expands it in full (annotation above). |
| Tabs `Session` / `Git` | Prototype: to S1 / S3 (dissolve 200 ms). |
| Composer | Sends a correction request to Claude about this diff. The session is `Terminée`, so sending resumes it (cover note: `reprise par claude --resume`). |

### 4.6 Mobile-specific

Unified diff only (side-by-side is desktop-only, per the helper). Line-number gutters are fixed 40 + 40 px, sign column 20 px; code fills the rest.

---

## 5. S3 — Workspace mobile · Onglet Git

| | |
|---|---|
| Node | `238:5863`, 390 × 844 |
| Prototype role | Step `S3 Git` of path C |
| Suggested route | `/sessions/[sessionId]?vue=git` |

### 5.1 Layout skeleton

Shell with `Git` active; badge `Terminée · 18 min`. Content `Git` (`238:5890`): column, **gap 14**, padding 12 16, scrolls. The composer is **replaced** by a full-width primary action (sticky bottom bar) + home indicator.

### 5.2 Content (top → bottom)

1. **`Branche`** card: bg `--bg`, border 1 `border`, radius 12, padding 10 12, row gap 8: `icon/git-branch` 16 `text`; `feature/crm-core` JetBrains Mono Medium 13 `text` (flex 1, ellipsis); `Badge` Accent `2 en avance`.
2. **`Titre`** row: `4 fichiers à committer` Outfit SemiBold 14 `text` (flex 1); `+152 −12` JetBrains Mono 12 `muted`.
3. **`Fichiers`** list: bg `--bg`, border 1 `border`, radius 12, padding 2 4; 4 × `Dev · Fichier modifié`:

| Statut | Chip | Path | Additions | Deletions |
|---|---|---|---|---|
| Modifié | `M` | `crm/PipelineBoard.tsx` | `+46` | `−12` |
| Ajouté | `A` | `crm/pipeline-totals.ts` | `+38` | — |
| Ajouté | `A` | `crm/__tests__/pipeline-totals.test.ts` | `+54` | — |
| Modifié | `M` | `crm/Pipeline.module.css` | `+14` | — |

(Paths are shown relative to `src/modules/`; the totals add up: 46 + 38 + 54 + 14 = 152.)

4. **`Message`** (column gap 6):
   - `Libellé` row: `Message de commit` Outfit Medium 13 `text` (flex 1) + `Badge` Accent `Proposé par Claude`.
   - `Champ` (textarea): bg `--bg`, border **1.5 `accent`** (focused look), radius 12, padding 10 12; text `crm : ajoute le tableau glissable et les totaux par étape` JetBrains Mono Regular 13 / 19 `text` (wraps to 2 lines).
5. **`Options`** box: bg `--bg`, border 1 `border`, radius 12, two rows 48 px, padding-x 12, gap 12, divider between rows (border-bottom 1 `border` on the first):
   - `Pousser sur origin` (Outfit Regular 14 `text`) + `Dev · Interrupteur` `Actif=Oui`.
   - `Ouvrir une pull request` + `Dev · Interrupteur` `Actif=Oui`.
6. **Bottom bar** (`Saisie`, 87 px, border-top): `Bouton compact` `Style=Principal`, full width 366 × **44**, radius 12, padding 0 14 0 12, gap 6, centered: `icon/upload` 16 `paper` + `Committer et pousser` Outfit Medium 14 `paper`. Then home indicator.

### 5.3 Data

Branch name, commits ahead of upstream (`2 en avance`), uncommitted files with status `M/A/D` and stats, total `+152 −12`, commit message proposed by Claude (editable), options `push` and `openPullRequest` (booleans).

### 5.4 Interactions

| Element | Behaviour |
|---|---|
| File row | Opens that file in the Diff tab (desktop behaviour; implied). |
| Commit message | Editable; prefilled with Claude's proposal (badge `Proposé par Claude`). Validation: non-empty. |
| Toggles | 36 × 20 visual, 44 px touch target (component note). |
| `Committer et pousser` | Runs `git commit` (+ `git push origin <branch>` if on, + PR creation if on). Show loading, then success feedback (`Dev · Toast` `au-dessus de la saisie (téléphone)`, e.g. `Commit poussé sur origin/feature/crm-core` / `Voir sur GitHub`). In the **prototype** this button navigates to `M01 · Accueil` (`220:2366`). The label for other toggle combinations is not designed (see §11). |
| Tab `Session` | Prototype: back to S1. |

---

## 6. S4 — Workspace mobile · Changer de session

| | |
|---|---|
| Node | `239:5667`, 390 × 844 |
| Suggested route | `/sessions/[sessionId]?vue=session` with the sheet as UI state (optionally `&sheet=sessions` so the back gesture closes it) |

### 6.1 Background (Workspace, `Session` tab, waiting for a permission)

- Badge Alerte `Autorisation demandée`.
- Thread (bottom-anchored, 564 px): clipped instruction bubble (`Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires.` · `Vous · 10:42`); `Edit` `src/modules/crm/PipelineBoard.tsx` `+46 −12`; `Write` `src/modules/crm/__tests__/pipeline-totals.test.ts` `+54`; Claude `10:51` `Les tests sont écrits. Je lance la suite du module pour les vérifier.`; then **`Dev · Demande d'autorisation · téléphone`** (pending, 358 × 358) — see §8.6 for its full anatomy. Copy: `Claude demande à exécuter une commande` · `$ npm run test -- crm` · `Lance la suite Vitest du module CRM dans le worktree crm-core.` · buttons `Autoriser` / `Toujours pour npm run test` / `Refuser` · note `Mode : demander avant d'agir`.
- `Saisie`: placeholder `Répondez d'abord à la demande…`, send disabled (bg `border`) — the composer's `Attente` state.

### 6.2 Scrim and sheet

- **`Voile`** (`239:5709`): full screen 390 × 844 (covers the status bar too), `near-black` `#141830` at **opacity 0.55**. Tap = close the sheet (prototype: navigates back to `M05 · Workspace Claude Code`, dissolve 200 ms).
- **`Feuille · Sessions de Nuera OS`** (`239:5710`): bottom sheet, absolute, width 390, top 494 (height 350, hugs content), bg `--bg`, **top corners radius `xl` 28**, `Shadow/Float`, padding 8 16 0 16, column gap 4.

| Part | Spec | Copy |
|---|---|---|
| `Poignée` | centered bar 36 × 5, radius 3, bg `border`; padding-bottom 8 | — |
| `Titre` | row, padding 4 0 8; title Outfit SemiBold 18 `text` (flex 1); counter JetBrains Mono 12 `muted` | `Sessions de Nuera OS` · `2 / 4` |
| Session row (current) `Session · Module CRM · pipeline` | min-height 64, padding 12, gap 12, radius 12, **bg `accent-pale`** (selected); `Dev · Point de statut` `Ton=Alerte` 8 px; text column gap 3: title Outfit SemiBold 15 `text` ellipsis, line `icon/worktree` 13 `muted` + JetBrains Mono 11 `muted` ellipsis; `Badge` Alerte | `Module CRM · pipeline` · `feature/crm-core · worktree crm-core` · `Autorisation` |
| Session row `Session · Tests e2e du devis` | same, no bg; dot `Ton=En cours` (`#E0A10F`); `Badge` Accent | `Tests e2e du devis` · `feature/devis-pdf · worktree devis-pdf` · `En cours` |
| `Nouvelle session` | height 56, padding 12, gap 12; `Pastille` 28 × 28 radius full bg `accent-pale` with `icon/plus` 16 `accent`; label Outfit Medium 15 `accent` | `Nouvelle session dans un worktree` |
| `Toutes les sessions` | height 52, padding 12, border-top 1 `border`; label Outfit Regular 15 `text` (flex 1); `icon/chevron` 18 `muted` | `Toutes les sessions` |
| `Dev · Indicateur d'accueil` | 34 | — |

### 6.3 Data

Sessions of the current project (title, branch, worktree name, status, status tone), count `2 / 4` (see §11), selected session.

### 6.4 Interactions

| Element | Behaviour |
|---|---|
| `Bouton · Changer de session` (header) | Opens the sheet (slide up; scrim fades in). |
| Session row | Switches the Workspace to that session (`/sessions/[id]`), closes the sheet. |
| `Nouvelle session dans un worktree` | Starts the "new session" flow (new git worktree + new CLI session) for this project. |
| `Toutes les sessions` | Goes to `/sessions` (probably filtered by project). |
| Handle drag down / scrim tap / system back | Closes the sheet. |

### 6.5 Mobile-specific

Thumb-reachable sheet anchored to the bottom; rows ≥ 52 px; current session highlighted in `accent-pale`. Status dots never carry meaning alone (component note) — each row also has a badge.

---

## 7. S5 — Mobile · Notification d'autorisation

| | |
|---|---|
| Node | `239:5757`, 390 × 844 |
| Prototype role | Step `S5 Notification` (start of path C) |
| Suggested route | `/` (M01 · Accueil) with an **OS push notification** on top; the notification deep-links to `/sessions/[sessionId]?vue=session` (scrolled to the pending request, e.g. `#demande-[id]`) |

### 7.1 Layout skeleton

Status bar 47 → `Contenu défilant` (706 visible, scrolls; content is ≈ 1300 px tall) → `Dev · Barre d'onglets` `Actif=Accueil` (91). The notification banner floats at left 16 / top 52, width 358.

`Contenu défilant` (`239:5759`): column, **gap 20** (`space/5`), padding 8 16 24 16.

### 7.2 Notification banner `Notification · Nuera Dev` (`239:5839`)

bg `--bg`, radius `lg` 20, `Shadow/Float`, padding 12 14, row gap 12.

- `Icône de l'application`: 40 × 40, bg `near-black`, radius 12; inside, the `DEV` pill (bg `accent-on-dark`, radius 8, padding 2 4, `DEV` JetBrains Mono Bold 12 `near-black`, letter-spacing 0.96 px).
- `Texte` (column gap 2):
  - `Source` row: `NUERA DEV` JetBrains Mono 11 tracking 0.88 px `muted` (flex 1) · `maintenant` Outfit 12 `muted`.
  - Title `Tests e2e du devis attend votre accord` — Outfit SemiBold 15 `text`.
  - Body `npm run test -- e2e · Nuera OS · touchez pour répondre` — Outfit 13 / 18 `muted`.
- This is drawn by the **OS**; it specifies the Web Push payload: title = `<session> attend votre accord`, body = `<command> · <project> · touchez pour répondre`, app badge = the `DEV` icon. Cover note (validation point): `Notifications au téléphone : application web installable et notifications push, ou relais par un service tiers.` → PWA (manifest + service worker + Web Push).
- Tap (prototype): opens `M05 · Workspace Claude Code`.

### 7.3 Home content (top → bottom), verbatim

1. **`En-tête`** (row gap 8): title `Bonjour Nezar` Outfit SemiBold 26 `text`; subtitle `Mer. 4 nov. · tout est disponible` Outfit 13 `muted`. `Bouton · Notifications` 44 × 44, bg `--bg`, border 1 `border`, radius 12, `icon/bell` 20 `text`.
2. **`États`** chips (row gap 8): each bg `success-pale`, radius full, padding 6 10, gap 6, `Dev · Point de statut` `Succès` + Outfit Medium 12 `success`: `VPS-3 en ligne`, `Claude Code connecté`.
3. **`Demande en attente`** card: bg `warn-pale`, border 1 `warn`, radius `lg` 20, padding 16, gap 10.
   - Title row (gap 8): `icon/alert` 18 `warn` + `Une session attend votre accord` Outfit SemiBold 15 `text`.
   - `Tests e2e du devis · Nuera OS` Outfit 13 `muted`.
   - `Commande` (light): bg `--bg`, border 1 `border`, radius 8, padding 8 10: `$ npm run test -- e2e` JetBrains Mono 12 `text`.
   - `Bouton · Répondre`: Bouton compact Principal, full width, **44 high**, no icon, `Répondre`.
4. **`Reprise rapide`** card: bg `--bg`, radius 20, `Shadow/Soft`, padding 16, gap 10.
   - Header (gap 8): `icon/history` 16 `accent` + `REPRISE RAPIDE` JetBrains Mono 11 tracking 0.88 px `muted` (flex 1) + `Badge` Accent `En cours`.
   - `Module CRM · pipeline` Outfit SemiBold 18 `text`.
   - `Contexte` (gap 6): `icon/worktree` 14 `muted` + `Nuera OS · feature/crm-core` JetBrains Mono 11 `muted`.
   - `Avancement` (gap 8): `icon/clock` 16 `en-cours` + `Plan 3 / 5 · écrit les tests` Outfit 13 `muted`.
   - `Bouton · Reprendre la session`: Bouton compact Secondaire, full width, 44 high, `icon/play` 16 `ink` + `Reprendre la session`.
5. **Overline** `SESSIONS ACTIVES · 2` (JetBrains Mono 11, tracking 0.88 px, `muted`) + link `Tout voir` (Outfit Medium 13 `accent`).
6. **`Rail · sessions actives`**: horizontal row, gap 12, two `Dev · Carte de session` at width 290 (second one peeks off-screen → horizontal scroll with snap):
   - `Statut=En cours`: `En cours` · `12 min` · `Module CRM · pipeline` · `Nuera OS` · `feature/crm-core · worktree crm-core` · `Écrit les tests de pipeline-totals.ts` · button `Ouvrir` (Secondaire).
   - `Statut=Autorisation`: `Autorisation demandée` · `2 min` · `Tests e2e du devis` · `Nuera OS` · `feature/devis-pdf · worktree devis-pdf` · `Attend votre accord pour npm run test -- crm` · button `Répondre` (Principal).
7. **`Indicateur du rail`**: centered dots, gap 6: active pill 18 × 6 radius 3 `accent`; inactive 6 × 6 radius 3 `border`.
8. **Overline** `PROJETS RÉCENTS` + link `Tous`.
9. **`Projets récents`** card (bg `--bg`, radius 20, `Shadow/Soft`, padding 16), rows padding-y 12, gap 12, divider 1 `border` except last; row = name Outfit SemiBold 15 `text` / branch JetBrains Mono 11 `muted` (ellipsis), `Badge`, `icon/chevron` 16 `muted`:
   - `Nuera OS` · `feature/crm-core` · Succes `À jour`
   - `Atelier Lune` · `feature/galerie-photos` · Alerte `2 en retard`
   - `Kiné Rive Gauche` · `fix/tarifs-mobile` · Succes `À jour`
10. **Overline** `DERNIÈRES MODIFICATIONS`.
11. **`Dernières modifications`** card (same card style), commit rows padding-y 12, gap 10: `icon/git-commit` 16 `muted`; message Outfit 14 `text` (ellipsis); meta JetBrains Mono 11 `muted`:
    - `crm : ajoute les colonnes glissables` · `a3f9c12 · Nuera OS · il y a 6 min`
    - `crm : calcule le total de chaque étape` · `7b21e04 · Nuera OS · il y a 9 min`
12. **`Dev · Barre d'onglets`** `Actif=Accueil` (see §8.3), Sessions tab counter `2`.

### 7.4 Data

User first name; today's date (`Mer. 4 nov.` = abbreviated French weekday + day + abbreviated month); global availability (`tout est disponible`); server status (`VPS-3 en ligne`); CLI connection (`Claude Code connecté`); pending permission requests (session, project, command); last active session with plan progress (`3 / 5`, current step); active sessions; recent projects with sync state (`À jour`, `N en retard`); recent commits (short SHA 7 chars, message, project, relative time `il y a N min`).

### 7.5 Interactions

| Element | Behaviour |
|---|---|
| Notification banner | Opens the Workspace of `Tests e2e du devis` on its pending request. |
| `Bouton · Notifications` | Opens notifications (panel not designed in these frames). |
| `Répondre` (pending card) | Same destination as the notification. |
| `Reprendre la session` | Opens/resumes `Module CRM · pipeline` in the Workspace. |
| `Tout voir` | `/sessions`. `Tous` → `/projets`. |
| Session cards | `Ouvrir` → Workspace; `Répondre` → Workspace on the request. Horizontal swipe; dots reflect the visible card. |
| Project row | `/projets/[projectId]`. |
| Commit row | Not specified (commit detail / GitHub). |
| Tab bar | Prototype targets: `Accueil` → M01 (`220:2366`), `Projets` → M02 (`220:2575`), `Sessions` → M06 (`223:2787`), `Intégrations` → M07 (`223:2966`), `Paramètres` → M08 (`226:2985`). |

---

## 8. Section 04 — Extensions to existing components

### 8.0 Section layout and canvas labels (verbatim)

Every label is JetBrains Mono 12, `muted`, letter-spacing 8 %.

| Node | x, y | Label |
|---|---|---|
| `240:5880` | 80, 100 | `ICÔNES · 37 ajouts, même dessin que les icônes de Nuera OS (24 px, trait 1,8, extrémités rondes, jeton ink)` |
| `240:5881` | 80, 300 | `LOGO` |
| `240:5882` | 80, 490 | `NAVIGATION · bureau` |
| `240:5883` | 1560, 490 | `NAVIGATION · Workspace` |
| `240:5884` | 2160, 490 | `NAVIGATION · téléphone` |
| `240:5885` | 2700, 490 | `PRIMITIVES` |
| `240:5886` | 3300, 490 | `WORKSPACE · fil de session` |
| `240:5887` | 4100, 490 | `WORKSPACE · décisions et saisie` |
| `240:5888` | 4900, 490 | `WORKSPACE · Git et lignes` |
| `240:5889` | 6100, 490 | `SESSIONS` |

Component-set frames on the canvas use a dashed 1 px `border` outline (dash 6/4) — documentation styling, not part of the components.

### 8.1 Icons

#### 8.1.1 Common spec

- 37 components `icon/<name>`, each 24 × 24, no description, transparent background.
- Vector paths only; **stroke 1.8, `stroke-linecap: round`, `stroke-linejoin: round`, fill none**; stroke colour bound to `ink` (`#233353`). Colour is always overridden per context (table 8.1.4).
- Exported SVGs (exact Figma geometry, unedited): `.design-refs/assets/icons/<name>.svg` (stroke hard-coded `#233353`; use `currentColor` in the icon component).
- Sizes used on instances: 20 (header buttons, tab bar, rail), 18 (sidebar, banners, toast), 16 (lines, buttons), 14, 13, 12.
- Rendering: absolute 1.8 px stroke at every size (§1.9).

#### 8.1.2 The 37 section 04 icons and their Lucide equivalents

Geometry was compared programmatically (symmetric point-to-segment Hausdorff distance, stroke ignored) against `lucide-static` 0.300.0, 0.400.0, 0.468.0, 0.520.0 and 1.68.0. "Exact" = distance ≤ 0.01 px (only Bézier-vs-arc rounding). Stroke width differs from Lucide's default 2 → always pass `strokeWidth={1.8}`.

| Icon | Node | Lucide name | Exact geometry in lucide-static |
|---|---|---|---|
| `terminal` | `199:13` | `terminal` | all tested (0.300 → 1.68) |
| `git-branch` | `199:20` | `git-branch` | 0.300 – 0.520 (redrawn in 1.x) |
| `git-commit` | `199:26` | `git-commit-horizontal` (old name `git-commit`) | all tested |
| `git-pull-request` | `199:33` | `git-pull-request` | all tested |
| `worktree` | `199:41` | `git-fork` | all tested |
| `file` | `199:46` | `file` | 0.400 – 0.520 |
| `file-diff` | `199:53` | `file-diff` | 0.400 – 0.520 |
| `folder` | `199:57` | `folder` | all tested |
| `play` | `199:61` | `play` | 0.400 – 0.520 (0.300 shifted 1 px; 1.x rounded) |
| `stop` | `199:65` | **none** (custom: rounded square 14 × 14 at (5,5), r 2; Lucide `square` is 18 × 18 at (3,3)) | — |
| `pause` | `199:70` | `pause` | 0.400 – 0.520 |
| `refresh` | `199:77` | `refresh-cw` | all tested |
| `github` | `199:82` | `github` | 0.300 – 0.520 (brand icons removed in Lucide 1.x) |
| `figma` | `199:90` | `figma` | 0.300 – 0.520 (removed in 1.x) |
| `star` | `199:94` | `star` (old sharp polygon) | 0.300 – 0.400 only (0.468+ uses rounded points) |
| `archive` | `199:100` | `archive` | all tested |
| `key` | `199:106` | `key` (old) | 0.300 only (redrawn from 0.400) |
| `cpu` | `199:112` | `cpu` | 0.400 – 0.468 |
| `lock` | `199:117` | `lock` | all tested |
| `x` | `199:122` | `x` | all tested |
| `arrow-left` | `199:127` | `arrow-left` | all tested |
| `chevron-down` | `199:131` | `chevron-down` | all tested |
| `more` | `199:137` | `ellipsis` (old `more-horizontal`) | all tested |
| `plug` | `199:144` | `plug` | 0.300 – 0.520 |
| `history` | `199:150` | `history` (renamed `rotate-ccw-clock` in 1.x) | all tested (exact as `rotate-ccw-clock` in 1.68) |
| `wifi-off` | `199:160` | `wifi-off` | 0.400 → 1.68 |
| `eye` | `199:165` | `eye` | 0.468 → 1.68 |
| `monitor` | `199:171` | `monitor` | all tested |
| `smartphone` | `199:176` | `smartphone` | all tested |
| `trash` | `199:182` | `trash` | 0.300 – 0.520 |
| `upload` | `199:188` | `upload` | all tested |
| `pull` | `199:194` | `arrow-down-to-line` | all tested |
| `panel-right` | `199:199` | `panel-right` | all tested |
| `external` | `199:205` | `external-link` | all tested |
| `filter` | `199:209` | `filter` (old polygon) | 0.300 – 0.468 (renamed `funnel` and redrawn with rounded corners from 0.5xx) |
| `list-checks` | `199:217` | `list-checks` | 0.300 – 0.520 |
| `home` | `199:222` | `house` (old `home`) | 0.400 → 1.68 |

No single Lucide release reproduces all 37. **lucide 0.468.0 matches 34/37** (all except `star`, `key`, `stop`); 0.400.0 also 34/37 (all except `eye`, `key`, `stop`). Recommendation: build the icon set from the exported SVGs (exact), or use `lucide-react@0.468.0` with `strokeWidth={1.8} absoluteStrokeWidth` and the exported SVGs for `star`, `key` and `stop`.

#### 8.1.3 Nuera OS icons used by these frames (not in section 04)

Masters live on page `Nuera OS`; also exported to `.design-refs/assets/icons/` (same 1.8 stroke style). The canvas note calls them `25 icônes de Nuera OS`.

| Icon | Master node | Lucide |
|---|---|---|
| `chevron` | `57:108` | `chevron-right` (exact) |
| `plus` | `57:69` | `plus` (exact) |
| `search` | `57:62` | custom (circle r 7 at (11,11) + handle to (20,20)) |
| `projets` | `57:36` | custom folder |
| `reglages` | `57:58` | custom sliders (3 lines + 3 knobs) |
| `check` | `57:83` | custom (`M5 12 L10 17 L19 7`) |
| `clock` | `57:105` | custom (circle r 9, hands to (12,7) and (15,14)) |
| `alert` | `99:3248` | custom sharp triangle + `!` |
| `shield` | `99:3219` | custom shield with check |
| `minus` | `57:89` | custom (`M6 12 H18`) |
| `paperclip` | `57:111` | custom |
| `send` | `57:76` | custom paper plane |
| `bell` | `57:66` | custom |

#### 8.1.4 Icon colour by context (instance overrides)

| Context | Icon(s) and colour token |
|---|---|
| Mobile session header | `arrow-left`, `worktree`, `more` 20 → `text` |
| Composer | `paperclip` → `muted`; `send` → `surface` (white) on `accent` / `border` button |
| `Dev · Ligne d'outil` | `Terminé` `check` → `success`; `En cours` `clock` → `en-cours`; `Erreur` `alert` → `danger`; `Refusé` `x` → `muted`; chevron 14 → `muted` |
| `Dev · Message · Claude` | `terminal` 16 → `accent` (on `accent-pale` 28 px pastille) |
| `Dev · Demande d'autorisation` | `En attente`: `shield` 18 → `warn`, `check` 16 → `paper`, `x` 16 → `accent`; `Autorisée`: `shield` → `muted`, `check` → `success`; `Refusée`: `shield` → `muted`, `x` → `danger` |
| Phone permission request | `shield` 20 → `warn`, `check` → `paper`, `x` → `accent` |
| `Dev · Plan de travail` | `list-checks` → `accent`; done `check` → `success`; current `clock` → `en-cours`; pending `minus` → `muted` |
| `Dev · Compositeur` | `paperclip` 18 → `muted`; `send` 18 → `paper` (ready) / `surface` (disabled); `stop` 16 → `ink` |
| `Dev · Bandeau` | Info `alert` → `accent`; Succès `check` → `success`; Alerte `alert` → `warn`; Erreur `alert` → `danger`, button `refresh` → `ink` |
| `Dev · Toast` | `check` 18 → `success-on-dark` |
| `Dev · Ligne de projet` | `star` → `accent`; `github` 12, `git-branch` 14, `more` 18 → `muted` |
| `Dev · Ligne d'historique` | `terminal` 16, `git-branch` 13 → `muted` |
| `Dev · Carte de session` | `projets` 14, `worktree` 14 → `muted` |
| `Dev · Champ` | `search` 16, `chevron-down` 16 → `muted` |
| Sidebar (dark) | inactive → `blue/accent-on-dark`; active → `paper`; `search` 16 → `accent-on-dark` |
| Tab bar | active → `accent`; inactive → `muted` |
| S3 | `git-branch` 16 → `text`; `upload` 16 → `paper` |
| S4 sheet | `worktree` 13 → `muted`; `plus` 16 → `accent`; `chevron` 18 → `muted` |
| S5 | `bell` → `text`; `alert` 18 → `warn`; `history` 16 → `accent`; `clock` 16 → `en-cours`; `play` 16 → `ink`; `git-commit` 16, `chevron` 16, `worktree` 14 → `muted` |

### 8.2 Logos

| Component | Node | Use | Export |
|---|---|---|---|
| `Logo Nuera Dev · papier` | `201:41` | On dark backgrounds (sidebar). White Nuera wordmark (`Logo Nuera · papier`, 136 × 27.61) + `DEV` pill bg `blue/accent-on-dark`, text `near-black`. | `.design-refs/assets/logos/logo-nuera-dev-papier.svg`, `EXT-logo-papier@2x.png` |
| `Logo Nuera Dev · encre` | `201:80` | On light backgrounds. Ink `#233353` wordmark + `DEV` pill bg `accent`, text `paper`. | `.design-refs/assets/logos/logo-nuera-dev-encre.svg`, `EXT-logo-encre@2x.png` |

Both 176 × 27.61, row gap 8, items centered. Pill: padding 2 4, radius 8, `DEV` JetBrains Mono Bold 12, letter-spacing 8 % (live text in Figma; outlined in the SVG export). Description (both): `Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction que la pastille OS de Nuera OS).`

### 8.3 Navigation

#### `Dev · Barre latérale` — component set `201:732` (screenshot `EXT-barre-laterale.png`)

- Description: `Navigation globale de Nuera Dev au bureau. Dérivée de la Barre latérale de Nuera OS (mêmes jetons, mêmes entrées). Ajoute la carte État du serveur. Le Workspace utilise la version repliée.`
- Property `Actif` = `Accueil` (default) | `Projets` | `Sessions` | `Intégrations` | `Paramètres`. Variants 248 × 1120: `201:431`, `201:432`, `201:478`, `201:524`, `201:570`.
- Container: column, padding 20 16 16 16, gap 16, bg `near-black`, full height.
  1. `Logo` (padding-left 8): `Logo Nuera Dev · papier`.
  2. `Recherche` (216 × 32): bg `white-alpha/5`, radius 8, padding 8 12, gap 8: `icon/search` 16, `Rechercher…` Outfit 13 `accent-on-dark` (flex 1), `⌘K` JetBrains Mono Medium 11 `accent-on-dark`. Opens global search (⌘K).
  3. `Navigation` (column gap 16), two groups:
     - Group label (padding 0 0 8 12): `ESPACE` / `CONFIGURATION` — JetBrains Mono Medium 10, `accent-on-dark` at opacity 0.6.
     - Item 216 × 34: padding 8 12, gap 12, radius 8; icon 18 + label Outfit 14 (flex 1). **Inactive**: icon/label `accent-on-dark`, Medium. **Active**: bg `white-alpha/10`, icon/label `paper`, SemiBold.
     - `ESPACE`: `Accueil` (`home`), `Projets` (`projets`), `Sessions` (`terminal`) + counter pill (bg `accent`, radius full, padding 1 4, `2` Outfit SemiBold 11 `paper`).
     - `CONFIGURATION`: `Intégrations` (`plug`), `Paramètres` (`reglages`).
  4. `Espace` (flex filler).
  5. `État du serveur` card: bg `white-alpha/5`, radius 12, padding 12, gap 8: dot 8 `success-on-dark` + `VPS-3 · OVH Gravelines` Outfit SemiBold 13 `paper`; `CPU 23 %  ·  RAM 5,1 / 16 Go` JetBrains Mono 11 `accent-on-dark`; dot 8 `success-on-dark` + `Claude Code connecté` Outfit 12 `accent-on-dark`.
  6. `Utilisateur`: bg `white-alpha/5`, radius 12, padding 8, gap 8: `Avatar` 36 (`NZ`) + `Nezar` Outfit SemiBold 13 `paper` / `Propriétaire · double facteur actif` Outfit 11 `accent-on-dark`.
- Data: server name and provider, CPU %, RAM used/total (French decimal comma, `Go`), CLI connection, user name, role, 2FA state, active-session count.

#### `Dev · Barre latérale repliée` — set `201:893` (`EXT-barre-laterale-repliee.png`)

- Description: `Rail de 72 px pour le Workspace : la navigation globale reste à un clic, la session prend la place. Libellés absents à l'écran, à porter en aria-label.`
- `Actif` = same 5 values; variants 72 × 1120 (`201:764`, `201:796`, `201:828`, `201:860`, `201:892`).
- Column, padding 20 12 16 12, gap 8, items centered, bg `near-black`: `DEV` pill (32 × 20, bg `accent-on-dark`, radius 8, `DEV` JetBrains Mono Bold 12 `near-black`, 8 % tracking) → 8 × 16 spacer → items 48 × 40 radius 8 with icon 20 (`Accueil`, `Projets`, `Sessions` — no counter) → `Séparateur` 32 × 1 `white-alpha/10` → `Intégrations`, `Paramètres` → flex spacer → `Avatar` 36 `NZ`. Active item: bg `white-alpha/10`, icon `paper`; inactive icon `accent-on-dark`. Each item needs `aria-label` = the full label.

#### `Dev · Barre d'onglets` — set `202:452` (`EXT-barre-onglets.png`)

- Description: `Navigation globale au téléphone, au pouce : les 5 entrées de la barre latérale. Absente du Workspace, qui prend tout l'écran. Cible de 78 × 56 px, au-dessus du minimum de 44.`
- `Actif` = same 5; variants 390 × 91 (`202:291`, `202:331`, `202:371`, `202:411`, `202:451`).
- Column, bg `surface`, border-top 1 `border`: `Onglets` row 56 high, 5 equal tabs (78 × 56): column, padding 8 0 6 0, gap 4, items centered. Icon holder 44 × 24 radius full (active: bg `accent-pale`), icon 20 (active `accent`, inactive `muted`). Label Outfit 11 (active SemiBold `accent`, inactive Medium `muted`): `Accueil`, `Projets`, `Sessions`, `Intégrations`, `Paramètres`. `Sessions` counter: absolute (30, −2) on the icon holder, bg `accent`, radius full, padding 1 5, `2` Outfit SemiBold 10 `paper`. Then `Dev · Indicateur d'accueil` (34).

#### `Dev · Barre d'état` — component `202:248` (`EXT-barre-etat@2x.png`)

390 × 47, row, padding 14 24 0 32, space-between: `9:41` Outfit SemiBold 16 `text`; `Réseau, wi-fi, batterie` 68 × 13 vector glyph (fills/stroke `text`). Description: `Barre d'état du téléphone (zone de sécurité haute, 47 px). Ses couleurs suivent le rôle text.` → app: `env(safe-area-inset-top)`, `theme-color`/status-bar style from `text`.

#### `Dev · Indicateur d'accueil` — component `202:251` (`EXT-indicateur-accueil@2x.png`)

390 × 34, centered bar 134 × 5, radius 3, `text`. Description: `Zone de sécurité basse (34 px).` → app: `env(safe-area-inset-bottom)` padding, not a drawn bar.

### 8.4 Primitives

#### `Dev · Interrupteur` — set `202:459` (`EXT-interrupteur@3x.png`)

- Description: `Même dessin que l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y est réservé à ChatGPT. Zone tactile de 44 px à prévoir autour.`
- `Actif` = `Oui` (default, `202:455`) | `Non` (`202:458`). 36 × 20, radius 12 (pill), knob 16 × 16 circle `surface` at y 2. `Oui`: track `accent`, knob x 18. `Non`: track `border`, knob x 2.
- Implement as `role="switch"` + `aria-checked`, 44 × 44 hit area; animate the knob.

#### `Dev · Point de statut` — set `202:478` (`EXT-point-statut@3x.png`)

- Description: `Pastille de 8 px qui précède un libellé d'état. Ne porte jamais seule l'information : toujours avec un texte.`
- `Ton` = `Succès` (`success`) | `En cours` (`en-cours`) | `Alerte` (`warn`) | `Danger` (`danger`) | `Neutre` (`muted`) | `Accent` (`accent`). 8 × 8 circle. Nodes `202:462`, `202:465`, `202:468`, `202:471`, `202:474`, `202:477`. Decorative (`aria-hidden`), always next to text.

#### `Dev · Champ` — set `202:503` (`EXT-champ@2x.png`)

- Description: `Champ de saisie et liste déroulante. Fond surface et bordure border, comme le compositeur de Nuera OS ; le champ de recherche de Nuera OS, sans bordure, reste réservé aux barres latérales.`
- Properties: `Texte` (text, default `Rechercher…`), `Avec icône` (boolean, true), `Icône` (instance swap, `icon/search`), `Déroulant` (boolean, false → shows `icon/chevron-down` 16 at the right), `État` = `Repos` | `Focus` | `Erreur`.
- 320 × 40, row, padding 8 12, gap 8, radius 12, bg `surface`; Outfit Regular 14. `Repos`: border 1 `border`, text `muted` (placeholder). `Focus`: border **1.5** `accent`, text `text`. `Erreur`: border 1.5 `danger`, text `text`. Leading icon 16 `muted`.

### 8.5 Workspace · fil de session

#### `Dev · Message · Instruction` — component `203:318` (`EXT-message-instruction.png`)

- Description: `Instruction envoyée à la session Claude Code. Même bulle que les messages sortants de Nuera OS.`
- 680 wide row, justify end. `Bulle`: width 520 (desktop), column, padding 12 16, gap 4, radius `lg` 20, bg `accent`; text Outfit 14 / 20 `paper`; meta JetBrains Mono 11 `accent-on-dark`. Master copy: `Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires. Respecte CLAUDE.md.` · `Vous · 10:42`.

#### `Dev · Message · Claude` — component `203:329` (`EXT-message-claude.png`)

- Description: `Texte produit par Claude Code dans la session. Rendu lisible de la sortie du CLI ; la vue Terminal montre le flux brut.`
- Row gap 12, align top: `Pastille` 28 × 28 radius 8 bg `accent-pale` + `icon/terminal` 16 `accent`; `Contenu` column gap 4: header row gap 8 (`Claude Code` Outfit SemiBold 13 `text` + time JetBrains Mono 11 `muted`), body Outfit 14 / 20 `text`. Master copy: `Claude Code` · `10:43` · `Je commence par lire les conventions du dépôt et la structure du module CRM.`

#### `Dev · Ligne d'outil` — set `203:369` (`EXT-ligne-outil.png`)

- Description: `Une action de Claude Code (Read, Edit, Write, Bash, Glob…), repliée. Le chevron déplie sa sortie (Dev · Sortie de commande).`
- `Statut` = `Terminé` (`203:338`) | `En cours` (`203:348`) | `Erreur` (`203:358`) | `Refusé` (`203:368`).
- 680 × 34 row, padding 8 12, gap 10, radius 12, bg `surface`, border 1 `border` (`Erreur`: border `danger`). Children: status icon 16; `Outil` JetBrains Mono Medium 12 `text`; `Argument` JetBrains Mono 12 `muted`, flex 1, one line, ellipsis; `Méta` JetBrains Mono 11 `muted` (`Erreur`: `danger`); `icon/chevron` 14 `muted`.

| Statut | Icon | Copy (tool · argument · meta) |
|---|---|---|
| Terminé | `check` `success` | `Edit` · `src/modules/crm/PipelineBoard.tsx` · `+142 −18` |
| En cours | `clock` `en-cours` | `Edit` · `src/modules/crm/PipelineBoard.tsx` · `en cours · 38 s` |
| Erreur | `alert` `danger` | `Bash` · `npm run test -- crm` · `code 1 · 2 échecs` |
| Refusé | `x` `muted` | `Edit` · `src/modules/crm/PipelineBoard.tsx` · `refusé` |

- Behaviour: whole row toggles (button with `aria-expanded`); expanded content = `Dev · Sortie de commande`. Running time ticks live (`38 s`).

#### `Dev · Sortie de commande` — component `203:373` (`EXT-sortie-commande.png`)

- Description: `Sortie brute d'une commande, sur le mode Dark de la collection Color (l'équivalent de .on-dark). Texte exact du terminal, jamais reformulé.`
- 680 wide, column, padding 12 16, gap 2, radius 12, bg `surface` in **Dark** (`#233353`). `Commande` JetBrains Mono 12 `text` (white): `$ npm run test -- crm`. `Sortie` JetBrains Mono 12 / 18 `muted` (white 62 %), whitespace preserved:

```
 ✓ pipeline-totals.test.ts (6 tests) 41 ms
 ✓ PipelineBoard.test.tsx (4 tests) 212 ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

- Render as `<pre>`; never reformat (no ANSI colouring is shown; errors would use `danger-pale` per gap #2 of the note).

### 8.6 Workspace · décisions et saisie

#### `Dev · Demande d'autorisation` — set `203:423` (`EXT-demande-autorisation.png`)

- Description: `Demande de permission du CLI. Trois choix au plus, dans l'ordre du CLI. Une fois tranchée, la carte se replie en une ligne et l'historique la garde.`
- `État` = `En attente` (`203:405`, 680 × 211) | `Autorisée` (`203:413`, 680 × 34) | `Refusée` (`203:422`, 680 × 34).
- **En attente**: column, padding 16, gap 12, radius `lg` 20, bg `warn-pale`, border 1 `warn`.
  - `En-tête` row gap 10: `icon/shield` 18 `warn`; `Claude demande à exécuter une commande` Outfit SemiBold 14 `text` (flex 1); `Badge` Alerte `En attente`.
  - `Commande` (Dark mode): padding 10 12, radius 12, bg `#233353`: `$ npm run test -- crm` JetBrains Mono 13 white.
  - `Explication` Outfit 13 / 18 `muted`: `Lance la suite Vitest du module CRM dans le worktree crm-core. Lecture et écriture limitées au dépôt.`
  - `Actions` row gap 8: `Bouton compact` Principal `Autoriser` (`check`); Secondaire `Toujours pour npm run test` (no icon); Discret `Refuser` (`x`). All 36 high on desktop.
  - `Note` JetBrains Mono 11 `warn`: `Mode : demander avant d'agir · la réponse est transmise au CLI`.
- **Autorisée** (one line, like a tool line: padding 8 12, gap 10, radius 12, bg `surface`, border 1 `border`): `icon/shield` 16 `muted` · `Commande autorisée une fois · npm run test -- crm` (JetBrains Mono 12 `muted`, flex 1) · `icon/check` 16 `success`.
- **Refusée**: `icon/shield` 16 `muted` · `Commande refusée · Claude a été prévenu` · `icon/x` 16 `danger`.
- Behaviour: buttons map 1:1 to the CLI permission prompt options, in the CLI's order (max 3). After a decision the card collapses into the one-liner, which stays in the thread history. While pending, the composer is in `Attente` and the session status is `Autorisation demandée`.

#### `Dev · Demande d'autorisation · téléphone` — component `222:2731` (`EXT-demande-autorisation-telephone@2x.png`)

- Description: `Demande d'autorisation au téléphone : les trois choix empilés, pleine largeur, 44 px chacun, dans la zone du pouce.`
- 358 × 358, column, padding 16, gap 12, radius 20, bg `warn-pale`, border 1 `warn`.
  - `En-tête` row gap 10, align top: `icon/shield` 20 `warn`; `Claude demande à exécuter une commande` Outfit SemiBold 15 / 20 `text` (wraps 2 lines).
  - `Commande` (**Color = Dark**): padding 10 12, radius 12, bg `#233353`; `$ npm run test -- crm` JetBrains Mono 13 white.
  - `Explication` Outfit 13 / 18 `muted`: `Lance la suite Vitest du module CRM dans le worktree crm-core.`
  - `Actions` column gap 8, each **full width × 44**, content centered: `Bouton · Autoriser` (Principal, `check` 16 `paper`, `Autoriser`); `Bouton · Toujours pour npm run test` (Secondaire, `Toujours pour npm run test`); `Bouton · Refuser` (Discret, `x` 16 `accent`, `Refuser`).
  - `Note` JetBrains Mono 11 `warn`: `Mode : demander avant d'agir`.
- No `En attente` badge on the phone version.

#### `Dev · Plan de travail` — component `203:455` (`EXT-plan-de-travail.png`)

- Description: `Liste de tâches tenue par Claude Code pendant la session, telle que le CLI l'expose. Rien n'est estimé par Nuera Dev.`
- 680 wide, column, padding 16, gap 10, radius 20, bg `surface`, border 1 `border`.
  - Header row gap 8: `icon/list-checks` 16 `accent`; `Plan de travail` Outfit SemiBold 14 `text` (flex 1); `3 / 5` JetBrains Mono 12 `muted`.
  - Steps (row gap 10, icon 16 + label Outfit 13):
    - done (`check` `success`, label `muted`, **strikethrough**): `Lire CLAUDE.md et la structure du module`, `Créer PipelineBoard.tsx avec colonnes glissables`, `Calculer le total par étape`
    - current (`clock` `en-cours`, Outfit **Medium** 13 `text`): `Écrire les tests de pipeline-totals.ts`
    - pending (`minus` `muted`, Regular 13 `text`): `Lancer la suite de tests du module`
- Data: the CLI's todo list (status `completed` / `in_progress` / `pending`, content). Counter = completed / total.

#### `Dev · Compositeur` — set `203:497` (`EXT-compositeur.png`)

- Description: `Saisie envoyée au CLI. En cours, l'envoi passe en file et Interrompre envoie Échap au processus. En attente d'autorisation, la saisie est suspendue.`
- `État` = `Prêt` (`203:467`) | `En cours` (`203:484`) | `Attente` (`203:496`); each 680 × 92.
- Column, padding 12 12 12 16, gap 10, radius 20, bg `surface`, border 1 `border`.
  - `Texte` (textarea placeholder) Outfit 14 / 20 `muted`:
    - Prêt: `Écrire une instruction à Claude…`
    - En cours: `Ajouter une précision pour Claude, elle sera lue à la fin de l'étape en cours…`
    - Attente: `Répondez d'abord à la demande d'autorisation ci-dessus…`
  - `Barre` row gap 8, items centered: `icon/paperclip` 18 `muted`; `Badge` Neutre `Mode : demander avant d'agir` (bg `surface-raised`, text `muted`); `Aide` JetBrains Mono 11 `muted` `/ commandes  ·  @ fichiers` (flex 1); [En cours only] `Bouton compact` Secondaire `Interrompre · Échap` with `icon/stop`; `Envoyer` 36 × 36 radius 12 — Prêt: bg `accent`, `send` 18 `paper`; En cours / Attente: bg `border`, `send` 18 white (disabled look).
- Behaviour: `/` opens slash-command completion, `@` opens file completion; Enter sends (Shift+Enter newline on desktop); `Interrompre · Échap` (and the Esc key) sends Escape to the CLI process; queued messages while running; input disabled while a permission is pending. The mode badge reflects the CLI permission mode.

### 8.7 Workspace · Git et lignes

#### `Dev · Ligne de diff` — set `203:534` (`EXT-ligne-diff.png`)

- Description: `Ligne de diff unifiée. Le signe double la couleur : la lecture ne dépend jamais du vert et du rouge seuls.`
- `Type` = `Bloc` (`203:506`) | `Contexte` (`203:515`) | `Ajout` (`203:524`) | `Suppression` (`203:533`); 640 × 22.
- Row, items centered, clip: `Ancienne ligne` 40 × 22 (right-aligned, padding-right 8) and `Nouvelle ligne` 40 × 22 — JetBrains Mono 11 `muted`; `Signe` 20 × 22 centered, JetBrains Mono Bold 12; `Code` JetBrains Mono 12, flex 1, one line, ellipsis, whitespace preserved.

| Type | Row bg | Sign | Code colour | Example |
|---|---|---|---|---|
| Bloc | `accent-pale` | blank | `accent` | `@@ -12,6 +12,24 @@ export function PipelineBoard()` (numbers blank) |
| Contexte | none | blank | `text` | `12` `12` `  const stages = useStages(projectId);` |
| Ajout | `success-pale` | `+` `success` | `text` | `13` (new only) `  const totals = computeStageTotals(deals);` |
| Suppression | `danger-pale` | `−` `danger` | `text` | `13` (old only) `  const total = deals.reduce(sum, 0);` |

#### `Dev · Fichier modifié` — set `203:554` (`EXT-fichier-modifie.png`)

- Description: `Entrée de la liste des changements Git. Le chemin long se tronque à la fin, le nom complet reste au survol et dans le diff.`
- `Statut` = `Modifié` (`203:541`) | `Ajouté` (`203:547`) | `Supprimé` (`203:553`); 400 × 32.
- Row, padding 6 8, gap 8, radius 8: `Statut` chip 20 × 20 radius 8 with letter JetBrains Mono Bold 11 — `M` (`warn-pale` / `warn`), `A` (`success-pale` / `success`), `D` (`danger-pale` / `danger`); `Chemin` JetBrains Mono 12 `text`, flex 1, ellipsis at the end, full path in `title`; `Ajouts` JetBrains Mono 11 `success` (`+142`); `Suppressions` JetBrains Mono 11 `danger` (`−18`). Counts are omitted when zero (`Ajouté` shows only `+38`; `Supprimé` only `−64`). Master paths: `src/modules/crm/PipelineBoard.tsx`, `src/modules/crm/pipeline-totals.ts`, `src/modules/crm/legacy-board.tsx`.

#### `Dev · Ligne de projet` — component `210:674` (`EXT-ligne-projet.png`)

- Description: `Ligne de la bibliothèque des projets : nom, dépôt GitHub, branche courante, état de synchronisation, sessions, dernière activité. Le menu porte favoris, synchronisation, branche et archivage.`
- 1088 × 65, row, padding 14 0, gap 16, border-bottom 1 `border`. Columns:
  1. `Projet` (flex): `Favori` `icon/star` 18 `accent` (toggle) + `Identité` column gap 2: `Nuera OS` Outfit SemiBold 15 `text`; `icon/github` 12 `muted` + `nuera-studio/nuera-os` JetBrains Mono 11 `muted`.
  2. `Colonne branche` 200: `icon/git-branch` 14 `muted` + `feature/crm-core` JetBrains Mono 12 `text` (ellipsis).
  3. `Colonne synchronisation` 170: `Badge` Succes `À jour`.
  4. `Colonne sessions` 130: `Dev · Point de statut` `En cours` + `2 actives` Outfit 13 `text`.
  5. `Colonne activité` 110: `il y a 3 min` Outfit 13 `muted`.
  6. `Colonne actions` 116 (right-aligned, gap 4): `Bouton compact` Secondaire `Ouvrir` + `Menu` 36 × 36 radius 12 with `icon/more` 18 `muted` (menu: favorite, sync, branch, archive).

#### `Dev · Ligne d'historique` — component `215:1791` (`EXT-ligne-historique.png`)

- Description: `Ligne de l'historique des sessions : nom, projet, branche, date, durée, statut de reprise, action.`
- 1088 × 61, row, padding 12 0, gap 16, border-bottom 1 `border`: `Session` (flex): `icon/terminal` 16 `muted` + `Galerie photos` Outfit SemiBold 14 (ellipsis); `Colonne projet` 140: `Atelier Lune` Outfit 13 `text`; `Colonne branche` 170: `icon/git-branch` 13 `muted` + `feature/galerie-photos` JetBrains Mono 11 `muted`; `Colonne début` 160: `hier · 16:20` Outfit 13 `muted`; `Colonne statut` 200: `Badge` Succes `Terminée`; `Colonne action` 120 (right): `Bouton compact` Discret `Voir le résumé`.

#### `Dev · Bandeau` — set `203:703` (`EXT-bandeau.png`)

- Description: `Message d'état dans une page : chargement, succès, alerte, erreur récupérable avec son action.`
- `Ton` = `Info` (`203:663`) | `Succès` (`203:674`) | `Alerte` (`203:686`) | `Erreur` (`203:702`); 640 × 60.
- Row, padding 12 16, gap 12, radius 12; icon 18; `Texte` column gap 2 (`Titre` Outfit SemiBold 14 `text`, `Message` Outfit 13 `muted`); optional trailing `Bouton compact` Secondaire.

| Ton | Bg | Icon | Titre | Message | Action |
|---|---|---|---|---|---|
| Info | `accent-pale` | `alert` `accent` | `Synchronisation en cours` | `Récupération de 3 commits depuis origin/main…` | — |
| Succès | `success-pale` | `check` `success` | `Projet cloné sur VPS-3` | `nuera-os est prêt dans /srv/dev/nuera-os.` | `Ouvrir` |
| Alerte | `warn-pale` | `alert` `warn` | `Autorisation GitHub bientôt expirée` | `Renouvelez l'accès avant le 12 novembre.` | `Renouveler` |
| Erreur | `danger-pale` | `alert` `danger` | `La synchronisation a échoué` | `origin/main n'a pas pu être récupéré : délai dépassé.` | `Réessayer` (`refresh`) |

Use `role="status"` (Info/Succès) or `role="alert"` (Alerte/Erreur).

#### `Dev · Toast` — component `203:709` (`EXT-toast@2x.png`)

- Description: `Confirmation éphémère d'une opération réussie, en bas à droite (bureau) ou au-dessus de la saisie (téléphone).`
- Hug (442 × 42), row, padding 12 16, gap 12, radius 12, bg `near-black`, `Shadow/Float`: `icon/check` 18 `success-on-dark`; `Commit poussé sur origin/feature/crm-core` Outfit 14 `paper`; action `Voir sur GitHub` Outfit SemiBold 14 `accent-on-dark` (link).
- Placement: desktop bottom-right; phone just above the composer / bottom bar. Auto-dismiss (duration not specified), `role="status"`.

### 8.8 Sessions

#### `Dev · Carte de session` — set `203:655` (`EXT-carte-session.png`)

- Description: `Session Claude Code vue de l'extérieur : statut, projet, branche et worktree, dernière activité, action principale. Tuile Nuera OS (rayon xl, Shadow/Soft).`
- `Statut` = `En cours` (`203:579`) | `Autorisation` (`203:604`) | `Terminée` (`203:629`) | `Interrompue` (`203:654`); 320 wide (290 on mobile), 203 high (221 when the activity wraps to 2 lines).
- Column, padding 20, gap 10, radius `xl` 28, bg `surface`, `Shadow/Soft`:
  - `Statut` row gap 8: dot 8; `Libellé du statut` Outfit Medium 12 (flex 1); `Durée` JetBrains Mono 11 `muted`.
  - `Titre` Outfit SemiBold 16 `text`, one line, ellipsis.
  - `Contexte` column gap 4: `icon/projets` 14 `muted` + project Outfit 12 `muted`; `icon/worktree` 14 `muted` + `branch · worktree name` JetBrains Mono 11 `muted` (ellipsis).
  - `Dernière activité` Outfit 13 / 18 `text`, max 2 lines, ellipsis.
  - `Bouton compact` (hug, 36 high).

| Statut | Dot | Label (colour) | Durée | Titre | Projet | Branche | Activité | Bouton |
|---|---|---|---|---|---|---|---|---|
| En cours | `en-cours` | `En cours` (`warn`) | `12 min` | `Module CRM · pipeline` | `Nuera OS` | `feature/crm-core · worktree crm-core` | `Écrit les tests de pipeline-totals.ts` | Secondaire `Ouvrir` |
| Autorisation | `warn` | `Autorisation demandée` (`warn`) | `2 min` | `Tests e2e du devis` | `Nuera OS` | `feature/devis-pdf · worktree devis-pdf` | `Attend votre accord pour npm run test -- crm` | Principal `Répondre` |
| Terminée | `success` | `Terminée` (`success`) | `hier` | `Galerie photos` | `Atelier Lune` | `feature/galerie-photos` | `3 fichiers modifiés · prête pour un commit` | Secondaire `Voir le résumé` |
| Interrompue | `danger` | `Interrompue` (`danger`) | `lun.` | `Correctif tarifs mobile` | `Kiné Rive Gauche` | `fix/tarifs-mobile` | `Connexion du navigateur perdue, la session a continué` | Secondaire `Reprendre` |

Note: the `En cours` label text uses `warn` while its dot uses `en-cours` (as designed).

### 8.9 Design System components reused here (from the code)

| Component | Spec observed |
|---|---|
| `Bouton compact` (`168:6952`) | Description: `Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code.` Props `Style` (Principal / Secondaire / Discret), `Libellé`, `Avec icône` (bool), `Icône` (swap). Height 36 (44 when stretched full width on mobile), padding 0 14 0 12 (Discret: 0), gap 6, radius 12, Outfit Medium 14. Principal: bg `accent`, text/icon `paper`. Secondaire: bg `paper`, border 1 `grey/border-on-light`, text/icon `ink`. Discret: transparent, text/icon `accent`. |
| `Badge` | Props `Label`, `Ton`. Padding 4 8, radius full, Outfit Medium 12. Tones seen: Accent (`accent-pale`/`accent`), Succes (`success-pale`/`success`), Alerte (`warn-pale`/`warn`), Neutre (`surface-raised`/`muted`). |
| `Avatar` | 36 × 36, radius full, bg `accent-pale`, initials Outfit SemiBold 13 `ink` (prop `Initiales`, `NZ`). |

### 8.10 `Note · Extensions et lacunes` — frame `240:5890` (`EXT-note-extensions.png`)

Card 1400 × 534, padding 28 32, gap 12, radius 20, bg `surface`, border 1 `border`. Title Outfit SemiBold 24 `text`; body Outfit 14 / 21 (`muted` for the intro, `text` for lists); overlines JetBrains Mono 11, 8 % (`muted`; the last one `warn`). Verbatim:

> **Extensions au système de design**
>
> Tout ce qui est ici est local à cette page et construit uniquement avec les variables existantes (Color, Spacing, Radius, App · statuts) et les styles Shadow/Soft et Shadow/Float. Aucun composant maître de Nuera OS ou du Design System n'a été modifié.
>
> RÉUTILISÉS TELS QUELS
>
> Button (Default, Accent) · Bouton compact (Principal, Secondaire, Discret) · Badge (les 6 tons, sauf ChatGPT) · Avatar · En-tête de tuile · 25 icônes de Nuera OS · Logo Nuera · mode Dark de la collection Color pour les zones de terminal.
>
> DÉRIVÉS DE NUERA OS
>
> Dev · Barre latérale (instance détachée de la Barre latérale de Nuera OS, entrées et carte serveur remplacées) · Logo Nuera Dev (pastille DEV, construction de la pastille OS) · Dev · Interrupteur (dessin de l'interrupteur des Réglages, passé à l'accent).
>
> CRÉÉS POUR NUERA DEV
>
> Barre latérale repliée, Barre d'onglets, Barre d'état, Indicateur d'accueil, Point de statut, Champ · Message (instruction, Claude), Ligne d'outil, Sortie de commande, Demande d'autorisation (bureau et téléphone), Plan de travail, Compositeur, Ligne de diff, Fichier modifié, Carte de session, Ligne de projet, Ligne d'historique, Bandeau, Toast.
>
> LACUNES À ARBITRER
>
> 1. Pas de variante destructive du Button : les confirmations (arrêter, archiver, supprimer) utilisent Accent. Proposer une variante Danger avec les jetons danger / danger-pale.
> 2. Pas de jeton danger-on-dark : les erreurs dans le terminal (mode Dark) utilisent danger-pale. À créer à côté de warn-on-dark et success-on-dark.
> 3. surface et surface-raised valent toutes deux paper en mode Light : les fonds de champs et de blocs se distinguent par une bordure, pas par une teinte.
> 4. Aucun style de texte n'est appliqué dans les écrans de Nuera OS (tailles posées à la main) : Nuera Dev suit la même échelle (28, 22, 18, 16, 14, 13, 12, 11) ; une rampe de styles « App » serait à formaliser.
> 5. Le Badge ChatGPT est propre à ChatGPT ; il n'est jamais utilisé pour Claude.

Implementation consequences: keep confirmations on Accent unless a Danger variant is decided; terminal errors use `danger-pale` text; separate `surface` vs `surface-raised` areas with borders in Light; define a text scale 28/22/18/16/14/13/12/11 (+ 26, 24, 15, 10 seen here) as CSS utilities.

---

## 9. Implied data model

| Entity | Fields (format) | Seen in |
|---|---|---|
| `Session` | id; title (`Module CRM · pipeline`); projectId/projectName; branch (`feature/crm-core`); worktreeName (`crm-core`); status `running` / `awaiting_permission` / `completed` / `interrupted` (labels `En cours`, `Autorisation demandée`, `Terminée`, `Interrompue`); startedAt/elapsed (`12 min`, `38 s`, `hier`, `lun.`); host (`VPS-3`); permissionMode (`demander avant d'agir`); lastActivity (`Écrit les tests de pipeline-totals.ts`); plan progress (`3 / 5`, current step); changedFilesCount (`Diff · 4`) | S1–S5, cards, sheet |
| `ThreadItem` | kind `instruction` / `claude_message` / `tool_call` / `permission_request`; createdAt (`HH:MM`); author (`Vous` / `Claude Code`); text | S1, S4 |
| `ToolCall` | tool (`Edit`, `Write`, `Bash`, `Read`, `Glob`…); argument (path or command); status `done` / `running` / `error` / `denied`; meta (`+a −d`, `en cours · N s`, `code N · M échecs`, `refusé`); output (raw text) | S1, S4, §8.5 |
| `PermissionRequest` | id; sessionId; command (`npm run test -- crm`); explanation; options (≤ 3, CLI order: allow once / always for prefix `npm run test` / deny); state `pending` / `allowed` / `denied`; summary line | S1, S4, S5, §8.6 |
| `PlanStep` | content; status `completed` / `in_progress` / `pending` | S5, §8.6 |
| `DiffFile` | path; status `M` / `A` / `D`; additions; deletions; hunks[] (header `@@ -a,b +c,d @@`, lines[]: type, oldNo, newNo, text) | S2, S3 |
| `GitState` | branch; aheadCount (`2 en avance`); behindCount (`2 en retard`); uncommitted files; totals (`+152 −12`); proposedCommitMessage; options push / openPR | S3, S5 |
| `Project` | id; name; repo (`nuera-studio/nuera-os`); currentBranch; sync state (`À jour` / `N en retard`); activeSessions (`2 actives`); lastActivity (`il y a 3 min`); favorite; path on server (`/srv/dev/nuera-os`) | S5, §8.7 |
| `Commit` | sha (7-char `a3f9c12`); message; project; relative time (`il y a 6 min`) | S5 |
| `ServerStatus` | name (`VPS-3`), provider (`OVH Gravelines`), online; CPU % (`23 %`); RAM used/total (`5,1 / 16 Go`); Claude Code connected | S5, sidebar |
| `User` | first name (`Nezar`); initials (`NZ`); role (`Propriétaire`); 2FA (`double facteur actif`) | S5, sidebar |
| `PushNotification` | title (`<session> attend votre accord`); body (`<command> · <project> · touchez pour répondre`); time (`maintenant`); deep link | S5 |

Formatting: French locale — `il y a N min`, `maintenant`, `hier · 16:20`, `lun.`, `Mer. 4 nov.`, decimal comma (`5,1`), space before `%`, `Go` for GB; deletion counts with U+2212.

---

## 10. Prototype links and behaviour summary

Prototype reactions on these frames (all `ON_CLICK` → navigate, `DISSOLVE 200 ms EASE_OUT`):

| From | Element | To |
|---|---|---|
| S1 | `Onglet · Diff · 4` | S2 |
| S2 | `Onglet · Session` | S1 |
| S2 | `Onglet · Git` | S3 |
| S3 | `Onglet · Session` | S1 |
| S3 | `Bouton compact` (`Committer et pousser`) | `M01 · Accueil` (`220:2366`) |
| S4 | `Voile` | `M05 · Workspace Claude Code` (`222:2732`) |
| S5 | `Notification · Nuera Dev` | `M05 · Workspace Claude Code` |
| S5 | Tab bar `Accueil` / `Projets` / `Sessions` / `Intégrations` / `Paramètres` | M01 / M02 (`220:2575`) / M06 (`223:2787`) / M07 (`223:2966`) / M08 (`226:2985`) |

Cover path **C · Mobilité**: `S5 Notification` › `M05 Workspace` › `S1 Réponse` › `S2 Diff` › `S3 Git`.

Cross-cutting rules from the cover's validation list (relevant here): `Demandes d'autorisation : les capter et y répondre depuis le navigateur sans contourner le mode de permission du CLI.` · `Persistance : une session par processus tmux et par worktree ; reprise par claude --resume après un redémarrage.` · `Rendu Conversation : lire la sortie du CLI dans un format exploitable (mode non interactif, sortie structurée) tout en gardant la session interactive. Repli : la vue Terminal brut seule.` · Principles: `Aucune métrique de coût, de quota ou de jetons inventée : seulement ce que le CLI affiche.`

---

## 11. Open questions and inconsistencies

1. **`2 / 4`** in the session sheet (S4) and in the desktop picker (W6: `NUERA OS · 2 SESSIONS ACTIVES` · `2 / 4`): likely "2 active sessions out of a maximum of 4 parallel sessions" — the cap is not stated anywhere.
2. **Durations disagree**: S1 badge `En cours · 13 min` vs meta `12 min · vit sur VPS-3`; S2/S3 badge `Terminée · 18 min` vs the same `12 min` meta. Decide what each number means (badge = run time; meta = ?).
3. **Command mismatch in S5**: notification and pending card say `npm run test -- e2e`, the `Autorisation` session card says `Attend votre accord pour npm run test -- crm` (master copy). Use the real command.
4. **S3 primary label** for other toggle combinations (push off, PR on/off) is not designed; also no in-progress / error state for commit-and-push on mobile (desktop W5 may cover it).
5. **Prev/next file** at the ends of the list (S2): disable or wrap — not specified.
6. **`Bouton · Actions de session`** (mobile `more`) menu content and **`Bouton · Notifications`** panel (S5) are not designed in these frames.
7. **Composer in a finished session** (S2 `Demander une correction à Claude…`): implies resuming the CLI session (`claude --resume`); confirm.
8. **Icons**: `stop` has no Lucide equivalent; `star`, `key` match only older Lucide releases; brand icons (`github`, `figma`) are gone from Lucide 1.x → ship the exported SVGs.
9. **Instruction bubble width** is fixed at 520 px in the component (overflows on mobile in Figma) — use a max-width on mobile.
10. **Danger variant** of Button and **`danger-on-dark`** token are explicitly undecided (note gaps 1–2).
