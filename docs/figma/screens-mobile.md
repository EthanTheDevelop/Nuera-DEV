# Nuera Dev — Mobile screens (390 × 844)

Implementation spec for the eight phone screens of the Figma page **NUERA DEV — WEB APP**. Figma is the visual source of truth; this document turns it into something you can build from without reopening Figma.

| | |
|---|---|
| Figma file | `nlvRWAtD1x2fKf8gVgcM0g` · page `199:3` · section `199:6` |
| Section title (verbatim) | `02 — Mobile Screens · 390 px · les 8 mêmes écrans, composés pour le téléphone` |
| Screenshots (1×, 390 × 844) | `.design-refs/screens/M01.png` … `M08.png` |
| Raw design-context code | `.design-refs/code/M01.tsx` … `M08.tsx`, plus `Mshell-sheet-S4.tsx`, `Mshell-scrim-S4.tsx`, `Mshell-section-title.tsx` |
| Assets (SVG, Figma-given names) | `.design-refs/assets/mobile/<CODE>/img*.svg` (the URLs in the saved code are rewritten to these local files) |
| Related state frames (documented elsewhere) | S1 `238:5434` keyboard open · S2 `238:5634` Diff tab · S3 `238:5863` Git tab · S4 `239:5667` switch session (sheet) · S5 `239:5757` push notification |

> **Read this first: the phone app is not a compressed desktop.** The section title says it: *"les 8 mêmes écrans, composés pour le téléphone"*. Every screen below has a **"Mobile vs desktop"** list. Build the mobile layouts as separate compositions that share components and data, not as a responsive squeeze of the desktop grid.

---

## Contents

0. [Conventions and tokens](#0-conventions-and-tokens)
1. [App shell (mobile)](#1-app-shell-mobile)
2. [Shared mobile patterns](#2-shared-mobile-patterns)
3. [M01 — Accueil](#m01--accueil)
4. [M02 — Projets](#m02--projets)
5. [M03 — Ajouter un projet](#m03--ajouter-un-projet)
6. [M04 — Détail du projet](#m04--détail-du-projet)
7. [M05 — Workspace Claude Code](#m05--workspace-claude-code)
8. [M06 — Sessions](#m06--sessions)
9. [M07 — Intégrations](#m07--intégrations)
10. [M08 — Paramètres](#m08--paramètres)
11. [Route map (mobile)](#11-route-map-mobile)
12. [Implied data model (from the mobile screens)](#12-implied-data-model-from-the-mobile-screens)
13. [Open questions and gaps](#13-open-questions-and-gaps)

---

## 0. Conventions and tokens

### 0.1 Copy rules

- All UI copy is quoted **verbatim** in `code spans`. Do not retranslate, re-punctuate or "fix" it.
- Characters as they exist in Figma (checked against the raw code):
  - Apostrophes are **straight `'` (U+0027)**, not typographic `’`: `l'application`, `Vue d'ensemble`, `Gérer l'accès`, `n'estime`, `d'agir`, `d'abord`.
  - Middle dot **`·` (U+00B7)** with **regular spaces** on both sides (`Nuera OS · feature/crm-core`).
  - Ellipsis **`…` (U+2026)**, a single character: `Rechercher un projet…`, `Synchronisation…`, `Répondez d'abord à la demande…`.
  - Minus sign **`−` (U+2212)** in diff stats: `+46 −12`.
  - **No non-breaking spaces anywhere** in the mobile frames. French spacing before `:`, `?` and `%` uses ordinary spaces (`Coolify : autorisation expirée`, `Un dépôt manque ?`, `99,95 %`). If you want NBSPs (recommended for wrapping), add them centrally in the formatting layer; do not hand-edit strings.
  - Empty line in the CLAUDE.md preview is a zero-width space (U+200B) in Figma; render it as an empty line.
- Overlines (`Sur-titre`) are **typed in uppercase in Figma** (`SESSIONS ACTIVES · 2`). Keep the source strings uppercase, or store them in sentence case and apply `text-transform: uppercase`. Either way, they must render uppercase.

### 0.2 Color tokens (Light mode; values from `get_variable_defs` and the code fallbacks)

| Token | Value | Mobile usage |
|---|---|---|
| `--surface-raised` | `#ffffff` | **Page background** of every mobile frame; segmented-control track; Neutre badge fill; composer field fill; empty capacity slots |
| `--bg` | `#ffffff` | Cards, list cards, top bars, tab bar, action bars, sheet |
| `--paper` | `#ffffff` | Text/icon on accent; secondary button fill |
| `--text` | `#233353` | Primary text, titles, home-indicator bar, status-bar glyphs |
| `--ink` | `#233353` | Secondary button label |
| `--muted` | `#645e78` | Subtitles, metadata, overlines, inactive tab icon/label, chevrons, Neutre dot |
| `--border` | `#d9dade` | Hairlines and row separators, field borders, inactive rail dot, inactive progress segment, off toggle track, disabled Send fill, sheet handle, non-favorite star stroke |
| `--border-on-light` | `#d9dade` | Secondary button border |
| `--accent` | `#4368b1` | Primary buttons, active tab label/icon, links, favorite star stroke, on toggle track, counters, selected radio |
| `--accent-pale` | `#dee5f2` | Active tab pill, selected chip/segment/row, icon tiles ("Pastille"), tinted icon buttons |
| `--accent-on-dark` | `#a6b9dd` | Metadata inside the accent instruction bubble (`Vous · 10:42`) |
| `--success` / `--success-pale` | `#2f6f4f` / `#e4f1ea` | Succès badge and dot, tool-row check icon |
| `--warn` / `--warn-pale` | `#8a6516` / `#fbf1dc` | Alerte badge, permission cards (fill + 1 px border), "Autorisation" dot and status label |
| `--danger` / `--danger-pale` | `#b4451f` / `#f8e6de` | Danger badge and dot, Coolify alert card, destructive settings row |
| `en-cours` (App · statuts) | `#e0a10f` | "En cours" status dot, clock icon in *Reprise rapide* |
| `--near-black` | `#141830` | Sheet scrim at **55 %** opacity |
| **Dark mode zones** (Color collection, mode *Dark*) | `--bg` `#233353`, `--text` `#ffffff`, `--muted` `rgba(255,255,255,0.62)` | Command block in the permission card (M05) and CLAUDE.md preview (M04). Implement as a `data-theme="dark"` scope on that block, not as hard-coded colors |

Status dots (`Dev · Point de statut`, 8 × 8 SVG, always followed by a text label, never alone): Succès `#2F6F4F` · En cours `#E0A10F` · Autorisation/Alerte `#8A6516` · Danger `#B4451F` · Neutre `#645E78`.

### 0.3 Spacing, radius and shadows

| Spacing | `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-8` 32 (px). Off-scale literals that also appear: 1, 2, 3, 5, 6, 10, 14. |
|---|---|
| Radius | `--radius-sm` 8 · `--radius-md` 12 · `--radius-lg` 20 · `--radius-xl` 28 · `--radius-full` 999. Literals: 2 (progress segments), 3 (rail dots, handles, home bar), 4 (capacity slots). |
| Shadow/Soft | `0 14px 34px -22px rgba(20,24,48,0.28)` (`#14183047`): cards, list cards, session cards |
| Shadow/Float | `0 24px 50px -18px rgba(20,24,48,0.55)` (`#1418308C`): bottom sheet |

### 0.4 Typography

Fonts: **Outfit** (400 Regular, 500 Medium, 600 SemiBold) for UI and **JetBrains Mono** (400 Regular, 500 Medium) for code, branches, SHAs, durations and overlines. Line height is `normal` unless stated.

| Role (mobile) | Spec |
|---|---|
| Page title (root tabs, M04 name) | Outfit SemiBold **26**, `--text` |
| Flow step title (M03) | Outfit SemiBold 22 |
| Card hero title (*Reprise rapide*), sheet title | Outfit SemiBold 18 |
| Top-bar title, card title, project/integration name | Outfit SemiBold 16 |
| Row title, card section title, permission title | Outfit SemiBold 15 (settings labels: Outfit **Regular** 15) |
| Body, button label, field text, settings value | Outfit Regular/Medium 14 (thread text: 14 / **20 px**) |
| Page subtitle, secondary body, links, segmented tabs | Outfit 13 (descriptive text 13 / **18 px**) |
| Badges, metadata, notes | Outfit 12 (badges Medium) |
| Tab-bar label | Outfit 11 (Medium inactive, SemiBold active) |
| Counter | Outfit SemiBold 10 |
| Overline (`Sur-titre`) | JetBrains Mono Regular 11, letter-spacing **0.88 px** (0.08 em), `--muted`, uppercase |
| Mono meta (branches, SHAs, times) | JetBrains Mono Regular 11 (12–13 for commands, 13 Medium for repo names in M03) |

> The design note *"Note · Extensions et lacunes"* states the type scale is `28, 22, 18, 16, 14, 13, 12, 11` with no text styles applied. Mobile page titles use **26**, which is not in that list (see [Open questions](#13-open-questions-and-gaps)).

### 0.5 Icons

Line icons from Nuera OS plus the page's extensions (`icon/terminal`, `icon/git-branch`, `icon/git-commit`, `icon/worktree`, `icon/play`, `icon/stop`, `icon/refresh`, `icon/github`, `icon/figma`, `icon/star`, `icon/plug`, `icon/history`, `icon/home`, `icon/more`, `icon/trash`, …). Stroke width **1.8**, color baked per instance (exported SVGs are already colored). Sizes used on mobile: 13, 14, 16, 18, 20 px. Color rules seen on mobile:

- Navigation and plain action icons: `--text` (bell, refresh, more, back arrow in M05, search, x).
- Section/row leading icons in cards and settings: `--accent` (history, terminal, cpu, book, plug, lock, monitor, server, shield, bell).
- Inline metadata icons and chevrons: `--muted`.
- Semantic icons: alert `--warn` (M01) or `--danger` (M07), shield `--warn` (permission), trash `--danger`, check `--success` (tool rows), clock `en-cours`.
- On accent buttons: white.

---

## 1. App shell (mobile)

### 1.1 Frame and breakpoint

- Reference viewport: **390 × 844** (iPhone 14/15). All screens use a 16 px side gutter (`--space-4`), i.e. a **358 px** content column.
- Suggested breakpoint: mobile shell **below 768 px**; desktop shell (sidebar) at 1024 px and up. Tablet range 768–1023 is not designed (see open questions).
- Page background is `--surface-raised` (#fff). Cards sit on it with Shadow/Soft; because `--surface` and `--surface-raised` are both white in Light mode, **separation comes from shadows and hairlines, not tints** (design note, lacuna 3).

### 1.2 Vertical structure (root tab screens: M01, M02, M06, M07, M08)

```
y=0    ┌──────────────────────────────┐
       │ Status bar (OS) 47 px        │  "Dev · Barre d'état" — safe area, not app UI
y=47   ├──────────────────────────────┤
       │ "Contenu défilant" 706 px    │  the only scroll area
       │  pt 8 · px 16 · pb 24        │  page header scrolls with content
       │  vertical gap per screen     │
y=753  ├──────────────────────────────┤
       │ Tab bar 1 + 56 px            │  "Dev · Barre d'onglets" (fixed)
       │ Home indicator 34 px         │  safe area
y=844  └──────────────────────────────┘
```

Other shells:

| Screen | Top | Scroll area | Bottom |
|---|---|---|---|
| M03 *Ajouter un projet* (flow) | Status bar 47 + **flow top bar 52** + progress 4 | 650 px | **Action bar** (border-top, `Continuer`) + home indicator 34. **No tab bar.** |
| M04 *Détail du projet* (pushed page) | Status bar 47 + **back top bar 52** | 586 px | **Action bar 69** (`Ouvrir le Workspace`) **above** the tab bar (90, no top border of its own) |
| M05 *Workspace* (contextual, full screen) | Status bar 47 + **session header 52** + status row 39 + segmented tabs 55 (all fixed) | Thread 564 px, bottom-anchored | **Composer** 53 (border-top) + home indicator 34. **No tab bar.** |

### 1.3 Safe areas (status bar and home indicator)

- `Dev · Barre d'état` (`202:248`): *"Barre d'état du téléphone (zone de sécurité haute, 47 px). Ses couleurs suivent le rôle text."* It draws `9:41` (Outfit SemiBold 16) and the network/wifi/battery glyphs (68 × 13) with `pl 32 · pr 24 · pt 14`. **Do not render it in the web app.** Reserve `env(safe-area-inset-top)` instead, and give that strip the page background (`--surface-raised`) so scrolled content never shows under the clock. Its text color "follows the text role" means: use dark status-bar content (`<meta name="theme-color" content="#ffffff">`, `apple-mobile-web-app-status-bar-style` = `default`).
- `Dev · Indicateur d'accueil` (`202:251`): *"Zone de sécurité basse (34 px)."* A 134 × 5 bar (`--text`, radius 3) centered in 34 px. **Do not draw the bar.** Pad the bottom-most bar (tab bar, action bar, composer, sheet) with `env(safe-area-inset-bottom)`.
- Requires `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` so that the safe-area insets exist and the keyboard resizes the layout (see S1).

### 1.4 Top bars

There is **no global app bar** on mobile. Four header patterns exist:

1. **Large page header** (root tabs). Part of the scroll content, not sticky. Row, gap 8, height 51: a title column (gap 2) with title (Outfit SemiBold 26 `--text`) and subtitle (Outfit Regular 13 `--muted`), plus an optional **44 × 44** action at the right, vertically centered:
   - M01: outlined bell (`--bg` fill, 1 px `--border`, radius md).
   - M02, M06: filled accent `+` (`--accent` fill, white `icon/plus` 20, radius md).
   - M07, M08: no action.
2. **Back top bar** (M04, `Barre du haut`, 52 px, `px 8`): text back button (`icon/arrow-left` 20 accent + parent label `Projets`, Outfit Regular 15 `--accent`, height 44, `pl 4 · pr 8`, gap 2), flexible spacer, then 44 × 44 transparent icon buttons (radius md).
3. **Flow top bar** (M03, 52 px, `px 8`, gap 4): close button 44 (`icon/x` 20 `--text`) on the **left**, centered title (Outfit SemiBold 16), step counter in a 44 × 44 box on the right (JetBrains Mono 12 `--muted`, `1 / 3`). Followed by a 3-segment progress bar (`px 16`, gap 4, each segment flex-1 × 4 px, radius 2; done/current `--accent`, upcoming `--border`).
4. **Session header** (M05): see [M05](#m05--workspace-claude-code). Back icon only (no label), two-line identity, two 44 × 44 actions.

Recommendation (not drawn): a compact sticky title could appear when the large header scrolls away. Not in Figma, so ship without it unless design confirms.

### 1.5 Bottom navigation — `Dev · Barre d'onglets` (`202:452`)

Component description (verbatim): *"Navigation globale au téléphone, au pouce : les 5 entrées de la barre latérale. Absente du Workspace, qui prend tout l'écran. Cible de 78 × 56 px, au-dessus du minimum de 44."*

Variants: `Actif=Accueil | Projets | Sessions | Intégrations | Paramètres` (symbols `202:291`, `202:331`, `202:371`, `202:411`, `202:451`).

| Property | Value |
|---|---|
| Container | `--bg`, **1 px top border `--border`** (omitted in M04, where the action bar above carries the border), total height 91 = 1 + 56 + 34 |
| Tabs row | height 56, 5 equal tabs (78 px each = touch target 78 × 56) |
| Tab | column, items centered, gap 4 (`--space-1`), `pt 8 · pb 6` |
| Icon pill | 44 × 24, radius full; **active** fill `--accent-pale`; icon 20 px (`--accent` active, `--muted` inactive) |
| Label | Outfit 11: **active** SemiBold `--accent`; inactive Medium `--muted` |
| Counter (Sessions tab) | absolutely positioned on the icon pill at `left 30 · top -2`; `--accent` fill, radius full, `px 5 · py 1`; Outfit SemiBold 10, white. Value `2` = number of running sessions (matches `SESSIONS ACTIVES · 2`) |
| Bottom | `env(safe-area-inset-bottom)` (34 px in the mock) |

Entries (verbatim labels, icons, destinations):

| Label | Icon | Route | Cover description (*Navigation et parcours*) |
|---|---|---|---|
| `Accueil` | `icon/home` | `/` | `serveur, Claude, reprise rapide` |
| `Projets` | `icon/projets` (folder) | `/projets` | `bibliothèque, ajout, détail` |
| `Sessions` | `icon/terminal` + counter | `/sessions` | `en cours, historique, capacité` |
| `Intégrations` | `icon/plug` | `/integrations` | `GitHub, serveurs MCP` |
| `Paramètres` | `icon/reglages` (sliders) | `/parametres` | `compte, Claude, serveur` |

Visibility rules:

- Visible on M01, M02, M04, M06, M07, M08. M04 (a page pushed from Projets) keeps `Projets` active.
- **Hidden on M05 (Workspace)** and on the **M03 add-project flow** (a full-screen task with its own bottom action bar).
- Cover note (transcribed from `00-navigation.png`): `Workspace · contextuel` — *"Ouvert depuis un projet ou une session, jamais depuis la navigation. Au bureau, la barre se replie en rail ; au téléphone, la barre d'onglets disparaît."* So there is **no Workspace tab**: it is reached from a project (M04 `Ouvrir le Workspace`), a session card or row, a pending-request card, or a push notification.
- Implementation: fixed-position nav with matching bottom padding on the page, so document scrolling keeps native behaviors (address-bar collapse, overscroll). Use `<nav aria-label>` with `aria-current="page"` on the active tab. The counter needs an accessible label (e.g. `2 sessions actives`; this wording is not in Figma).

### 1.6 Bottom action bars (sticky, thumb zone)

| Where | Spec |
|---|---|
| M03 `Barre d'action` | `--bg`, 1 px top border, `pt 12 · px 16`; full-width primary `Continuer` (h 44); then the safe area. Replaces the tab bar. |
| M04 `Barre d'action` | `--bg`, 1 px top border, `px 16 · py 12` (69 px); full-width primary with `icon/terminal` 16 `Ouvrir le Workspace`; sits **directly above** the tab bar. |
| M05 `Saisie` | Composer, see M05. |

Rule shown by the designs: **a screen's main action moves to a full-width 44 px button at the bottom edge**, inside thumb reach. Desktop keeps the same action as a header button.

### 1.7 Bottom sheet (from S4 `Feuille · Sessions de Nuera OS`, `239:5710`)

The only sheet drawn on the page. Use it as **the** mobile pattern for pickers and overflow menus (session switcher, `Plus` / `Actions de session` menus, branch picker, settings pickers). Only the session switcher is actually drawn; the other uses are inferred.

| Part | Spec |
|---|---|
| Scrim `Voile` (`239:5709`) | full screen, `--near-black` `#141830` at **55 %**; it is a link in Figma, so a tap dismisses the sheet |
| Sheet | `--bg`, top corners `--radius-xl` (28), **Shadow/Float**, `pt 8 · px 16`, vertical gap 4; height fits its content (350 px in S4, top at y = 494) |
| Handle `Poignée` | 36 × 5 bar, `--border`, radius 3, centered, `pb 8` |
| Title row | `pt 4 · pb 8`: title Outfit SemiBold 18 (`Sessions de Nuera OS`) + right meta JetBrains Mono 12 `--muted` (`2 / 4`) |
| Option rows | min-height 64, `p 12`, gap 12, radius md; **current item** fill `--accent-pale`; content: status dot 8, column (title Outfit SemiBold 15 ellipsis; `icon/worktree` 13 + mono 11 `--muted` `feature/crm-core · worktree crm-core`), trailing badge (`Autorisation` Alerte / `En cours` Accent) |
| Create row | height 56, `p 12`: 28 × 28 `--accent-pale` circle with `icon/plus` 16 + `Nouvelle session dans un worktree` (Outfit Medium 15 `--accent`) |
| Footer link | 1 px top border, height 52, `p 12`: `Toutes les sessions` (Outfit Regular 15) + chevron 18 |
| Bottom | safe area (34) |

Behavior to implement: opens with a slide-up, dismisses on scrim tap, on a downward drag of the handle, and with Escape. Focus is trapped inside while open, with `role="dialog"` and `aria-modal="true"`.

### 1.8 Keyboard (from S1) and notifications (from S5)

- **Keyboard (S1)**: the Workspace composer stays pinned **directly above the keyboard**, the safe-area spacer disappears, and the thread shrinks (307 px visible). The send button turns accent once text is entered. Implement with `100dvh` plus `interactive-widget=resizes-content` (or the VisualViewport API as a fallback).
- **Push notification (S5)**: a system banner (`Notification · Nuera Dev`: app icon `DEV`, app label `NUERA DEV`, title `Tests e2e du devis attend votre accord`, body `npm run test -- e2e · Nuera OS · touchez pour répondre`, meta `maintenant`; copy transcribed from `S5.png`, since S5 is documented with the states) over M01. Tapping it opens M05 on the request (prototype path **C · Mobilité**: `S5 Notification` › `M05 Workspace` › `S1 Réponse` › `S2 Diff` › `S3 Git`). The cover's "to validate" list says: *"Notifications au téléphone : application web installable et notifications push, ou relais par un service tiers."* This implies a **PWA** (manifest, service worker, Web Push). M08's `Notifications` toggle drives the subscription.

### 1.9 Touch targets

- Every icon button is 44 × 44. Tab targets are 78 × 56. Primary and secondary actions stretched on mobile are 44 px tall.
- `Bouton compact` (`168:6952`): *"Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code."* Where the mobile mock keeps 36 px visuals (session cards' `Ouvrir` / `Répondre`, M04 `Modifier`), extend the hit area to 44 px.
- `Dev · Interrupteur` (`202:459`, 36 × 20): *"Même dessin que l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y est réservé à ChatGPT. Zone tactile de 44 px à prévoir autour."* Prefer making the **whole row** the toggle's label.

---

## 2. Shared mobile patterns

| Pattern | Spec | Used in |
|---|---|---|
| **Card** | `--bg`, `--radius-lg` 20, Shadow/Soft, `p 16`, column with gap 10 (or 2 for row lists) | M01, M04, M06, M07 |
| **List card** | Card with `px 16 · py 4` (or `p 16`); rows `py 12` with a 1 px `--border` bottom separator except on the last row; trailing chevron 16–18 `--muted` | M01, M02, M06, M07 |
| **Settings group** | `--bg`, radius lg, `px 16`, **no shadow, no border**; rows 52 px (60 with a sublabel), gap 12, leading icon 20 accent, label Outfit Regular 15, optional sublabel 12 `--muted`, optional value Outfit Regular 14 `--muted` or Badge, chevron 16 | M08 |
| **Overline row** (`Sur-titre`) | overline (mono 11 caps, 0.88 px tracking) left; optional right link (Outfit Medium 13 `--accent`) or 44 px icon button | M01, M06, M07, M08 |
| **Status pill** | `--success-pale`, radius full, `px 10 · py 6`, gap 6: dot 8 + Outfit Medium 12 `--success` | M01 |
| **Badge** (Nuera OS) | `px 8 · py 4`, radius full, Outfit Medium 12, height 23. Tones: **Accent** (`--accent-pale` / `--accent`), **Succes** (`--success-pale` / `--success`), **Alerte** (`--warn-pale` / `--warn`), **Danger** (`--danger-pale` / `--danger`), **Neutre** (`--surface-raised` / `--muted`, so it reads as plain text on white) | everywhere |
| **Filter chips** | Badges in a row with gap 6; selected = Accent, others = Neutre. Single select | M02, M04 (scrolling), M06 |
| **Search field** (`Dev · Champ`, `202:503`) | h 44, `--bg`, 1 px `--border`, radius md, `px 12 · py 8`, gap 8, search icon 16 `--muted`, placeholder Outfit Regular 14 `--muted`. Description: *"Champ de saisie et liste déroulante. Fond surface et bordure border, comme le compositeur de Nuera OS ; le champ de recherche de Nuera OS, sans bordure, reste réservé aux barres latérales."* | M02, M03 |
| **Primary button (mobile)** | `Bouton compact` *Principal* stretched: full width, h 44, `--accent`, radius md, `pl 12 · pr 14`, gap 6, optional icon 16 white, label Outfit Medium 14 `--paper` | M01, M03, M04, M05 |
| **Secondary button (mobile)** | full width (or flex-1), h 44, `--paper` fill, 1 px `--border-on-light`, radius md, optional icon 16 `--ink`, label Outfit Medium 14 `--ink` | M01, M05, M07 |
| **Discreet button** | no fill, icon 16 + label Outfit Medium 14 `--accent` | M04 `Modifier`, M05 `Refuser` |
| **Icon button** | 44 × 44, radius md. Variants: plain, outline (`--bg` + `--border`), filled accent, tinted (`--accent-pale` + accent icon), disabled (`--border` fill + white icon) | all |
| **Horizontal rail** | row of `Dev · Carte de session` at **290 px**, gap 12, overflowing to the right so the next card peeks by 56 px. Below it, a centered dot indicator (gap 6, height 6): active 18 × 6 `--accent`, inactive 6 × 6 `--border`, radius 3. Implement with `overflow-x: auto` and `scroll-snap-type: x mandatory`; dots reflect the snapped index | M01, M06 |
| **`Dev · Carte de session`** (`203:655`) | *"Session Claude Code vue de l'extérieur : statut, projet, branche et worktree, dernière activité, action principale. Tuile Nuera OS (rayon xl, Shadow/Soft)."* `--bg`, radius xl 28, Shadow/Soft, `p 20`, gap 10, width 290 on mobile (component default 320). Rows: status (dot 8 + label Outfit Medium 12 **`--warn`** + elapsed mono 11 `--muted` right); title Outfit SemiBold 16 ellipsis; context (`icon/projets` 14 + Outfit 12 `--muted` project; `icon/worktree` 14 + mono 11 `--muted` `branch · worktree name`, ellipsis); activity Outfit 13 / 18 `--text` (wraps up to 2 lines, which is why heights are 203 or 221); action = `Bouton compact` h 36 (`Répondre` Principal for *Autorisation*, `Ouvrir` Secondaire for *En cours*). Variants: `Statut=En cours | Autorisation | Terminée | Interrompue` (only the first two appear on mobile) | M01, M06 |

---

## M01 — Accueil

| | |
|---|---|
| Frame | `M01 · Accueil` · node **`220:2366`** · 390 × 844 |
| Route | `/` |
| Desktop equivalent | D01 `205:422` (`.design-refs/screens/D01.png`) |
| Shell | Root tab; tab bar `Actif=Accueil` |
| Files | `screens/M01.png`, `code/M01.tsx`, `assets/mobile/M01/` |

### Layout skeleton

Scroll container `Contenu défilant` (`220:2377`): column, **gap 20** (`--space-5`), `pt 8 · px 16 · pb 24`. The content is about **1,319 px** tall in a 706 px viewport. Order and positions (y relative to the scroll content):

| # | Region (layer) | y | h | Notes |
|---|---|---|---|---|
| 1 | `En-tête` | 8 | 51 | large page header + outlined bell |
| 2 | `États` | 79 | 27 | 2 status pills |
| 3 | `Demande en attente` | 126 | 177 | warn card, shown only when a request is pending |
| 4 | `Reprise rapide` | 323 | 193 | card |
| 5 | `Sur-titre · Sessions actives · 2` | 536 | 16 | overline + link |
| 6 | `Rail · sessions actives` | 572 | 221 | horizontal rail, 2 cards |
| 7 | `Indicateur du rail` | 813 | 6 | dots |
| 8 | `Sur-titre · Projets récents` | 839 | 16 | overline + link |
| 9 | `Projets récents` | 875 | 214 | list card, 3 rows |
| 10 | `Sur-titre · Dernières modifications` | 1109 | 15 | overline |
| 11 | `Dernières modifications` | 1144 | 151 | list card, 2 rows |

Items 1 to 6 (rail partly cut) are visible above the fold. Item 3 is deliberately first after the status pills.

### Content and copy (top to bottom)

1. **Header**: title `Bonjour Nezar`; subtitle `Mer. 4 nov. · tout est disponible`. Right: `Bouton · Notifications`, 44 × 44 outline (`--bg`, 1 px `--border`, radius md) with `icon/bell` 20 `--text`.
2. **Status pills** (`États`, gap 8): `VPS-3 en ligne` · `Claude Code connecté` (each a Succès dot + label, see the *Status pill* pattern).
3. **Pending request card** (`Demande en attente`): `--warn-pale` fill, **1 px `--warn` border**, radius lg 20, `p 16`, gap 10.
   - Title row (gap 8): `icon/alert` 18 `--warn` + `Une session attend votre accord` (Outfit SemiBold 15).
   - `Tests e2e du devis · Nuera OS` (Outfit Regular 13 `--muted`).
   - Command block `Commande`: `--bg` fill, 1 px `--border`, radius sm 8, `px 10 · py 8`, JetBrains Mono 12 `--text`: `$ npm run test -- e2e`.
   - `Bouton · Répondre`: full-width primary, h 44: `Répondre`.
4. **Quick resume card** (`Reprise rapide`): card, `p 16`, gap 10.
   - Header row (gap 8): `icon/history` 16 accent + overline `REPRISE RAPIDE` (flex-1) + Badge Accent `En cours`.
   - Title `Module CRM · pipeline` (Outfit SemiBold **18**).
   - Context row (gap 6): `icon/worktree` 14 + `Nuera OS · feature/crm-core` (mono 11 `--muted`, ellipsis).
   - Progress row (gap 8): `icon/clock` 16 (`en-cours` #E0A10F) + `Plan 3 / 5 · écrit les tests` (Outfit Regular 13 `--muted`).
   - `Bouton · Reprendre la session`: full-width **secondary**, h 44, play icon 16 + `Reprendre la session`.
5. Overline `SESSIONS ACTIVES · 2` + link `Tout voir`.
6. **Rail** (gap 12) of `Dev · Carte de session`, width 290:
   - Card 1 `Statut=En cours`: `En cours` · `12 min` · `Module CRM · pipeline` · `Nuera OS` · `feature/crm-core · worktree crm-core` · `Écrit les tests de pipeline-totals.ts` · button `Ouvrir` (secondary).
   - Card 2 `Statut=Autorisation`: `Autorisation demandée` · `2 min` · `Tests e2e du devis` · `Nuera OS` · `feature/devis-pdf · worktree devis-pdf` · `Attend votre accord pour npm run test -- crm` · button `Répondre` (primary).
7. Rail dots: 2 (first active).
8. Overline `PROJETS RÉCENTS` + link `Tous`.
9. **Recent projects** list card (`p 16`): rows `py 12`, gap 12: text column (gap 2; name Outfit SemiBold 15; branch mono 11 `--muted` ellipsis) + Badge + `icon/chevron` 16.
   - `Nuera OS` · `feature/crm-core` · Badge Succes `À jour`
   - `Atelier Lune` · `feature/galerie-photos` · Badge Alerte `2 en retard`
   - `Kiné Rive Gauche` · `fix/tarifs-mobile` · Badge Succes `À jour`
10. Overline `DERNIÈRES MODIFICATIONS` (no link).
11. **Latest changes** list card (`p 16`): rows `py 12`, gap 10: `icon/git-commit` 16 `--muted` + column (gap 2; message Outfit Regular 14 `--text` ellipsis; meta mono 11 `--muted`).
    - `crm : ajoute les colonnes glissables` / `a3f9c12 · Nuera OS · il y a 6 min`
    - `crm : calcule le total de chaque étape` / `7b21e04 · Nuera OS · il y a 9 min`

### Components and variants

`Dev · Barre d'état`, `Dev · Point de statut` (ton Succès; card dots En cours and Autorisation), `Badge` (Accent, Succes, Alerte), `Bouton compact` (Principal for `Répondre`, Secondaire for `Reprendre la session`, stretched to 44), `Dev · Carte de session` (`Statut=En cours`, `Statut=Autorisation`), `Dev · Barre d'onglets` (`Actif=Accueil`), `Dev · Indicateur d'accueil`. Effect: Shadow/Soft on `Reprise rapide`, the cards and both list cards. **No shadow on the warn card**, which uses its border instead.

### Data → entities and fields

| UI | Entity.field | Format |
|---|---|---|
| `Bonjour Nezar` | `owner.firstName` | `Bonjour {firstName}` |
| `Mer. 4 nov.` | today | `fr-FR` short weekday (capitalized, with period) + day + short month: `Mer. 4 nov.` |
| `tout est disponible` | derived: server online AND Claude CLI connected | otherwise a degraded summary (copy not designed) |
| `VPS-3 en ligne` | `server.name`, `server.status` | dot + label |
| `Claude Code connecté` | `claudeCli.connectionStatus` | dot + label |
| Pending card | `permissionRequest` (oldest or most recent pending): `session.title`, `project.name`, `request.command` | `$ {command}` |
| Quick resume | last active `session`: `title`, `project.name`, `branch`, `plan.currentStep` / `plan.totalSteps`, `plan.currentStepLabel`, `status` | `Plan {n} / {total} · {label}` |
| `SESSIONS ACTIVES · 2` | count of running sessions (also the tab counter) | |
| Session card | `session.status`, `elapsed` (`12 min`), `title`, `project.name`, `branch`, `worktree.name`, `lastActivity` (text), primary action | elapsed is a compact duration |
| Recent project | `project.name`, `currentBranch`, `syncStatus` | `À jour` / `{n} en retard` / … |
| Commit row | `commit.message` (first line), `commit.shortSha` (7 chars), `project.name`, `commit.committedAt` | `il y a 6 min` (relative, French) |

### Interactions

| Element | Behavior |
|---|---|
| Bell | Opens notifications (no notification center is designed; see open questions). |
| `Répondre` (pending card) | Opens **M05** for that session, scrolled to the permission card (path C). |
| `Reprendre la session` | Opens **M05** for the quick-resume session. If the CLI process is gone, it resumes (`claude --resume`, per the desktop notes). |
| `Tout voir` | Goes to the **Sessions** tab (M06). |
| Session card tap, `Ouvrir` | M05 for that session. `Répondre` opens M05 at the request. |
| Rail swipe | Horizontal scroll with snap; dots follow. |
| `Tous` | Goes to the **Projets** tab (M02). |
| Project row | M04 for that project. |
| Commit row | Not specified on mobile. Desktop offers `Ouvrir sur GitHub` at section level, so an external link to the commit on GitHub is the likely target. |

### States and annotations

- Shown: everything available, one pending request, 2 running sessions.
- The `Demande en attente` card is **conditional**. When nothing is pending, the screen starts with `Reprise rapide`.
- S5 shows this screen under a push-notification banner.
- Loading, empty and error variants are not drawn for mobile (T1–T8 are desktop-only).

### Mobile vs desktop (D01)

- **Navigation**: the sidebar (logo, `Rechercher… ⌘K`, server card, user card) becomes the bottom tab bar. There is **no global search** and no user card on mobile.
- **Header**: desktop `Mercredi 4 novembre 2026 · VPS-3 et Claude Code sont disponibles` + bell + primary **`Nouvelle session`**. Mobile shortens to `Mer. 4 nov. · tout est disponible`, keeps only the bell, and **drops `Nouvelle session`**, which moves to the Sessions tab's `+`.
- **Tiles collapse into pills**: the desktop *Serveur VPS-3* tile (CPU, memory and storage gauges) and *Claude Code* tile (`2 sessions actives sur 4 possibles`, CLI account text) become two status pills.
- **Priority reorder**: on desktop the pending authorization is a warning line inside the *Claude Code* tile. On mobile it is a **full-width warn card placed first**, with the command visible and a full-width `Répondre` in thumb reach.
- **Reprise rapide**: the `DERNIÈRE INSTRUCTION` quote and the `Toutes les sessions` link are removed. The button becomes **secondary**, because `Répondre` is the screen's primary action.
- **Sessions**: the desktop 2-up grid becomes a **swipeable rail with dots**.
- **Projets récents**: no favorite stars and no activity time; 3 rows instead of 4; link label `Tous` instead of `Tous les projets`.
- **Dernières modifications**: 2 commits instead of 4 (no PR row such as `#42`). The SHA moves from a separate accent column into the meta line. `Ouvrir sur GitHub` is removed.
- **Intégrations tile removed** from Home. It lives in its own tab, and the Coolify alert appears there.

---

## M02 — Projets

| | |
|---|---|
| Frame | `M02 · Projets` · node **`220:2575`** · 390 × 844 |
| Route | `/projets` |
| Desktop equivalent | D02 `210:675` |
| Shell | Root tab; tab bar `Actif=Projets` |
| Files | `screens/M02.png`, `code/M02.tsx`, `assets/mobile/M02/` |

### Layout skeleton

`Contenu défilant` (`220:2586`): column, **gap 12**, `pt 8 · px 16 · pb 24`; content about 849 px tall.
`En-tête` (y 8, h 51) → `Champ` search (y 71, h 44) → `Filtres` (y 127, h 23) → 5 project cards of 358 × 123 (y 162, 297, 432, 567, 702). About 4 cards are visible above the fold.

### Content and copy

1. Header: `Projets` / `5 dépôts sur VPS-3 · 41 Go`. Right: `Bouton · Ajouter un projet`, 44 × 44 **filled accent** with white `icon/plus` 20.
2. Search field placeholder: `Rechercher un projet…`
3. Filter chips (gap 6): `Tous · 5` (Accent, selected) · `Favoris · 2` (Neutre) · `Archivés · 1` (Neutre).
4. **Project card** (whole card tappable; the first is an `<a>` in Figma): card `p 16`, gap 8.
   - Header row (gap 10): `icon/star` 18 (**favorite = `--accent` stroke, not favorite = `--border` stroke, both outline only**) · identity column (gap 2; name Outfit SemiBold 16; `owner/repo` mono 11 `--muted` ellipsis) · `icon/chevron` 18.
   - Context row (gap 6): `icon/git-branch` 14 + branch (mono 11 `--muted`, ellipsis).
   - Status row (gap 8): sync Badge · sessions summary (dot 8 + Outfit Regular 12 `--text`) · activity time (mono 11 `--muted`, right-aligned, flex-1).

| Star | Name | Repo | Branch | Sync badge (tone) | Sessions (dot) | Time |
|---|---|---|---|---|---|---|
| ★ accent | `Nuera OS` | `nuera-studio/nuera-os` | `feature/crm-core` | `À jour` (Succes) | `2 actives` (En cours) | `3 min` |
| ★ accent | `Atelier Lune` | `nuera-studio/atelier-lune` | `feature/galerie-photos` | `2 en retard` (Alerte) | `1 terminée` (Succès) | `hier` |
| ☆ grey | `Kiné Rive Gauche` | `nuera-studio/kine-rive-gauche` | `fix/tarifs-mobile` | `À jour` (Succes) | `1 interrompue` (Danger) | `lun.` |
| ☆ grey | `Site Nuera Studio` | `ethanthedevelop/nuera-studio` | `main` | `Conflit` (Danger) | `aucune` (Neutre) | `30 oct.` |
| ☆ grey | `Nuera Dev` | `nuera-studio/nuera-dev` | `main` | `Synchronisation…` (Accent) | `aucune` (Neutre) | `28 oct.` |

### Data → entities and fields

- Header: `projects.count` (`5 dépôts sur VPS-3`), `projects.diskUsage` (`41 Go`).
- Filter counts: total, favorites, archived.
- Project: `id`, `name`, `repo.fullName`, `isFavorite`, `isArchived`, `currentBranch`, `syncStatus` ∈ {`upToDate` → `À jour`, `behind(n)` → `{n} en retard`, `conflict` → `Conflit`, `syncing` → `Synchronisation…`}, `sessionsSummary` ∈ {`{n} actives` (En cours dot), `{n} terminée` (Succès), `{n} interrompue` (Danger), `aucune` (Neutre)}, `lastActivityAt`.
- Compact activity date: `3 min` (today, relative and unit-only, no `il y a`) · `hier` · weekday abbreviation `lun.` (this week) · `30 oct.` (older).

### Interactions

| Element | Behavior |
|---|---|
| `+` | Opens **M03** (`/projets/ajouter`), full screen. |
| Search | Filters the list as you type (name and repo). |
| Chips | Single-select filter. Counts stay visible. |
| Star | Toggles favorite (implied; desktop has `Retirer des favoris` in the row menu). Needs its own 44 px hit area separate from the card tap. |
| Card | Opens **M04** `/projets/{id}`. |
| Row actions | The desktop `…` menu (`Retirer des favoris`, `Synchroniser maintenant`, `Nouvelle branche…`, `Nouvelle session ici`, `Archiver le projet…`) has **no mobile trigger on this screen**. Expose it through M04's `Plus` sheet (inference). |

### States

All four sync states and all four session-summary states appear, plus favorite on and off. Empty, loading and search-with-no-result states are not drawn on mobile.

### Mobile vs desktop (D02)

- **Table → stacked cards.** The desktop columns `PROJET / BRANCHE / SYNCHRONISATION / SESSIONS / ACTIVITÉ / ACTIONS` are recomposed into three lines per card (identity, branch, status line).
- **No per-row `Ouvrir` button and no `…` menu.** The whole card is the target, with a chevron.
- **Header**: desktop text button `Ajouter un projet` becomes an icon-only accent `+`. The subtitle shortens from `5 dépôts clonés sur VPS-3 · 41 Go utilisés sur 160` to `5 dépôts sur VPS-3 · 41 Go`.
- **No sort control** (desktop `Trier : activité récente`). Recency order is implied.
- **Search** moves to its own full-width row (desktop: inline with the chips, `Rechercher un projet ou un dépôt…`).
- **Shorter status copy**: `2 commits en retard` → `2 en retard`; `Conflit à résoudre` → `Conflit`; `il y a 3 min` → `3 min` (mono). Repo line has no GitHub icon.
- The desktop footnote about archiving (`Archiver retire un projet de cette liste…`) is removed.

---

## M03 — Ajouter un projet

| | |
|---|---|
| Frame | `M03 · Ajouter un projet` · node **`221:2587`** · 390 × 844 |
| Route | `/projets/ajouter` (step 1 of 3, e.g. `?etape=depot`) |
| Desktop equivalent | D03 `211:933` (modal, step 2 *Configuration*); step 1 on desktop is state **A1** `233:4846`; A2–A4 are clone states |
| Shell | **Full-screen flow**, no tab bar |
| Files | `screens/M03.png`, `code/M03.tsx`, `assets/mobile/M03/` |

### Layout skeleton

| Region | y | h | Spec |
|---|---|---|---|
| Status bar | 0 | 47 | safe area |
| `Barre du haut` | 47 | 52 | flow top bar (close · title · step) |
| `Progression` | 99 | 4 | 3 segments, `px 16`, gap 4 |
| `Contenu défilant` | 103 | 650 | column, gap 16, `pt 20 · px 16 · pb 16`; content 496 px, so no scroll at this size |
| `Barre d'action` | 753 | 91 | `--bg`, top border, `pt 12 · px 16`: `Continuer` + safe area |

### Content and copy

1. Top bar: close `icon/x` (left) · `Ajouter un projet` (centered, Outfit SemiBold 16) · `1 / 3` (mono 12 `--muted`).
2. Progress: segment 1 `--accent`, segments 2–3 `--border`.
3. Title block (gap 4): `Choisir un dépôt` (Outfit SemiBold 22) / `Les dépôts que l'application GitHub de Nuera Dev peut lire.` (13 `--muted`).
4. Search field: `Rechercher un dépôt…`
5. **Repository list** (`Dépôts`): bordered list card (`--bg`, **1 px `--border`**, radius lg, **no shadow**, `px 16 · py 4`). Rows: `px 8 · py 12`, gap 12, radius sm 8, bottom hairline. Radio `Choix` 22 × 22 round. Text column (gap 2): repo `owner/name` in **JetBrains Mono Medium 13** `--text` (ellipsis) and meta Outfit Regular 12 `--muted`.
   - **Selected**: row fill `--accent-pale`; radio filled `--accent` with white `icon/check` 14 → `nuera-studio/roux-conseil` / `Privé · TypeScript · il y a 2 j`
   - Unselected (radio: `--bg` fill + 1 px `--border`):
     - `nuera-studio/menuiserie-dupre` / `Privé · TypeScript · il y a 1 sem.`
     - `nuera-studio/bistrot-du-port` / `Privé · Astro · il y a 3 sem.`
     - `nuera-studio/nuera-crm-api` / `Privé · TypeScript · il y a 1 mois`
   - **Disabled** (whole row at **50 % opacity**, no separator): `ethanthedevelop/nuera-studio` / `Déjà cloné sur VPS-3`
6. Note (gap 8): `icon/github` 16 `--muted` + `Un dépôt manque ? Ajoutez-le à l'application sur GitHub.` (Outfit 12 `--muted`).
7. Bottom: full-width primary `Continuer`.

### Data → entities and fields

GitHub App installation repositories: `fullName`, `visibility` (`Privé`), `primaryLanguage` (`TypeScript`, `Astro`), `pushedAt` / `updatedAt` as a relative age (`il y a 2 j`, `il y a 1 sem.`, `il y a 3 sem.`, `il y a 1 mois`; buckets: j / sem. / mois), and `alreadyCloned` (true → disabled with `Déjà cloné sur VPS-3`, metadata replaced).

### Interactions

| Element | Behavior |
|---|---|
| `x` | Cancels the flow and returns to M02. No confirmation is drawn; none is needed at step 1 since nothing is created yet. |
| Search | Filters repos (`owner/name`). |
| Row | Single select (radio semantics; the whole row is the hit area). Disabled rows are not focusable for selection. |
| `Continuer` | Goes to step 2 *Configuration* (not drawn on mobile; desktop D03 shows the content). **Disable it until a repo is selected** (implied). |
| Note | Opens the GitHub App installation or permissions page (external). Make `GitHub` or the whole line a link (not styled as one in Figma). |

### States

Selected, unselected and disabled ("already cloned") rows. The mobile versions of steps 2–3 (Configuration, Clonage), the clone progress, success and error states (A2–A4) are **not drawn**.

### Mobile vs desktop (D03 / A1)

- **Modal dialog over the Projets list → full-screen page.** The tab bar is hidden and the bottom action bar replaces it.
- **Close moves to the top-left** (desktop: `×` top-right of the dialog).
- **Labeled stepper** (`Dépôt` ✓ — `2 Configuration` — `3 Clonage`) → **compact `1 / 3` counter + 3-segment progress bar**.
- **Footer** `Étape 2 sur 3` + `Retour` + `Cloner sur VPS-3` → a **single sticky full-width CTA** (`Continuer` at step 1). On mobile, going back between steps is expected through the top bar (not drawn).
- Desktop dialog subtitle `Le dépôt est cloné sur VPS-3, là où Claude Code travaille.` → mobile per-step title `Choisir un dépôt` with the GitHub App explanation line.

---

## M04 — Détail du projet

| | |
|---|---|
| Frame | `M04 · Détail du projet` · node **`221:2661`** · 390 × 844 |
| Route | `/projets/[projetId]` (overview); sections via chips, e.g. `?section=environnement` |
| Desktop equivalent | D04 `213:1233` |
| Shell | Pushed page inside the Projets tab; tab bar `Actif=Projets` (no top border); sticky action bar above it |
| Files | `screens/M04.png`, `code/M04.tsx`, `assets/mobile/M04/` |

### Layout skeleton

| Region | y | h | Spec |
|---|---|---|---|
| Status bar | 0 | 47 | |
| `Barre du haut` | 47 | 52 | back link + refresh + more |
| `Contenu défilant` | 99 | 586 | column, gap 16, `pt 4 · px 16 · pb 16`; content about 879 px (`Outils MCP` is below the fold) |
| `Barre d'action` | 685 | 69 | `Ouvrir le Workspace` |
| Tab bar | 754 | 90 | `Actif=Projets` |

Content order: `Identité` (y 4, h 109) → `Onglets défilants` (y 129, h 23) → `Environnement` card (y 168, h 251) → `CLAUDE.md` card (y 435, h 188) → `Outils MCP` card (y 639, h 224).

### Content and copy

1. **Top bar**: `‹ Projets` (back) · spacer · `Bouton · Synchroniser` (`icon/refresh`) · `Bouton · Plus` (`icon/more`).
2. **Identity** (gap 8):
   - Name row (gap 10): `Nuera OS` (Outfit SemiBold 26) + Badge Succes `À jour`.
   - Repo row (gap 6): `icon/github` 14 accent + `nuera-studio/nuera-os` (mono **12 `--accent`**, a link).
   - `Sélecteur de branche`: full-width control, h 44, `--bg`, 1 px `--border`, radius md, `px 12`, gap 8: `icon/git-branch` 16 · `feature/crm-core` (mono 13 `--text`, flex-1, ellipsis) · `6 branches` (Outfit 12 `--muted`) · `icon/chevron-down` 16.
3. **Section chips** (`Onglets défilants`, gap 6, **horizontally scrollable**, total width 520 > 358): `Vue d'ensemble` (Accent, selected) · `Environnement` · `CLAUDE.md` · `MCP · 2` · `Variables · 4` · `Sessions · 7` (Neutre).
4. **`Environnement` card** (`p 16`, gap 2): header (gap 8) `icon/terminal` 16 accent + `Environnement` (Outfit SemiBold 15). Command rows (`py 10`, gap 12, hairline): label (Outfit Medium 14) above command (mono 12 `--muted`) · status Badge · 44 × 44 **tinted** action button (`--accent-pale`, accent icon 20, radius md).
   - `Installation` / `npm ci` / Badge Succes `Réussie` / ▶ `Bouton · Lancer Installation`
   - `Lancement` / `npm run dev` / Badge Accent `En cours` / ■ `Bouton · Arrêter Lancement`
   - `Tests` / `npm run test` / Badge Succes `10 / 10` / ▶ `Bouton · Lancer Tests`
5. **`CLAUDE.md` card** (`p 16`, gap 10): header `icon/book` 16 accent + `CLAUDE.md` (15 SemiBold, flex-1) + discreet `Bouton compact` (pencil 16 + `Modifier`, accent, h 36). Preview `Aperçu`: **Dark-mode block** (`#233353` fill, radius md, `px 12 · py 10`, height 110, content clipped), JetBrains Mono 12 / 18, color `rgba(255,255,255,0.62)`:
   ```
   # Nuera OS
   CRM et espace client de Nuera Studio.

   ## Règles
   - Commentaires en français
   ```
6. **`Outils MCP` card** (below the fold; `p 16`, gap 2): header `icon/plug` 16 accent + `Outils MCP`. Rows (`py 10`, gap 12, hairline): name (Outfit Medium 14) above description (Outfit 12) · `Dev · Interrupteur` 36 × 20.
   - `Figma` / `maquettes Nuera OS` / on
   - `GitHub` / `issues et pull requests` / on
   - `Coolify` / `à reconnecter` (**`--warn` text**) / **off**
7. **Action bar**: full-width primary with `icon/terminal` 16 white: `Ouvrir le Workspace`.

### Data → entities and fields

- Project: `name`, `syncStatus` badge, `repo.fullName` + `repo.htmlUrl`, `currentBranch`, `branches.count` (`6 branches`).
- Chip counts: `mcp.enabledCount` (2), `envVars.count` (4), `sessions.count` (7).
- Environment command: `kind` (`Installation` / `Lancement` / `Tests`; desktop also has `Build`), `command`, `lastRun.status` → badge (`Réussie`, `En cours`, `{passed} / {total}` for tests), `isRunning` → stop vs play.
- `claudeMd.content` (Markdown; preview shows the first lines).
- Per-project MCP tool: `server.name`, `usageNote` (`maquettes Nuera OS`), `enabled` (toggle), `health` (`à reconnecter` → warn text, toggle off).

### Interactions

| Element | Behavior |
|---|---|
| `‹ Projets` | Back to M02 (preserve list scroll and filters). |
| Refresh | Fetch/sync with origin; the badge shows `Synchronisation…` while running (M02 variant), then the result (`À jour`, `{n} en retard`, `Conflit`). |
| `…` (Plus) | **Bottom sheet** of project actions (not drawn). Likely the desktop row-menu set: `Retirer des favoris`, `Synchroniser maintenant`, `Nouvelle branche…`, `Nouvelle session ici`, `Archiver le projet…` (archiving is a sensitive action; see T8). |
| Repo link | Opens GitHub (external, new tab). |
| Branch selector | Opens a branch picker sheet (not drawn; desktop D04 has a *Branches* section with statuses `Courante`, `Session active`, `Protégée`, `Fusionnée`, plus `Nouvelle branche`). |
| Chips | Switch section in place (overview = the 3 cards shown). Keep the chip row scrollable; scroll the selected chip into view. |
| ▶ / ■ | Start or stop the command in the active worktree. The desktop note says output goes to the Workspace terminal. Show the running state via the badge (`En cours`). Stopping a dev server may deserve a confirmation (T8; not drawn). |
| `Modifier` | Edit CLAUDE.md (desktop note: each change is a commit on the current branch). |
| MCP toggle | Enable or disable the server for this project. For an expired server (Coolify), the toggle is off. Tapping it should offer reconnection (route to M07 / D2) rather than enabling silently (inference). |
| `Ouvrir le Workspace` | Opens **M05** for this project: the most recent or active session, or a new session if there is none (decision needed). |

### States

Command statuses (`Réussie`, `En cours`, `10 / 10`), play vs stop, toggles on and off, a degraded MCP server (`à reconnecter`).

### Mobile vs desktop (D04)

- **Breadcrumb `Projets / Nuera OS` → back link `‹ Projets`.**
- **Header buttons → icons**: `Synchroniser` (secondary) becomes a refresh icon button. `Ouvrir le Workspace` (primary, top-right) becomes the **sticky bottom bar CTA**. A `Plus` overflow is added.
- **Repo/branch line**: the desktop inline line (repo link with external icon, compact branch dropdown, `/srv/dev/nuera-os · synchronisé il y a 4 min`) becomes a repo link plus a **full-width branch selector showing the branch count**. The path and last-sync time are dropped.
- **Tabs → scrollable chips**; `Outils MCP · 2` shortens to `MCP · 2`; the **`Branches · 6` tab is removed** (the branch selector replaces it).
- **Two columns (7 cards) → one column with 3 cards** for the overview. *Branches*, *Sessions de ce projet* and *Variables d'environnement* are **not on the mobile overview**; they are reached via chips.
- **Environnement**: 4 rows → 3 (no `Build`); editable command inputs become read-only mono text; badges lose their times (`Réussie · il y a 2 h` → `Réussie`, `En cours · port 3000` → `En cours`, `10 / 10 réussis · 10:51` → `10 / 10`); text actions `Lancer` / `Arrêter` become 44 px icon buttons. The explanatory footnote is removed.
- **CLAUDE.md**: shorter clipped preview; the `Modifié le 28 oct. · commit 4c1d0e2…` footnote is removed; `Modifier` becomes a discreet button.
- **Outils MCP**: no server icons; descriptions shortened (`maquettes Nuera OS · lecture` → `maquettes Nuera OS`; `environnement de développement · à reconnecter` → `à reconnecter`).

---

## M05 — Workspace Claude Code

| | |
|---|---|
| Frame | `M05 · Workspace Claude Code` · node **`222:2732`** · 390 × 844 |
| Route | `/sessions/[sessionId]` with `?vue=session` (other tabs: `fichiers`, `diff`, `git`) |
| Desktop equivalent | D05 `214:1424` (and W1–W7 states) |
| Shell | **Full screen, contextual, no tab bar** |
| Related states | S1 keyboard + answered request, S2 Diff tab, S3 Git tab, S4 session switcher sheet, S5 notification entry |
| Files | `screens/M05.png`, `code/M05.tsx`, `assets/mobile/M05/` |

### Layout skeleton

| Region (layer) | y | h | Spec | Sticky |
|---|---|---|---|---|
| Status bar | 0 | 47 | | yes |
| `En-tête de session` | 47 | 52 | `--bg`, `px 4`, gap 2 | yes |
| `État de la session` | 99 | 39 | `--bg`, `pt 6 · pb 10 · px 16`, gap 8 | yes |
| `Onglets du Workspace` | 138 | 55 | `--bg`, `px 16 · pb 10`, **1 px bottom border** | yes |
| `Fil de la session` | 193 | 564 | **scroll area**, column, gap 12, `px 16 · py 12`, **`justify-content: flex-end`** (bottom-anchored chat; older items overflow upward; the instruction bubble is cut at y = −65) | — |
| `Saisie` | 757 | 87 | `--bg`, 1 px top border, `pt 8 · px 12`; composer 44 + safe area 34 | yes |

### Content and copy

1. **Session header**: `Bouton · Retour` 44 (`icon/arrow-left` 20 `--text`) · identity column (flex-1, gap 1): `Module CRM · pipeline` (Outfit SemiBold 16, ellipsis) / `Nuera OS · feature/crm-core · worktree crm-core` (mono 11 `--muted`, ellipsis) · `Bouton · Changer de session` 44 (`icon/worktree` 20 + **counter `2`** at `left 26 · top 6`, accent pill, Outfit SemiBold 10 white) · `Bouton · Actions de session` 44 (`icon/more`).
2. **Status row**: Badge Alerte `Autorisation demandée` + `12 min · vit sur VPS-3` (mono 11 `--muted`, ellipsis).
3. **Segmented tabs** (`Onglets`): track h 44, `--surface-raised`, 1 px `--border`, radius md, `p 3`, gap 2; four equal segments, radius sm 8. **Active**: `--accent-pale` fill, Outfit **SemiBold 13 `--accent`**. Inactive: Outfit Medium 13 `--muted`. Labels: `Session` (active) · `Fichiers` · `Diff · 4` · `Git`.
4. **Thread** (bottom-anchored, oldest at the top):
   1. `Dev · Message · Instruction` (right-aligned): bubble `--accent`, radius lg, `px 16 · py 12`, gap 4: `Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires.` (Outfit 14 / 20 white) + `Vous · 10:42` (mono 11 `--accent-on-dark`). The component bubble is 520 px wide (desktop); on mobile cap it at the column width (`max-width: 100%`, or about 85 % if design prefers a visible inset).
   2. `Dev · Ligne d'outil` × 2: `--bg`, 1 px `--border`, radius md, `px 12 · py 8`, gap 10: `icon/check` 16 `--success` · tool (mono **Medium** 12 `--text`) · path (mono 12 `--muted`, flex-1, ellipsis) · stats (mono 11 `--muted`) · `icon/chevron` 14.
      - `Edit` · `src/modules/crm/PipelineBoard.tsx` · `+46 −12`
      - `Write` · `src/modules/crm/__tests__/pipeline-totals.test.ts` · `+54`
   3. `Dev · Message · Claude`: row, gap 12: 28 × 28 `--accent-pale` tile (radius sm) with `icon/terminal` 16 accent · column (gap 4): `Claude Code` (Outfit SemiBold 13) + `10:51` (mono 11 `--muted`) / `Les tests sont écrits. Je lance la suite du module pour les vérifier.` (Outfit 14 / 20).
   4. **`Dev · Demande d'autorisation · téléphone`** (`222:2731`), described as *"Demande d'autorisation au téléphone : les trois choix empilés, pleine largeur, 44 px chacun, dans la zone du pouce."* Spec: `--warn-pale`, **1 px `--warn` border**, radius lg 20, `p 16`, gap 12.
      - Header (gap 10): `icon/shield` 20 `--warn` + `Claude demande à exécuter une commande` (Outfit SemiBold 15 / 20).
      - Command: **Dark-mode block** `#233353`, radius md, `px 12 · py 10`: `$ npm run test -- crm` (mono 13 white).
      - Explanation: `Lance la suite Vitest du module CRM dans le worktree crm-core.` (Outfit 13 / 18 `--muted`).
      - Actions (column, gap 8, each full width × 44): **`Autoriser`** (primary, check icon 16) · **`Toujours pour npm run test`** (secondary) · **`Refuser`** (discreet, accent, `x` icon 16).
      - Footer: `Mode : demander avant d'agir` (mono 11 `--warn`).
5. **Composer** (`Compositeur`, row, gap 6): `Bouton · Joindre un fichier` 44 (`icon/paperclip` 20 `--muted`) · field (flex-1, h 44, `--surface-raised`, 1 px `--border`, **radius full**, `px 14`), placeholder `Répondez d'abord à la demande…` (Outfit 14 `--muted`, ellipsis) · `Bouton · Envoyer` 44 (radius md) in its **disabled** look: `--border` fill, white `icon/send` 20.

### Components and variants

`Dev · Message · Instruction` (`203:318`, *"Instruction envoyée à la session Claude Code. Même bulle que les messages sortants de Nuera OS."*), `Dev · Ligne d'outil` (`203:369`, *"Une action de Claude Code (Read, Edit, Write, Bash, Glob…), repliée. Le chevron déplie sa sortie (Dev · Sortie de commande)."*), `Dev · Message · Claude` (`203:329`, *"Texte produit par Claude Code dans la session. Rendu lisible de la sortie du CLI ; la vue Terminal montre le flux brut."*), `Dev · Demande d'autorisation · téléphone` (`222:2731`), Badge Alerte, `Bouton compact` (Principal, Secondaire, Discret at 44 px), `Dev · Indicateur d'accueil`.

### Data → entities and fields

- Session: `id`, `title`, `project.name`, `branch`, `worktree.name`, `status` (→ badge `Autorisation demandée`; S1: `En cours · 13 min`; S2/S3: `Terminée · 18 min`), `elapsed` (`12 min`), `host` (`vit sur VPS-3`), `siblingSessionsInProject` (header counter `2`), `diff.fileCount` (tab `Diff · 4`).
- Thread events (from the CLI stream): `instruction {text, author: 'Vous', at}`, `toolCall {tool, target, additions, deletions, status, output}`, `assistantMessage {text, at}`, `permissionRequest {kind: 'command', command, explanation, options: [allowOnce, allowAlwaysForPrefix('npm run test'), deny], mode: 'demander avant d'agir'}`.
- Times are `HH:MM` 24 h (`10:42`, `10:51`).

### Interactions

| Element | Behavior |
|---|---|
| Back | Returns to where the user came from (M04, M06, M01 or the notification entry → M01). The session keeps running on VPS-3 (desktop footer: *Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas.*). |
| `Changer de session` | Opens the **sheet** (S4): `Sessions de Nuera OS` `2 / 4`, the project's sessions with statuses, `Nouvelle session dans un worktree`, `Toutes les sessions` (→ M06). |
| `Actions de session` | Overflow sheet (not drawn). Should carry the header actions missing from the phone layout: `Interrompre`, the Conversation / `Terminal brut` switch, the model, etc. |
| Segmented tabs | `Session` = thread; `Fichiers` = file tree (not drawn); `Diff · 4` = S2 (one file at a time with prev/next, unified diff; S2 note: *"Une ligne coupée s'ouvre en entier au toucher. Le côte à côte reste réservé au bureau."*); `Git` = S3 (branch, files to commit, commit message `Proposé par Claude`, toggles `Pousser sur origin` / `Ouvrir une pull request`, sticky `Committer et pousser`). |
| Tool row | Tap or chevron expands its output (`Dev · Sortie de commande`). |
| `Autoriser` | Sends allow-once to the CLI. The card collapses to a one-line receipt (S1: `Commande autorisée une fois · npm run test -- crm` with a check). The composer re-enables. |
| `Toujours pour npm run test` | Adds an allow rule for that command prefix. It is a persistent permission change, so a confirmation may apply (T8 *Actions sensibles à confirmer*). |
| `Refuser` | Sends deny. Claude continues or asks again. |
| Composer | **Disabled while a permission request is pending** (placeholder tells you to answer first; send greyed). Otherwise it sends an instruction to the session; the send button turns accent once text is entered (S1). Attach opens a file picker. |
| Thread scroll | Stay pinned to the newest event while the user is at the bottom; do not yank the scroll when they have scrolled up (no "jump to latest" control is drawn). |

### States and annotations

- Shown: session awaiting authorization, composer disabled.
- Related frames: S1 (answered and typing, keyboard open), S2 (Diff tab), S3 (Git tab), S4 (switch session), plus desktop W1–W7 (new session, long task, finished, multi-file diff, commit and PR, parallel sessions, lost connection). Lost connection (W7) has no mobile frame.
- Cover principles relevant here (from `00-principes.png`): *"Aucune API de chat privée sur l'abonnement Max : l'écran pilote une vraie session du CLI, la vue Conversation n'est qu'une mise en forme de son flux."* and *"Demandes d'autorisation : les capter et y répondre depuis le navigateur sans contourner le mode de permission du CLI."*

### Mobile vs desktop (D05)

- **Tab bar hidden** (desktop: the sidebar collapses to an icon rail). The whole screen is the Workspace.
- **Header**: desktop breadcrumb `Nuera OS / Module CRM · pipeline` + badge + repo, branch and worktree chips + `tmux · 12 min · vit sur VPS-3`. Mobile condenses this to **back + two-line identity**, with the status on its own row.
- **Desktop header actions removed**: `2 sessions sur ce projet` dropdown → **worktree icon with counter, opening a bottom sheet**. `Interrompre`, `Commit et push`, `…`, the panel toggle → the `…` sheet and the **Git tab**.
- **Two panes → one pane with a segmented control.** Desktop's left conversation plus right panel (`Fichiers` / `Modifications · 4` / `Tests` / `Terminal` / `Projet`) become `Session` / `Fichiers` / `Diff · 4` / `Git`. `Modifications · 4` is renamed `Diff · 4`. **`Tests`, `Terminal` and `Projet` are not top-level tabs**, and the `Conversation` / `Terminal brut` toggle is gone from the surface (needs a home; see open questions).
- **Permission card**: desktop has three inline buttons plus an `En attente` label and `Mode : demander avant d'agir · la réponse est transmise au CLI`. The phone variant **stacks the three choices full width at 44 px in the thumb zone** and shortens the footer to `Mode : demander avant d'agir`.
- **Composer**: desktop multi-line box (`Répondez d'abord à la demande d'autorisation ci-dessus…`, mode selector, `/ commandes`, `@ fichiers` hints, `Échap · interrompre`). Mobile is a **single-line pill** with attach and send and a shorter placeholder.
- **Thread density**: the desktop tool rows show result counts (`212 lignes`, `14 fichiers`); the mobile rows show only diff stats. The *Plan de travail* card exists in the thread above the fold.
- **Commit and PR** live in the Git tab with a sticky `Committer et pousser` (S3), instead of the desktop right-panel footer (`Préparer le commit` / `Préparer la pull request`).

---

## M06 — Sessions

| | |
|---|---|
| Frame | `M06 · Sessions` · node **`223:2787`** · 390 × 844 |
| Route | `/sessions` |
| Desktop equivalent | D06 `215:1792` |
| Shell | Root tab; tab bar `Actif=Sessions` |
| Files | `screens/M06.png`, `code/M06.tsx`, `assets/mobile/M06/` |

### Layout skeleton

`Contenu défilant` (`223:2798`): column, **gap 16**, `pt 8 · px 16 · pb 24`; content about 930 px.
`En-tête` (y 8) → `Capacité` (y 75, h 67) → overline `EN COURS · 2` (y 158) → rail (y 189, h 221) → dots (y 426) → `Sur-titre · Historique` (y 448, h 44) → `Filtres` (y 508) → `Historique` list card (y 547, h 359, partly below the fold).

### Content and copy

1. Header: `Sessions` / `Une session = un processus Claude Code sur VPS-3`. Right: `Bouton · Nouvelle session`, 44 filled accent `+`.
2. **Capacity card** (`Capacité`, card `p 16`, gap 8): header (gap 8) `icon/cpu` 16 accent · `2 sessions sur 4` (Outfit SemiBold 15, flex-1) · `10,9 Go libres` (mono 11 `--muted`). Slots `Créneaux`: 4 equal segments, h 8, radius 4, gap 4. Used slots `--accent`; free slots `--surface-raised` with a 1 px `--border`.
3. Overline `EN COURS · 2`.
4. Rail (gap 12, cards 290): **the authorization card comes first**.
   - `Autorisation demandée` · `2 min` · `Tests e2e du devis` · `Nuera OS` · `feature/devis-pdf · worktree devis-pdf` · `Attend votre accord pour npm run test -- crm` · `Répondre` (primary)
   - `En cours` · `12 min` · `Module CRM · pipeline` · `Nuera OS` · `feature/crm-core · worktree crm-core` · `Écrit les tests de pipeline-totals.ts` · `Ouvrir` (secondary)
5. Rail dots (2).
6. Overline row: `HISTORIQUE` + `Bouton · Rechercher` 44 (`icon/search` 20 `--text`).
7. Filter chips: `Toutes` (Accent, selected) · `Terminées` · `Reprise possible` · `Archivées` (Neutre).
8. **History list card** (`px 16 · py 4`): rows `py 12`, gap 10: column (gap 3; title Outfit SemiBold 15 ellipsis; `Projet · branche` mono 11 `--muted` ellipsis; meta row gap 8 = Badge + `date · durée` Outfit Regular 12 `--muted`) + `icon/chevron` 18.

| Title | Project · branch | Status badge (tone) | When · duration |
|---|---|---|---|
| `Galerie photos` | `Atelier Lune · feature/galerie-photos` | `Terminée` (Succes) | `hier · 48 min` |
| `Correctif tarifs mobile` | `Kiné Rive Gauche · fix/tarifs-mobile` | `Reprise possible` (Alerte) | `lun. · 1 h 12` |
| `Migration Next 16` | `Site Nuera Studio · chore/next-16` | `Archivée` (Neutre) | `28 oct. · 2 h 40` |
| `Audit des contrastes` | `Site Nuera Studio · fix/contrastes` | `Reprise impossible` (Danger) | `21 oct. · 35 min` |

### Data → entities and fields

- Capacity: `sessions.runningCount` (2), `limits.maxConcurrentSessions` (4; desktop says it is configurable in Paramètres · Serveur), `server.memory.free` (`10,9 Go libres`; French decimal comma).
- Running session card: see M01.
- History session: `title`, `project.name`, `branch`, `status` ∈ {`Terminée`, `Reprise possible` (interrupted, worktree still present), `Archivée`, `Reprise impossible` (worktree deleted)}, `startedAt` (compact date: `hier`, `lun.`, `28 oct.`), `duration` (`48 min`, `1 h 12`, `2 h 40`, `35 min`: `{h} h {mm}` when at least 1 h, otherwise `{m} min`).

### Interactions

| Element | Behavior |
|---|---|
| `+` | New session flow. Not drawn on mobile; desktop: *"Choisir un projet et une branche. Un worktree dédié est créé, la session tourne même navigateur fermé."* On the phone, use a sheet or full-screen picker (project → branch → open M05). |
| `Répondre` | Opens M05 at the request. |
| `Ouvrir` / card tap | Opens M05. |
| Search icon | Reveals a search field for the history (inferred: expands in place or pushes a search view; desktop placeholder `Rechercher une session…`). |
| Chips | Filter the history by status. |
| History row | Opens the session summary or replay. Desktop actions by status: `Voir le résumé` (Terminée), `Reprendre` (Reprise possible), `Voir` (Archivée), `Pourquoi ?` (Reprise impossible). On mobile they go on the detail screen or a row sheet (not drawn). |

### States

Capacity at 2 of 4; both running-card variants; all four history statuses. The empty state (`T2 · Listes vides`) is not drawn for mobile.

### Mobile vs desktop (D06)

- **Subtitle shortened**: `Chaque session est un processus Claude Code sur VPS-3, dans son propre worktree.` → `Une session = un processus Claude Code sur VPS-3`.
- `Nouvelle session` text button → **icon `+`**. The dashed `Démarrer une session` placeholder card (with explanation) is **removed**.
- **Capacity strip condensed**: `2 sessions actives sur 4 autorisées` + `Limite réglable dans Paramètres · Serveur` + `Mémoire libre : 10,9 Go sur 16 · processeur 23 %` → `2 sessions sur 4` + `10,9 Go libres` (CPU dropped).
- **Running sessions**: grid → **rail with dots**, and the **authorization-pending card is sorted first** (desktop order: running first). The worktree explanation line is removed.
- **History filters**: search field + 3 dropdowns (`Projet : tous`, `Statut : tous`, `30 derniers jours`) → **search icon + status chips**. Project and date-range filters are not on mobile.
- **History table → two-line rows**: the columns `SESSION / PROJET / BRANCHE / DÉBUT · DURÉE / STATUT / ACTION` are recomposed; dates lose the time of day (`hier 16:20 · 48 min` → `hier · 48 min`); the status label `Interrompue · reprise possible` → `Reprise possible`; per-row action buttons → chevron.
- The `claude --resume` footnote is removed.

---

## M07 — Intégrations

| | |
|---|---|
| Frame | `M07 · Intégrations` · node **`223:2966`** · 390 × 844 |
| Route | `/integrations` (details: `/integrations/github`, `/integrations/mcp/[serveurId]`) |
| Desktop equivalent | D07 `216:2035` (states D1 `234:4927` Figma connected, D2 `234:5127` Coolify to reconnect) |
| Shell | Root tab; tab bar `Actif=Intégrations` |
| Files | `screens/M07.png`, `code/M07.tsx`, `assets/mobile/M07/` |

### Layout skeleton

`Contenu défilant` (`223:2977`): column, **gap 16**, `pt 8 · px 16 · pb 24`; content about 843 px.
`En-tête` (y 8) → `GitHub` card (y 75, h 176) → `Alerte Coolify` (y 267, h 143) → overline (y 426) → `Serveurs MCP` list card (y 457, h 312) → `Garde-fou` (y 785, h 34).

### Content and copy

1. Header (no action): `Intégrations` / `Les accès utilisés sur VPS-3, sans secret affiché`.
2. **GitHub card**: `--bg`, **1.5 px `--accent` border** (highlighted as the primary integration), radius lg, Shadow/Soft, `p 16`, gap 12.
   - Header (gap 12): 36 × 36 `--accent-pale` tile (radius sm) with `icon/github` 18 · column: `GitHub` (Outfit SemiBold 16) / `Application GitHub de Nuera Dev` (12 `--muted`) · Badge Succes `Connecté`.
   - `12 dépôts · contenu et pull requests en écriture · vérifiée il y a 6 min` (Outfit 13 / 18 `--muted`).
   - Actions (gap 8): two **secondary** buttons, flex-1 × 44: refresh icon + `Vérifier` · `Gérer l'accès`.
3. **Coolify alert** (`Alerte Coolify`): `--danger-pale` fill, **no border, no shadow**, radius lg, `p 16`, gap 10. Title row (gap 8): `icon/alert` 18 `--danger` + column: `Coolify : autorisation expirée` (Outfit SemiBold 15) / `Les sessions continuent, sans accès aux environnements de développement.` (13 / 18 `--muted`). Full-width secondary button with refresh icon: `Reconnecter`.
4. Overline `SERVEURS MCP · 4`.
5. **MCP list card** (`px 16 · py 4`): rows `py 12`, gap 12: 36 × 36 `--accent-pale` tile with icon 18 accent · column (gap 2; name Outfit SemiBold 15; description 12 `--muted` ellipsis) · status Badge · chevron 18.
   - `icon/figma` · `Figma` / `Maquettes et composants` · `Connecté` (Succes)
   - `icon/github` · `GitHub` / `Issues et pull requests` · `Connecté` (Succes)
   - `icon/rocket` · `Coolify` / `Développement uniquement` · `Expiré` (Danger)
   - `icon/globe2` · `Playwright` / `Tests de bout en bout` · `Désactivé` (Neutre, renders as plain muted text)
   - Last row `Ajouter un MCP`: 36 × 36 tile with a **dashed 1 px `--border`** and `icon/plus` 18 accent + `Ajouter un serveur MCP` (Outfit **Medium** 15 `--accent`).
6. **Guardrail** (`Garde-fou`, gap 8): `icon/shield` 16 `--muted` + `Les actions de production Coolify ne passent jamais par Claude : elles restent dans Coolify.` (Outfit 12 / 17 `--muted`).

### Data → entities and fields

- GitHub App installation: `status` (`Connecté`), `accessibleRepoCount` (12), `permissionsSummary` (`contenu et pull requests en écriture`), `lastVerifiedAt` (`vérifiée il y a 6 min`).
- Alerts: `integration.authExpired` (Coolify) → alert card. The copy depends on the server.
- MCP server: `id`, `name`, `icon`, `description`, `status` ∈ {`Connecté`, `Expiré`, `Désactivé`}, `scope` (Coolify: development only). The count in the overline (`4`) excludes the add row.

### Interactions

| Element | Behavior |
|---|---|
| `Vérifier` | Re-checks the GitHub App connection. Spinner on the button, then a toast (T3 success / T4 error; not drawn for mobile). |
| `Gérer l'accès` | Opens the GitHub App installation settings (external). |
| `Reconnecter` | Starts Coolify re-authorization (D2 flow). |
| MCP row | Opens the server detail (D1 Figma connected, D2 Coolify to reconnect; desktop-only frames). Mobile detail is a pushed page. |
| `Ajouter un serveur MCP` | Add-server flow (not drawn). |

### States

Connected, expired and disabled servers; an auth-expired alert. All servers healthy (no alert card) is the implied default.

### Mobile vs desktop (D07)

- **Header button `Ajouter un serveur MCP` → last row of the MCP list.**
- **Subtitle shortened**: `Les accès que Nuera Dev et Claude Code utilisent sur VPS-3. Aucun secret n'est affiché ici.` → `Les accès utilisés sur VPS-3, sans secret affiché`.
- **GitHub hero condensed**: title `GitHub · import et synchronisation des dépôts` → `GitHub` + `Application GitHub de Nuera Dev`. The long description is removed. The three stat tiles (`DÉPÔTS ACCESSIBLES`, `DROITS`, `DERNIÈRE VÉRIFICATION`) merge into one sentence. `Vérifier la connexion` / `Voir les 12 dépôts` / `Gérer l'accès` / expiration note → two equal buttons `Vérifier` and `Gérer l'accès`.
- **Alert moved up and shortened**: desktop shows a banner **below** the MCP grid (`Coolify ne répond plus depuis 09:12` + `Voir le journal` + `Reconnecter`). Mobile places a card **above** the list (`Coolify : autorisation expirée` + `Reconnecter`).
- **MCP 5-card grid → list rows** with status badge and chevron. Per-card project counts (`3 projets`) and buttons (`Configurer`, `Reconnecter`, `Activer`) are removed. The `Autorisation expirée` badge → `Expiré`.
- **Three guardrail cards** (`Production hors de portée`, `Un accès, un projet`, `Diagnostic automatique`) → **one footnote** (production only).

---

## M08 — Paramètres

| | |
|---|---|
| Frame | `M08 · Paramètres` · node **`226:2985`** · 390 × 844 |
| Route | `/parametres` (drill-downs such as `/parametres/claude`, `/parametres/securite`, `/parametres/serveur`) |
| Desktop equivalent | D08 `217:2179` |
| Shell | Root tab; tab bar `Actif=Paramètres` |
| Files | `screens/M08.png`, `code/M08.tsx`, `assets/mobile/M08/` |

### Layout skeleton

`Contenu défilant` (`226:2996`): column, **gap 12**, `pt 8 · px 16 · pb 24`; content about 877 px.
`En-tête` (y 8) → overline `CLAUDE CODE` (y 71) → group (y 98, h 216) → footnote (y 326) → overline `SÉCURITÉ` (y 368) → group (y 395, h 156) → overline `SERVEUR VPS-3` (y 563) → group (y 590, h 164) → overline `PRÉFÉRENCES` (y 766) → group (y 793, h 60).

### Content and copy

Header: `Paramètres` / `Un seul propriétaire : Nezar` (no action button).

**Écart multi-comptes** (`docs/MULTICOMPTE.md` §14, W5-1) : le sous-titre construit est `Compte de <prénom>` ; la
tuile d'identité de `Compte et sécurité` est titrée par le rôle (`Propriétaire` · `Administrateur` · `Membre`), légende
`<rôle> · double facteur actif · serveur <nom>` (ou `· aucun serveur attribué`).

Settings groups (see *Settings group* in §2). Row anatomy: leading icon 20 (accent unless noted) · label Outfit **Regular** 15 `--text` (+ optional sublabel 12 `--muted`) · trailing value (Outfit Regular 14 `--muted`) or Badge or toggle · `icon/chevron` 16 `--muted`. Rows are 52 px, or 60 px with a sublabel.

| Group (overline) | Icon | Label | Sublabel | Trailing |
|---|---|---|---|---|
| `CLAUDE CODE` | `icon/terminal` | `Compte Claude` | `Connexion par le CLI officiel` | Badge Succes `Connecté · Max` + chevron |
| | `icon/reglages` | `Modèle par défaut` | — | `Défaut du CLI` + chevron |
| | `icon/shield` | `Mode de permission` | — | `Demander` + chevron |
| | `icon/history` | `Utilisation` | — | `Ouvrir /status` + chevron |
| *(footnote)* | | `Nuera Dev ne stocke aucun identifiant Claude et n'estime aucun coût.` (Outfit 12 `--muted`) | | |
| `SÉCURITÉ` | `icon/lock` | `Double facteur` | — | Badge Succes `Actif` + chevron |
| | `icon/monitor` | `Accès ouverts` | — | `3` + chevron |
| | `icon/history` | `Journal de sécurité` | — | chevron |
| `SERVEUR VPS-3` | `icon/server` | `État` | `4 services · 99,95 % sur 30 jours` | Badge Succes `En ligne` + chevron |
| | `icon/book` | `Journaux` | — | chevron |
| | `icon/trash` (**`--danger`**) | `Nettoyer les worktrees inactifs` (**label in `--danger`**) | — | `2,4 Go` + chevron |
| `PRÉFÉRENCES` | `icon/bell` | `Notifications` | `Autorisations et fins de session` | `Dev · Interrupteur` **on** (no chevron) |

### Data → entities and fields

- `owner.name` (single-owner app).
- Claude CLI: `account.connected`, `account.plan` (`Max`; badge `Connecté · Max`), `defaultModel` (`Défaut du CLI`), `permissionMode` (`Demander` = *ask before acting*), usage = output of `/status` (never computed by Nuera Dev, per the footnote and the cover principle *"Aucune métrique de coût, de quota ou de jetons inventée : seulement ce que le CLI affiche."*).
- Security: `twoFactor.enabled`, `activeSessions.count` (3 devices), security log.
- Server: `services.count` (4), `uptime30d` (`99,95 %`, French decimal comma and a space before `%`), `status` (`En ligne`), logs, `inactiveWorktrees.totalSize` (`2,4 Go`).
- Preferences: `pushNotifications.enabled` (scope: permission requests and session ends).

### Interactions

| Row | Behavior |
|---|---|
| `Compte Claude` | Detail page: CLI connection info and `Se reconnecter dans un terminal` (desktop). **No token form**: per the cover principles, *"Aucun formulaire de jeton Claude : la connexion passe par la procédure du CLI, dans un terminal."* |
| `Modèle par défaut`, `Mode de permission` | Picker (sheet) with the current value. Desktop values: `Défaut du CLI`, `Demander avant d'agir`. |
| `Utilisation` | Runs or shows `/status` (desktop: `Ouvrir /status` button). |
| `Double facteur` | 2FA detail (desktop: `Application d'authentification · 8 codes de secours restants`). |
| `Accès ouverts` | Devices list with `Révoquer` (desktop shows 3 devices, one marked `Cet appareil`). |
| `Journal de sécurité`, `Journaux` | Log views. |
| `État` | Server status detail (services, 30-day availability chart). |
| `Nettoyer les worktrees inactifs` | **Destructive.** Review screen, then confirmation (T8 *Actions sensibles à confirmer*). Desktop label: `Worktrees inactifs` / `3 worktrees sans session depuis 30 jours · 2,4 Go` / `Examiner…`. |
| `Notifications` toggle | Requests the Web Push permission and subscribes this device; off unsubscribes. Make the whole row toggle it (44 px target). |

### Mobile vs desktop (D08)

- **Card dashboard with inline controls → grouped drill-down list** (iOS-settings style). The desktop section tabs (`Vue d'ensemble`, `Compte et sécurité`, `Claude Code`, `Serveur`, `Préférences`) become **overline groups on one scrolling page**.
- **Dropdowns → value rows** (`Défaut du CLI`, `Demander`; desktop `Demander avant d'agir`) that open pickers.
- **Collapsed into counts or rows**: the open-access device list (→ `Accès ouverts 3`), the security log preview (→ `Journal de sécurité`), the four service rows and the uptime bar chart (→ `État` + `4 services · 99,95 % sur 30 jours`), *Maintenance* (`Journaux` / `Consulter`, `Claude Code` / `Vérifier`, `Worktrees inactifs` / `Examiner…` → two rows; the Claude Code update check is not on the mobile overview).
- **Not on the mobile overview** (presumably inside drill-downs; to confirm): `Bloquer le mode sans autorisation` toggle, `Se reconnecter dans un terminal`, `Thème` (`Clair`), `Langue` (`Français`), the access-expiry rule (`Un accès expire après 12 h d'inactivité…`).
- **Wording**: the desktop explanatory paragraph is replaced by the one-line footnote `Nuera Dev ne stocke aucun identifiant Claude et n'estime aucun coût.`; `Notifications sur ce téléphone` / `Quand Claude demande une autorisation ou termine une session` → `Notifications` / `Autorisations et fins de session`; subtitle → `Un seul propriétaire : Nezar`.
- The worktree clean-up is presented as a **red destructive row** (desktop: neutral `Examiner…` button).

---

## 11. Route map (mobile)

Proposed App Router routes. **The same URLs serve desktop and mobile**; only the layout changes. Align with the desktop spec, which was not yet written when this file was produced.

| Code | Screen | Route | Shell | Active tab |
|---|---|---|---|---|
| M01 | Accueil | `/` | tabs | Accueil |
| M02 | Projets | `/projets` | tabs | Projets |
| M03 | Ajouter un projet (step 1/3) | `/projets/ajouter` (`?etape=depot|configuration|clonage`). On desktop, intercept it as a modal over `/projets` (D03); on mobile render a full page | full-screen flow, no tabs | — |
| M04 | Détail du projet | `/projets/[projetId]` (`?section=…` for chips) | pushed page + tabs + action bar | Projets |
| M05 | Workspace | `/sessions/[sessionId]` (`?vue=session|fichiers|diff|git`) | full screen, no tabs | — |
| M06 | Sessions | `/sessions` | tabs | Sessions |
| M07 | Intégrations | `/integrations` | tabs | Intégrations |
| M08 | Paramètres | `/parametres` | tabs | Paramètres |

Sheets (session switcher, overflow menus, pickers) should be URL-less UI state, or shallow `?sheet=` parameters if back-button dismissal is wanted. On Android and iOS PWAs, the system back gesture should close an open sheet first.

## 12. Implied data model (from the mobile screens)

- **Owner**: `firstName` (`Nezar`), single account, `twoFactorEnabled`, `openAccessCount`.
- **Server** (VPS-3): `name`, `status` (online), `freeMemory`, `servicesCount`, `uptime30d`, `inactiveWorktreesSize`, `maxConcurrentSessions` (4).
- **ClaudeCli**: `connected`, `plan` (`Max`), `defaultModel`, `permissionMode`.
- **Project**: `id`, `name`, `repoFullName`, `repoUrl`, `isFavorite`, `isArchived`, `currentBranch`, `branchCount`, `syncStatus` (`upToDate | behind(n) | conflict | syncing`), `lastActivityAt`, `diskUsage`, `envCommands[]`, `claudeMd`, `mcpTools[]` (per-project enablement), `envVarCount`, `sessionCount`.
- **EnvCommand**: `kind` (`install | dev | build | test`), `command`, `lastRun {status, passed?, total?, at}`, `running`.
- **Session**: `id`, `title`, `projectId`, `branch`, `worktree`, `status` (`running | awaiting_permission | finished | interrupted_resumable | interrupted_unresumable | archived`), `startedAt`, `duration` / `elapsed`, `lastActivityText`, `plan {current, total, currentLabel}`, `diffFileCount`, `events[]`.
- **SessionEvent**: `instruction | assistant_message | tool_call | permission_request | permission_receipt`.
- **PermissionRequest**: `id`, `sessionId`, `kind` (command), `command`, `explanation`, `options` (`allow_once`, `allow_always_prefix`, `deny`), `status`.
- **Commit**: `sha`, `shortSha`, `message`, `projectId`, `committedAt`.
- **GitHubAppInstallation**: `status`, `repoCount`, `permissions`, `lastVerifiedAt`, `availableRepos[] {fullName, visibility, language, updatedAt, alreadyCloned}`.
- **McpServer**: `id`, `name`, `icon`, `description`, `status` (`connected | expired | disabled`), `scope`.
- **NotificationPreference**: push subscription per device.

Formatting helpers needed (all `fr-FR`): compact relative time (`3 min`, `hier`, `lun.`, `30 oct.`), long relative (`il y a 6 min`, `il y a 2 j`, `il y a 1 sem.`, `il y a 1 mois`), durations (`48 min`, `1 h 12`, `2 h 40`), short date with weekday (`Mer. 4 nov.`), sizes (`41 Go`, `10,9 Go`, `2,4 Go`), percentages (`99,95 %`), counters with middle dot (`Tous · 5`, `Diff · 4`), `HH:MM` times.

> **Mock data is not consistent across screens; do not hard-code it.** For example, M01's pending card shows `$ npm run test -- e2e` for *Tests e2e du devis*, while the session card says `Attend votre accord pour npm run test -- crm`. M05 shows *Module CRM · pipeline* awaiting `$ npm run test -- crm`, while M01 and M06 show that session as `En cours` and *Tests e2e du devis* as the one awaiting. S4's sheet agrees with M05, not with M01/M06. Bind everything to live data.

## 13. Open questions and gaps

1. **Tablet range (768–1023 px)** has no design: mobile shell, desktop shell, or a hybrid with a rail?
2. **Page title size**: mobile uses 26 px, which is outside the documented scale (`28, 22, 18, 16, 14, 13, 12, 11`). Keep 26 or switch to 28?
3. **Notifications bell (M01)**: there is no notification center screen. Should it list pending requests and session ends?
4. **Overflow menus not drawn**: M04 `Plus`, M05 `Actions de session`, M02 row actions. Proposed content is the desktop menu set plus `Interrompre` and `Terminal brut` for the Workspace, presented as bottom sheets.
5. **Workspace views without a mobile home**: desktop `Terminal` (raw CLI stream), `Tests` and `Projet` panels, the model indicator, and the Conversation / `Terminal brut` toggle.
6. **`Fichiers` tab** (M05) content is not drawn on mobile.
7. **Mobile steps 2–3 of *Ajouter un projet*** (Configuration, Clonage, success and error, i.e. A2–A4 equivalents) are not drawn. Assume the same full-screen pattern with `‹` back in the top bar?
8. **New session flow on mobile** (M06 `+`, sheet `Nouvelle session dans un worktree`, M04 `Ouvrir le Workspace` when no session exists) is not drawn.
9. **Cross-cutting states on mobile**: loading, empty lists, errors, server unavailable, Claude disconnected, authorization expired and sensitive confirmations (T1–T8) exist only at desktop size (720 to 2200 px wide frames). Mobile adaptations (toasts above the tab bar? banners under the header?) need a decision.
10. **Lost connection in the Workspace** (W7) has no phone version.
11. **Sticky compact title on scroll** for root tabs: not drawn; ship without it?
12. **Instruction bubble width** on mobile (component is 520 px): full column width or about 85 %?
13. Whether **push notifications** use Web Push (PWA) or a third-party relay. This is listed "à valider" on the cover.

---

*Captured with the Figma MCP from file `nlvRWAtD1x2fKf8gVgcM0g`. Every value above comes from `get_design_context` / `get_variable_defs` on the listed nodes. Copy is verbatim. Items marked "inferred" or "not drawn" are not in Figma.*
