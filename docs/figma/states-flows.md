# Nuera Dev — Section 03 · Parcours A, Parcours D, États transversaux (T1–T8)

Implementation spec for the **state and flow frames** of section `03 — UI States & Flows` (node `199:7`) on the page
`NUERA DEV — WEB APP` (node `199:3`) of the Figma file `nlvRWAtD1x2fKf8gVgcM0g`.

- The prose is in English. **All UI copy is quoted verbatim from Figma, in French** (code spans or quotes). Do not
  rephrase, re-accent or re-punctuate it.
- Every frame has a screenshot in `.design-refs/screens/<CODE>.png` and the raw `get_design_context` output in
  `.design-refs/code/<CODE>.tsx`. That code is a React/Tailwind *reference*, not production code: it contains exact
  values, node ids (`data-node-id`) and the asset mapping in its header comment.
- Assets (SVG icons, toggles, logo parts) for these frames: `.design-refs/assets/states-flows/<figma-asset-id>.svg`.
  The mapping from each code constant to its local file is in the header of each code file.

> **Naming caveat.** In this section, `D1` and `D2` are **Parcours D** frames (MCP connection). They are *not* the
> desktop screens `D01`…`D08` from section 01 (two-digit codes, documented elsewhere). Likewise `A1`–`A4` are
> Parcours A frames, and `T1`–`T8` are cross-cutting states ("états transversaux").

---

## 0. Inventory

| Code | Figma frame name | Node | Size (px) | Screenshot | Design code |
|---|---|---|---|---|---|
| A1 | `A1 · Ajouter un projet · Choix du dépôt` | `233:4846` | 720 × 725 | `screens/A1.png` | `code/A1.tsx` |
| A2 | `A2 · Ajouter un projet · Clonage en cours` | `233:4944` | 720 × 656 | `screens/A2.png` | `code/A2.tsx` |
| A3 | `A3 · Ajouter un projet · Clonage réussi` | `233:5004` | 720 × 651 | `screens/A3.png` | `code/A3.tsx` |
| A4 | `A4 · Ajouter un projet · Erreur récupérable` | `233:5075` | 720 × 647 | `screens/A4.png` | `code/A4.tsx` |
| D1 | `D1 · Intégrations · MCP Figma connecté` | `234:4927` | 1440 × 1120 | `screens/D1.png` | `code/D1.tsx` |
| D2 | `D2 · Intégrations · MCP Coolify à reconnecter` | `234:5127` | 1440 × 1120 | `screens/D2.png` | `code/D2-tiroir.tsx` (drawer only; background = D1) |
| T1 | `T1 · Chargement et synchronisation` | `235:5273` | 720 × 461 | `screens/T1.png` | `code/T1.tsx` |
| T2 | `T2 · Listes vides` | `235:5307` | 1240 × 377 | `screens/T2.png` | `code/T2.tsx` |
| T3 | `T3 · Succès d'une opération` | `235:5346` | 720 × 306 | `screens/T3.png` | `code/T3.tsx` |
| T4 | `T4 · Erreur récupérable` | `235:5367` | 720 × 351 | `screens/T4.png` | `code/T4.tsx` |
| T5 | `T5 · Serveur indisponible` | `236:5335` | 720 × 491 | `screens/T5.png` | `code/T5.tsx` |
| T6 | `T6 · Claude Code déconnecté` | `236:5372` | 720 × 451 | `screens/T6.png` | `code/T6.tsx` |
| T7 | `T7 · Autorisation expirée` | `236:5401` | 1520 × 195 | `screens/T7.png` | `code/T7.tsx` |
| T8 | `T8 · Actions sensibles à confirmer` | `236:5432` | 2200 × 521 | `screens/T8.png` | `code/T8.tsx` |

(All paths relative to `.design-refs/`.)

### 0.1 Canvas annotations (verbatim)

Section-level markers on the canvas:

- Section title (`241:6126`, Outfit SemiBold 32): `03 — UI States & Flows · Workspace, parcours, états transversaux, téléphone`
- Marker above A/D frames (`241:6128`, JetBrains Mono 14, tracking 1.12 px, `--muted`):
  `PARCOURS A · AJOUT DE PROJET (A1 À A4)   ·   PARCOURS D · CONNEXION MCP (D1, D2)` (three spaces on each side of the middle dot, `whitespace-pre`)
- Marker above T frames (`241:6129`): `ÉTATS TRANSVERSAUX · T1 À T8`

Frame-level annotations (the paragraph at the bottom of each T board, Outfit Regular 13/18, `--muted`). They are
**design intent**, not UI copy:

| Frame | Annotation (verbatim) |
|---|---|
| T1 | `Silhouettes à la place des lignes tant que la liste arrive ; le bandeau dit ce qui se synchronise. En mouvement réduit, pas de miroitement : les silhouettes restent fixes.` |
| T2 | `Une liste vide dit pourquoi elle l'est et propose la seule action utile. Jamais d'illustration décorative : la pastille reprend l'icône de la section.` |
| T3 | `Le bandeau reste dans la page tant qu'il y a une suite à donner ; le toast disparaît seul après 6 s et reste lisible au survol.` |
| T4 | `Toute erreur dit ce qui a échoué, ce qui n'a pas été touché, et propose l'action pour réessayer. La sortie brute reste à un clic.` |
| T5 | `Remplace le contenu de toutes les pages tant que le serveur ne répond pas. L'Accueil et la barre latérale passent en rouge, sans masquer la navigation.` |
| T6 | `« Se reconnecter » ouvre un terminal sur VPS-3 qui lance la procédure de connexion du CLI (claude /login). Aucun formulaire de jeton dans Nuera Dev.` |
| T7 | `Même logique pour GitHub, Figma ou Coolify : prévenir avant, dire ce qui s'arrête après, et renvoyer vers le service qui délivre l'accès.` |
| T8 | `Une confirmation liste ce qui change et ce qui est conservé, puis nomme l'action sur son bouton. Le système de design n'a pas de variante destructive du Button : à arbitrer (voir 04).` |

MCP transport notes (in the D1 drawer, "CONFIGURATION" block, JetBrains Mono 12/19):

```
.mcp.json de chaque projet activé
transport : HTTP distant
authentification : autorisation Figma (OAuth)
```

Related note in section 04 (`240:5890`, "Note · Extensions et lacunes", "LACUNES À ARBITRER"), quoted because T8 points to it:

1. `Pas de variante destructive du Button : les confirmations (arrêter, archiver, supprimer) utilisent Accent. Proposer une variante Danger avec les jetons danger / danger-pale.`
2. `Pas de jeton danger-on-dark : les erreurs dans le terminal (mode Dark) utilisent danger-pale. À créer à côté de warn-on-dark et success-on-dark.`
3. `surface et surface-raised valent toutes deux paper en mode Light : les fonds de champs et de blocs se distinguent par une bordure, pas par une teinte.`
4. `Aucun style de texte n'est appliqué dans les écrans de Nuera OS (tailles posées à la main) : Nuera Dev suit la même échelle (28, 22, 18, 16, 14, 13, 12, 11) ; une rampe de styles « App » serait à formaliser.`

### 0.2 Where these frames sit in the prototyped flows

From the frame `Navigation et parcours` in section 00 (`241:5935`, block "PARCOURS PROTOTYPÉS"):

- **Parcours A · Premier projet**: `D02 Projets` → **`A1 Dépôt`** → `D03 Configuration` → **`A2 Clonage`** → **`A3 Réussi`** → `D04 Détail` → `W1 Workspace`.
  A4 is the recoverable error branch of step 2 (`D03 Configuration`, whose primary button is `Cloner sur VPS-3`).
- **Parcours D · Connexion MCP**: `D07 Intégrations` → **`D1 Figma`** → **`D2 Coolify`**.
- T1–T8 are not screens. They are reusable states that every page uses.

### 0.3 Copy conventions observed in Figma

- Apostrophes are **straight** (`'`, U+0027) everywhere: `n'est`, `l'accès`, `s'y`. Keep them as-is.
- Separators are a **middle dot with regular spaces** (` · `, U+00B7). Ellipsis is the single character `…` (U+2026).
- French guillemets with regular spaces: `« Interrompue »`, `« Module CRM · pipeline »`.
- No non-breaking spaces were found in the Figma text (checked on the text-layer metadata of these frames), including
  before `:`, `;`, `?`, `%` (`64 %`, `CPU 23 %`). To avoid orphaned punctuation, the implementation may render those
  spaces as U+202F/U+00A0. That changes rendering only, not the copy.
- Numbers use French formatting: decimal comma (`5,1`, `2,1 Go`, `1,8 Go`), a space before units (`84 Mo`, `12 s`, `64 %`).

### 0.4 Presentation boards vs. UI

- **A1–A4**: the 720-wide frame is a backdrop (`--near-black` `#141830`, padding 40 = `--space-10`) with the modal
  centred inside it. In the product, the modal sits over the Projets page with a **Voile** (see D03 `211:1254`, and
  D1/D2: near-black at 55 % opacity).
- **T1–T8**: the frame is a specimen board (`--surface-raised` background, 1 px `--border`, padding 32, vertical gap 20)
  that ends with an annotation paragraph. Only the components inside the board are UI.
- **D1/D2**: full desktop screens (1440 × 1120) = the Intégrations page (`D07`) + Voile + right drawer.

---

## 1. Tokens used by these frames

Values come from `get_variable_defs` and the design code. CSS variable names are the ones Figma emits; use them as
the Tailwind v4 `@theme` / CSS custom-property names.

### 1.1 Colour

| Token | Light value | Used for |
|---|---|---|
| `--near-black` | `#141830` | sidebar background, Voile (55 %), toast background, modal backdrop |
| `--btn-edge` | `#141830` | Button edge/border and Default label |
| `--paper` | `#ffffff` | Button Default face, white labels on accent |
| `--bg` | `#ffffff` (Light) · **`#233353` (Dark mode)** | cards, modal, drawer; in **Dark** = terminal/log/code zones |
| `--surface-raised` | `#ffffff` | board background, detail tiles, Badge Neutre background, "Ce qui est sûr" box |
| `--surface-raised-dark` | `#ffffff0d` (white 5 %) | sidebar search and server/user cards |
| `--hairline-on-dark` | `#ffffff1a` (white 10 %) | active sidebar item background |
| `--text` / `--ink` | `#233353` | main text |
| `--muted` | `#645e78` (Light) · **`#ffffff9e` = rgba(255,255,255,0.62) (Dark)** | secondary text; log text in Dark zones |
| `--border` / `--border-on-light` | `#d9dade` | 1 px borders, separators, skeleton bars |
| `--accent` | `#4368b1` | primary actions, selection, current step, links, focus border |
| `--accent-pale` | `#dee5f2` | selected row, Badge Accent, icon pastilles, Bandeau Info |
| `--accent-on-dark` | `#a6b9dd` | sidebar text, toast action link |
| `success` | `#2f6f4f` | check icons, Badge Succès text |
| `success-pale` | `#e4f1ea` | done steps, success pastille, Bandeau Succès, Badge Succès |
| `success-on-dark` | `#5fc48b` | toast check icon, sidebar status dots |
| `danger` | `#b4451f` | error border/text, Badge Danger text, alert/trash icons |
| `danger-pale` | `#f8e6de` | Bandeau Erreur, Badge Danger, danger pastille |
| `warn` | `#8a6516` | warning icons, Badge Alerte text, "non commités" text |
| `warn-pale` | `#fbf1dc` | Bandeau Alerte, warn pastilles, Badge Alerte |
| `en-cours` | `#e0a10f` | running step icon (`icon/clock` in A2) — collection "App · statuts" |

**Dark mode zones**: the A2 `Journal` and the D1 `Fichier` code block use the **Dark mode of the Color collection**
(their variables resolve to `--bg: #233353`, `--muted: #ffffff9e`). Implement them as a `data-theme="dark"` (or
`.dark`) scoped container rather than with hard-coded colours.

### 1.2 Spacing, radius, shadow, type

- Spacing: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 ·
  `--space-7` 28 · `--space-8` 32 · `--space-10` 40. Off-scale values used: 2, 6, 9, 10, 14, 26 (Button padding x), 13 (Button padding y).
- Radius: `--radius-sm` 8 · `--radius-md` 12 · `--radius-lg` 20 · `--radius-xl` 28 · `--radius-full` 999.
  Skeleton bars use 4; the skeleton badge uses 11.
- Shadows: **`Shadow/Soft`** = `0 14px 34px -22px rgba(20,24,48,0.28)` (`#14183047`) for page cards;
  **`Shadow/Float`** = `0 24px 50px -18px rgba(20,24,48,0.55)` (`#1418308C`) for modal, drawer, dialogs, toasts.
- Fonts: **Outfit** (Regular 400, Medium 500, SemiBold 600, Bold 700) for UI; **JetBrains Mono** (Regular, Medium,
  Bold) for paths, repo names, counters, overlines, logs. `line-height: normal` unless stated.
- Text style `Text/UI` = Outfit Bold 15 / line-height 1.25 (Button labels).
- Type scale used here: 32 (canvas only), 28 (page title), 22 (modal title), 20 (drawer/card title), 18, 16, 15, 14, 13, 12, 11, 10.
- Overline style (used repeatedly): JetBrains Mono Regular 11, `letter-spacing: 0.88px`, `--muted`, uppercase in the copy.

---

## 2. Components used (shared)

Component names, ids and descriptions come from Figma. Descriptions are quoted verbatim because they are design rules.

### 2.1 `Button` (Design System `7:117`) — variants `Default`, `Accent`

> `Bouton du site (src/components/ui/Button). Default sur clair neutre, Accent sur fond clair, On dark dans une section sombre. Couper le burst près d'un bord : ses rayons débordent de 26 px.`

Structure (outer height **54**): wrapper `padding-top: 3px` → **Edge** (`--btn-edge`, radius 12, `padding-bottom: 3px`)
→ **Face** (radius 12, border 1.5 px `--btn-edge`, padding 13 × 26) → label `Text/UI` (Outfit Bold 15/1.25).

- `Default`: face `--paper`, label `--btn-edge`.
- `Accent`: face `--accent`, label `--paper`.
- Hover/pressed and the "burst" come from the Design System button states (see the DS doc). Every T8 confirm button
  uses **Accent**: there is no destructive variant yet.

### 2.2 `Bouton compact` (`168:6952`) — `Principal`, `Secondaire`, `Discret`

> `Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code.`

Height 36, radius 12, gap 6, padding-left 12 / right 14, label Outfit Medium 14, optional leading icon 16.

- `Principal`: bg `--accent`, label/icon `--paper`.
- `Secondaire`: bg `--paper`, 1 px `--border-on-light`, label/icon `--ink`.
- `Discret`: no background or border, label `--accent`, no padding (text button).
- Hit area: 44 px minimum in code (padding or pseudo-element).

### 2.3 `Badge` (`57:*`) — `ton`: `Accent` (`57:112`), `Succes` (`57:114`), `Alerte` (`57:116`), `Danger` (`57:118`), `Neutre` (`57:120`)

Padding 4 × 8, radius full, Outfit Medium 12. Text/background pairs: Accent `--accent`/`--accent-pale` ·
Succes `success`/`success-pale` · Alerte `warn`/`warn-pale` · Danger `danger`/`danger-pale` ·
Neutre `--muted`/`--surface-raised`. Neutre has **no border**, so on white it reads as plain muted text. Height 23.

### 2.4 `Dev · Bandeau` (`203:703`) — `Ton=Info | Succès | Alerte | Erreur`

> `Message d'état dans une page : chargement, succès, alerte, erreur récupérable avec son action.`

Row: padding 12 × 16, radius 12, gap 12, `align-items: center`, width = container. Icon 18 → text column (gap 2:
title Outfit SemiBold 14 `--text`, body Outfit Regular 13 `--muted`) → optional `Bouton compact Secondaire`.

| Ton | Background | Icon (stroke) | Example (frame) |
|---|---|---|---|
| Info | `--accent-pale` | `icon/alert` (`--accent`) | T1, no action |
| Succès | `success-pale` | `icon/check` (`success`) | T3, action `Ouvrir` |
| Alerte | `warn-pale` | `icon/alert` (`warn`) | T7, action `Renouveler` |
| Erreur | `danger-pale` | `icon/alert` (`danger`) | T4 action `Réessayer` (refresh icon); A4 and D2 without action |

The action is optional (hidden in A4 and D2). Two similar banners are not instances of this component: `Diagnostic Coolify`
(D1/D2) and `Accès GitHub révoqué` (T7). They are custom rows with the Erreur look but `padding-y: 14`, and T7 replaces
the alert icon with the service icon (`icon/github`). Model them as `Banner` props (`icon`, `dense=false`).

### 2.5 `Dev · Toast` (`203:709`)

> `Confirmation éphémère d'une opération réussie, en bas à droite (bureau) ou au-dessus de la saisie (téléphone).`

Background `--near-black`, radius 12, padding 12 × 16, gap 12, `Shadow/Float`, content-width (442 and 398 px in T3).
`icon/check` 18 (stroke `success-on-dark` `#5FC48B`) → message Outfit Regular 14 `--paper` → action link Outfit
SemiBold 14 `--accent-on-dark`.

### 2.6 `Dev · Champ` (`202:503`) — `État=Repos | Focus | Erreur`

> `Champ de saisie et liste déroulante. Fond surface et bordure border, comme le compositeur de Nuera OS ; le champ de recherche de Nuera OS, sans bordure, reste réservé aux barres latérales.`

Height 40, radius 12, padding 8 × 12, gap 8, leading icon 16, text 14.
`Repos`: 1 px `--border` (A1 search). `Focus`: 1.5 px `--accent` (D2 token field). `Erreur`: 1.5 px `--danger` (A4 destination).

### 2.7 `Dev · Interrupteur` (`202:459`) — `Actif=Oui | Non`

> `Même dessin que l'interrupteur de Nuera OS (Réglages · Connexions), passé à l'accent : le vert ChatGPT y est réservé à ChatGPT. Zone tactile de 44 px à prévoir autour.`

36 × 20 switch. On: track `#4368B1`; off: track `#D9DADE`; knob white (SVGs `7180f044…svg` / `cdc1ad0b…svg`).
Implement it as an accessible `role="switch"` with a 44 px touch target.

### 2.8 Other building blocks

- `Dev · Barre latérale` (`201:732`, D1/D2, `actif = Intégrations`). See the shell doc. Its description:
  `Navigation globale de Nuera Dev au bureau. Dérivée de la Barre latérale de Nuera OS (mêmes jetons, mêmes entrées). Ajoute la carte État du serveur. Le Workspace utilise la version repliée.`
- `Logo Nuera Dev · papier` (`201:41`): `Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction que la pastille OS de Nuera OS).`
- `Avatar` (`57:125`), 36 px, initials Outfit SemiBold 13.
- **Pastille** (icon tile, not a library component): square radius 12 (sizes 32/40/48) or circle (36/56), tinted
  background (`accent-pale`, `success-pale`, `warn-pale`, `danger-pale`) with a stroked icon in the matching strong colour.
- Icons used (Nuera OS set, stroke icons): `icon/x`, `icon/search`, `icon/check`, `icon/github`, `icon/clock`,
  `icon/minus`, `icon/projets` (folder), `icon/git-branch`, `icon/terminal`, `icon/book`, `icon/alert`, `icon/figma`,
  `icon/rocket`, `icon/globe2`, `icon/plus`, `icon/shield`, `icon/plug`, `icon/refresh`, `icon/lock`, `icon/wifi-off`,
  `icon/stop`, `icon/archive`, `icon/trash`, `icon/worktree`, `icon/home`, `icon/reglages`. Unnamed `Icône` slots in
  buttons and fields: refresh (Vérifier/Tester/Reconnecter/Réessayer/Relancer), plus (Nouvelle session, Ajouter un
  serveur MCP), terminal (Se reconnecter dans un terminal), external-link (Réautoriser sur GitHub), folder (A4
  destination), key (D2 token).

---

## 3. Parcours A — "Ajouter un projet" (A1 → A4)

### 3.1 Shared modal shell ("Modale · Ajouter un projet")

**Route (suggested)**: the modal opens over `/projets`. With the App Router, use an intercepting route
`app/(app)/projets/@modal/(.)ajouter/page.tsx`, plus the full page `app/(app)/projets/ajouter/page.tsx` for direct
loads and for the phone. Keep the step in state or in `?etape=depot|configuration|clonage`, and the clone job in
`?job=<id>` so a closed modal can be reopened while the clone keeps running.

Layout (desktop):

- Modal: width **640**, `--bg`, radius **28** (`--radius-xl`), `overflow: hidden`, `Shadow/Float`, vertical stack.
  The height hugs the content (645 / 576 / 571 / 567 px). Centre it over a Voile.
- **En-tête** (height 135): padding 24 top, 20 bottom, 28 sides; 1 px bottom border `--border`; gap 16.
  - Title row (gap 12, centred): title `Ajouter un projet` (Outfit SemiBold 22, `--text`). Subtitle
    `Le dépôt est cloné sur VPS-3, là où Claude Code travaille.` (Outfit Regular 14, `--muted`, gap 4 under the title).
    **Fermer** icon button 36 × 36, radius 12, `icon/x` 18 (`--muted`), no visible background at rest.
  - **Stepper** (`Étapes`, gap 8): `Numéro` 24 × 24 circle + label (gap 8), steps joined by 40 × 1 `--border` connectors
    (`Liaison`). Labels: `Dépôt` · `Configuration` · `Clonage`.

    | Step state | Circle | Content | Label |
    |---|---|---|---|
    | current | `--accent` | number, JetBrains Mono Bold 12, `--paper` | Outfit **SemiBold** 14 `--text` |
    | upcoming | `--surface-raised` + 1 px `--border` | number, JetBrains Mono Bold 12, `--muted` | Outfit Regular 14 `--muted` |
    | done | `success-pale` | `icon/check` 14 (`success`) | Outfit Regular 14 `--text` |
- **Corps**: padding 24 × 28, vertical gap 16.
- **Pied** (height 87): 1 px top border `--border`; padding 16 × 28; gap 12; left helper text (Outfit Regular 12,
  `--muted`, flex-1, wraps); right `Button`s (Default then Accent).
- Phone: the same flow is the full-screen `M03 · Ajouter un projet`. It has a top bar with Annuler, the title and the
  step, three progress segments, scrolling content, and a bottom action bar with `Continuer` above the home indicator.
  See the mobile doc.

### 3.2 A1 · Choix du dépôt (`233:4846`) — step 1 "Dépôt"

Stepper: 1 current, 2 and 3 upcoming.

Body:

1. **Search** — `Dev · Champ` (Repos), full width, `icon/search` 16 (stroke `#233353`), placeholder `Rechercher un dépôt…`.
2. **Account filter chips** (`Comptes`, gap 6), single choice: `Badge Accent` `Tous · 12` (selected),
   `Badge Neutre` `nuera-studio · 11`, `Badge Neutre` `ethanthedevelop · 1`.
3. **Repository list** (`Dépôts`): 1 px `--border`, radius 12, padding 4. Rows are 54 px high, padding 10 × 12, gap 12,
   radius 8:
   - `Choix` radio 20 × 20 circle. Selected: `--accent` fill with `icon/check` 12 in white. Unselected: `--bg` + 1 px `--border`.
   - `icon/github` 16 (`--muted`).
   - Text column (gap 2): repo `owner/name` in JetBrains Mono Medium 13 `--text`; meta in Outfit Regular 12 `--muted`.
   - Selected row background: `--accent-pale`.
   - Disabled row (repo already cloned): whole row at `opacity: 0.5`, right `Badge Neutre` `Déjà cloné`.

   | Repo | Meta | State |
   |---|---|---|
   | `nuera-studio/roux-conseil` | `Privé · TypeScript · mis à jour il y a 2 j` | selected |
   | `nuera-studio/menuiserie-dupre` | `Privé · TypeScript · il y a 1 semaine` | — |
   | `nuera-studio/bistrot-du-port` | `Privé · Astro · il y a 3 semaines` | — |
   | `nuera-studio/nuera-crm-api` | `Privé · TypeScript · il y a 1 mois` | — |
   | `ethanthedevelop/nuera-studio` | `Déjà cloné sur VPS-3 · Site Nuera Studio` | disabled + `Déjà cloné` |

   The list frame is 280 px high and shows 5 of the 12 repos. Inference: give it a `max-height` of about 280 px with
   `overflow-y: auto`, and keep the search and chips fixed.
4. Footer: left `12 dépôts accessibles · gérer l'accès sur GitHub`; buttons `Annuler` (Default, 110 × 54) and
   `Continuer` (Accent, 124 × 54).

Data:
- GitHub repos visible to the Nuera Dev GitHub App installation: `fullName`, `owner`, `private` → `Privé`,
  `primaryLanguage`, `updatedAt` (relative time, see §6), and `clonedProject` (`{ id, name }` or null).
- Count per owner for the chips, and the total accessible count (`12`).

Interactions:
- Typing in the search filters by `owner/name` (debounced; server- or client-side).
- Chips filter by owner (single select). `Tous` resets.
- Clicking a row selects the repo (radio semantics, keyboard ↑/↓). Already cloned rows are not selectable; consider a
  tooltip or link to the existing project (not designed).
- `Continuer` goes to step 2 (`D03 Configuration`). Disable it while nothing is selected (the design shows a pre-selected row).
- `Annuler`, the `Fermer` (X) button, Esc or a click on the Voile close the modal with no side effect.
- `gérer l'accès sur GitHub` is plain muted text in Figma. If it becomes a link to the GitHub App installation settings
  (inferred intent), keep the same style.

### 3.3 Step 2 reference (`D03 · Ajouter un projet`, documented with the desktop screens)

Fields in Figma: `Branche de départ`, `Nom dans Nuera Dev`, `Destination sur VPS-3` (helper starting with
`Dossier vide requis. Espace libre : 99 Go sur 16`; the string is truncated in the metadata dump, see the D03 doc), toggles `Installer les dépendances après le clonage` and
`Un worktree par nouvelle session`, `CLAUDE.md du dépôt`. Footer `Étape 2 sur 3` · `Retour` · **`Cloner sur VPS-3`**.
A4 is the error state of this step.

### 3.4 A2 · Clonage en cours (`233:4944`) — step 3 "Clonage", running

Stepper: 1 done, 2 done, 3 current.

Body:

1. Title row (gap 12): `Clonage de nuera-studio/roux-conseil` (Outfit SemiBold 16, `--text`, flex-1) +
   `Badge Accent` `64 %`.
2. **Progress bar** (`Barre`): height 8, full width, `--surface-raised`, 1 px `--border`, radius full, `overflow: hidden`.
   Fill `--accent`, height 8, width = percent (374 / 584 ≈ 64 %). Use `role="progressbar"` with `aria-valuenow`.
3. **Sub-steps** (`Étapes`, gap 8). Rows: gap 10, `icon` 16 + label Outfit 14 (flex-1) + right meta
   JetBrains Mono Regular 11 `--muted`.

   | Sub-step label | State | Icon (stroke) | Label style | Meta |
   |---|---|---|---|---|
   | `Cloner le dépôt` | done | `icon/check` (`success`) | Regular, `--text` | `84 Mo · 12 s` |
   | `Installer les dépendances (npm ci)` | running | `icon/clock` (`en-cours` `#E0A10F`) | **Medium**, `--text` | `en cours · 31 s` |
   | `Lire CLAUDE.md et détecter les commandes` | pending | `icon/minus` (`--muted`) | Regular, `--muted` | `en attente` |
4. **Live log** (`Journal`): Dark-mode zone (`--bg` `#233353`), radius 12, padding 12 × 14, JetBrains Mono Regular
   12 / line-height 19, `--muted` (Dark = rgba(255,255,255,0.62)). Verbatim lines:

   ```
   $ git clone https://github.com/nuera-studio/roux-conseil.git
   Clonage dans '/srv/dev/roux-conseil'…
   Réception d'objets: 100% (1284/1284), 84.2 Mio, fait.
   Résolution des deltas: 100% (612/612), fait.
   $ npm ci
   npm WARN deprecated inflight@1.0.6
   ⠙ installation de 912 paquets…
   ```
   These are streamed process output (git and npm, localised by the server). The last line is a live spinner (`⠙`,
   braille frames). Auto-scroll to the bottom and cap the height (157 px in the design) with `overflow-y: auto`.
5. Footer: `Vous pouvez fermer : le clonage continue sur VPS-3.` + `Fermer` (Button Default, 107 × 54). There is no
   cancel action for the clone.

Behaviour: the clone is a **server-side background job**. The UI subscribes to progress (SSE or WebSocket) for the
percentage, sub-step status and durations, and log lines. Closing the modal does not cancel the job. When the job ends
with the modal open, show A3. When the modal is closed, notify with a T3 `Bandeau Succès` and/or toast (inference based
on T3's `Projet cloné sur VPS-3`).

### 3.5 A3 · Clonage réussi (`233:5004`) — step 3 done

Stepper: all three steps done (check + Regular `--text` labels).

Body (centred, gap 16):

1. Pastille 56 × 56 circle `success-pale` with `icon/check` 28 (`success`).
2. Title `Roux Conseil · Landing est prêt` (Outfit SemiBold 22, `--text`). `Roux Conseil · Landing` is the project
   display name set in step 2 (`Nom dans Nuera Dev`), not the repo name.
3. `Le dépôt est sur VPS-3, ses dépendances sont installées. Claude Code peut y travailler.` (Outfit Regular 14/20,
   `--muted`, centred).
4. **Summary** (`Récapitulatif`): 1 px `--border`, radius 12. Rows: padding 10 × 14, gap 10, separated by 1 px
   `--border`. Each row: icon 16 `--muted`, label Outfit Regular 13 `--muted` (flex-1), value JetBrains Mono Regular 12 `--text`.

   | Icon | Label | Value |
   |---|---|---|
   | `icon/projets` | `Dossier` | `/srv/dev/roux-conseil` |
   | `icon/git-branch` | `Branche` | `main` |
   | `icon/terminal` | `Commandes détectées` | `dev · build · test · lint` |
   | `icon/book` | `CLAUDE.md` | `trouvé à la racine · 86 lignes` |
5. Footer: `Ajouté à Projets · 912 paquets installés en 38 s` (wraps on 2 lines in a 211 px column),
   `Voir le projet` (Default, 144 × 54), `Démarrer une session` (Accent, 205 × 54).

Interactions:
- `Voir le projet` goes to the project detail `/projets/[projetId]` (D04).
- `Démarrer une session` opens the Workspace on a new session for that project (W1), for example
  `/projets/[projetId]/workspace?session=nouvelle`, or a POST that creates the session and redirects.
- The X button closes the modal and refreshes the Projets list (the new project row appears).

Data (clone result): `projectId`, `displayName`, `path`, `branch`, `scripts[]` (from `package.json`: `dev`, `build`,
`test`, `lint`), `claudeMd { found, location: 'racine', lines }`, `packages { count: 912, durationSec: 38 }`.

### 3.6 A4 · Erreur récupérable (`233:5075`) — step 2 error (destination not empty)

Stepper: 1 done, **2 current** (Configuration), 3 upcoming.

Body:

1. `Dev · Bandeau` **Ton=Erreur**, without action: title `Le dossier de destination n'est pas vide`, body
   `/srv/dev/roux-conseil contient déjà 14 fichiers. Rien n'a été écrasé.`
2. Field group (`Champ · Destination`, gap 6): label `Destination sur VPS-3` (Outfit Medium 13, `--text`).
   `Dev · Champ` **État=Erreur** (1.5 px `--danger`) with a folder icon 16 and the value `/srv/dev/roux-conseil` in
   JetBrains Mono Regular 14 `--text`. Error helper (Outfit Regular 12, `--danger`):
   `Choisissez un dossier vide, ou ouvrez le projet qui s'y trouve déjà.`
3. **Suggestions** (gap 8). Each is a clickable card: 1 px `--border`, radius 12, padding 10 × 14. Title Outfit Medium
   14 `--accent`, sub-line Outfit Regular 12 `--muted`.
   - `Utiliser /srv/dev/roux-conseil-landing` · `Dossier libre, proposé automatiquement`
   - `Ouvrir le projet existant` · `Le dossier contient déjà un clone de ce dépôt (main)`
4. Footer: `Étape 2 sur 3` + `Retour` (Default, 102 × 54) + `Réessayer` (Accent, 127 × 54).

Behaviour:
- The server validates the destination when the user submits step 2 (`Cloner sur VPS-3`). On a non-empty folder it
  returns an error with `{ path, fileCount: 14, existingClone: { repo, branch: 'main' } | null, suggestedPath }`.
  Nothing is written.
- Suggestion 1 fills the field with the suggested free path and clears the error. Suggestion 2 registers or opens the
  existing clone as a project (inferred) and goes to its detail.
- `Réessayer` re-submits with the current value (spinner while it runs). `Retour` goes to step 1.
- Use `aria-invalid` and `aria-describedby` on the field so the helper text is announced.

---

## 4. Parcours D — Intégrations · serveurs MCP (D1, D2)

**Route (suggested)**: `/integrations` (page = D07), with the drawer as a parallel/intercepting route
`/integrations/mcp/[serveur]` (for example `/integrations/mcp/figma`, `/integrations/mcp/coolify`). The drawer is
reachable directly by URL.

### 4.1 Page behind the Voile (identical in D1 and D2 = D07 `Intégrations`)

Layout: frame 1440 × 1120, background `--surface-raised`. Row = **sidebar 248** (full height, sticky) + **Contenu**
(flex-1 = 1192, padding 28 × 32, vertical gap 24). Figma clips the content (`overflow: hidden`); in code, make the
content column scroll vertically.

- **Sidebar** (`Dev · Barre latérale`, `actif=Intégrations`): `--near-black`, padding 20/16/16, gap 16.
  Logo Nuera Dev (136 px wordmark + `DEV` pastille). Search `Rechercher…` + `⌘K`. Group `ESPACE`: `Accueil`,
  `Projets`, `Sessions` with an accent count pill `2`. Group `CONFIGURATION`: **`Intégrations`** (active:
  `--hairline-on-dark` background, `--paper` SemiBold) and `Paramètres`. Spacer. Server card: green dot (`#5FC48B`)
  `VPS-3 · OVH Gravelines`, `CPU 23 %  ·  RAM 5,1 / 16 Go` (JetBrains Mono 11, pre-formatted double spaces), green dot
  `Claude Code connecté`. User card: Avatar `NZ`, `Nezar`, `Propriétaire · double facteur actif`.
- **Header**: `Intégrations` (Outfit SemiBold 28) / `Les accès que Nuera Dev et Claude Code utilisent sur VPS-3. Aucun secret n'est affiché ici.`
  (14, `--muted`), plus `Ajouter un serveur MCP` (Button Accent, 218 × 54).
- **GitHub card**: `--bg`, **1.5 px `--accent` border**, radius 28, padding 24, gap 16, `Shadow/Soft`.
  - Head (gap 16): Pastille 48 (`--accent-pale`, radius 12) with `icon/github` 20 (accent).
    `GitHub · import et synchronisation des dépôts` (SemiBold 18).
    `Connecté par l'application GitHub de Nuera Dev, installée sur l'organisation nuera-studio et sur le compte ethanthedevelop. Aucun jeton n'est saisi à la main.`
    (13/18 `--muted`). `Badge Succes` `Connecté`. `Gérer l'accès` (Button Default, 145).
  - Three equal detail tiles (gap 16; `--surface-raised`, 1 px `--border`, radius 12, padding 12 × 16, gap 4: overline,
    value Outfit SemiBold 16, sub Outfit 12 `--muted`):
    `DÉPÔTS ACCESSIBLES` / `12 dépôts` / `sélectionnés à l'installation` ·
    `DROITS` / `Contenu · pull requests` / `lecture et écriture ; issues en lecture` ·
    `DERNIÈRE VÉRIFICATION` / `il y a 6 min` / `synchronisation sans erreur`.
  - Actions (gap 8): `Vérifier la connexion` (compact Secondaire, refresh icon), `Voir les 12 dépôts` (compact Discret),
    note `Expiration : jeton d'installation renouvelé automatiquement par GitHub.` (12 `--muted`).
- **MCP title row**: overline `SERVEURS MCP · 4` + `Activés projet par projet, dans Détail du projet · Outils MCP.` (12 `--muted`).
- **MCP grid** (row, gap 20): four cards `flex: 1` (≈ 221 px) of equal height (223, `align-self: stretch`), plus a
  160 px "add" tile. Card: `--bg`, radius 28, padding 20, gap 12, `Shadow/Soft`. Head: Pastille 32 (accent-pale) +
  icon 20 (accent) + name SemiBold 16. Then a description (13/18 `--muted`), a status badge pair (gap 6), and one compact button.

  | Card (layer) | Icon | Description | Badges | Button |
  |---|---|---|---|---|
  | `MCP · Figma` | `icon/figma` | `Maquettes et composants nécessaires au développement.` | `Connecté` (Succes) · `3 projets` (Neutre) | `Configurer` (Secondaire) |
  | `MCP · GitHub` | `icon/github` | `Issues et pull requests, dans le périmètre de l'application.` | `Connecté` · `2 projets` | `Configurer` (Secondaire) |
  | `MCP · Coolify` (**1 px `danger` border**) | `icon/rocket` | `Environnements de développement. Production exclue.` | `Autorisation expirée` (Danger) · `1 projet` | `Reconnecter` (**Principal**, refresh icon) |
  | `MCP · Navigateur Playwright` | `icon/globe2` | `Tests de bout en bout pilotés par Claude.` | `Désactivé` (Neutre) · `aucun projet` (Neutre) | `Activer` (Secondaire) |
  | `Ajouter un MCP` (1 px **dashed** `--border`, radius 28, centred) | Pastille 36 circle + `icon/plus` 18 | `Ajouter un serveur MCP` (Medium 13 accent) | — | the whole tile is the action |
- **Diagnostic Coolify** (custom error row, padding 14 × 16): `icon/alert` (danger),
  `Coolify ne répond plus depuis 09:12` (SemiBold 14),
  `Le jeton du serveur MCP a expiré. Les sessions de Nuera OS continuent, sans accès aux environnements de développement.`
  (13 `--muted`), plus `Voir le journal` (Discret) and `Reconnecter` (Secondaire, refresh icon).
- Overline `GARDE-FOUS`, then three info cards (flex-1, gap 20; `--bg`, 1 px `--border`, radius 20, padding 16, gap 12;
  icon 18 accent; title SemiBold 14; body 13/18 `--muted`):
  - `icon/shield` `Production hors de portée` — `Déployer ou redémarrer un service de production ne passe jamais par Claude : ces actions restent dans Coolify, avec votre compte.`
  - `icon/plug` `Un accès, un projet` — `Un serveur MCP n'est visible que des projets où il est activé. Les autres sessions ne le voient pas.`
  - `icon/refresh` `Diagnostic automatique` — `Chaque connexion est vérifiée toutes les 15 minutes. Une expiration s'affiche ici et sur l'Accueil.`

### 4.2 Overlay and drawer shell (D1, D2)

- **Voile**: absolute, full viewport (also covers the sidebar), `--near-black` at **55 %** opacity. A click closes the drawer.
- **Tiroir**: fixed right, width **480**, full height, `--bg`, `Shadow/Float`, vertical stack. Implement it as a
  `role="dialog"` with `aria-modal`, a focus trap and Esc to close.
  - **En-tête**: padding 24 top, 20 bottom, 24 sides; 1 px bottom border; gap 6. Title row (gap 12): Pastille 40
    (accent-pale, radius 12) with the service icon 20 (accent). Name Outfit SemiBold 20, sub-line Outfit Regular 13
    `--muted` (gap 2). Close button 36 (`icon/x` 18). The **status Badge** sits on its own line underneath.
  - **Corps**: flex-1, padding 20 × 24, gap 20. Make it scroll with `overflow-y: auto` (Figma clips).
    Blocks = overline (`ÉTAT`, …) + rows. Key/value rows: padding 9 × 0, 1 px `--border` bottom except on the last row,
    gap 12, label Outfit Regular 14, value JetBrains Mono 12.
  - **Pied**: 1 px top border, padding 16 × 24, gap 10, a flexible spacer, then the actions, right-aligned.

### 4.3 D1 · MCP Figma connecté (`234:4927`) — drawer "Figma"

Header: `Figma` / `Serveur MCP · lecture des maquettes et des composants` / `Badge Succes` `Connecté`.

Body:

1. **`ÉTAT`**: `Connexion` → `compte nuera-studio` · `Dernier appel` → `il y a 3 min · Nuera OS` ·
   `Vérification` → `toutes les 15 min · OK`. Then `Tester la connexion` (compact Secondaire, refresh icon).
   Labels are `--muted`, values JetBrains Mono `--text`.
2. **`ACTIVÉ DANS`**: one row per project, name (Outfit Regular 14 `--text`) + `Dev · Interrupteur`.
   `Nuera OS` on · `Site Nuera Studio` on · `Atelier Lune` on · `Kiné Rive Gauche` off · `Nuera Dev` off
   (3 on = the `3 projets` badge on the card).
3. **`PERMISSIONS ACCORDÉES`** (rows: icon 16 + text 14):
   `icon/check` (success) `Lire les fichiers et les composants` · `icon/check` `Lire les variables et les styles` ·
   `icon/x` (muted) `Modifier les fichiers Figma` (`--muted`) with `non accordé` (12 `--muted`) on the right.
   Footnote (12/16 `--muted`): `Les droits viennent de l'autorisation donnée dans Figma, révocable depuis Figma.`
4. **`CONFIGURATION`**: Dark-mode code block (`#233353`, radius 12, padding 10 × 12, JetBrains Mono 12/19, rgba(255,255,255,0.62)).
   It holds the three MCP transport lines quoted in §0.1.

Footer: `Désactiver partout` (compact Discret) + `Fermer` (Button Default, 107 × 54).

Interactions:
- Toggles enable or disable the Figma MCP for a project. The server writes that project's `.mcp.json` (remote HTTP
  transport). Use an optimistic toggle with rollback and an error toast. Sessions only see the MCP of projects where it
  is enabled (`Un accès, un projet`).
- `Tester la connexion` runs a health check and refreshes `Vérification` / `Dernier appel`. Show a loading state on the button.
- `Désactiver partout` disables the server in every project. It is a sensitive bulk action, so confirm it with a T8
  dialog (inference).
- `Fermer`, X, Esc or a click on the Voile close the drawer (back to `/integrations`).
- Auth is Figma OAuth: there is no token field. Rights come from the Figma authorisation and are revoked in Figma.

### 4.4 D2 · MCP Coolify à reconnecter (`234:5127`) — drawer "Coolify"

Header: `icon/rocket` · `Coolify` / `Serveur MCP · environnements de développement` / `Badge Danger` `Autorisation expirée`.

Body:

1. `Dev · Bandeau` **Ton=Erreur** without action: `Jeton expiré ce matin à 09:12` /
   `Les sessions de Nuera OS n'ont plus accès aux environnements de développement.`
2. **`RECONNECTER`**: `Créez un nouveau jeton dans Coolify, limité à l'équipe Développement, puis collez-le ici. Il est chiffré sur VPS-3 et n'est plus jamais affiché.`
   (13/18 `--muted`). Then `Dev · Champ` **État=Focus** (1.5 px accent) with a key icon and the masked value
   `••••••••••••••••••••` (Outfit 14). Use `type="password"` with `autocomplete="off"`, write-only, never echoed back.
3. **`PÉRIMÈTRE`**:
   - `Environnements de développement` (Outfit Medium 14) / `Déploiements de prévisualisation, journaux, variables`
     (12 `--muted`) + `Interrupteur` on.
   - Row at 60 % opacity: `Environnements de production` /
     `Non disponible : ces actions restent dans Coolify, avec votre compte.` + `icon/lock` 18 (`--muted`). There is
     no switch: production is permanently out of scope.
4. **Garde-fou note**: `--surface-raised`, 1 px `--border`, radius 12, padding 10 × 12, gap 8, `icon/shield` 16
   (accent), `Après reconnexion, chaque projet garde son propre réglage dans Outils MCP.` (12 `--muted`).

Footer: `Annuler` (Default, 110 × 54) + `Reconnecter` (Accent, 142 × 54).

Interactions:
- Entry points: the Coolify card `Reconnecter`, the diagnostic `Reconnecter`, and T7-style banners on Accueil.
- `Reconnecter` is disabled while the field is empty. On submit: POST the token and validate it against the Coolify API
  (team scope Développement) with a loading state. On success, close the drawer, set the badge back to `Connecté`,
  remove the diagnostic and show a success toast. On failure, put the field in the `Erreur` state with a message
  (copy not designed).
- `Annuler` closes without saving.
- `Voir le journal` (page) opens the MCP connection log (screen not designed).

### 4.5 D-flow data model

- `GitHubAppInstallation { accounts: ['nuera-studio', 'ethanthedevelop'], repoCount: 12, permissions: { contents: 'rw', pullRequests: 'rw', issues: 'r' }, lastCheckedAt, lastSyncOk, tokenAutoRenewed: true }`
- `McpServer { id: 'figma'|'github'|'coolify'|'playwright', name, description, icon, transport: 'http-remote'|…, auth: 'oauth'|'token'|'github-app'|'none', status: 'connected'|'expired'|'disabled'|'unreachable', account ('compte nuera-studio'), lastCallAt + lastCaller ('Nuera OS'), checkIntervalMin: 15, lastCheckOk, permissions[{ label, granted }], scope (Coolify: dev on, prod locked), expiredAt (09:12) }`
- `McpActivation { serverId, projectId, enabled }`: counts drive `3 projets` / `1 projet` / `aucun projet`.
- `McpDiagnostic { serverId, since: '09:12', message, logUrl }`.

---

## 5. Cross-cutting states (T1–T8) and the reusable components they define

### 5.1 T1 · Chargement et synchronisation (`235:5273`)

UI in the board:

- `Dev · Bandeau` **Ton=Info** (no action): `Synchronisation en cours` / `Récupération de 3 commits depuis origin/main…`.
  The Info variant uses the `icon/alert` triangle in accent.
- **Skeleton table** (`Tableau en chargement`): `--bg`, radius 28, padding 8 × 20, `Shadow/Soft`. Four rows
  (`Ligne fantôme`), each with padding 16 × 0, gap 16 and a 1 px `--border` bottom except on the last:
  - Circle 18 × 18 filled `#D9DADE` (`Fantôme`).
  - Text block (flex-1, gap 6): bar 12 px high + bar 10 px high, `--border` colour at **opacity 0.7**, radius 4.
    Widths per row: 160/220, 146/200, 132/180, 118/160 (decreasing).
  - Right "badge" placeholder 80 × 22, radius 11, `--border` at **opacity 0.5**.

Reusable components:
- `<SkeletonList rows={4} />` built from `<SkeletonRow />` (avatar/icon dot + two text bars + trailing pill). It
  matches the real row metrics of each list (project rows 65 px, session cards…) so content does not jump when it loads.
- Shimmer: optional. Under `@media (prefers-reduced-motion: reduce)` the silhouettes **stay static**, with no shimmer
  (annotation).
- `<Banner tone="info">` for an operation in progress, with a live message (`aria-live="polite"`).

Where: first load of Projets (D02 table), Sessions (D06), Accueil lists, project history/commits (D04), Intégrations
cards, the A1 repo list while GitHub responds. The sync banner covers `git fetch`/`pull` of a project
(`Récupération de N commits depuis origin/<branche>…`).

### 5.2 T2 · Listes vides (`235:5307`)

Three empty states side by side (flex-1 ≈ 378 px, gap 20). Card: `--bg`, radius 28, padding 32 × 24, gap 12,
centred, `Shadow/Soft`. Content: Pastille 56 circle `--accent-pale` with the section icon 26 (accent), title Outfit
SemiBold 18, body Outfit Regular 14/20 `--muted` centred, then one action.

| Empty state | Icon | Title | Body | Action |
|---|---|---|---|---|
| Projects | `icon/projets` | `Aucun projet pour l'instant` | `Ajoutez un dépôt GitHub : il sera cloné sur VPS-3, prêt pour Claude Code.` | `Ajouter un projet` (**Button Accent**, 172 × 54) → opens A1 |
| Sessions | `icon/terminal` | `Aucune session en cours` | `Démarrez-en une depuis un projet. Elle continue même navigateur fermé.` | `Nouvelle session` (compact **Principal**, plus icon) |
| MCP servers | `icon/plug` | `Aucun serveur MCP` | `Ajoutez Figma, GitHub ou Coolify, puis activez-les projet par projet.` | `Ajouter un serveur MCP` (compact **Secondaire**, plus icon) |

Reusable: `<EmptyState icon title description action />`. The action slot accepts any button kind; the hierarchy is
chosen per page (the Projets empty state uses the big Button because it is the page's main action). There is never a
decorative illustration (annotation).

Where: Projets list (D02/M02), Sessions "en cours" (D06/M06, Accueil), Intégrations MCP grid (D07/M07). Use the same
pattern for any other empty list, for example filtered results with no match (copy not designed).
`Nouvelle session` has no project context here. It should open a project picker or go to Projets (inference; to decide).

### 5.3 T3 · Succès d'une opération (`235:5346`)

- `Dev · Bandeau` **Ton=Succès** with action: `Projet cloné sur VPS-3` / `nuera-os est prêt dans /srv/dev/nuera-os.` +
  `Ouvrir` (compact Secondaire, no icon).
- `Dev · Toast` × 2:
  - `Commit poussé sur origin/feature/crm-core` · action `Voir sur GitHub`
  - `Pull request #57 ouverte vers main` · action `Ouvrir sur GitHub`

Reusable:
- `<Banner tone="success" title description action />` — **persistent** while there is a follow-up action. It stays
  until the user acts or navigates away. Inline in the page, at the top of the content.
- `<Toaster />` + `toast({ message, action: { label, href, external } })`:
  - Auto-dismiss after **6 s**. The timer pauses on hover and focus and the toast "stays readable on hover" (annotation).
  - Position: **bottom-right on desktop**, **above the input/composer on phone** (component description).
  - Use `role="status"` / `aria-live="polite"`. Stack several toasts with the newest at the bottom (inference).
  - Success only. Errors use banners or error cards (T4).

Where: clone finished (banner on Projets/Accueil), commit/push/PR from the Workspace Git panel (toasts), MCP
reconnected, worktrees deleted, project archived.

### 5.4 T4 · Erreur récupérable (`235:5367`)

- `Dev · Bandeau` **Ton=Erreur** with action: `La synchronisation a échoué` /
  `origin/main n'a pas pu être récupéré : délai dépassé.` + `Réessayer` (compact Secondaire, refresh icon).
- **Failed command card** (`Commande échouée`): `--bg`, **1 px `danger` border**, radius 20, padding 16, gap 10.
  - Head: `npm run build a échoué` (Outfit SemiBold 15) + `Badge Danger` `code 1`.
  - Excerpt (JetBrains Mono 12/18 `--muted`, wraps):
    `Type error: Property 'amount' does not exist on type 'Deal'. · src/modules/crm/pipeline-totals.ts:11`
  - Actions (gap 8): `Relancer` (compact Secondaire, refresh icon) · `Demander à Claude de corriger` (compact
    **Principal**) · `Voir la sortie complète` (compact Discret).

Reusable:
- `<Banner tone="error" action={{ label: 'Réessayer', icon: 'refresh', onClick }} />` for failed background operations.
- `<CommandErrorCard command exitCode excerpt location onRetry onAskClaude onShowOutput />`:
  - `exitCode` is rendered as `code N`.
  - The excerpt is the first meaningful error line plus `file:line`. It should link to the file in the diff/file
    viewer (inference).
  - `Demander à Claude de corriger` sends the command, the exit code and the output tail as a prompt to the project's
    session (current or new).
  - `Voir la sortie complète` opens the raw output (Dark terminal zone, sheet or drawer). The raw output is always one click away.
- Rule (annotation): every error says **what failed**, **what was not touched** (A4: `Rien n'a été écrasé.`) and
  offers **the retry action**.

Where: git sync, push and PR failures; project commands (`dev`/`build`/`test`/`lint`) in D04 and the Workspace;
clone/install failures (A-flow); MCP check failures.

### 5.5 T5 · Serveur indisponible (`236:5335`)

**Blocking state card** (`Carte · VPS-3 ne répond pas`): `--bg`, radius 28, padding 28, gap 14, `Shadow/Soft`.

- Pastille 48 (square radius 12, `danger-pale`) with `icon/wifi-off` 24 (danger).
- `VPS-3 ne répond pas` (Outfit SemiBold 20).
- `Dernier contact il y a 3 min. Nuera Dev réessaie toutes les 10 s, sans rien faire de plus.` (14/20 `--muted`).
- **"Ce qui est sûr" facts box**: `--surface-raised`, 1 px `--border`, radius 12, padding 12 × 14, gap 6. Rows gap 8,
  icon 16 + Outfit 13/18 `--text`:
  - ✓ `Vos dépôts, worktrees et commits poussés sont intacts sur le disque du serveur.`
  - ✓ `Une coupure réseau n'arrête pas les sessions tmux : elles reprendront à l'affichage.`
  - ⚠ (warn) `Si le serveur a redémarré, les sessions seront marquées « Interrompue », reprenables par claude --resume.`
- Actions (gap 10): `Réessayer maintenant` (Button Accent, 210) · `État du serveur chez OVH` (Button Default, 231,
  external link to the OVH status/manager page).

Behaviour:
- App-level `ServerHealth` heartbeat every **10 s**. Show the "last contact" time as a relative time.
- While the server is unreachable, this card **replaces the content of every page**. The sidebar and phone tab bar stay
  usable, and the sidebar server card and Accueil turn **red** (danger dot). The annotation says the navigation stays visible.
- `Réessayer maintenant` triggers an immediate check (spinner on the button). Auto-recovery restores the page with no reload.
- Sessions found dead after a reboot get the `Interrompue` status (`Dev · Carte de session` variant
  `Statut=Interrompue`) and resume with `claude --resume`.

Reusable: `<BlockingStateCard tone="danger"|"warn" icon title description facts={[{ kind: 'ok'|'risk', text }]} actions />`
(shared with T6), mounted by a `<ConnectivityGate>` in the app layout.
See also `W7 · Workspace · Connexion perdue`, which covers loss of the live connection inside the Workspace.

### 5.6 T6 · Claude Code déconnecté (`236:5372`)

Same card anatomy as T5 with the **warn** tone:

- Pastille `warn-pale` with `icon/terminal` 24 (warn).
- `Claude Code n'est plus connecté à votre compte Claude` (SemiBold 20).
- `Le CLI officiel signale une connexion expirée. Les sessions en cours s'arrêteront à leur prochaine requête.`
- Facts: ✓ `Aucun identifiant n'est stocké par Nuera Dev : la reconnexion se fait dans le CLI.` ·
  ✓ `Les conversations restent enregistrées et reprenables après reconnexion.`
- Actions: `Se reconnecter dans un terminal` (compact **Principal**, terminal icon) · `Pourquoi ?` (compact Discret).

Behaviour (annotation): `Se reconnecter` opens a **web terminal on VPS-3** (PTY over WebSocket) that runs the CLI
login (`claude /login`). Nuera Dev never shows a token form and never stores credentials. Poll the CLI auth status and
dismiss the state once it is valid again. `Pourquoi ?` opens a short explanation (popover or help sheet, not designed).
Where: Accueil (Claude status), sidebar server card line `Claude Code connecté` → warn, Workspace (composer blocked),
Sessions. Show it as a page-level card where Claude is required; other pages show a warn banner (inference).

### 5.7 T7 · Autorisation expirée (`236:5401`)

Two columns (gap 20), each with an overline:

- `AVANT L'EXPIRATION` → `Dev · Bandeau` **Ton=Alerte**: `Autorisation GitHub bientôt expirée` /
  `Renouvelez l'accès avant le 12 novembre.` + `Renouveler` (compact Secondaire, no icon).
- `APRÈS L'EXPIRATION` → custom danger row (`Accès GitHub révoqué`, padding 14 × 16, `danger-pale`) with the **service
  icon** `icon/github` 18 (danger) instead of the alert icon: `L'accès GitHub a été retiré` /
  `Synchronisation, push et pull requests suspendus. Le travail local continue.` + `Réautoriser sur GitHub` (compact
  Secondaire, **external-link** icon).

Reusable: `<AuthExpiryBanner service="github"|"figma"|"coolify" status="expiring"|"expired" expiresAt />`.
`expiring` maps to the Alerte banner with `Renouveler`. `expired` maps to the Erreur look with the service icon and a
deep link to the provider (`Réautoriser sur …`). The same logic applies to every service (annotation): warn before,
say what stops after, link to the service that grants access.
Where: Accueil, Intégrations (cards + diagnostic), project detail. In the Workspace, disable push/PR with the reason.
"Bientôt" has no threshold in the design (open question).

### 5.8 T8 · Actions sensibles à confirmer (`236:5432`)

Three **confirmation dialogs** (width **520**, `--bg`, radius 28, padding 24, gap 16, `Shadow/Float`):

- Head (gap 12): Pastille 40 (square radius 12, tinted) + icon 20 + question title (Outfit SemiBold 18, `--text`).
- **Conséquences** (gap 8): rows of icon 16 + Outfit 13/18 `--text`. ✓ `icon/check` (success) = what is **kept**;
  ⚠ `icon/alert` (warn) = what **changes or is lost**.
- Optional extras: an option checkbox row and a list of affected resources.
- Actions right-aligned (gap 10): `Annuler` (Button Default) + the named action (Button **Accent**).

| Dialog | Pastille / icon | Consequences (verbatim, icon) | Extra | Buttons |
|---|---|---|---|---|
| `Arrêter « Module CRM · pipeline » ?` | warn-pale / `icon/stop` (warn) | ⚠ `Claude Code reçoit Échap puis s'arrête, même au milieu d'une étape.` · ✓ `Les fichiers modifiés et le worktree crm-core sont conservés.` · ✓ `La conversation reste reprenable depuis Sessions.` | — | `Annuler` · `Arrêter la session` |
| `Archiver Atelier Lune ?` | warn-pale / `icon/archive` (warn) | ✓ `Le projet quitte la liste ; il reste dans Archivés.` · ✓ `Le dépôt GitHub n'est jamais touché.` · ⚠ `1 session terminée sera archivée avec lui.` | **Option** row (1 px border, radius 12, padding 10 × 12, gap 10): checkbox 18 × 18 (`--bg`, 1 px border, radius 8), unchecked + `Supprimer aussi le clone de VPS-3 (2,1 Go)` | `Annuler` · `Archiver` |
| `Supprimer 2 worktrees inactifs ?` | **danger-pale** / `icon/trash` (danger) | ✓ `Libère 1,8 Go sur VPS-3.` · ⚠ `Un worktree avec des modifications non commitées est exclu d'office.` · ⚠ `Les sessions liées ne pourront plus être reprises.` | **Worktrees list** (1 px border, radius 12; rows padding 9 × 12, gap 10, separators): `icon/worktree` 15 · name JetBrains Mono Medium 12 · meta Outfit 12 · right badge. `contrastes` / `Site Nuera Studio · 21 oct.` / `Supprimé` (Neutre) · `next-16` / `Site Nuera Studio · 28 oct.` / `Supprimé` (Neutre) · `galerie-photos-v1` (name `--muted`) / `Atelier Lune · 2 fichiers non commités` (**warn** text) / `Exclu` (Alerte) | `Annuler` · `Supprimer 2 worktrees` |

Reusable: `<ConfirmDialog tone="warn"|"danger" icon title consequences={[{ kind: 'kept'|'risk', text }]} confirmLabel cancelLabel="Annuler" onConfirm>{extra}</ConfirmDialog>`.

- The confirm label **names the action** (`Arrêter la session`, `Archiver`, `Supprimer 2 worktrees`). Never use a
  generic "OK"/"Confirmer". The count in the label follows the eligible items.
- Accessibility: `role="alertdialog"`, title as `aria-labelledby`, consequences as `aria-describedby`. Esc and a Voile
  click cancel. Initial focus on `Annuler` (safer default, inference).
- While the mutation runs, the confirm button shows a loading state and both buttons are disabled. On success, close
  and show a toast (T3). On failure, show an error banner inside the dialog.
- The worktree dialog computes eligibility on the server: worktrees with uncommitted changes are automatically
  **excluded** (`Exclu`), and the deletable ones carry the neutral `Supprimé` badge (as rendered in Figma).
- **No typed confirmation** (type the name to confirm) is designed. Do not add one unless it is decided.
- **Destructive styling is open** (annotation + section 04 gap #1): every confirm uses Button **Accent** for now. If a
  `Danger` Button variant (`danger`/`danger-pale`) is adopted, use it for `Supprimer…` (and maybe `Arrêter…`).

Where: stop a session (Workspace header, Sessions list, Accueil), archive a project (Projets actions, D04), delete
inactive worktrees (D04 / Paramètres · serveur), `Désactiver partout` (D1 drawer, inference), and any irreversible git
action (discard changes, force push) that may appear later.

---

## 6. Data formats

- **Relative time** (French): `il y a 3 min`, `il y a 6 min`, `il y a 2 j` (short "j"), `il y a 1 semaine`,
  `il y a 3 semaines`, `il y a 1 mois`. The first repo row has the prefix `mis à jour`
  (`mis à jour il y a 2 j`), the others don't. Suggested buckets: < 1 h → `il y a N min`; < 24 h → `il y a N h`;
  < 7 j → `il y a N j`; < 5 sem. → `il y a N semaine(s)`; then `il y a N mois`.
- **Clock times**: `09:12` (24 h, `ce matin à 09:12`, `depuis 09:12`).
- **Dates**: `21 oct.`, `28 oct.` (short month with a dot), `12 novembre` (long month in sentences).
- **Sizes**: `84 Mo`, `2,1 Go`, `1,8 Go`, `RAM 5,1 / 16 Go`, `99 Go`. Decimal comma, SI-style French units. Raw tool
  output stays untouched (`84.2 Mio`, `100%`).
- **Durations**: `12 s`, `31 s`, `38 s`. **Percent**: `64 %`, `CPU 23 %` (space before `%`).
- **Counts with French plurals**: `12 dépôts`, `3 projets`, `1 projet`, `aucun projet`, `912 paquets`, `86 lignes`,
  `14 fichiers`, `2 fichiers non commités`, `1 session terminée`, `2 worktrees`. Use `Intl.PluralRules('fr')`.
- **Status vocabulary**: `Connecté`, `Autorisation expirée`, `Désactivé`, `Déjà cloné`, `en cours`, `en attente`,
  `non accordé`, `Supprimé`, `Exclu`, `Interrompue`, `code 1`.

## 7. Implied API surface (for the back end)

- `GET /api/github/repos?owner=&q=` → repos with `fullName, private, language, updatedAt, clonedProject`, counts per owner.
- `POST /api/projects` `{ repo, branch, name, destination, installDeps, worktreePerSession }`
  - `202 { cloneJobId }`
  - `409 DESTINATION_NOT_EMPTY { path, fileCount, existingClone, suggestedPath }` (A4)
- `GET /api/clone-jobs/:id/stream` (SSE): `{ percent, steps[{ key, status, sizeBytes?, elapsedSec }], log }` →
  final `{ projectId, path, branch, scripts, claudeMd, packages }` (A2/A3).
- `GET /api/integrations` (GitHub App + MCP servers + activations + diagnostics).
- `PATCH /api/mcp/:server/activations/:projectId { enabled }`.
- `POST /api/mcp/:server/check`.
- `POST /api/mcp/:server/disable-all`.
- `PUT /api/mcp/coolify/token { token }` (write-only, stored encrypted on VPS-3).
- `GET /api/health` (heartbeat for T5).
- `GET /api/claude/auth` (T6).
- `POST /api/terminal { command: 'claude /login' }` (T6).
- `POST /api/sessions/:id/stop` (send Esc to the tmux pane, then stop).
- `POST /api/projects/:id/archive { deleteClone }`.
- `GET /api/projects/:id/worktrees?inactive=1` and `DELETE /api/worktrees { ids }` (server re-checks for uncommitted changes).
- `POST /api/projects/:id/sync` (T1/T4).
- `POST /api/projects/:id/commands/:name/run` (T4 `Relancer`).

## 8. Open questions / decisions

1. **Destructive Button variant** for T8 (and section 04 gap #1). Accent everywhere for now. Adopt `Danger`?
2. **Typed confirmation**: not designed. Confirm that none is wanted (even for `Supprimer…`).
3. **Expiry threshold** for `bientôt expirée` (T7). Is the renewal in-app or always a deep link to the provider?
4. **Info banner icon** (T1): the variant uses the alert triangle in accent. Keep it, or use a refresh/info icon?
5. **`Nouvelle session` from the empty Sessions list** (T2): project picker or redirect to Projets?
6. **`Ouvrir le projet existant`** (A4): register the existing folder as a new project, or open an already known project?
7. **Clone cancel**: A2 has no cancel. Is the clone uncancellable by design?
8. **Drawer and dialogs on phone**: not designed in these frames. Suggestion: full-height sheet for MCP details and a
   bottom sheet for T8 with full-width stacked buttons, following the S4 sheet pattern.
9. **`gérer l'accès sur GitHub`** (A1 footer) is styled as plain text. Make it a link?
10. **Copy inconsistencies to confirm**: `mis à jour il y a 2 j` vs `il y a 1 semaine`; `Supprimé` (past tense) on
    worktrees that are about to be deleted.

## 9. Mobile notes for these states

- Touch targets: `Bouton compact` and `Dev · Interrupteur` need a 44 px hit area (component descriptions).
- Toasts sit **above the input/composer** on phone, not bottom-right.
- T5/T6 cards replace the page content but keep the bottom tab bar (`sans masquer la navigation`).
- A-flow on phone = `M03` full-screen stepper (top bar `Annuler`, step indicator, three-segment progress, bottom action bar).
- D drawers have no phone design. See `M07 · Intégrations` for the page; the drawer content can be reused as-is in a
  full-height sheet.

## 10. Capture notes

- `get_screenshot` does not upscale beyond 1×. The PNGs are therefore at native size (720-wide boards, 1440 desktop,
  1240/1520/2200 wide boards), not 2×.
- `A3.png` was saved from the `get_design_context` render (identical 720 × 651 native render) because one
  `get_screenshot` call hit the rate limit.
- `D2`: only the drawer (`234:5235`) was exported as code. The rest of the frame is identical to D1 (`234:4929` ≡
  `234:5129`, verified on the screenshot).
