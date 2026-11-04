# Nuera Dev — Desktop screens A (D01–D04) and the desktop app shell

Source of truth: Figma file `nlvRWAtD1x2fKf8gVgcM0g`, page **NUERA DEV — WEB APP** (`199:3`), section
**01 — Desktop Screens** (`199:5`). The canvas title of that section reads, verbatim:
`01 — Desktop Screens · 1440 px · 8 écrans, dans l'ordre du tableau`.

| Code | Figma frame | Node | Size | Screenshot | Raw design-context code | Assets (SVG, colour baked in) |
|---|---|---|---|---|---|---|
| D01 | `D01 · Accueil` | `205:422` | 1440 × 1120 | `.design-refs/screens/D01.png` | `.design-refs/code/D01.tsx` | `.design-refs/assets/D01/` (32 files) |
| D02 | `D02 · Projets` | `210:675` | 1440 × 1120 | `.design-refs/screens/D02.png` | `.design-refs/code/D02.tsx` | `.design-refs/assets/D02/` (28 files) |
| D03 | `D03 · Ajouter un projet` | `211:933` | 1440 × 1120 | `.design-refs/screens/D03.png` | `.design-refs/code/D03.tsx` | `.design-refs/assets/D03/` (30 files) |
| D04 | `D04 · Détail du projet` | `213:1233` | 1440 × 1158 | `.design-refs/screens/D04.png` | `.design-refs/code/D04.tsx` | `.design-refs/assets/D04/` (35 files) |

How to read the raw code files: they are the unmodified `get_design_context` output (React + Tailwind,
absolute values) with the temporary Figma asset URLs rewritten to the local SVGs. Every token appears as
`var(--token, fallback)`, every Figma node keeps its `data-node-id`, and the Figma component descriptions
are appended in a trailing comment. Use them for exact values; do not ship them.

Copy conventions (checked on the raw strings):

- All UI copy below is verbatim. Figma uses the **straight apostrophe** `'` (U+0027) everywhere
  (`Vue d'ensemble`, `n'est`, `Tout l'historique`…), never `’`.
- No non-breaking space exists in these four frames: separators are `space · space` (U+00B7 middle dot),
  `23 %`, `16 Go`, `Trier : …` all use normal spaces. Ellipses are the single glyph `…` (U+2026).
  Quotes are `« … »` with normal inner spaces. Whether to add NBSPs for French typography is an
  open decision (see §9).
- A few strings rely on **multiple spaces** and are rendered with `white-space: pre` in Figma; they are
  shown in code spans and must be preserved: `CPU 23 %  ·  RAM 5,1 / 16 Go` (two spaces around `·`),
  `Projets  /  Nuera OS` (two spaces around `/`), and the CLAUDE.md preview lines.

---

## 1. Foundations used by these screens

### 1.1 Colour tokens (Figma variables, Light mode unless stated)

| CSS variable (Figma code syntax) | Value | Where it is used in D01–D04 |
|---|---|---|
| `--near-black` | `#141830` | Sidebar background, modal veil (55 % opacity), DEV pill text |
| `--btn-edge` | `#141830` | Button edge + border + Default-button label |
| `--accent` | `#4368b1` | Accent button face, compact primary button, links, refs, active count pill, gauge fill, selected chip text, toggle "on" |
| `--accent-on-dark` | `#a6b9dd` | Sidebar inactive labels/icons, sidebar meta text, DEV pill background |
| `--accent-pale` | `#dee5f2` | Tile-header icon tiles ("Pastille"), avatar, selected chip/tab, hovered menu option, Accent badge |
| `--ink` | `#233353` | Tile titles, secondary button label, avatar initials, dark icons |
| `--text` | `#233353` | Body text, titles |
| `--muted` | `#645e78` | Secondary text, placeholders, table headers, neutral icons |
| `--bg` | `#ffffff` | Tiles, fields, menus, modal |
| `--paper` | `#ffffff` | Text on dark/accent, secondary button face |
| `--surface-raised` | `#ffffff` | Page background (root frame), gauge track, command boxes, "Dernière instruction" box |
| `--surface-raised-dark` | `#ffffff0d` = `rgba(255,255,255,0.05)` | Sidebar search, server card, user card |
| `--hairline-on-dark` | `#ffffff1a` = `rgba(255,255,255,0.10)` | Active sidebar item background |
| `--border` | `#d9dade` | Row separators, field borders, menu border, stepper connectors |
| `--border-on-light` | `#d9dade` | Secondary compact button border |

Status colours (collection referred to as "App · statuts" in the canvas note; in the variables API they
have **no code syntax**, the generated code nevertheless uses these names — recommend exposing them as
`--success`, `--warn`, …):

| Name | Value | Use |
|---|---|---|
| `success` | `#2f6f4f` | Success badge text, "Succès" status dot, shield/check icons |
| `success-pale` | `#e4f1ea` | Success badge background, done step circle |
| `success-on-dark` | `#5fc48b` | Green dots in the sidebar server card |
| `warn` | `#8a6516` | Alert badge text, alert box text/icon, "Alerte"/"Autorisation" dot, session-card status label, Coolify "à reconnecter" text |
| `warn-pale` | `#fbf1dc` | Alert badge background, alert box background |
| `danger` | `#b4451f` | Danger badge text, destructive menu item, "interrompue" dot, Coolify error message |
| `danger-pale` | `#f8e6de` | Danger badge background |
| `en-cours` | `#e0a10f` | "En cours" status dot, clock icon in "Reprise rapide" |

Dark mode of the Color collection is applied to the CLAUDE.md preview (D04) only: there `--bg` =
`#233353` and `--muted` = `#ffffff9e` (= `rgba(255,255,255,0.62)`). Canvas note: "mode Dark de la
collection Color pour les zones de terminal".

### 1.2 Spacing, radius, effects

- Spacing variables: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 ·
  `--space-6` 24 · `--space-7` 28 · `--space-8` 32. Off-scale literals used in these frames: 1, 2, 3, 5,
  6, 10, 13, 14, 26 px (all listed per component below).
- Radius: `--radius-sm` 8 · `--radius-md` 12 · `--radius-xl` 28 · `--radius-full` 999 (`--radius-lg` 20
  exists in the Design System but is not used here). Gauge fill uses a literal 4 px radius.
- `Shadow/Soft` (`--shadow-soft`): `0 14px 34px -22px rgba(20,24,48,0.28)` (Figma colour `#14183047`) — every tile.
- `Shadow/Float` (`--shadow-float`): `0 24px 50px -18px rgba(20,24,48,0.55)` (`#1418308C`) — row menu (D02), modal (D03).
- Opacity literals: sidebar group labels 60 %; modal veil 55 %.

### 1.3 Typography

Fonts: **Outfit** (400 Regular, 500 Medium, 600 SemiBold, 700 Bold) and **JetBrains Mono** (400, 500, 700).
The only Figma text style applied is `Text/UI` = Outfit Bold 15 / line-height 1.25 / letter-spacing 0
(big buttons). Everything else is set by hand (canvas note: Nuera Dev follows the scale
28, 22, 18, 16, 14, 13, 12, 11; these screens also use 30, 20, 15 and 10). Line-height is `normal`
unless stated.

| Role | Font / weight / size / line-height / tracking | Example |
|---|---|---|
| Page title (H1) | Outfit 600 28 | "Bonjour Nezar", "Projets", "Nuera OS" |
| Modal title | Outfit 600 22 | "Ajouter un projet" |
| Big metric | Outfit 600 30 | "2" (Claude Code tile) |
| Hero item title | Outfit 600 20 | "Module CRM · pipeline" (Reprise rapide) |
| Card title | Outfit 600 16 | session card titles |
| Table item name | Outfit 600 15 | project names (D02) |
| Big button label | Outfit 700 15 / 1.25 (`Text/UI`) | "Nouvelle session" |
| List primary | Outfit 600 14 (names), 500 14 (D04 lists, option titles, field-less labels), 400 14 (commit messages, inputs, menu options) | |
| Tile title | Outfit 600 14, `--ink` | "Serveur VPS-3" |
| Compact button / nav item | Outfit 500 14 (nav active: 600) | "Ouvrir", "Accueil" |
| Page subtitle | Outfit 400 14, `--muted` | "5 dépôts clonés sur VPS-3 · 41 Go utilisés sur 160" |
| Secondary / helper | Outfit 400 13, `--muted` | gauge labels, activity times (D02) |
| Link | Outfit 500 13, `--accent` | "Toutes les sessions", "Gérer" |
| Field label | Outfit 500 13, `--text` | "Branche de départ" |
| Meta | Outfit 400 12, `--muted`; notes 12 / 17 px; modal helpers 12 / 16 px | |
| Badge | Outfit 500 12 | "À jour" |
| Small meta (sidebar) | Outfit 400 11 | "Propriétaire · double facteur actif" |
| Count pill | Outfit 600 11 | "2" |
| Mono caps label | JetBrains Mono 400 11, tracking 0.88 px (0.08 em), uppercase as typed | "PROJET", "DERNIÈRE INSTRUCTION" |
| Mono meta | JetBrains Mono 400 11 | branches, short times, session sub-lines |
| Mono value | JetBrains Mono 500 12 | "23 %", commit refs, env keys |
| Mono command / breadcrumb | JetBrains Mono 400 12 (CLAUDE.md preview 12 / 18 px) | "npm ci" |
| Mono branch name | JetBrains Mono 500 13 | D04 branch list |
| Mono repo (modal) | JetBrains Mono 500 14 | "nuera-studio/roux-conseil" |
| Mono input value | JetBrains Mono 400 14 | "main", "/srv/dev/roux-conseil" |
| Mono bold | JetBrains Mono 700 12 (DEV pill: tracking 0.96 px) | "DEV", step numbers |
| Sidebar group label | JetBrains Mono 500 10, opacity 0.6 | "ESPACE" |
| Shortcut | JetBrains Mono 500 11 | "⌘K" |

### 1.4 Icons

- Stroke icons in the Feather/Lucide style, `stroke-width 1.8`, round caps and joins, `fill none`.
  The stroke stays **1.8 px at every rendered size** (12, 14, 16, 18 px) — i.e. "absolute stroke width",
  not scaled with the glyph. Master 24 px glyphs exported by the icon pass live in
  `.design-refs/assets/icons/`; the per-screen exports in `.design-refs/assets/D0x/` are the exact
  instances (size + colour baked in, file name = Figma const name in the raw code).
- Tile-header glyph slot is named `icon/dashboard` in every instance; the glyph actually swapped in is
  given by the asset name: server (`imgIconServer`), terminal, history, folder (`icon/projets`),
  git-commit, plug, git-branch, book (`imgIconBook`), key (`imgIconKey`).
- Icon names used in D01–D04: `icon/home`, `icon/projets` (folder), `icon/terminal`, `icon/plug`,
  `icon/reglages` (sliders), `icon/search`, `icon/bell`, `icon/alert` (triangle), `icon/check`,
  `icon/clock`, `icon/history`, `icon/worktree` (fork glyph), `icon/star` (outline only), `icon/git-commit`,
  `icon/git-pull-request`, `icon/github`, `icon/figma`, `icon/rocket`, `icon/more` (horizontal dots),
  `icon/archive`, `icon/refresh`, `icon/git-branch`, `icon/x`, `icon/shield` (shield-check),
  `icon/external`, `icon/chevron-down`, `icon/lock`, `icon/eye`, `icon/edit`, `icon/key`, server, book;
  plus "Icône" slots holding play (▷), plus (+), pencil, folder, search and chevron glyphs.

### 1.5 Motion (cross-reference, defined on the Design System page)

Hover/pressed/state transitions are not drawn in these frames; use the Design System motion tokens:
`--dur-instant` 60 ms (click feedback), `--dur-fast` 180 ms (hovers), `--dur-base` 350 ms (state
transitions), curves `--ease-out` `cubic-bezier(0.22, 1, 0.36, 1)`, `--ease-in-out`
`cubic-bezier(0.65, 0, 0.35, 1)`, `--ease-emphasis` `cubic-bezier(0.32, 0.72, 0, 1)`, `--ease-steady`
`cubic-bezier(0.4, 0, 0.2, 1)`; every effect needs a `prefers-reduced-motion` version.

---

## 2. Shared components as instantiated in D01–D04

### 2.1 `Button` (Design System `7:117`) — big 3D button

Props: `Variant` = Default | Accent | On dark; `State` = Rest | Hover | Pressed. Height is always 54 px.
Description (verbatim): "Bouton du site (src/components/ui/Button). Default sur clair neutre, Accent sur
fond clair, On dark dans une section sombre. Couper le burst près d'un bord : ses rayons débordent de 26 px."

Structure: wrapper (column) → **Edge** (bg `--btn-edge`, radius `--radius-md`, bottom padding = visible
edge) → **Face** (border 1.5 px `--btn-edge`, radius `--radius-md`, padding 13 px × 26 px) → label
`Text/UI` (Outfit 700 15 / 1.25), no wrap.

| State | Wrapper padding-top | Edge padding-bottom | Effect |
|---|---|---|---|
| Rest | 3 px | 3 px | face sits 3 px above the edge |
| Hover | 0 | 6 px | face lifts by 3 px |
| Pressed | 5 px | 1 px | face pushed down |

Faces: Default = `--paper` face + `--btn-edge` label; Accent = `--accent` face + `--paper` label; On dark
= `--accent-on-dark` face + `--btn-edge` label (not used here). Instances in these screens (all Rest):
"Nouvelle session" (Accent, 168 wide), "Ajouter un projet" (Accent, 172), "Retour" (Default, 102),
"Cloner sur VPS-3" (Accent, 173), "Synchroniser" (Default, 146), "Ouvrir le Workspace" (Accent, 196).
There is no destructive variant (see §9).

### 2.2 `Bouton compact` (`168:6952`)

Description (verbatim): "Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action.
Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure
(annuler, déplacer). Zone cliquable 44 px en code."

Common: height 36, radius `--radius-md`, gap 6, optional leading icon 16, label Outfit 500 14 nowrap.

| Style | Background / border | Padding | Label colour | Icon colour |
|---|---|---|---|---|
| Principal | `--accent` | left 12, right 14 | `--paper` | white |
| Secondaire | `--paper` + 1 px `--border-on-light` | left 12, right 14 | `--ink` | `--ink` |
| Discret | none | 0 (text button) | `--accent` | `--accent` |

Keep a 44 px hit area in code (e.g. invisible padding / `::before`).

### 2.3 `Badge`

Pill: padding 4 × 8 (`--space-1` × `--space-2`), radius full, label Outfit 500 12 nowrap, height 23.

| Ton | Background | Text |
|---|---|---|
| Succès | `success-pale` | `success` |
| Alerte | `warn-pale` | `warn` |
| Danger | `danger-pale` | `danger` |
| Accent | `--accent-pale` | `--accent` |
| Neutre | `--surface-raised` (white) | `--muted` |

Badges are also used as **filter chips** (D02) and **tabs** (D04): selected = Accent, unselected = Neutre
(which reads as plain grey text on white). The ChatGPT badge tone exists but must never be used.

### 2.4 Tile (`Tuile`) and `En-tête de tuile`

- Tile: bg `--bg`, radius `--radius-xl` (28), padding 20 (`--space-5`), `Shadow/Soft`, overflow clip,
  vertical stack. Inner gap: 4 for list tiles, 10 for session cards, 12 or 16 for mixed tiles (given per tile).
- `En-tête de tuile`: row, height 28, gap 8: **Pastille** 28 × 28, bg `--accent-pale`, radius
  `--radius-sm`, centred 16 px glyph in `--accent`; title Outfit 600 14 `--ink`, flex 1.
  The tile header row (`En-tête`) may append on the right: a link (Outfit 500 13 `--accent`), a Badge,
  or a Bouton compact (header then grows to 36 px).

### 2.5 List row (inside tiles)

Row: horizontal, items centred, gap 12, padding 10 px 0, 1 px bottom border `--border`. Two-line text
block = primary line + secondary line with gap 2. Typical row height 55–57 px. In D01 every row keeps its
bottom border (including the last one); in D04 the last row of each list has no border; in the D02 table
the last row has no border.

### 2.6 `Dev · Point de statut` (`202:478`)

8 × 8 circle. Tons: Succès `#2f6f4f`, En cours `#e0a10f`, Alerte `#8a6516`, Danger `#b4451f`, Neutre
`#645e78`, Accent (exists in the component set, not used in D01–D04, colour not captured). Description (verbatim): "Pastille de 8 px qui précède un libellé d'état.
Ne porte jamais seule l'information : toujours avec un texte." The sidebar uses a separate green dot
`#5fc48b` (`success-on-dark`).

### 2.7 `Dev · Interrupteur` (`202:459`)

36 × 20 track, radius 10, 16 px white knob (r = 8, 2 px inset). `Actif=Oui`: track `--accent`
`#4368b1`, knob right; `Actif=Non`: track `#d9dade`, knob left. Description (verbatim): "Même dessin que
l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y est réservé à
ChatGPT. Zone tactile de 44 px à prévoir autour." Implement as `role="switch"` with `aria-checked`.

### 2.8 `Dev · Champ` (`202:503`) — input / select

Height 40, bg `--bg`, 1 px `--border`, radius `--radius-md`, padding 8 × 12, gap 8; optional leading
icon 16 (`--muted`), value Outfit 400 14 (`--text`) or placeholder (`--muted`), optional trailing chevron
16 `--muted` for selects. Label above (when present): Outfit 500 13 `--text`, gap 6. Helper below:
Outfit 400 12 / 16 `--muted`. Component states: Repos (shown), Focus, Erreur (defined in 04 · Extensions,
not shown in D01–D04). Description (verbatim): "Champ de saisie et liste déroulante. Fond surface et
bordure border, comme le compositeur de Nuera OS ; le champ de recherche de Nuera OS, sans bordure, reste
réservé aux barres latérales."

### 2.9 Icon button (`Bouton icône`, D01) and ghost icon buttons

- Bordered: 36 × 36, bg `--bg`, 1 px `--border`, radius `--radius-md`, padding 8, icon 18 `--ink` (bell).
- Ghost (row menu "…", modal close "×"): 36 × 36, radius `--radius-md`, no bg/border, icon 18 `--muted`.

### 2.10 `Avatar`

36 × 36 circle, bg `--accent-pale`, initials Outfit 600 13 `--ink` ("NZ").

### 2.11 `Dev · Carte de session` (`203:655`) — used in D01

Variants: Statut = En cours | Autorisation | Terminée | Interrompue (only the first two appear here).
Description (verbatim): "Session Claude Code vue de l'extérieur : statut, projet, branche et worktree,
dernière activité, action principale. Tuile Nuera OS (rayon xl, Shadow/Soft)." Spec in §4.4.

### 2.12 `Dev · Ligne de projet` (`210:674`) — used in D02/D03

Description (verbatim): "Ligne de la bibliothèque des projets : nom, dépôt GitHub, branche courante, état
de synchronisation, sessions, dernière activité. Le menu porte favoris, synchronisation, branche et
archivage." Spec in §5.4.

---

## 3. App shell (desktop)

All four screens share the same shell: a fixed dark **left sidebar** (`Dev · Barre latérale`) and a
white **content region**. There is **no top bar** and no global header; every page renders its own header
inside the content region.

```
┌──────────────── 1440 ─────────────────────────────────────────────────────────────┐
│ Sidebar 248 (bg #141830)  │ Contenu 1192 (bg white, padding 28 / 32)               │
│  Logo + DEV               │  Page header (title + subtitle | actions)              │
│  Rechercher…        ⌘K    │  …page content (max inner width 1128 at 1440)…         │
│  ESPACE                   │                                                        │
│   Accueil / Projets /     │                                                        │
│   Sessions (2)            │                                                        │
│  CONFIGURATION            │                                                        │
│   Intégrations /          │                                                        │
│   Paramètres              │                                                        │
│  (flex spacer)            │                                                        │
│  [État du serveur]        │                                                        │
│  [Utilisateur]            │                                                        │
└───────────────────────────┴────────────────────────────────────────────────────────┘
```

### 3.1 Root frame

Row layout, items start, bg `--surface-raised` (white). Sidebar = fixed 248 px; content = flex 1
(1192 px at 1440). Frame height is 1120 for D01–D03 and 1158 for D04 (content taller than the viewport).

### 3.2 Sidebar — `Dev · Barre latérale` (component set `201:732`)

Variant property `Actif` = Accueil | Projets | Sessions | Intégrations | Paramètres. Description
(verbatim): "Navigation globale de Nuera Dev au bureau. Dérivée de la Barre latérale de Nuera OS (mêmes
jetons, mêmes entrées). Ajoute la carte État du serveur. Le Workspace utilise la version repliée."

Container: width 248, full height, bg `--near-black`, vertical stack, gap 16 (`--space-4`), padding
top 20 (`--space-5`), left/right/bottom 16 (`--space-4`). Top to bottom:

1. **Logo** — wrapper padding-left 8. `Logo Nuera Dev · papier` (`201:41`): Nuera wordmark 136 × 27.611
   (white; drawn from `imgVector.svg` + `imgGroup1.svg` with `imgGroup.svg` as luminance mask — prefer a
   single exported logo SVG from the logo pass) + gap 8 + **DEV pill**: bg `--accent-on-dark`, radius
   `--radius-sm`, padding 2 × 4, text "DEV" JetBrains Mono 700 12, tracking 0.96 px, `--near-black`.
   Description (verbatim): "Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction
   que la pastille OS de Nuera OS)." The logo is not a link in the prototype (suggest: link to `/`).
2. **Recherche** (search trigger) — full width, bg `--surface-raised-dark`, radius `--radius-sm`,
   padding 8 × 12, gap 8, **no border**, height ≈ 32: `icon/search` 16 (`#a6b9dd`), placeholder
   "Rechercher…" Outfit 400 13 `--accent-on-dark` (flex 1), shortcut "⌘K" JetBrains Mono 500 11
   `--accent-on-dark`. Implies a command palette (not designed).
3. **Navigation** — vertical, gap 16 between the two groups.
   - Group label: padding-left 12, padding-bottom 8, JetBrains Mono 500 10, `--accent-on-dark`,
     opacity 0.6: "ESPACE", "CONFIGURATION".
   - Item: full width, padding 8 × 12, gap 12, radius `--radius-sm`, height ≈ 34; icon 18; label
     Outfit 14, flex 1.
     - Inactive: label 500 `--accent-on-dark`, icon stroke `#a6b9dd`, transparent background.
     - Active: bg `--hairline-on-dark` (rgba 255/255/255/0.10), label 600 `--paper`, icon stroke white.
   - Entries (verbatim, in order): ESPACE → "Accueil" (`icon/home`), "Projets" (`icon/projets`),
     "Sessions" (`icon/terminal`) with a trailing **count pill** (bg `--accent`, radius full, padding
     1 × 4, Outfit 600 11 `--paper`, text "2" = number of active sessions); CONFIGURATION →
     "Intégrations" (`icon/plug`), "Paramètres" (`icon/reglages`).
4. **Spacer** — flex 1 (pushes the two cards to the bottom).
5. **État du serveur** card — full width, bg `--surface-raised-dark`, radius `--radius-md`, padding 12,
   vertical gap 8:
   - line 1 (gap 8): 8 px dot `#5fc48b` + "VPS-3 · OVH Gravelines" Outfit 600 13 `--paper`;
   - line 2: `CPU 23 %  ·  RAM 5,1 / 16 Go` JetBrains Mono 400 11 `--accent-on-dark`, `white-space: pre`;
   - line 3 (gap 8): 8 px dot `#5fc48b` + "Claude Code connecté" Outfit 400 12 `--accent-on-dark`.
6. **Utilisateur** card (account area) — full width, bg `--surface-raised-dark`, radius `--radius-md`,
   padding 8, row gap 8, items centred: Avatar 36 "NZ" + column (no gap) "Nezar" Outfit 600 13
   `--paper` / "Propriétaire · double facteur actif" Outfit 400 11 `--accent-on-dark` (nowrap; it
   touches the card edge at 248 px — allow ellipsis). No menu is drawn (suggest: opens Paramètres → compte).

### 3.3 Content region and page header pattern

- `Contenu`: vertical stack, padding 28 (`--space-7`) top/bottom and 32 (`--space-8`) left/right, gap
  24 (`--space-6`) on D01–D03 and 20 (`--space-5`) on D04. Inner width 1128 at 1440. Overflow is clipped
  in Figma; in code it is the scroll container.
- Page header (`En-tête`): row, gap 12 (`--space-3`). Left `Titre` column (flex 1, gap 4): H1 Outfit 600
  28 `--text` + subtitle Outfit 400 14 `--muted`. Right: optional bordered icon button (D01 bell) and the
  page's primary `Button` (Accent). Items centred on D01–D03; D04 uses a richer header (breadcrumb, badge,
  meta row) with items aligned to the bottom (`items-end`) and two Buttons.

### 3.4 Scroll and sticky behaviour (implementation guidance)

The sidebar must stay fixed while the content scrolls (D04 is 38 px taller than the 1120 viewport):
sidebar `position: sticky; top: 0; height: 100dvh`, content `min-height: 100dvh` scrolling with the
document (or an `overflow-y: auto` content pane). On short viewports let the sidebar's nav area scroll
while the bottom cards stay pinned. Below 1440 the content region flexes (grids in §4–§7 give the column
rules); no breakpoint between desktop and the 390 px phone layout is drawn.

### 3.5 Status indicators in the shell

- Server health: green dot + host label + live CPU/RAM (same values as the Accueil server tile).
- Claude Code CLI link: green dot + "Claude Code connecté".
- Active sessions count on "Sessions" (pill).
Degraded states (server unreachable, Claude Code disconnected, expired authorisation) are drawn in
section 03 (`T5 · Serveur indisponible`, `T6 · Claude Code déconnecté`, `T7 · Autorisation expirée`) and
documented elsewhere; the shell cards should switch dot colour/text accordingly.

### 3.6 Per-screen differences

| Screen | `Actif` | Nav items carrying a prototype link (`<a>` in the raw code) | Sidebar height | Notes |
|---|---|---|---|---|
| D01 | Accueil | Projets, Sessions, Intégrations, Paramètres | 1120 | active item is not a link |
| D02 | Projets | Accueil, Sessions, Intégrations, Paramètres | 1120 | |
| D03 | Projets | none | 1120 | a modal is open: the 55 % veil covers the sidebar too, nothing behind it is interactive |
| D04 | Projets | all five, including the active "Projets" | 1158 | on a sub-page the active entry still links back to the list |

Everything else (logo, search, labels, server values, user card) is identical across D01–D04.
The 72 px rail `Dev · Barre latérale repliée` (`201:893`) is **not** used by D01–D04; only the Workspace
uses it.

### 3.7 Navigation annotations on the canvas (verbatim, from `00 — Cover & Product Overview`)

- Header: "NAVIGATION GLOBALE · 5 ENTRÉES". Entries with their scope: "Accueil" — "serveur, Claude,
  reprise rapide"; "Projets" — "bibliothèque, ajout, détail"; "Sessions" — "en cours, historique,
  capacité"; "Intégrations" — "GitHub, serveurs MCP"; "Paramètres" — "compte, Claude, serveur".
- "Workspace · contextuel" — "Ouvert depuis un projet ou une session, jamais depuis la navigation. Au
  bureau, la barre se replie en rail ; au téléphone, la barre d'onglets disparaît."
- "PARCOURS PROTOTYPÉS · DÉPART MARQUÉ DANS LE MODE PRÉSENTATION":
  - A "Premier projet": `D02 Projets` › `A1 Dépôt` › `D03 Configuration` › `A2 Clonage` › `A3 Réussi` ›
    `D04 Détail` › `W1 Workspace`.
  - B "Travail quotidien": `D01 Accueil` › `D05 Autorisation` › `W3 Terminée` › `W4 Diff` › `W5 Commit et PR`.
- Product principles that constrain these screens ("CE QUE LES MAQUETTES S'INTERDISENT"): "Aucun
  formulaire de jeton Claude : la connexion passe par la procédure du CLI, dans un terminal." / "Aucune
  métrique de coût, de quota ou de jetons inventée : seulement ce que le CLI affiche." / "Aucune action de
  production Coolify à portée de Claude." (→ no cost/token widgets on Accueil, no token field anywhere.)

### 3.8 Suggested routes (Next.js App Router)

`/` Accueil (D01) · `/projets` (D02) · `/projets/nouveau` as an intercepted modal over `/projets` (D03,
with a step state `depot | configuration | clonage`) · `/projets/[projetId]` (D04, tabs as nested
segments or `?onglet=`) · `/sessions` (D06) · `/integrations` (D07) · `/parametres` (D08). Workspace
routes belong to the D05/W* spec. Put the sidebar in the `(app)` route-group layout so it persists
across navigations.

### 3.9 Not designed in the shell

Hover / focus-visible / pressed styles of nav items, search palette (⌘K, and its Windows label "Ctrl K"),
notifications panel, account menu, sidebar collapse control on non-Workspace pages, intermediate
desktop widths.

---

## 4. D01 — Accueil

### 4.1 Identity

`D01 · Accueil`, node `205:422`, 1440 × 1120, sidebar `Actif=Accueil`. Route `/`.
Purpose: daily dashboard — server availability, Claude Code capacity and pending authorisations, quick
resume of the last session, live sessions, recent projects, latest Git activity, integration health.

### 4.2 Layout skeleton

```
Contenu (x 248, padding 28/32, column gap 24)
├─ En-tête (y 28, h 57): Titre (flex) | Bouton icône 36 (bell) | Button Accent "Nouvelle session" (168 × 54)
├─ Rangée · Disponibilité (y 109, h 297, gap 24, items-start)
│   ├─ Tuile · Serveur VPS-3        w 360, self-stretch, gap 16
│   ├─ Tuile · Claude Code          w 360, self-stretch, gap 12
│   └─ Tuile · Reprise rapide       flex 1 (= 360), gap 12   ← sets the row height (297)
├─ Rangée · Activité (y 430, h 308, gap 24)
│   ├─ Dev · Carte de session (En cours)       w 320, self-stretch
│   ├─ Dev · Carte de session (Autorisation)   w 320, self-stretch
│   └─ Tuile · Projets récents                 flex 1 (= 440), gap 4  ← row height 308
└─ Rangée · Git et intégrations (y 762, h 308, gap 24)
    ├─ Tuile · Dernières modifications  w 744, gap 4  ← row height 308
    └─ Tuile · Intégrations             flex 1 (= 360), self-stretch, gap 4
```

Content ends at y 1070 (50 px left in the 1120 frame). Responsive rule that reproduces 1440 exactly:
rows 1 and 3 use a 3-column grid of equal columns (1128 − 2 × 24) / 3 = 360, "Dernières modifications"
spanning 2 columns (744); row 2 uses `320px 320px 1fr` (or ratio 8 : 8 : 11). Tiles in a row stretch to
the tallest one; content inside stays top-aligned (extra space at the bottom of session cards, as drawn).

### 4.3 Copy (verbatim)

Header: "Bonjour Nezar" · "Mercredi 4 novembre 2026 · VPS-3 et Claude Code sont disponibles" · bell
button (no label) · "Nouvelle session".

Tuile · Serveur VPS-3: "Serveur VPS-3" · badge "En ligne" · "Processeur" / "23 %" · "Mémoire" /
"5,1 / 16 Go" · "Stockage" / "61 / 160 Go" · "OVH Gravelines · en ligne depuis 18 j · redémarrage
automatique actif".

Tuile · Claude Code: "Claude Code" · badge "Attention requise" · "2" + "sessions actives sur 4 possibles" ·
alert "Tests e2e du devis attend votre autorisation" · "CLI officiel connecté au compte Claude · formule
Max. Nuera Dev ne stocke aucun identifiant." · buttons "Répondre" (check icon) and "Voir les sessions".

Tuile · Reprise rapide: "Reprise rapide" · link "Toutes les sessions" · "Module CRM · pipeline" ·
"Nuera OS" · "feature/crm-core" · "DERNIÈRE INSTRUCTION" · "« Termine le module pipeline du CRM : colonnes
glissables, total par étape et tests unitaires. »" · "Plan 3 / 5 · écrit les tests de pipeline-totals.ts" ·
button "Reprendre la session" (play icon).

Carte de session 1: "En cours" · "12 min" · "Module CRM · pipeline" · "Nuera OS" · "feature/crm-core ·
worktree crm-core" · "Écrit les tests de pipeline-totals.ts" · button "Ouvrir".
Carte de session 2: "Autorisation demandée" · "2 min" · "Tests e2e du devis" · "Nuera OS" ·
"feature/devis-pdf · worktree devis-pdf" · "Attend votre accord pour npm run test -- crm" · button "Répondre".

Tuile · Projets récents: "Projets récents" · link "Tous les projets" · rows:

| Name | Branch | Badge | Time |
|---|---|---|---|
| "Nuera OS" (favourite) | "feature/crm-core" | "À jour" (Succès) | "3 min" |
| "Atelier Lune" (favourite) | "feature/galerie-photos" | "2 en retard" (Alerte) | "hier" |
| "Kiné Rive Gauche" | "fix/tarifs-mobile" | "À jour" (Succès) | "lun." |
| "Site Nuera Studio" | "main" | "À jour" (Succès) | "28 oct." |

Tuile · Dernières modifications: "Dernières modifications" · link "Ouvrir sur GitHub" · rows:

| Icon | Ref | Message | Meta |
|---|---|---|---|
| git-commit | "a3f9c12" | "crm : ajoute les colonnes glissables du pipeline" | "Nuera OS · feature/crm-core · par Claude Code · il y a 6 min" |
| git-commit | "7b21e04" | "crm : calcule le total de chaque étape" | "Nuera OS · feature/crm-core · par Claude Code · il y a 9 min" |
| git-pull-request | "#42" | "Galerie photos : pull request ouverte vers main" | "Atelier Lune · feature/galerie-photos · hier" |
| git-commit | "e19d5aa" | "galerie : grille de photos sur trois colonnes" | "Atelier Lune · feature/galerie-photos · hier" |

Tuile · Intégrations: "Intégrations" · link "Gérer" · "GitHub" / "12 dépôts accessibles" / "Connecté" ·
"Figma" / "serveur MCP" / "Connecté" · "Coolify" / "serveur MCP · développement" / "Expiré" · footer
"Coolify : reconnecter pour relancer les déploiements de développement."

### 4.4 Components and exact values

- **Header**: see §3.3. Bell = bordered icon button (§2.9), `icon/bell` 18 `#233353`. "Nouvelle session"
  = `Button` Accent Rest.
- **Tuile · Serveur VPS-3** (w 360, gap 16): header = `En-tête de tuile` (server glyph, "Serveur VPS-3")
  + Badge Succès "En ligne". Three gauges (`Jauge · Processeur / Mémoire / Stockage`, each column gap 6):
  label row `justify-between` — label Outfit 400 13 `--muted`, value JetBrains Mono 500 12 `--text`;
  track ("Piste") 8 px tall incl. 1 px `--border`, bg `--surface-raised`, radius full, overflow clip;
  fill ("Remplissage") bg `--accent`, radius 4 px, inset 1 px, width = percentage of the inner track
  (drawn: 74 / 102 / 122 px of 318 ≈ 23 %, 31.9 %, 38.1 %). Footer JetBrains Mono 400 11 / 16 `--muted`.
- **Tuile · Claude Code** (w 360, gap 12): header (terminal glyph) + Badge Alerte "Attention requise".
  `Valeur` row (gap 8, baseline aligned): "2" Outfit 600 30 `--text` + label Outfit 400 13 `--muted`.
  `Alerte` box: bg `warn-pale`, radius `--radius-md`, padding 8 × 12, gap 8, `icon/alert` 16 `warn` + text
  Outfit 400 13 `warn`. Note Outfit 400 12 / 17 `--muted`. `Actions` (gap 8): Bouton compact Principal +
  check icon "Répondre" (109 wide), Bouton compact Secondaire "Voir les sessions" (127 wide).
- **Tuile · Reprise rapide** (flex 1, gap 12): header (history glyph) + link "Toutes les sessions".
  Title Outfit 600 20 `--text`. `Contexte` row (gap 12): project (gap 6, folder icon 14 `--muted`, Outfit
  400 12 `--muted`) and branch (gap 6, worktree icon 14 `--muted`, JetBrains Mono 400 11 `--muted`).
  `Dernière instruction` box: bg `--surface-raised`, 1 px `--border`, radius `--radius-md`, padding
  10 × 12, gap 4; label JetBrains Mono 400 11 `--muted` tracking 0.88 px; quote Outfit 400 13 / 18 `--text`.
  `Avancement` (gap 8): `icon/clock` 16 `en-cours` + Outfit 400 13 `--muted`. Bouton compact Principal +
  play icon "Reprendre la session" (176 wide).
- **Dev · Carte de session** (w 320, padding 20, gap 10, radius xl, Shadow/Soft):
  `Statut` row (gap 8): dot 8 (En cours → `en-cours` `#e0a10f`; Autorisation → `warn` `#8a6516`) +
  label Outfit 500 12 **`warn` in both variants** (flex 1) + elapsed JetBrains Mono 400 11 `--muted`.
  Title Outfit 600 16 `--text`, one line, ellipsis. `Contexte` column (gap 4): project row (gap 6,
  folder 14 + Outfit 400 12 `--muted`), branch row (gap 6, worktree 14 + JetBrains Mono 400 11 `--muted`,
  ellipsis). Last activity Outfit 400 13 / 18 `--text`, ellipsis. Action: En cours → Bouton compact
  Secondaire "Ouvrir"; Autorisation → Bouton compact Principal "Répondre" (no icon).
- **Tuile · Projets récents** (flex 1, gap 4): header (folder glyph) + link "Tous les projets". Rows (§2.5,
  56 high): `icon/star` 16 (stroke `--accent` = favourite, `#d9dade` = not favourite; outline only) ·
  name block flex 1 (name Outfit 600 14 `--text`; branch JetBrains Mono 400 11 `--muted`, ellipsis) ·
  Badge · time JetBrains Mono 400 11 `--muted`.
- **Tuile · Dernières modifications** (w 744, gap 4): header (git-commit glyph) + link "Ouvrir sur GitHub".
  Rows: icon 16 `--muted` · `Réf` cell w 72, JetBrains Mono 500 12 `--accent` · text block flex 1
  (message Outfit 400 14 `--text`; meta Outfit 400 12 `--muted`).
- **Tuile · Intégrations** (flex 1, self-stretch, gap 4): header (plug glyph) + link "Gérer". Rows: Pastille
  28 (`--accent-pale`, radius sm, brand/service icon 16 `--accent`) · name block flex 1 (Outfit 600 14
  `--text` / Outfit 400 12 `--muted`) · Badge (Succès "Connecté" / Danger "Expiré"). Footer Outfit 400
  12 / 17 `danger`.

### 4.5 Data displayed → entities and formats

- `User`: firstName "Nezar" (greeting "Bonjour {prénom}"), initials, role "Propriétaire", `twoFactor`.
- Today's date, long French format with capitalised weekday: "Mercredi 4 novembre 2026". Availability
  sentence "VPS-3 et Claude Code sont disponibles" (variants when one is down are not drawn).
- `Server`: name "VPS-3", provider/location "OVH Gravelines", status (badge "En ligne"), `cpuPercent`
  (integer, `23 %`), memory used/total in Go with one decimal and comma (`5,1 / 16 Go`), disk used/total
  (`61 / 160 Go`), uptime in days (`en ligne depuis 18 j`), `autoRestart` flag.
- `ClaudeCodeStatus`: CLI connected, account plan "formule Max", `activeSessions` 2, `maxSessions` 4,
  pending authorisations (session title → alert sentence "{session} attend votre autorisation"); tile
  badge "Attention requise" when ≥ 1 pending.
- `Session`: id, title, project name, branch, worktree name, status (`en_cours` | `autorisation` |
  `terminee` | `interrompue`), elapsed since start or last event (`12 min`, `2 min`), last activity line,
  last instruction (prompt text, rendered in « »), plan progress (`Plan 3 / 5 · {current step}`), pending
  permission description ("Attend votre accord pour {commande}").
- `Project` (recent list): name, favourite, current branch, sync summary (`À jour` | `{n} en retard`),
  last activity short format (`3 min`, `hier`, `lun.`, `28 oct.`). Four rows, ordered by last activity.
- `GitEvent`: type (`commit` | `pull_request`), ref (7-char short SHA or `#{number}`), message, project,
  branch, author ("par Claude Code" when authored by a session; omitted for PR rows), relative time
  (`il y a 6 min`, `hier`).
- `Integration`: name, kind/detail ("12 dépôts accessibles", "serveur MCP", "serveur MCP · développement"),
  status (`Connecté` | `Expiré`), optional error message line.

### 4.6 Interactive elements

| Element | Prototype link in Figma | Behaviour (target / effect) |
|---|---|---|
| Sidebar items | yes (except Accueil) | navigate to the section |
| Bell button | no | open notifications (not designed); badge for unread not drawn |
| "Nouvelle session" (Button Accent) | yes | start a new session → Workspace new-session state (`W1 · Workspace · Nouvelle session`, `227:3075`); needs a project choice |
| "Répondre" (Claude Code tile) | yes | open the session waiting for permission → `D05 · Workspace Claude Code` (Parcours B "D05 Autorisation") |
| "Voir les sessions" | no | → `/sessions` (D06) |
| "Toutes les sessions" link | no | → `/sessions` |
| "Reprendre la session" | yes | open the Workspace of "Module CRM · pipeline" (D05) |
| Session card "Ouvrir" / "Répondre" | no | open that session's Workspace (Répondre = jump to the permission request) |
| "Tous les projets" link | no | → `/projets` |
| Recent project row | no | → `/projets/[id]` (D04); star toggles favourite (implied) |
| "Ouvrir sur GitHub" link | no | external GitHub (new tab) |
| Commit ref / PR row | no | external link to commit / PR (implied) |
| "Gérer" link | no | → `/integrations` (D07) |
| Coolify row / error line | no | → D07 reconnect flow (`D2 · Intégrations · MCP Coolify à reconnecter`) |

All values are live: gauges, counts and relative times should refresh (polling or server push);
loading/skeleton states are in `T1 · Chargement et synchronisation` (other spec).

### 4.7 States and variants shown

Server online (Succès badge). Claude Code with a pending permission ("Attention requise" Alerte badge +
warn alert box). Session cards in `En cours` and `Autorisation`. Favourite vs non-favourite stars. Sync
badges `À jour` and `2 en retard`. Integrations `Connecté` and `Expiré` (+ danger footer line). No
annotation is placed on the D01 frame itself.

### 4.8 Mobile

Phone counterpart: `M01 · Accueil` (`220:2366`), documented in the mobile spec (bottom tab bar replaces
the sidebar).

---

## 5. D02 — Projets

### 5.1 Identity

`D02 · Projets`, node `210:675`, 1440 × 1120, sidebar `Actif=Projets`. Route `/projets`.
Purpose: library of repositories cloned on VPS-3, with search, filters, sort, per-row status and a row
action menu. The frame shows the **row menu of "Atelier Lune" open** (`Menu · Atelier Lune`, `210:991`).

### 5.2 Layout skeleton

```
Contenu (padding 28/32, gap 24)
├─ En-tête (y 28, h 57): Titre (w 944) | Button Accent "Ajouter un projet" (172 × 54)
├─ Barre d'outils (y 109, h 40, gap 12, items centred):
│    Champ recherche w 360 | Filtres (3 chips, gap 4) | Espace (flex) | Champ tri w 230
├─ Tableau des projets (y 173, h 376): tile, padding 8 × 20
│    En-têtes (h 36) + 5 × Dev · Ligne de projet (65, last 64)
└─ Note · Archivage (y 573, h 16)
Menu · Atelier Lune: absolute, x 1140, y 341, 248 × 192 (over the table)
```

Table columns (gap 16 between cells, container padding 20 left/right):

| Column | Header (verbatim) | Width | Alignment |
|---|---|---|---|
| Projet | "PROJET" | flex 1 (282 at 1440) | left |
| Branche | "BRANCHE" | 200 | left |
| Synchronisation | "SYNCHRONISATION" | 170 | left |
| Sessions | "SESSIONS" | 130 | left |
| Dernière activité | "ACTIVITÉ" | 110 | left |
| Actions | "ACTIONS" | 116 | right |

### 5.3 Copy (verbatim)

Header: "Projets" · "5 dépôts clonés sur VPS-3 · 41 Go utilisés sur 160" · "Ajouter un projet".
Toolbar: placeholder "Rechercher un projet ou un dépôt…" · chips "Tous · 5" (selected), "Favoris · 2",
"Archivés · 1" · select "Trier : activité récente".

Rows:

| Fav. | Name | Repo | Branch | Sync badge | Sessions | Activity | Actions |
|---|---|---|---|---|---|---|---|
| ★ accent | "Nuera OS" | "nuera-studio/nuera-os" | "feature/crm-core" | "À jour" (Succès) | dot En cours + "2 actives" | "il y a 3 min" | "Ouvrir" · "…" |
| ★ accent | "Atelier Lune" | "nuera-studio/atelier-lune" | "feature/galerie-photos" | "2 commits en retard" (Alerte) | dot Succès + "1 terminée" | "hier" | "Ouvrir" · "…" |
| ☆ grey | "Kiné Rive Gauche" | "nuera-studio/kine-rive-gauche" | "fix/tarifs-mobile" | "À jour" (Succès) | dot Danger + "1 interrompue" | "lun. 2 nov." | "Ouvrir" · "…" |
| ☆ grey | "Site Nuera Studio" | "ethanthedevelop/nuera-studio" | "main" | "Conflit à résoudre" (Danger) | dot Neutre + "aucune" | "30 oct." | "Ouvrir" · "…" |
| ☆ grey | "Nuera Dev" | "nuera-studio/nuera-dev" | "main" | "Synchronisation…" (Accent) | dot Neutre + "aucune" | "28 oct." | "Ouvrir" · "…" |

(In the screenshot the open menu hides the activity/actions cells of rows 3–5; the values above come from
the layer data and are visible in D03.)

Archive note: "Archiver retire un projet de cette liste et peut libérer son espace sur VPS-3, après
confirmation. Le dépôt GitHub n'est jamais supprimé."

Row menu (`Menu · Atelier Lune`): "Retirer des favoris" (star) · "Synchroniser maintenant" (refresh,
highlighted) · "Nouvelle branche…" (git-branch) · "Nouvelle session ici" (terminal) · "Archiver le
projet…" (archive, danger).

### 5.4 Components and exact values

- **Search field**: `Dev · Champ` 360 × 40, leading search icon 16 `--muted`, placeholder Outfit 400 14 `--muted`.
- **Filter chips**: `Badge` — "Tous · 5" Accent (selected), others Neutre; gap 4; height 23.
- **Sort select**: `Dev · Champ` 230 × 40, value Outfit 400 14 `--text`, trailing chevron 16 `--muted`.
- **Table tile**: bg `--bg`, radius xl, `Shadow/Soft`, padding 8 (top/bottom) × 20 (sides), full width.
  - Header row: padding 10 × 0, gap 16, 1 px bottom `--border`, height 36; labels JetBrains Mono 400 11
    `--muted`, tracking 0.88 px.
  - **Dev · Ligne de projet** (1088 × 65): padding 14 × 0, gap 16, 1 px bottom `--border` (none on the last
    row), items centred.
    - Projet cell (gap 12): `Favori` star 18 (stroke `--accent` if favourite, `#d9dade` otherwise) +
      `Identité` (gap 2): name Outfit 600 15 `--text`; `Ligne dépôt` (gap 6): `icon/github` 12 `--muted`
      + owner/repo JetBrains Mono 400 11 `--muted`.
    - Branche cell (gap 6): `icon/git-branch` 14 `--muted` + JetBrains Mono 400 12 `--text`, ellipsis.
    - Synchronisation cell: one Badge (Succès / Alerte / Danger / Accent as above).
    - Sessions cell (gap 8): `Dev · Point de statut` (En cours / Succès / Danger / Neutre) + Outfit 400 13 `--text`.
    - Activité cell: Outfit 400 13 `--muted`.
    - Actions cell (gap 4, right-aligned): Bouton compact Secondaire "Ouvrir" (no icon) + ghost icon
      button 36 with `icon/more` 18 `--muted`.
- **Note · Archivage**: row gap 8, `icon/archive` 16 `--muted` + Outfit 400 13 `--muted`.
- **Row menu** (`Menu · Atelier Lune`): absolute, width 248, bg `--bg`, 1 px `--border`, radius
  `--radius-md`, padding 6, vertical gap 2, `Shadow/Float`. Option: padding 8 × 10, gap 10, radius
  `--radius-sm`, icon 16 + label Outfit 400 14. Normal option: icon `#233353`, label `--text`. Highlighted
  option (hover/keyboard focus): bg `--accent-pale`. Destructive option: icon and label `danger`
  `#b4451f`. Anchoring: the menu's right edge aligns with the "…" trigger's right edge (x 1388) and its
  top sits 8 px below the trigger (trigger bottom ≈ 333, menu top 341) — i.e. `bottom-end`, offset 8.

### 5.5 Data → entities

- Header aggregates: number of cloned repos (`5 dépôts clonés sur VPS-3`), disk used by projects vs disk
  total (`41 Go utilisés sur 160`).
- `Project`: id, name, `repoFullName` (owner/repo; owners vary: `nuera-studio`, `ethanthedevelop`),
  favourite, archived, current branch, sync state (`a_jour` | `en_retard{n}` → "{n} commits en retard" |
  `conflit` → "Conflit à résoudre" | `synchronisation` → "Synchronisation…"), sessions summary (active
  count → "{n} actives" with En cours dot; else last session outcome "1 terminée" / "1 interrompue";
  else "aucune" with neutral dot), last activity (relative: "il y a 3 min", "hier", then
  "lun. 2 nov." within the week, then "30 oct.").
- Filter counts: total, favourites, archived. Sort options: only "activité récente" is drawn.

### 5.6 Interactive elements

| Element | Prototype link | Behaviour |
|---|---|---|
| "Ajouter un projet" | yes | open the add-project modal at step 1 → `A1 · Ajouter un projet · Choix du dépôt` (`233:4846`), then D03 |
| Search field | no | filter rows by project name or `owner/repo` as you type |
| Chips "Tous / Favoris / Archivés" | no | single-select filter; the selected chip is the Accent badge |
| "Trier : activité récente" | no | sort select (other options not drawn) |
| Star | no | toggle favourite |
| Row "Ouvrir" | yes (Nuera OS row) | → `/projets/[id]` (D04) |
| Row "…" | no | open the row menu (as drawn) |
| Menu "Retirer des favoris" | — | toggle favourite (label becomes the opposite for non-favourites; wording not drawn) |
| Menu "Synchroniser maintenant" | — | fetch/pull now; row badge shows "Synchronisation…" while running |
| Menu "Nouvelle branche…" | — | open the new-branch dialog (ellipsis = asks for input) |
| Menu "Nouvelle session ici" | — | start a session on this project → Workspace |
| Menu "Archiver le projet…" | — | destructive, requires confirmation (`T8 · Actions sensibles à confirmer`); never deletes the GitHub repo, may free disk space |

Menu keyboard support (implementation): `role="menu"`, arrow keys, Escape closes and returns focus to "…".

### 5.7 States and variants shown

Four sync states, four session summaries, favourite on/off, selected vs unselected chip, open row menu with
a highlighted item and a destructive item, last table row without separator. Empty list / loading states
live in `T2 · Listes vides` and `T1` (other spec).

### 5.8 Mobile

Phone counterpart: `M02 · Projets` (`220:2575`).

---

## 6. D03 — Ajouter un projet (step 2 « Configuration »)

### 6.1 Identity

`D03 · Ajouter un projet`, node `211:933`, 1440 × 1120. A modal (`Modale · Ajouter un projet`,
`211:1255`, 640 × 771) over the D02 page, behind a full-frame veil (`Voile`, `211:1254`). Sidebar
`Actif=Projets`, inert. Route suggestion: `/projets/nouveau` (intercepted modal over `/projets`), step
`configuration`. In Parcours A this is "D03 Configuration", between "A1 Dépôt" and "A2 Clonage".

### 6.2 Layout skeleton

```
Background: D02 page (no open menu)                          Veil: 1440 × 1120, --near-black @ 55 %
Modal: x 524, y 175, w 640 (h 771), radius 28, Shadow/Float, overflow clip
├─ En-tête (h 135): padding 24 top / 20 bottom / 28 sides, gap 16, 1 px bottom border
│   ├─ Titre row (gap 12): Texte (title + subtitle, gap 4) | Fermer 36 (×)
│   └─ Étapes (gap 8): ✓ Dépôt ── (2) Configuration ── (3) Clonage
├─ Corps (h 549): padding 24 × 28, gap 20
│   ├─ Dépôt choisi (584 × 62)
│   ├─ Deux colonnes (gap 16): Champ · Branche (284) | Champ · Nom (284)
│   ├─ Champ · Destination sur VPS-3 (584, with helper)
│   ├─ Options (bordered group, 584 × 181, 3 rows)
│   └─ Accès GitHub (icon + 2-line note)
└─ Pied (h 87): 1 px top border, padding 16 × 28, gap 12: "Étape 2 sur 3" (flex) | Retour | Cloner sur VPS-3
```

Centering: the modal is centred on the **content region** (x 248 + (1192 − 640) / 2 = 524), not on the
viewport, and vertically centred in the frame ((1120 − 771) / 2 ≈ 175). The veil covers the sidebar too.

### 6.3 Copy (verbatim)

- Title "Ajouter un projet"; subtitle "Le dépôt est cloné sur VPS-3, là où Claude Code travaille."
- Stepper: "Dépôt" (done, check), "2" "Configuration" (current), "3" "Clonage" (upcoming).
- Selected repo: "nuera-studio/roux-conseil" · "Privé · TypeScript · mis à jour il y a 2 jours · 84 Mo" ·
  "Changer".
- "Branche de départ" → value "main" (select). "Nom dans Nuera Dev" → value "Roux Conseil · Landing".
- "Destination sur VPS-3" → value "/srv/dev/roux-conseil"; helper "Dossier vide requis. Espace libre :
  99 Go sur 160."
- Options: "Installer les dépendances après le clonage" / "Lance npm ci : le gestionnaire est détecté
  depuis package-lock.json." (switch on) · "Un worktree par nouvelle session" / "Deux sessions ne modifient
  jamais le même dossier." (switch on) · "CLAUDE.md du dépôt" / "Trouvé à la racine. Claude Code le lit à
  chaque session." (badge "Détecté").
- "Accès GitHub : lecture et écriture du contenu, pull requests. Accordé à l'application GitHub de Nuera
  Dev, jamais par jeton collé à la main."
- Footer: "Étape 2 sur 3" · "Retour" · "Cloner sur VPS-3".
- Background differs from D02 in one string: the activity column header reads "DERNIÈRE ACTIVITÉ"
  (overflows its 110 px column); D02's "ACTIVITÉ" is the one to keep (see §9).

### 6.4 Components and exact values

- Modal container: bg `--bg`, radius `--radius-xl`, `Shadow/Float`, width 640, overflow clip, vertical.
- Header: title Outfit 600 22 `--text`; subtitle Outfit 400 14 `--muted`; close = ghost icon button 36,
  `icon/x` 18 `--muted`.
- Stepper (`Étapes`, gap 8, items centred): step = circle 24 + label (gap 8).
  - Done: circle bg `success-pale`, `icon/check` 14 `success`; label Outfit 400 14 `--text`.
  - Current: circle bg `--accent`, number JetBrains Mono 700 12 `--paper`; label Outfit 600 14 `--text`.
  - Upcoming: circle bg `--surface-raised` + 1 px `--border`, number JetBrains Mono 700 12 `--muted`;
    label Outfit 400 14 `--muted`.
  - Connector (`Liaison`): 40 × 1, bg `--border`.
- `Dépôt choisi`: bg `--surface-raised`, 1 px `--border`, radius `--radius-md`, padding 12 × 16, gap 12,
  items centred: Pastille 36 (`--accent-pale`, radius sm, `icon/github` 18 `--accent`) · text block flex 1
  (gap 2): repo JetBrains Mono 500 14 `--text`; meta Outfit 400 12 `--muted` · Bouton compact Discret
  "Changer" (no icon).
- Fields: `Dev · Champ` (§2.8) — Branche: leading git-branch icon 16 (the export mixes `#645e78` and
  `#233353` strokes), value JetBrains Mono 400 14, trailing chevron 16 `--muted` (select); Nom: plain text input Outfit 400 14; Destination: leading folder icon 16 `--muted`,
  value JetBrains Mono 400 14, helper 12 / 16 `--muted`.
- `Options` group: bg `--bg`, 1 px `--border`, radius `--radius-md`, overflow clip; rows padding 12 × 16,
  gap 12, 1 px bottom border between rows; text block (gap 2): title Outfit 500 14 `--text`, description
  Outfit 400 12 `--muted`; trailing `Dev · Interrupteur` (Actif=Oui) or Badge Succès "Détecté".
- `Accès GitHub`: row gap 8, `icon/shield` 16 `success` + Outfit 400 12 / 16 `--muted` (2 lines).
- Footer: step text JetBrains Mono 400 12 `--muted`, flex 1; `Button` Default "Retour"; `Button` Accent
  "Cloner sur VPS-3".
- Veil: `--near-black`, opacity 0.55, covers 1440 × 1120.

### 6.5 Data → entities

- `GitHubRepo` (chosen at step 1): fullName, visibility ("Privé"), primary language ("TypeScript"),
  `updatedAt` relative ("mis à jour il y a 2 jours"), size ("84 Mo"), branches (for the select), default
  branch preselected ("main"), detected package manager (from lockfile → "npm ci"), presence of a root
  `CLAUDE.md`.
- `AddProjectDraft`: `baseBranch`, `displayName` (prefilled from the repo name, editable — "Roux Conseil ·
  Landing"), `destinationPath` (prefilled `/srv/dev/{repo}`), `installDependencies` (bool, default on),
  `worktreePerSession` (bool, default on).
- Server disk: free / total ("Espace libre : 99 Go sur 160").
- GitHub access is granted by the Nuera Dev GitHub App (permissions: contents read/write, pull requests) —
  never a pasted token.

### 6.6 Interactive elements

| Element | Prototype link | Behaviour |
|---|---|---|
| Close "×", veil click, Escape | no | close the modal, back to `/projets` (confirm if the draft changed — not drawn) |
| "Changer" | no | back to step 1 (A1 · Choix du dépôt) keeping the draft |
| "Branche de départ" | no | select among repo branches |
| "Nom dans Nuera Dev" | no | free text, required |
| "Destination sur VPS-3" | no | path input; validate: folder must be empty/non-existent and enough free space (error state = `Dev · Champ` État=Erreur) |
| Two switches | no | toggle options |
| "Détecté" badge | no | read-only information |
| "Retour" | no | step 1 (A1) |
| "Cloner sur VPS-3" | yes | start the clone → `A2 · Ajouter un projet · Clonage en cours` (`233:4944`); then A3 success or A4 recoverable error |

Focus management: trap focus inside the modal, initial focus on the first field or the title, restore
focus to "Ajouter un projet" on close; `aria-modal="true"`, labelled by the title.

### 6.7 States and variants shown

Stepper with done / current / upcoming steps; switches on; detected CLAUDE.md; filled fields at rest.
Other steps and errors: A1, A2, A3, A4 frames in section 03 (other spec).

### 6.8 Mobile

Phone counterpart: `M03 · Ajouter un projet` (`221:2587`) — full-screen flow with a top bar, a 4 px
progress bar and a bottom action bar (documented in the mobile spec).

---

## 7. D04 — Détail du projet

### 7.1 Identity

`D04 · Détail du projet`, node `213:1233`, 1440 × **1158** (content scrolls), sidebar `Actif=Projets`.
Route `/projets/[projetId]` (tab "Vue d'ensemble"). Purpose: everything about one project — repo, branch,
sync, dev commands, branches/worktrees, sessions, CLAUDE.md, per-project MCP tools, environment variables.

### 7.2 Layout skeleton

```
Contenu (padding 28/32, gap 20)
├─ En-tête (y 28, h 89, gap 12, items-end)
│   ├─ Titre (flex, gap 6): breadcrumb (16) / Nom row (35: H1 + badge) / Méta row (26)
│   ├─ Button Default "Synchroniser" (146 × 54)
│   └─ Button Accent "Ouvrir le Workspace" (196 × 54)
├─ Onglets (y 137, h 23, gap 4): 7 badge-tabs
└─ Grille (y 180, h 950, gap 20)
    ├─ Colonne principale (flex 1 = 688, gap 20)
    │   ├─ Tuile · Environnement de développement (h 349)
    │   ├─ Tuile · Branches (h 311)
    │   └─ Tuile · Sessions de ce projet (h 250)
    └─ Colonne latérale (w 420, gap 20)
        ├─ Tuile · CLAUDE.md (h 356)
        ├─ Tuile · Outils MCP du projet (h 247)
        └─ Tuile · Variables d'environnement (h 271)
```

Grid rule: `grid-template-columns: minmax(0, 1fr) 420px; gap: 20px`. Frame bottom = 180 + 950 + 28.

### 7.3 Copy (verbatim)

Header: breadcrumb `Projets  /  Nuera OS` · H1 "Nuera OS" · badge "À jour" · repo link
"nuera-studio/nuera-os" (+ external icon) · branch selector "feature/crm-core" · "/srv/dev/nuera-os ·
synchronisé il y a 4 min" · "Synchroniser" · "Ouvrir le Workspace".

Tabs: "Vue d'ensemble" (selected) · "Branches · 6" · "Environnement" · "CLAUDE.md" · "Outils MCP · 2" ·
"Variables · 4" · "Sessions · 7".

Tuile · Environnement de développement — title "Environnement de développement":

| Label | Command | Status badge | Action |
|---|---|---|---|
| "Installation" | `npm ci` | "Réussie · il y a 2 h" (Succès) | "Lancer" (play) |
| "Lancement" | `npm run dev` | "En cours · port 3000" (Accent) | "Arrêter" (no icon) |
| "Build" | `npm run build` | "Réussi · hier" (Succès) | "Lancer" (play) |
| "Tests" | `npm run test` | "10 / 10 réussis · 10:51" (Succès) | "Lancer" (play) |

Footnote: "Chaque commande tourne dans le worktree actif et s'affiche dans le Terminal du Workspace. Le
résultat ci-dessus est celui du dernier lancement réel."

Tuile · Branches — "Branches" · button "Nouvelle branche" (plus icon):

| Icon | Branch | Description | Badge |
|---|---|---|---|
| git-branch | "feature/crm-core" | "worktree crm-core · 2 commits d'avance sur main" | "Courante" (Accent) |
| git-branch | "feature/devis-pdf" | "worktree devis-pdf · une session y travaille" | "Session active" (Alerte) |
| lock | "main" | "branche protégée · à jour avec origin" | "Protégée" (Neutre) |
| git-branch | "fix/pipeline-scroll" | "fusionnée dans main il y a 3 jours" | "Fusionnée" (Succès) |

Tuile · Sessions de ce projet — "Sessions de ce projet" · link "Tout l'historique":

| Dot | Title | Sub-line | Action |
|---|---|---|---|
| En cours `#e0a10f` | "Module CRM · pipeline" | "feature/crm-core · depuis 12 min" | "Ouvrir" (Discret) |
| Alerte `#8a6516` | "Tests e2e du devis" | "feature/devis-pdf · attend une autorisation" | "Répondre" (Principal, no icon) |
| Succès `#2f6f4f` | "Devis PDF · première version" | "19 oct. · terminée · 1 h 05" | "Résumé" (Discret) |

Tuile · CLAUDE.md — "CLAUDE.md" · button "Modifier" (pencil icon) · preview (11 lines, keep spacing):

```
# Nuera OS
CRM et espace client de Nuera Studio.
Next.js 16, TypeScript, Postgres.

## Commandes
- npm run dev   développement
- npm run test  Vitest

## Règles
- Commentaires en français
- Aucune valeur en dur : tokens
```

Footnote: "Modifié le 28 oct. · commit 4c1d0e2. Chaque modification passe par un commit sur la branche
courante."

Tuile · Outils MCP du projet — "Outils MCP du projet": "Figma" / "maquettes Nuera OS · lecture" (on) ·
"GitHub" / "issues et pull requests du dépôt" (on) · "Coolify" / "environnement de développement · à
reconnecter" (off, warn text).

Tuile · Variables d'environnement — "Variables d'environnement" · badge ".env.local · hors Git":

| Key | Value | Icon |
|---|---|---|
| `DATABASE_URL` | `••••••••••••` | eye |
| `AUTH_SECRET` | `••••••••••••` | eye |
| `NEXT_PUBLIC_SITE_URL` | `https://os.nuera.studio` | edit (pencil) |
| `CAL_API_KEY` | `••••••••••••` | eye |

Footer: "Secrets masqués, jamais écrits dans un fichier versionné." · "Ajouter" (plus icon).
(The mask is exactly 12 × U+2022.)

### 7.4 Components and exact values

- **Header**: `Titre` column gap 6. Breadcrumb JetBrains Mono 400 12 `--muted`, `white-space: pre`.
  `Nom` row gap 10: H1 Outfit 600 28 `--text` + Badge Succès. `Méta` row gap 16, items centred:
  - repo link (gap 6): `icon/github` 14 `--accent` + JetBrains Mono 400 12 `--accent` + `icon/external` 12 `--accent`;
  - branch selector chip ("Sélecteur de branche"): 1 px `--border`, radius full, padding 4 × 10, gap 6,
    height 26: `icon/git-branch` 14 `#233353` + JetBrains Mono 400 12 `--text` + `icon/chevron-down` 14 `--muted`;
  - path + sync text Outfit 400 13 `--muted` (Outfit, not mono).
  Buttons bottom-aligned with the meta row.
- **Tabs** (`Onglets`): Badges, gap 4; selected = Accent, others Neutre.
- **Tuile · Environnement de développement** (gap 4): header (terminal glyph). Command row: padding
  10 × 0, gap 12, 1 px bottom border (none on "Tests"), height 57: label cell w 110 Outfit 500 14
  `--text` · command box flex 1: bg `--surface-raised`, 1 px `--border`, radius `--radius-sm`, padding
  6 × 10, JetBrains Mono 400 12 `--text` (height 30) · status Badge · Bouton compact Discret ("Lancer" with
  play icon 16 `--accent`; "Arrêter" text only). Footnote Outfit 400 12 / 17 `--muted`.
- **Tuile · Branches** (gap 4): header (git-branch glyph) + Bouton compact Secondaire with plus icon 16
  `#233353` "Nouvelle branche" (header height 36). Row: padding 10 × 0, gap 12, border except last;
  icon 16 `--muted` (git-branch, or lock for protected) · text (gap 2): branch JetBrains Mono 500 13
  `--text`, description Outfit 400 12 `--muted` · Badge.
- **Tuile · Sessions de ce projet** (gap 4): header (terminal glyph) + link "Tout l'historique" (Outfit 500
  13 `--accent`). Row: padding 10 × 0, gap 12; `Dev · Point de statut` · text (gap 2): title Outfit 500 14
  `--text`, sub-line JetBrains Mono 400 11 `--muted` · Bouton compact (Discret / Principal).
- **Tuile · CLAUDE.md** (gap 12): header (book glyph) + Bouton compact Secondaire with pencil icon 16
  `#233353` "Modifier". Preview (`Aperçu`, Color collection in **Dark** mode): bg `#233353`, radius
  `--radius-md`, padding 12 × 14, JetBrains Mono 400 12 / 18, colour `rgba(255,255,255,0.62)`,
  `white-space: pre-wrap`, blank lines kept. Footnote Outfit 400 12 / 17 `--muted`.
- **Tuile · Outils MCP du projet** (gap 4): header (plug glyph). Row: padding 10 × 0, gap 12, border except
  last; Pastille 28 (`--accent-pale`, service icon 16 `--accent`) · text (gap 2): name Outfit 500 14
  `--text`, description Outfit 400 12 `--muted` (Coolify: `warn`) · `Dev · Interrupteur` (Oui / Non).
- **Tuile · Variables d'environnement** (gap 4): header (key glyph) + Badge Succès ".env.local · hors Git".
  Row: padding 10 × 0, gap 12, border except last, height 37: key cell w 170 JetBrains Mono 500 12 `--text`
  ellipsis · value flex 1 JetBrains Mono 400 12 `--muted` ellipsis · icon 16 `--muted` (eye = reveal,
  pencil = edit). `Pied` (gap 8): note Outfit 400 12 `--muted` flex 1 + Bouton compact Discret with plus
  icon "Ajouter".

### 7.5 Data → entities

- `Project`: name, sync state (badge), `repoFullName` + GitHub URL, current branch, local path
  (`/srv/dev/nuera-os`), last sync (relative, "synchronisé il y a 4 min"); tab counters: branches (6),
  enabled MCP tools (2), env vars (4), sessions total (7).
- `DevCommand` (kinds: install, dev, build, test): command string, last run status (success / running /
  failed — failed not drawn), last run time (relative "il y a 2 h", "hier", or clock "10:51"), for `dev`
  the port (3000) while running, for `test` passed/total ("10 / 10 réussis").
- `Branch`: name, worktree name, ahead/behind main ("2 commits d'avance sur main"), current flag, has
  active session, protected flag, up to date with origin, merged (target + relative date). The overview
  lists 4 of 6.
- `Session` (project scope): title, branch, status, duration/elapsed ("depuis 12 min", "1 h 05"), end date
  ("19 oct."), pending authorisation flag. Overview lists 3 of 7.
- `ClaudeMd`: content, last modified date ("28 oct."), commit short SHA ("4c1d0e2").
- `ProjectMcpTool`: integration (Figma, GitHub, Coolify), scope description ("maquettes Nuera OS ·
  lecture", "issues et pull requests du dépôt", "environnement de développement"), enabled flag,
  needs-reconnect flag ("à reconnecter").
- `EnvVar`: key, value, `secret` flag (masked + reveal) vs public (shown + edit), storage file
  (".env.local", outside Git).

### 7.6 Interactive elements

| Element | Prototype link | Behaviour |
|---|---|---|
| Breadcrumb "Projets" | no | → `/projets` |
| Repo link | no | external GitHub repo (new tab) |
| Branch selector chip | no | dropdown to switch the current branch / worktree |
| "Synchroniser" | no | fetch + pull current branch; badge "À jour" changes while syncing |
| "Ouvrir le Workspace" | yes | open the Workspace on this project → `W1 · Workspace · Nouvelle session` (Parcours A "W1 Workspace") |
| Tabs | no | switch section (only "Vue d'ensemble" is designed) |
| "Lancer" | no | run the command in the active worktree; output streams to the Workspace Terminal; badge updates |
| "Arrêter" | no | stop the running dev server (sensitive? see `T8`) |
| "Nouvelle branche" | no | create-branch dialog (not drawn) |
| Session "Ouvrir" / "Répondre" / "Résumé" | no | open the Workspace / jump to the permission request / open the finished-session summary (`W3 · Workspace · Session terminée`) |
| "Tout l'historique" | no | → Sessions history filtered on this project (D06 or "Sessions · 7" tab) |
| "Modifier" (CLAUDE.md) | no | edit CLAUDE.md; saving creates a commit on the current branch |
| MCP switches | no | enable/disable a tool for this project; Coolify needs reconnection first (→ D07) |
| Eye icon | no | reveal a masked secret (consider confirmation / auto re-mask) |
| Pencil icon | no | edit a public variable |
| "Ajouter" | no | add an env variable (written to `.env.local`, never to a versioned file) |

### 7.7 States and variants shown

Command states (success, running with port, test counts); branch badges (Courante, Session active,
Protégée, Fusionnée); session statuses (En cours, Alerte, Succès) with three action styles; switches on and
off; MCP tool needing reconnection (warn text); masked vs plain env values; selected vs unselected tabs;
CLAUDE.md preview in Dark mode.

### 7.8 Mobile

Phone counterpart: `M04 · Détail du projet` (`221:2661`) — top bar + scrolling content + bottom action
bar (mobile spec).

---

## 8. Consolidated data model (D01–D04)

Suggested shapes (names are suggestions; formats are from the design):

```ts
type SyncState = { kind: 'a_jour' } | { kind: 'en_retard'; commits: number } | { kind: 'conflit' } | { kind: 'synchronisation' };
type SessionStatus = 'en_cours' | 'autorisation' | 'terminee' | 'interrompue';

interface Server { name: string; provider: string; location: string; online: boolean; uptimeDays: number;
  autoRestart: boolean; cpuPercent: number; memUsedGo: number; memTotalGo: number; diskUsedGo: number; diskTotalGo: number }
interface ClaudeCli { connected: boolean; plan: string; activeSessions: number; maxSessions: number }
interface Project { id: string; name: string; repoFullName: string; favorite: boolean; archived: boolean;
  currentBranch: string; path: string; sync: SyncState; lastSyncAt: string; lastActivityAt: string; diskUsageGo: number }
interface Session { id: string; projectId: string; title: string; branch: string; worktree: string; status: SessionStatus;
  startedAt: string; endedAt?: string; lastActivity: string; lastInstruction?: string;
  plan?: { step: number; total: number; label: string }; pendingPermission?: { command: string; requestedAt: string } }
interface GitEvent { type: 'commit' | 'pull_request'; ref: string; message: string; projectId: string; branch: string;
  author: string; at: string; url: string }
interface Integration { id: 'github' | 'figma' | 'coolify'; label: string; detail: string; status: 'connecte' | 'expire' }
interface DevCommand { kind: 'install' | 'dev' | 'build' | 'test'; command: string; status: 'reussi' | 'en_cours' | 'echec';
  at: string; port?: number; passed?: number; total?: number }
interface Branch { name: string; worktree?: string; ahead?: number; current: boolean; activeSession: boolean;
  protected: boolean; upToDateWithOrigin?: boolean; mergedInto?: string; mergedAt?: string }
interface EnvVar { key: string; value: string; secret: boolean }
interface ProjectMcpTool { integrationId: string; scope: string; enabled: boolean; needsReconnect: boolean }
interface AddProjectDraft { repoFullName: string; baseBranch: string; displayName: string; destinationPath: string;
  installDependencies: boolean; worktreePerSession: boolean }
```

French formatting helpers needed: long date with capitalised weekday ("Mercredi 4 novembre 2026");
relative time long ("il y a 3 min", "il y a 2 h", "hier", "lun. 2 nov.", "30 oct.") and short ("3 min",
"hier", "lun.", "28 oct.", "12 min"); "depuis 12 min"; durations "1 h 05"; days "18 j"; sizes in Go/Mo
with comma decimals ("5,1"); percent with a space ("23 %"); clock "10:51".

---

## 9. Open questions and inconsistencies spotted

1. D03's background shows the header "DERNIÈRE ACTIVITÉ" (127 px, clipped in a 110 px column) while D02
   shows "ACTIVITÉ". Recommendation: use "ACTIVITÉ".
2. Mock data differs between screens (illustrative only): "Site Nuera Studio" is "À jour / 28 oct." on D01
   but "Conflit à résoudre / 30 oct." on D02; "Kiné Rive Gauche" is "lun." vs "lun. 2 nov."; Atelier Lune
   "2 en retard" (D01, short form) vs "2 commits en retard" (D02, long form — the short form is a deliberate
   compact wording on the dashboard).
3. In `Dev · Carte de session` both "En cours" and "Autorisation demandée" labels use `warn` text; only the
   dot differs (`en-cours` vs `warn`). Confirm this is intended.
4. No destructive `Button` variant exists (canvas note "LACUNES À ARBITRER", verbatim: "1. Pas de variante
   destructive du Button : les confirmations (arrêter, archiver, supprimer) utilisent Accent. Proposer une
   variante Danger avec les jetons danger / danger-pale.").
5. Canvas note, verbatim: "3. surface et surface-raised valent toutes deux paper en mode Light : les fonds
   de champs et de blocs se distinguent par une bordure, pas par une teinte." — page, tiles and fields are
   all white; tiles rely on `Shadow/Soft` only.
6. Status variables (`success`, `warn`, `danger`, `en-cours`, `success-on-dark`, …) have no code syntax in
   Figma; pick CSS names (proposed `--success`, `--warn`, `--danger`, `--en-cours`, …).
7. NBSP: Figma uses normal spaces before ":" / "%" / units and around "·"; decide whether the app adds
   NBSPs (better French typography, avoids orphan "Go" or "·") or stays byte-identical to Figma.
8. "⌘K" is macOS-specific; the owner works on Windows — show "Ctrl K" there?
9. Undesigned targets: bell/notifications, account menu, ⌘K palette, D04 tabs other than "Vue
   d'ensemble", new-branch dialog, CLAUDE.md editor, env-var add/edit/reveal UI, row-menu label for
   non-favourites ("Ajouter aux favoris"?), sort options.
10. The modal (D03) is centred on the content region, not on the viewport — keep or centre on viewport?
11. Responsive behaviour between 1024 and 1440 px is not drawn; the column rules in §4.2 / §5.2 / §7.2 are
    proposals that reproduce 1440 exactly.

---

## 10. Capture status

- Fully captured for D01–D04: frame screenshots (1440 wide), complete `get_design_context` code (persisted
  untruncated), all referenced SVG assets (125 files), variable definitions (Light; Dark values on the
  CLAUDE.md preview), component descriptions, Button and Bouton compact component sets.
- Not captured: prototype interaction targets (the MCP output only reveals which layers carry a link —
  `<a>` in the raw code; targets above are inferred from the "Parcours" annotations and frame names);
  `Dev · Champ` Focus/Erreur specs and the individual `Dev · Barre latérale` variants (Figma MCP call
  limit reached after the main captures).
