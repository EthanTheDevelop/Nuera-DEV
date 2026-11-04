# Nuera — Design System (Figma → code), as used by Nuera Dev

> **Sources.** Figma file `nlvRWAtD1x2fKf8gVgcM0g`, page **Design System** (`1:834`) — sections Intro → 08 Logos, the `Button` component set and the site header/footer frames — plus the variables actually bound in **NUERA DEV — WEB APP** (`199:3`) and the **Nuera OS** components that Nuera Dev reuses as-is (`57:3`).
> **Companion file:** [`docs/figma/tokens.css`](./tokens.css) — Tailwind CSS v4 `@theme` + `:root` tokens with the exact Figma values and names.
> **Raw references:** `.design-refs/code/DS-*.tsx` (verbatim `get_design_context` output, Figma asset URLs replaced by local paths), `.design-refs/screens/DS-*.png`, `.design-refs/assets/{design-system,logos}/`.
> All French strings in `code` spans or quotes are **verbatim UI/canvas copy**. English is commentary.

---

## 0. Read me first

### 0.1 What this page is (and is not)

- The Design System page documents the **Nuera Studio marketing site** system: « Tout ce que le site applique, tiré du code (src/styles/tokens.css et DESIGN.md). » Its variables, effect styles and the `Button` component are the **foundation of Nuera Dev**: the canvas note `240:5890` (page 199:3) says Nuera Dev is « construit uniquement avec les variables existantes (Color, Spacing, Radius, App · statuts) et les styles Shadow/Soft et Shadow/Float ».
- What Nuera Dev **reuses as-is** (note `240:5890`, verbatim): « Button (Default, Accent) · Bouton compact (Principal, Secondaire, Discret) · Badge (les 6 tons, sauf ChatGPT) · Avatar · En-tête de tuile · 25 icônes de Nuera OS · Logo Nuera · mode Dark de la collection Color pour les zones de terminal. »
- What it does **not** reuse: the site's fluid display scale is barely used (app titles are hand-set 28/22/18… — §3.5), the site header/footer are marketing patterns (§10 lists only what transfers), Lenis/GSAP scroll effects, the paper grain.

### 0.2 Pseudo-screen index (this document's "screens")

| Code | Figma frame | Node | Size (px) | Screenshot | Raw code |
|---|---|---|---|---|---|
| DS-00 | `Intro` | `21:21` | 1440 × 657 | `DS-00-intro.png` | `DS-00-intro.tsx` |
| DS-01 | `01 Couleurs` | `21:22` | 1440 × 1660 | `DS-01-couleurs.png` | `DS-01-couleurs.tsx` |
| DS-02 | `02 Typographie` | `21:23` | 1440 × 2229 | `DS-02-typographie.png` | `DS-02-typographie.tsx` |
| DS-03 | `03 Espacement` | `21:24` | 1440 × 987 | `DS-03-espacement.png` | `DS-03-espacement.tsx` |
| DS-04 | `04 Rayons et ombres` | `21:25` | 1440 × 753 | `DS-04-rayons-ombres.png` | `DS-04-rayons-ombres.tsx` |
| DS-05 | `05 Mouvement` | `21:26` | 1440 × 803 | `DS-05-mouvement.png` | `DS-05-mouvement.tsx` |
| DS-06 | `06 Bouton` + component set `Button` | `21:27` + `7:117` | 1440 × 623 / 744 × 294 | `DS-06-bouton.png`, `DS-06-button-component-set.png` | `DS-06-bouton.tsx`, `DS-06-button-component-set.tsx` |
| DS-07 | `07 Téléphone et accessibilité` | `21:28` | 1440 × 569 | `DS-07-telephone-accessibilite.png` | `DS-07-telephone-accessibilite.tsx` |
| DS-08 | `08 Logos` | `29:21` | 1440 × 1054.5 | `DS-08-logos.png` | `DS-08-logos.tsx` |
| DS-09 | Site header / menus / footer (8 frames) | `30:454` `30:469` `30:572` `30:692` `30:808` `30:834` `30:854` `30:898` | 1440 × 138 … 390 × 476.5 | `DS-09a…g-*.png` | `DS-09-*.tsx` (3 files) |
| DS-10 | `Logo Nuera Dev · papier` / `· encre` (+ cover instance) | `201:41` / `201:80` / `241:5881` | 176 × 27.61 (cover ×1.4) | `DS-10-logo-nuera-dev-*.png` (+ `@4x`) | `DS-10-logo-nuera-dev.tsx` |
| DS-11 | Nuera OS `Badge`, `Bouton compact` | `57:124`, `168:6952` | 398 × 32, 319 × 68 | — (inline in context) | `DS-11-nuera-os-badge-bouton-compact.tsx` |

### 0.3 Token provenance (what is a real Figma variable, what is derived)

| Kind | Tokens | Evidence |
|---|---|---|
| **Figma variables** (bound, resolved by `get_variable_defs`) | colours `--bg --text --accent --muted --border --surface-raised --ink --paper --accent-on-light --accent-on-dark --accent-pale --near-black --muted-on-light --muted-on-dark --border-on-light --border-on-dark --hairline-on-dark --surface-raised-dark --btn-edge`; statuses `success success-pale success-on-dark warn warn-pale warn-on-dark danger danger-pale en-cours chatgpt chatgpt-pale`; `--space-1 … --space-32`; `--radius-sm … --radius-full` | nodes `21:22`, `21:24`, `21:25`, `5:102`, `205:422`, `220:2366`, `214:1424`, `203:373`, `57:13`… |
| **Figma styles** (text & effect styles, no variable) | `Display/Hero … Mono/Eyebrow`, `Script/Accent H2`, `Shadow/Soft`, `Shadow/Float` | style metadata of every DS frame |
| **CSS names written on the canvas** (code tokens of the site, not Figma variables) | `--text-6xl … --text-xs`, `--text-ui`, `--section-y`, `--gutter`, `--wrap-w`, `--wrap-narrow-w`, `--wrap-wide-w`, `--wrap-vast-w`, `--tap-min`, `--header-capsule-h`, `--shadow-soft`, `--shadow-float`, `--ease-*`, `--dur-*` | DS-02 … DS-05 labels |
| **Mentioned only in notes** | `--surface` (« surface et surface-raised valent toutes deux paper en mode Light ») | note `240:5900` |
| **Derived for code (proposed names, values from the canvas)** | `--text-script`, `--text-app-*`, `--tracking-*`, `--leading-*`, `--btn-lift-*`, `--btn-border-w`, `--btn-burst-overflow`, `--focus-ring-*`, `--paper-grain-opacity`, `--header-row-h`, `--app-*` shell sizes, Tailwind `--breakpoint-nav/desk`, `--container-*` | this document |

### 0.4 Canvas conventions shared by every DS frame (useful when reproducing any "documentation" page)

- Frame: `bg var(--bg)` (white), padding **96** on all sides → content width **1248**; section = vertical stack, gap **40**.
- Head block (gap **16**): eyebrow `Mono/Eyebrow` in `--accent` (e.g. `01 · Couleurs`) → title `Display/H2` in `--text` → lead `Text/Lead` in `--muted`, width **760**.
- Info cards: `bg var(--surface-raised)`, `1px solid var(--border)`, radius **20**, padding **24–28**, inner gap **8–14**.
- Big demo panels: radius **28** (`--radius-xl`), padding **36** (roles) or **48 × 40** (button demo).
- Notes: `Text/Body` in `--muted`, gap **10**, each line starts with `· ` (U+00B7 + space).

### 0.5 Copy & typography conventions

- Sections Intro → 07 use the straight apostrophe `'` (U+0027). Section **08 Logos** uses the typographic apostrophe `’` (U+2019): `aujourd’hui`, `n’est`, `n’a`, `qu’il`. Keep each string exactly as captured.
- Separators: `·` (U+00B7) surrounded by spaces; arrows `→` (U+2192) in ranges (`38 → 104 px`); spaces before `:`/`%` appear as plain spaces in the MCP exports (no U+00A0 / U+202F seen).

---

## 1. DS-00 · Intro — the three rules (`21:21`)

**Layout:** header stack gap **24**; three equal rule cards in a row (`flex: 1`, gap **24**); card = `--surface-raised`, `1px --border`, radius **20**, padding **28**, inner gap **12** (number `Mono/Eyebrow` `--accent` → title `Display/H4` `--text` → body `Text/Body` `--muted`). Title `Le système de design` uses `Display/H1`.

**Copy (verbatim):**

- Eyebrow: `NUERA STUDIO · SYSTÈME DE DESIGN`
- Title: `Le système de design`
- Lead: `Tout ce que le site applique, tiré du code (src/styles/tokens.css et DESIGN.md). Les variables Figma portent le nom CSS en code syntax : un token ici est un token là-bas.`
- `01` · `Aucune valeur en dur` — `Couleur, taille, espacement, rayon, courbe, durée : tout vient d'un token. Un besoin sans token, on ajoute le token, pas l'exception.`
- `02` · `Les rôles, pas les teintes` — `On écrit text, accent, muted, border, jamais ink ou le bleu. C'est ce qui permet à une section sombre de tout rebasculer seule.`
- `03` · `Jamais d'accent choisi à la main` — `Une section sombre (tone="dark") bascule l'accent toute seule : #4368b1 sur clair, #a6b9dd sur sombre.`

**Implementation consequences (binding for Nuera Dev):**

1. No hard-coded colour, size, spacing, radius, easing or duration in components: always a token from `tokens.css`. Missing token → add it to `tokens.css` first.
2. Components consume **role** tokens (`--text`, `--muted`, `--accent`, `--border`, `--bg`, `--surface-raised`), never primitives (`--ink`, `--accent-on-light`). Exceptions sanctioned by Figma itself: the `Button` (uses `--btn-edge`, `--paper`, `--accent-on-dark`), the logos, the status colours.
3. Dark areas are **scopes**, not restyled components: put `data-tone="dark"` (or `.tone-dark`) on the container (sidebar, terminal/command output, cover, dark toast) and every child flips (§2.2).

---

## 2. DS-01 · Couleurs (`21:22`)

Head: `01 · Couleurs` / `Couleurs` / `Trois teintes de marque, et rien d'autre : le bleu de nuit, le blanc, le bleu. Les autres valeurs en sont dérivées.`

### 2.1 Brand primitives (collection **Color**, identical in both modes)

| Swatch label (hex as shown) | Variable (code syntax) | Value | Intended usage (verbatim) |
|---|---|---|---|
| `#233353` | `--ink` | `#233353` | `Fonds sombres, texte sur clair` |
| `#FFFFFF` | `--paper` | `#ffffff` | `Fond du site, texte sur sombre` |
| `#4368B1` | `--accent-on-light` | `#4368b1` | `Accent sur clair` |
| `#A6B9DD` | `--accent-on-dark` | `#a6b9dd` | `Accent sur sombre` |
| `#DEE5F2` | `--accent-pale` | `#dee5f2` | `Aplats, fonds de badge` |
| `#141830` | `--near-black` | `#141830` | `Contour et ombre des boutons` |
| `#645E78` | `--muted-on-light` | `#645e78` | `Texte secondaire sur clair` |
| `#D9DADE` | `--border-on-light` | `#d9dade` | `Bordures sur clair` |

Additional primitives bound in the files (not drawn as swatches):

| Variable | Value | CSS | Usage |
|---|---|---|---|
| `--muted-on-dark` | `#ffffff9e` | `rgb(255 255 255 / 0.62)` | secondary text on dark (« muted 62 % ») |
| `--border-on-dark` | `#ffffff24` | `rgb(255 255 255 / 0.14)` | borders on dark (« border 14 % ») |
| `--hairline-on-dark` | `#ffffff1a` | `rgb(255 255 255 / 0.10)` | « filet 10 % » — capsule/panel outlines, dividers on ink (site header, mobile menu, Nuera Dev sidebar) |
| `--surface-raised-dark` | `#ffffff0d` | `rgb(255 255 255 / 0.05)` | « carte 5 % » — raised cards on ink (sidebar server card, dark example card) |
| `--btn-edge` | `#141830` | = near-black | Button socle, face outline and label (Default / On dark) |

### 2.2 Role tokens — Light (default) and Dark (`tone="dark"`) modes

Values below are the ones Figma resolves: Light from `21:22`/`205:422`, Dark from `5:102` (« Rôles — Dark ») and `203:373` (`Dev · Sortie de commande`, the terminal block).

| Role | Figma label & description (verbatim) | Light (« SUR LE PAPIER (PAR DÉFAUT) ») | Dark (« DANS UNE SECTION TONE="DARK" ») |
|---|---|---|---|
| `--bg` | — | `#ffffff` (= `--paper`) | `#233353` (= `--ink`) |
| `--text` | `--text` · `Texte principal` | `#233353` | `#ffffff` |
| `--accent` | `--accent` · `Accent : liens, eyebrows, détails` | `#4368b1` | `#a6b9dd` |
| `--muted` | `--muted` · `Texte secondaire` | `#645e78` | `#ffffff9e` (62 %) |
| `--border` | `--border` · `Bordures et filets` | `#d9dade` | `#ffffff24` (14 %) |
| `--surface-raised` | — | `#ffffff` | `#ffffff0d` (5 %) |
| `--surface` | — | `#ffffff` | *not captured* (never bound in Nuera Dev) |
| `--btn-edge` | — | `#141830` | `#141830` |

Example card copy on both panels: `01 · EXEMPLE` / `Un titre de section` / `Le texte courant prend --text, le secondaire --muted. Rien n'est recoloré à la main.`

CSS (already in `tokens.css`):

```css
:root { --bg: var(--paper); --text: var(--ink); --accent: var(--accent-on-light);
        --muted: var(--muted-on-light); --border: var(--border-on-light);
        --surface: var(--paper); --surface-raised: var(--paper); }
[data-tone="dark"], .tone-dark {
        --bg: var(--ink); --text: var(--paper); --accent: var(--accent-on-dark);
        --muted: var(--muted-on-dark); --border: var(--border-on-dark);
        --surface-raised: var(--surface-raised-dark); }
```

### 2.3 Status colours — collection « App · statuts » (Nuera OS, reused by Nuera Dev)

Figma names have **no** `--` code syntax (`success`, `warn`…); `tokens.css` exposes them as `--success`, `--warn`…

| Variable | Value | Role in Nuera Dev (observed) |
|---|---|---|
| `success` | `#2f6f4f` | success text/icons, `Ton=Succès` dot, diff additions text |
| `success-pale` | `#e4f1ea` | success badge/banner background, diff addition line background |
| `success-on-dark` | `#5fc48b` | success inside dark scopes (sidebar server status, toast on ink) |
| `warn` | `#8a6516` | alert text, `Ton=Alerte` |
| `warn-pale` | `#fbf1dc` | alert badge/banner background |
| `warn-on-dark` | `#f2c14e` | alert inside dark scopes (bound in the Nuera OS component section `57:13`; not found in the Nuera Dev frames sampled) |
| `danger` | `#b4451f` | errors, destructive confirmations text, diff deletions text |
| `danger-pale` | `#f8e6de` | error badge/banner background, diff deletion line background; **also errors inside the terminal** (gap #2 below) |
| `en-cours` | `#e0a10f` | "running" state (`Ton=En cours` status dot, `Statut=En cours`) |
| `chatgpt` | `#10a37f` | `Badge` tone ChatGPT only |
| `chatgpt-pale` | `#e3f5ef` | idem — « Le Badge ChatGPT est propre à ChatGPT ; il n'est jamais utilisé pour Claude. » |

### 2.4 Where each mode applies in Nuera Dev

- **App screens are Light**: `--bg`/`--surface-raised` `#ffffff`, `--text` `#233353`, `--border` `#d9dade` (variables of `205:422` D01, `220:2366` M01, `214:1424` D05…).
- **Dark scopes**: desktop sidebar `Dev · Barre latérale` (`201:431`; in D01 the 248 px column `205:423` is filled with **`--near-black` `#141830`**, not ink, and uses `--surface-raised-dark`, `--hairline-on-dark`, `--accent-on-dark`, `success-on-dark`, `--paper` text), terminal/command blocks (`203:373`: `--bg #233353` = ink, `--text #fff`, `--muted #ffffff9e`), the dark toast (`203:709`: `--near-black`, `--paper`, `--accent-on-dark`, `success-on-dark`, `Shadow/Float`) and the cover (`241:5880`, near-black presentation frame).
- Consequence: a near-black container (sidebar, toast) sets `background: var(--near-black)` explicitly **and** `data-tone="dark"` for its content roles; an ink container (terminal) just uses `bg-bg` inside the dark scope.
- Canvas note `240:5890`: « mode Dark de la collection Color pour les zones de terminal ».

### 2.5 Notes written on the canvas (verbatim)

- `· L'accent a deux valeurs, et ce n'est pas un doublon : #4368b1 tombe à 2.31 de contraste sur l'ink (sous le 3.0 de WCAG 1.4.11), #a6b9dd remonte à 6.35.`
- `· Gris secondaire #645e78 : 6.10 sur le papier, 4.86 sur accent-pale. Au-dessus du 4.5 AA pour du texte courant.`
- `· Le papier a un grain (bruit fractal statique, opacité 0.22) : le fond réellement vu est environ six niveaux sous #FFFFFF. Choisir une couleur en regardant le rendu, pas le token.`
- `· Sur sombre, les variantes sont des blancs transparents : muted 62 %, border 14 %, filet 10 %, carte 5 %.`

Contrast table derived from these notes: `#4368b1`/ink **2.31** (fails 3.0 → never accent-on-light on ink), `#a6b9dd`/ink **6.35**, `#645e78`/paper **6.10**, `#645e78`/accent-pale **4.86**. The grain is a **site** effect; no Nuera Dev frame draws it (flat `#ffffff`).

### 2.6 Gaps the designer asked to arbitrate (note `240:5900`, verbatim)

`1. Pas de variante destructive du Button : les confirmations (arrêter, archiver, supprimer) utilisent Accent. Proposer une variante Danger avec les jetons danger / danger-pale. 2. Pas de jeton danger-on-dark : les erreurs dans le terminal (mode Dark) utilisent danger-pale. À créer à côté de warn-on-dark et success-on-dark. 3. surface et surface-raised valent toutes deux paper en mode Light : les fonds de champs et de blocs se distinguent par une bordure, pas par une teinte. 4. Aucun style de texte n'est appliqué dans les écrans de Nuera OS (tailles posées à la main) : Nuera Dev suit la même échelle (28, 22, 18, 16, 14, 13, 12, 11) ; une rampe de styles « App » serait à formaliser. 5. Le Badge ChatGPT est propre à ChatGPT ; il n'est jamais utilisé pour Claude.`

### 2.7 Canvas details of the section (for reproduction)

- Swatch cards (×8, wrap, gap **16**): width **296**, `--surface-raised`, `1px --border`, radius **20**, overflow clip; colour block height **140**; meta block padding `20 20 22`, gap **6**: hex in `Display/H4` `--text`; token name in JetBrains Mono 12, tracking 2.4px (0.2em), **not** uppercased, `--accent`; usage `Text/Label` `--muted`.
- Role panels (2 × flex 1, gap **24**): radius **28**, padding **36**, gap **20**; each role row = 36 px circle (fill = role colour, 1 px stroke `#d9dade` on light / white 14 % on dark — assets `.design-refs/assets/design-system/*.svg`) + label `Text/UI` (15/700) and description `Text/Label` `--muted`, gap 16 / 2.

---

## 3. DS-02 · Typographie (`21:23`)

Head: `02 · Typographie` / `Typographie` / `Quatre polices, quatre rôles, aucun recouvrement. L'échelle est fluide : chaque pas va du téléphone (390 px) à l'ordinateur (1440 px).`

### 3.1 Font families

| Role | Family | Load it with | Weights to load for Nuera Dev | Canvas notes (verbatim) |
|---|---|---|---|---|
| Display (titrage) | **Gesty Ratio** — *not available*; Figma and every mockup use **Outfit Bold (700)** instead | not on Google Fonts/Fontsource (demo licence) → use Outfit 700 via `--font-display` | Outfit 700 | `GESTY RATIO` · `Aa Titres` · `Titres et gros textes. Une seule graisse (400) : jamais de gras, on joue sur la taille. Licence démo, à régulariser avant la mise en ligne. Absente de Figma : Outfit Bold la remplace ici et dans les maquettes. Installer Gesty Ratio puis changer la famille des styles Display.` |
| Everything else | **Outfit** | `next/font/google` → `Outfit` (variable, 100–900) · Fontsource `@fontsource-variable/outfit` | 400, 500, 600, 700 (DS allows 300–900) | `OUTFIT` · `Aa Tout le reste` · `Corps, nav, boutons, labels. Graisses 300 à 900.` |
| Script accent | **Pinyon Script** | `next/font/google` → `Pinyon_Script` (`weight: "400"` only) · Fontsource `@fontsource/pinyon-script` | none — no Nuera Dev frame uses it (site only) | `PINYON SCRIPT` · `Unique` · `Un ou deux mots dans un titre, jamais une phrase. Corps x1.12, interlettrage +0.015em. Fonte d'accent en cours de choix (labo).` |
| Mono | **JetBrains Mono** | `next/font/google` → `JetBrains_Mono` (variable, 100–800) · Fontsource `@fontsource-variable/jetbrains-mono` | 400, 500, 700 | `JETBRAINS MONO` · `01 · Eyebrow` · `Les eyebrows, et rien d'autre. Capitales, 0.2em.` |

**Mono usage — DS vs. Nuera Dev.** On the site, mono = eyebrows only. Nuera Dev deliberately extends it to *machine data*: repository slugs (`nuera-studio/roux-conseil`, 13 px Medium), branches (`feature/crm-core`, `main`), paths (`/srv/dev/roux-conseil`), commands and terminal output, durations/sizes/metrics (`84 Mo · 12 s`, `CPU 23 %  ·  RAM 5,1 / 16 Go`), uppercase table headers (`PROJET`, `BRANCHE`, `SYNCHRONISATION`, 11 px, 0.08em) and the `DEV` badge (12 px Bold, 0.08em). Prose is never mono.

### 3.2 Text styles (Figma styles = desktop sizes; collection « Type » holds the phone/desktop modes)

Letter-spacing values in Figma are percentages (`-4` = -4 % = -0.04em; `20` = 0.2em).

| Figma style | Token | Phone 390 → Desktop 1440 | Family / weight | Line-height | Tracking | Case | Role (verbatim spec line) |
|---|---|---|---|---|---|---|---|
| `Display/Hero` | `--text-6xl` | 38 → **104** | Outfit 700* | 1.06 | -0.04em (-4.16px @104) | — | `38 → 104 px · Hero, interlettrage -0.04em` — sample `Build a standout site` |
| `Display/H1` | `--text-5xl` | 44 → **80** | Outfit 700* | 1.06 | -0.03em (-2.4px) | — | `44 → 80 px · h1, -0.03em, interligne 1.06` — `Titre de page` |
| `Display/H2` | `--text-4xl` | 36 → **56** | Outfit 700* | 1.06 | -0.03em (-1.68px) | — | `36 → 56 px · h2, titres de section` — `Titre de section` |
| `Display/H3` | `--text-3xl` | 30 → **44** | Outfit 700* | 1.06 | -0.02em (-0.88px) | — | `30 → 44 px · h3, -0.02em` — `Sous-titre fort` |
| `Display/H4` | `--text-2xl` | 24 → **32** | Outfit 700* | 1.06 | -0.02em (-0.64px) | — | `24 → 32 px · h4` — `Titre de carte` |
| `Text/XL` | `--text-xl` | 20 → **24** | Outfit 400 | 1.25 | 0 | — | `20 → 24 px · Interligne 1.25` — `Texte mis en avant` |
| `Text/Lead` | `--text-lg` | 17 → **20** | Outfit 400 | 1.25 | 0 | — | `17 → 20 px · Chapô, interligne 1.25` — `Un chapô qui pose le sujet.` |
| `Text/Body` | `--text-base` | **16** | Outfit 400 | 1.6 | 0 | — | `16 px · Corps, interligne 1.6` — `Le texte courant du site, en Outfit.` |
| `Text/UI` | `--text-ui` | **15** | Outfit **700** | 1.25 | 0 | — | `15 px · Nav et boutons, graisse 700` — `Prendre rendez-vous` |
| `Text/Label` | `--text-sm` | **14** | Outfit 400 | 1.25 | 0 | — | `14 px · Labels` — `Un label de champ` |
| `Text/Caption` | `--text-xs` | **12** | Outfit 400 | 1.6 | 0 | — | `12 px · Mentions légales` — `Mentions légales · 2026` |
| `Mono/Eyebrow` | `--text-xs` | **12** | JetBrains Mono 400 | 1.25 | **0.2em** (2.4px) | UPPERCASE | `12 px · Mono, capitales, 0.2em` — `01 · Le sujet` |
| `Script/Accent H2` | `--text-script` (derived) | **63** (= 56 × 1.125) | Pinyon Script 400 | 1.06 | **+0.015em** (0.945px) | — | the script word inside a H2 — `Unique` |

\* Display styles should be Gesty Ratio 400; Outfit 700 is the stand-in used everywhere in Figma — implement Outfit 700.

Fluid formula (identical for every step and for `--section-y`/`--gutter`): `size = min + (max − min) × (100vw − 390px) / 1050px`, clamped. Exact `clamp()` strings are in `tokens.css` (e.g. `--text-6xl: clamp(2.375rem, 0.8429rem + 6.2857vw, 6.5rem)`).

### 3.3 Rules written on the canvas (verbatim)

- `· Interlignes : 1.06 pour le titrage, 1.25 pour les sous-titres, 1.6 pour le corps.`
- `· Le titrage se resserre en grossissant : -0.02em (titres), -0.03em (h1, h2), -0.04em (hero). Le corps reste à 0.`
- `· L'anglaise ne prend JAMAIS l'interlettrage du titrage : resserrée, ses liaisons s'écrasent. Toujours +0.015em, corps x1.12 (plage 1.05 à 1.25).`
- `· Utiliser un pas de l'échelle plutôt qu'une taille inventée. Les styles Figma sont aux tailles ordinateur ; la collection Type donne les deux modes.`

Example of the mixed title on the footer (`30:903`): `Parlons de votre ` in Outfit Bold 36/38.2, -0.72px + `Projet` in Pinyon Script **40.4** (= 36 × 1.12), +0.61px (0.015em), same line-height.

### 3.4 CSS recipes

```css
.eyebrow  { font: 400 var(--text-xs)/var(--leading-subtitle) var(--font-mono);
            letter-spacing: var(--tracking-eyebrow); text-transform: uppercase; color: var(--accent); }
.h-hero   { font: 700 var(--text-6xl)/var(--leading-display) var(--font-display); letter-spacing: var(--tracking-hero); }
.h1       { font: 700 var(--text-5xl)/var(--leading-display) var(--font-display); letter-spacing: var(--tracking-display); }
.h2       { font: 700 var(--text-4xl)/var(--leading-display) var(--font-display); letter-spacing: var(--tracking-display); }
.h3       { font: 700 var(--text-3xl)/var(--leading-display) var(--font-display); letter-spacing: var(--tracking-title); }
.h4       { font: 700 var(--text-2xl)/var(--leading-display) var(--font-display); letter-spacing: var(--tracking-title); }
.script   { font-family: var(--font-script); font-weight: 400; font-size: 1.12em; letter-spacing: var(--tracking-script); }
/* Tailwind equivalents: text-6xl font-display · text-xs font-mono uppercase tracking-eyebrow leading-subtitle text-accent */
```

### 3.5 Nuera Dev app ramp (hand-set sizes, observed in the 199:3 code exports)

Gap #4 says no text style is applied in the app screens; the designer's ramp is « 28, 22, 18, 16, 14, 13, 12, 11 ». The exports also contain 26, 20, 15 and 10. **Line-height is Figma "Auto" → CSS `normal`** unless stated. Counts = occurrences in the `.design-refs/code` exports available at capture time (D01–D05, D1, D2-tiroir, M01–M08, W1–W3, S1–S5, T1–T8, A1–A4); D06–D08 and W4–W7 follow the same ramp per the canvas note.

| Size (token) | Family · weight (count) | Line-height | Typical use (verbatim samples) |
|---|---|---|---|
| 28 (`--text-app-28`) | Outfit 600 | normal | desktop page title: `Bonjour Nezar`, `Projets`, `Nuera OS`, `Intégrations` |
| 26 (`--text-app-26`) | Outfit 600 | normal | phone page title: `Bonjour Nezar`, `Projets`, `Sessions`, `Paramètres` |
| 22 (`--text-app-22`) | Outfit 600 | normal | dialog / drawer title: `Ajouter un projet`, `Choisir un dépôt` |
| 20 (`--text-app-20`) | Outfit 600 (8) | normal | occasional block titles (the 28× Outfit 400/20 are the iOS keyboard keys of S1, not UI) |
| 18 (`--text-app-18`) | Outfit 600 (16), 500 (7) | normal | card / tile titles |
| 16 (`--text-app-16`) | Outfit 600 (37) | normal | row and item titles |
| 15 (`--text-ui` / `--text-app-15`) | Outfit 700 lh 1.25 (30) = Button label; Outfit 600 (37) | 1.25 / normal | `Button` labels; emphasised UI text |
| 14 (`--text-app-14`) | Outfit **500** (146), 400 (100, incl. 29 with **lh 20px** for paragraphs), 600 (52) | normal / 20px | nav entries, field labels, compact buttons (500); descriptions (400) |
| 13 (`--text-app-13`) | Outfit 400 (117, incl. 43 with **lh 18px**), 500 (50), 600 (40); JetBrains Mono 500 (15) | normal / 18px | secondary text; repo slugs and branch names in mono 500 |
| 12 (`--text-app-12`) | JetBrains Mono 400 (168), Outfit 500 (85), Outfit 400 (101), JBM 500 (41), JBM 700 (45) | normal | paths/branches/commands (mono), `Badge` labels (Outfit 500), `DEV` badge (JBM 700, 0.96px) |
| 11 (`--text-app-11`) | JetBrains Mono 400 (304, of which 45 uppercase at **0.88px = 0.08em**), Outfit 500 (28), JBM 700 (14), Outfit 600 (12) | normal | meta (`84 Mo · 12 s`, `en cours · 31 s`, `en attente`), table headers (`PROJET`, `BRANCHE`, `ACTIVITÉ`, `DERNIÈRE INSTRUCTION`) in `--muted` |
| 10 (`--text-app-10`) | Outfit 600 (12), JBM 500 (10) | normal | tab-bar `Compteur` bubble (`2`, `--paper` on `--accent`, pill, padding 1 × 5) |

Mono labels always use **0.08em** tracking (0.88px @11, 0.96px @12; the canvas section markers `Repère · …` use 1.12px @14) → `--tracking-label`.

---

## 4. DS-03 · Espacement et mise en page (`21:24`)

Head: `03 · Espacement et mise en page` / `Espacement et mise en page` / `Base 4 px. Rester sur ces pas garde le rythme vertical d'une section à l'autre.`

### 4.1 Spacing scale (collection **Spacing**; Figma variable `space/N`, code syntax `--space-N`)

| Token | px | Tailwind step (default `--spacing: 0.25rem`) |
|---|---|---|
| `--space-1` | 4 | `1` |
| `--space-2` | 8 | `2` |
| `--space-3` | 12 | `3` |
| `--space-4` | 16 | `4` |
| `--space-5` | 20 | `5` |
| `--space-6` | 24 | `6` |
| `--space-7` | 28 | `7` |
| `--space-8` | 32 | `8` |
| `--space-10` | 40 | `10` |
| `--space-12` | 48 | `12` |
| `--space-16` | 64 | `16` |
| `--space-20` | 80 | `20` |
| `--space-24` | 96 | `24` |
| `--space-32` | 128 | `32` |

(Only these 14 steps exist. Off-scale values seen in Figma such as 2, 6, 22, 13 and 26 belong to component internals: label gaps 2, compact-button gap 6, swatch meta padding-bottom 22, Button face padding 13 × 26.)

### 4.2 Layout tokens (verbatim descriptions)

| Token | Value | Description (verbatim) |
|---|---|---|
| `--section-y` | 88 → 152 px (fluid) | `Respiration d'une section, posée en haut ET en bas : entre deux blocs, le blanc vaut le double.` |
| `--gutter` | 20 → 40 px (fluid) | `Gouttière latérale.` |
| `--wrap-w` | 1200 px | `Largeur de contenu standard.` |
| `--wrap-narrow-w` | 760 px | `Colonne de lecture : au-delà, la ligne fatigue.` |
| `--wrap-wide-w` | 1320 px | `Surfaces seulement (cartes pleine largeur, visuels), jamais du texte.` |
| `--wrap-vast-w` | 1560 px | `Grilles de trois cartes riches.` |
| `--tap-min` | 44 px | `Cible tactile minimale (WCAG 2.5.5).` |
| `--header-capsule-h` | 64 px | `Capsule du header accostée. Ligne du logo : 138 px.` |

Rule (verbatim): `· Section gère le vertical, Wrap l'horizontal. Jamais les deux au même endroit : c'est ce qui permet d'imbriquer sans doubler un padding.`
→ In code: a `<Section>` owns `padding-block: var(--section-y)`; a `<Wrap>` owns `max-width` + `padding-inline: var(--gutter)`; never both on one element.

### 4.3 Grid and breakpoints

From the DS (§8): phone **designed at 390, holds to 320**; tablet corrections **below 1024**; mobile navigation **below 900**; desktop frames **1440**. `tokens.css` exposes `nav:` (≥ 900 px = 56.25rem), `lg:` (≥ 1024), `desk:` (≥ 1440) and `max-w-wrap|narrow|wide|vast`.

Nuera Dev shell geometry (observed in 199:3, see the screen specs for details):

| Region | Desktop 1440 | Phone 390 |
|---|---|---|
| Navigation | `Dev · Barre latérale` **248** wide, full height 1120, dark scope filled `--near-black` | `Dev · Barre d'onglets` 390 × **91** (5 tabs, includes home-indicator area) |
| Workspace navigation | `Dev · Barre latérale repliée` **72** wide | no tab bar |
| Content | x = 248, width **1192**, padding **32** left/right, **28** top | full width |
| System chrome (mock) | — | `Dev · Barre d'état` 390 × **47** (→ `env(safe-area-inset-top)`), `Dev · Indicateur d'accueil` 390 × **34** (→ `env(safe-area-inset-bottom)`) |

Recommended mapping: tab bar + phone layout below `nav` (900 px), sidebar from `nav` up; tablet tweaks below `lg`.

---

## 5. DS-04 · Rayons et ombres (`21:25`)

Head: `04 · Rayons et ombres` / `Rayons et ombres`.

### 5.1 Radii (collection **Radius**)

| Token | Value | Usage (verbatim) | Uses in Nuera Dev exports |
|---|---|---|---|
| `--radius-sm` | 8 px | `Champs, petits badges` | 293 |
| `--radius-md` | 12 px | `Boutons` | 409 |
| `--radius-lg` | 20 px | `Cartes, capsule du header` | 80 |
| `--radius-xl` | 28 px | `Grands blocs` | 47 |
| `--radius-full` | 999 px | `Pilules` | 368 |

Non-token radii seen in app frames: 4 px (gauge bars `Barre`/`Remplissage`), 3 px (`Pastille` dots), 2 px (spacing squares on the DS canvas), 5 px (duration bars on the DS canvas), 11 px (one-off). Treat 4/3 as component internals.

Canvas specimen: 120 px tall rectangles, `bg --accent-pale`, `1.5px solid --accent`, labels `--radius-sm · 8 px` (Text/UI) + usage (Text/Label `--muted`).

### 5.2 Shadows (effect styles; colour = near-black `#141830`)

| Style | Token | Figma effect | Exact CSS | Description (verbatim) |
|---|---|---|---|---|
| `Shadow/Soft` | `--shadow-soft` | DROP_SHADOW `#14183047`, offset (0, 14), radius 34, spread -22 | `box-shadow: 0 14px 34px -22px rgb(20 24 48 / 0.28);` | `--shadow-soft · 0 14 34 -22, near-black 28 %. Décolle une carte du papier, ne la fait jamais léviter.` |
| `Shadow/Float` | `--shadow-float` | DROP_SHADOW `#1418308C`, offset (0, 24), radius 50, spread -18 | `box-shadow: 0 24px 50px -18px rgb(20 24 48 / 0.55);` | `--shadow-float · 0 24 50 -18, near-black 55 %. Ce qui flotte au-dessus de la page.` |

Usage in Nuera Dev exports: Soft ×67 (cards, tiles, session cards), Float ×19 (menus, popovers, toasts, dialogs).
One-off shadows outside the styles (to replace by a token or add one): site header capsule `0 24px 50px 0 rgb(20 24 48 / .55)` (Float without spread), site dropdown `filter: drop-shadow(0 24px 25px rgb(20 24 48 / .55))`, and in app frames `0 6px 16px 0 rgba(0,0,0,.25)`, `0 16px 40px 0 rgba(20,23,48,.25)`, `0 12px 32px 0 rgba(20,23,48,.22)` (one occurrence each — see the owning screen spec).

---

## 6. DS-05 · Mouvement (`21:26`)

Head: `05 · Mouvement` / `Mouvement` / `Une seule famille de courbes. Une animation qui réclame une courbe absente d'ici est presque toujours une animation à revoir.`

### 6.1 Curves (`COURBES`)

| Token | Value | Role (verbatim) |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | `--ease-out · Entrées : la signature du site` |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | `--ease-in-out · Aller-retours` |
| `--ease-emphasis` | `cubic-bezier(0.32, 0.72, 0, 1)` | `--ease-emphasis · Morphings d'interface` |
| `--ease-steady` | `cubic-bezier(0.4, 0, 0.2, 1)` | `--ease-steady · Progressions régulières` |

### 6.2 Durations (`DURÉES`)

| Token | Value | Role (verbatim) |
|---|---|---|
| `--dur-instant` | 60 ms | `60 ms · --dur-instant · Retour au clic` |
| `--dur-fast` | 180 ms | `180 ms · --dur-fast · Survols` |
| `--dur-base` | 350 ms | `350 ms · --dur-base · Transitions d'état` |
| `--dur-reveal` | 750 ms | `750 ms · --dur-reveal · Révélations au scroll (600 à 900)` |
| `--dur-slow` | 900 ms | `900 ms · --dur-slow · Remplissage de la capsule du header` |

(Canvas bars: width = ms ÷ 4, height 10, radius 5, `--accent`.)

### 6.3 Notes (verbatim)

- `· Le défilement est piloté par Lenis, jamais par scroll-behavior: smooth.`
- `· Tout effet a une version prefers-reduced-motion : ce qu'une animation cache doit rester visible sans elle.`
- `· GSAP est le moteur par défaut ; motion ne sert qu'au burst du bouton.`

### 6.4 What animates in Nuera Dev (mapping; the app has no scroll storytelling)

| Interaction | Duration | Curve |
|---|---|---|
| Button face lift on hover / drop on press | `--dur-fast` / `--dur-instant` | `--ease-out` |
| Hover backgrounds, colour changes, chevrons, nav-roll | `--dur-fast` | `--ease-out` |
| Open/close of menus, popovers, sheets, drawers, dialogs; tab switches; toast in/out | `--dur-base` | `--ease-out` (enter) / `--ease-in-out` (round trips) |
| Sidebar ↔ collapsed rail, panel resizes, accordion height morphs | `--dur-base` | `--ease-emphasis` |
| Progress bars, clone progress, gauges (CPU/RAM/disk), streaming indicators | linear to data, transitions `--dur-base` | `--ease-steady` |

Lenis and GSAP are site concerns; Nuera Dev can use CSS transitions only (and `motion` only if the button burst is kept). Native scrolling inside terminal/output panes must stay unmodified.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important;
                           transition-duration: 1ms !important; scroll-behavior: auto !important; }
}
```
(« ce qu'une animation cache doit rester visible sans elle » → never rely on an animation to reveal content.)

---

## 7. DS-06 · Bouton (`21:27`, component set `7:117`) and the reused compact controls

Head copy (verbatim): `06 · Bouton` / `Bouton` / `Deux éléments : un socle near-black et une face levée de 0.22em au-dessus. Au survol la face monte à 0.38em, au clic elle redescend à 0.04em. Texte en Outfit 700, 15 px, rayon 12.`
Caption under the demo: `Clic : la face descend. Survol : elle monte. La version sombre se pose sur un fond tone="dark".`
Component description (verbatim): `Bouton du site (src/components/ui/Button). Default sur clair neutre, Accent sur fond clair, On dark dans une section sombre. Couper le burst près d'un bord : ses rayons débordent de 26 px.`
Sample label in every variant: `Prendre rendez-vous`.

### 7.1 Anatomy (Figma `Button`, 199 × 54 per symbol)

```
Button (wrapper, padding-top = reserve)          ← keeps the outer box 54 px tall in every state
└─ Edge  (bg --btn-edge #141830, radius 12, padding-bottom = visible edge, overflow clip)   ← the "socle"
   └─ Face (border 1.5px --btn-edge, radius 12, padding 13 × 26, bg per variant)
      └─ Label (Outfit 700 15/1.25, colour per variant, nowrap)
```

| State | Wrapper padding-top | Edge padding-bottom (visible socle) | Spec in em (of 15 px) |
|---|---|---|---|
| `Rest` | 3 | 3 | lift **0.22em** (3.3 px) |
| `Hover` | 0 | 6 | lift **0.38em** (5.7 px) |
| `Pressed` | 5 | 1 | lift **0.04em** (0.6 px) |

| Variant | Face background | Label colour | Where (verbatim intent) |
|---|---|---|---|
| `Default` | `--paper` `#ffffff` | `--btn-edge` `#141830` | « Default sur clair neutre » |
| `Accent` | `--accent` (`#4368b1` on light) | `--paper` `#ffffff` | « Accent sur fond clair » |
| `On dark` | `--accent-on-dark` `#a6b9dd` | `--btn-edge` `#141830` | « On dark dans une section sombre » |

Symbol ids: Default `7:81`/`7:85`/`7:89`, Accent `7:93`/`7:97`/`7:101`, On dark `7:105`/`7:109`/`7:113` (Rest/Hover/Pressed). Nuera Dev uses **Default and Accent** (note `240:5890`); its confirmations (arrêter, archiver, supprimer) use **Accent** until a Danger variant exists (gap #1).

### 7.2 Exact CSS

```css
.btn {                                    /* = Edge (socle) + wrapper */
  --btn-face: var(--paper);
  --btn-label: var(--btn-edge);
  --btn-lift: var(--btn-lift-rest);       /* 0.22em */
  position: relative;
  display: inline-flex;
  margin-top: var(--btn-lift-hover);      /* reserve the max lift (0.38em): outer height ≈ 54 px like Figma */
  padding: 0;
  border: 0;
  border-radius: var(--radius-md);        /* 12px */
  background: var(--btn-edge);            /* #141830 */
  font: 700 var(--text-ui) / 1.25 var(--font-sans);   /* Text/UI 15/1.25 */
  color: var(--btn-label);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.btn__face {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  padding: 13px 26px;                     /* Figma py 13 / px 26 → face height 47.75 */
  border: var(--btn-border-w) solid var(--btn-edge);   /* 1.5px */
  border-radius: var(--radius-md);
  background: var(--btn-face);
  white-space: nowrap;
  transform: translateY(calc(-1 * var(--btn-lift)));
  transition: transform var(--dur-fast) var(--ease-out);
}
@media (hover: hover) { .btn:hover { --btn-lift: var(--btn-lift-hover); } }      /* 0.38em */
.btn:active { --btn-lift: var(--btn-lift-pressed); }                             /* 0.04em */
.btn:active .btn__face { transition-duration: var(--dur-instant); }              /* « Retour au clic » */
.btn:focus-visible { outline: var(--focus-ring-w) solid var(--accent); outline-offset: var(--focus-ring-offset); }
.btn--accent  { --btn-face: var(--accent);         --btn-label: var(--paper); }    /* light scopes only */
.btn--on-dark { --btn-face: var(--accent-on-dark); --btn-label: var(--btn-edge); } /* inside data-tone="dark" */
@media (prefers-reduced-motion: reduce) { .btn__face { transition: none; } }
```

Markup: `<button class="btn btn--accent"><span class="btn__face">Libellé</span></button>`. Never use `.btn--accent` inside a dark scope (`--accent` becomes `#a6b9dd` and white text fails contrast) — that is what `On dark` is for.
**Not designed in Figma:** disabled, loading and danger states (gap #1), icon placement (none in the set). Proposal pending design: Danger = `--btn-face: var(--danger)`, `--btn-label: var(--paper)`; disabled = no lift (`--btn-lift: 0`), `cursor: not-allowed`, label `--muted`.
**Burst:** only « ses rayons débordent de 26 px » and « motion ne sert qu'au burst du bouton » are specified; rays geometry is not on the canvas. Optional for Nuera Dev; if implemented, keep 26 px clearance from container edges.

### 7.3 Coded variant seen in the site header/footer (`30:569`, `30:904`) — differences to know

Face border **1px** (not 1.5), height 42.5 (face) with the same 3.3 px (= 0.22em) offset, label Outfit 700 15 px with **line-height 15px** and **tracking 0.15px** (0.01em), left padding 26.3. The footer button stacks two labels in an 18 px-high clipped box — `Prendre rendez-vous` then `30 minutes suffiront !` — i.e. a label **roll** on hover. Full-width version on phone (332 wide). The DS component (§7.2) is the reference for Nuera Dev.

### 7.4 `Bouton compact` (Nuera OS `168:6952`, reused as-is)

Description (verbatim): `Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code.`
Props: `style` = `Principal | Secondaire | Discret`, `avecIcone` (default true), `libelle` (default `Valider`), `icone` (16 px, stroke 1.8, round caps; default `icon/check`).

```css
.btn-compact { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 36px;
               padding: 0 14px 0 12px; border-radius: var(--radius-md);
               font: 500 14px/normal var(--font-sans); white-space: nowrap; }
.btn-compact::after { content: ""; position: absolute; inset: -4px 0; }   /* 44 px hit area (« Zone cliquable 44 px en code ») */
.btn-compact svg { width: 16px; height: 16px; flex: none; }
.btn-compact--principal  { background: var(--accent); color: var(--paper); }
.btn-compact--secondaire { background: var(--paper); color: var(--ink); border: 1px solid var(--border-on-light); }
.btn-compact--discret    { background: none; color: var(--accent); padding: 0; }   /* Figma: no padding, no fill */
```
Hover/pressed/disabled are not designed for this component (only `Rest`).

### 7.5 `Badge` (Nuera OS `57:124`, reused as-is, « les 6 tons, sauf ChatGPT »)

Pill, `padding: var(--space-1) var(--space-2)` (4 × 8), `border-radius: var(--radius-full)`, label Outfit **500** 12/normal (≈ 23 px tall), no border.

| `ton` | Background | Text |
|---|---|---|
| `Accent` | `--accent-pale` `#dee5f2` | `--accent` `#4368b1` |
| `Succes` | `success-pale` `#e4f1ea` | `success` `#2f6f4f` |
| `Alerte` | `warn-pale` `#fbf1dc` | `warn` `#8a6516` |
| `Danger` | `danger-pale` `#f8e6de` | `danger` `#b4451f` |
| `Neutre` | `--surface-raised` `#ffffff` | `--muted` `#645e78` |
| `ChatGPT` | `chatgpt-pale` `#e3f5ef` | `chatgpt` `#10a37f` — **never for Claude** |

---

## 8. DS-07 · Téléphone et accessibilité (`21:28`)

Head: `07 · Téléphone et accessibilité` / `Téléphone et accessibilité` / `Le téléphone a sa propre composition, pas une réduction du bureau.`

Notes (verbatim):

- `· Téléphone conçu à 390 px, tenu jusqu'à 320 px. Tablette corrigée sous 1024 px ; le bureau, lui, ne voit rien de la couche mobile.`
- `· Le menu mobile prend la main sous 900 px.`
- `· Une rangée de cartes devient un rail : défilement aimanté, aperçu de la carte suivante, pastilles d'indication. C'est ce qui remplace le survol au toucher.`
- `· Toute cible tactile fait au moins 44 px de côté.`
- `· Un texte coloré se mesure : viser 4.5 pour le texte courant, 3.0 pour les éléments d'interface. Les mesures vivent à côté de la couleur.`
- `· Le lien d'évitement reste le premier élément focusable ; l'anneau de focus fait 2 px, décalé de 3 px.`

Implementation rules:

```css
:focus-visible { outline: var(--focus-ring-w) solid var(--accent); outline-offset: var(--focus-ring-offset); } /* 2px / 3px; colour = role accent (flips on dark) — colour not specified in Figma */
.skip-link { position: absolute; left: var(--space-4); top: var(--space-4); transform: translateY(-200%); z-index: 100; }
.skip-link:focus-visible { transform: none; }
/* every interactive element: min-width/min-height var(--tap-min) (44px) — visual size may be smaller (compact button 36, switch 36×20, 8 px status dots) with an invisible hit area */
.rail { display: flex; gap: var(--space-4); overflow-x: auto; scroll-snap-type: x mandatory;
        padding-inline: var(--gutter); scroll-padding-inline: var(--gutter); }
.rail > * { scroll-snap-align: start; flex: 0 0 calc(100% - 3 * var(--gutter)); } /* next card peeks; add dot indicators */
```

- The phone layer must not leak into desktop: phone-only components (tab bar, sheets, rails) are mounted below the `nav` breakpoint only.
- Safe areas: replace the mock status bar (47) and home indicator (34) by `env(safe-area-inset-top|bottom)`; the tab bar pads its bottom with the inset.
- Contrast: never `--accent-on-light` text on ink (2.31); use roles so dark scopes switch to `#a6b9dd` (6.35). Skip-link label is not in Figma (to define).

---

## 9. DS-08 · Logos (`29:21`)

Copy (verbatim): `08 · Logos` / `Logos` / `Le logotype et les icônes tels que le site les utilise aujourd’hui (Wordmark.tsx, icon.svg). Le logo définitif n’est pas encore choisi : ces fichiers seront remplacés le jour venu.`
Card captions: `Logotype · encre sur papier` · `Logotype · papier sur bleu de nuit (header, hero)` · `Logotype · accent sur bleu de nuit` · `Le N ruban seul` · `Favicon (src/app/icon.svg) : 128, 64, 32 et 16 px`.
Rules (verbatim):

- `· Le logotype suit la couleur du texte de son contexte : il n’a jamais de couleur figée.`
- `· Le N chevauche le u : le jour entre eux est un vrai trou, pas un contour. Il laisse voir le fond, quel qu’il soit.`
- `· Hauteur dans le header : 32 px au bureau, 21 à 25 px au téléphone.`

### 9.1 Asset map (`.design-refs/assets/logos/`, Figma names kept)

| File | What it is |
|---|---|
| **`derived/nuera-wordmark.currentColor.svg`** | **The "nuera" wordmark, ready to use**: 298 × 60.5 viewBox, `fill="currentColor"`, luminance mask punching the N/u gap. Derived mechanically from the Figma export `ecbfffbf-…svg` (background rects removed, `#233353` → `currentColor`). Use this as `Wordmark`. |
| `ecbfffbf-c60a-45a0-abc5-24416f5a331a.svg` | Figma SVG export of the wordmark frame `29:26` (contains canvas background rects — reference only) |
| `e3aebfd9-…svg` / `89a0bab0-…svg` / `72319d13-…svg` | the **N ribbon** alone, 67.963 × 58.527 — ink / white / `#A6B9DD` |
| `4a5da6ea-…svg` / `bf88f2d0-…svg` / `7e632b63-…svg` | the **"uera"** letters, 237.963 × 58.414 — ink / white / `#A6B9DD` |
| `5346c4c0-…svg` | the **luminance mask** (white rect + black N stroked 10.99) applied to "uera" |
| `ea91e066-8917-48c0-ad1e-dd677970715b.svg` | **monogram** « Le N ruban seul », 120 × 106, ink |
| `234180ff-…svg` · `d7907293-…svg` · `980fe3a9-…svg` · `14d11bd8-…svg` | **favicon / app icon** 128 · 64 · 32 · 16 px: rounded square `#233353` (radius 24 / 12 / 6 / 3 = 18.75 %) + N in `#A6B9DD` |
| `ef44cf12-…` `f830e97f-…` `c5c933dc-…` | Nuera Dev logo · papier pieces (136-wide wordmark: N white, mask, "uera" white) |
| `3e41258c-…` `04b31d89-…` `0bba99b1-…` | Nuera Dev logo · encre pieces (ink) |
| `13293d43-…` `5f0d013b-…` `266899a3-…` | cover instance pieces (×1.4) |
| `4bf062b4-…svg` / `42519c2a-…svg` | Figma SVG exports of `Logo Nuera Dev · papier` / `· encre` (DEV text outlined; canvas rects included — reference only) |

### 9.2 Wordmark construction and sizes

- Box 298 × 60.5 (ratio **4.926**). N at (0.5, 1.27); "uera" at (59.66, 1.27); "uera" is masked by the N outline (stroke 10.99 in the 298 box ≈ **3.7 % of the width**) so the gap is a real hole showing the background.
- Colour = `currentColor` (ink on paper, paper on ink in header/hero, `--accent-on-dark` on ink as the accent version).
- Sizes in use: site header desktop **157.8 × 32**, phone **103.5 × 21** (rule: 21–25 px), Nuera Dev sidebar/inline **136 × 27.61**, Nuera Dev cover **190.4 × 38.66**.
- `aria-label="Nuera"` (or `Nuera Dev` when combined with the badge); the derived SVG carries `role="img"`.

### 9.3 Nuera Dev logo & the `DEV` badge (answer to "how is the cover badge built")

Components `Logo Nuera Dev · papier` (`201:41`, for dark backgrounds) and `Logo Nuera Dev · encre` (`201:80`, for light backgrounds), 176 × 27.61. Description (verbatim): `Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction que la pastille OS de Nuera OS).`

- Horizontal flex, `align-items: center`, gap **`--space-2` (8 px)**: wordmark **136 × 27.611** + badge.
- Badge `DEV`: padding **2 px × `--space-1` (4 px)**, radius **`--radius-sm` (8 px)**, overflow clip → ≈ 32 × 20 px; text **JetBrains Mono Bold (700) 12 px**, line-height normal, letter-spacing **0.96 px (0.08em)**, uppercase glyphs typed as `DEV`.
- Colours: **papier** = badge `--accent-on-dark` `#a6b9dd` + text `--near-black` `#141830`, wordmark white; **encre** = badge `--accent` `#4368b1` + text `--paper` `#ffffff`, wordmark `#233353`.
- Same construction as Nuera OS's `OS` pill (`91:4094`, 24 × 20 at y 3.8).
- **Cover (`241:5880`)**: instance `241:5881` of the *papier* variant, **uniformly scaled ×1.4** (245.8 × 38.655): wordmark 190.4 × 38.66, gap 11.2, badge text 16.8 px with 1.344 px tracking, padding 2.8 × 5.6, radius 11.2. In code: render the same component with a scale factor (e.g. `font-size`-driven em values) rather than a different design.

```tsx
// sketch — sizes in em so the cover can scale the whole lock-up
<span className="inline-flex items-center gap-[0.667em] text-[12px]">           {/* 8px gap at 12px */}
  <Wordmark className="h-[2.301em] w-auto" />                                     {/* 27.61px */}
  <span className="rounded-[0.667em] px-[0.333em] py-[0.167em] font-mono font-bold tracking-[0.08em]
                   bg-accent-on-dark text-near-black">DEV</span>                  {/* papier variant; 8px radius at 12px */}
</span>
```

---

## 10. DS-09 · Site header, menus and footer — reusable patterns only

Frames: `Header — sur le hero (bureau)` `30:454` (no capsule fill, logo only), `Header — accosté (bureau)` `30:469`, `Header — menu Services ouvert` `30:572`, `Header — menu Ressources ouvert` `30:692`, `Footer — bureau` `30:808`, `Header — téléphone` `30:834`, `Menu téléphone — ouvert` `30:854`, `Footer — téléphone` `30:898`. Marketing copy (`Services`, `Réalisations`, `Ressources`, `Tarifs`, `Prendre rendez-vous`, menu items) is **not** Nuera Dev UI.

| Pattern | Exact values | Reuse in Nuera Dev |
|---|---|---|
| **Dark capsule surface** | `bg --ink`, `1px solid --hairline-on-dark`, height `--header-capsule-h` 64, radius `--radius-lg` 20, shadow `0 24px 50px 0 rgb(20 24 48/.55)`; capsule fills in over `--dur-slow` when the header docks (« accosté ») | look of dark floating bars/panels |
| **Dropdown / popover panel** | 580 wide, 12 px below its trigger, `bg --ink`, `1px --hairline-on-dark`, radius 20, `drop-shadow(0 24px 25px rgb(20 24 48/.55))`, padding 24; items 88 tall with a radius-12 hover surface outset by 12 px; title Outfit 600 20/25 -0.4px `--paper`; description Outfit 400 14/17.5 `--muted-on-dark` | dark menus (the app's light menus use Shadow/Float instead) |
| **Nav roll-over** | link label Outfit 500 15/24, -0.07px, drawn twice in a 24 px clipped box → letters roll up on hover (`--dur-fast`, `--ease-out`); chevron 10 × 6.7 stroke 1.33 round, rotates 180° when open | optional micro-interaction |
| **Phone header** | row 72, wordmark 21 px high inside a 44 px hit area, toggle = 44 × 44 circle (radius 22) `--ink` + `1px --hairline-on-dark`, two 18 × 2 bars (radius 1) at y 16 / 24 | 44 px icon buttons on dark |
| **Phone sheet menu** | 366 × 706.5 (12 px side margins), scroll area from y 57, list inset 16 / 8; entries 60 tall, Outfit 700 30.2/32 -0.6px `--paper`, separators `border-top 1px --hairline-on-dark`; accordion sub-links 101 tall (Outfit 600 20/25 + 16/24 `--muted-on-dark`), chevron 14 × 9.3 stroke 1.87 (180° when open), direct links end with an arrow 14 × 10.5 stroke 1.4; full-width CTA pinned at the bottom | sheet rhythm, separators, accordion rows |
| **Footer legal grid (phone)** | links in a 2-column grid of **175 × 44** targets, Outfit 14/17.5 `--muted-on-dark`; copyright `© 2026 Nuera Studio. Tous droits réservés.` and `Conçu et développé en France.` 12/15; `English` 12/15 `--paper` after a `·` | 44 px targets for small links |
| **Two-label button roll** | `Prendre rendez-vous` / `30 minutes suffiront !` stacked in an 18 px clip | optional |
| **Seal** | scalloped outline (stroke `#A6B9DD`), 604.8 desktop / 320 phone, opacity .45, rotate 38°, bleeding over the section above | site only |

Raw code: `DS-09-header-accoste-bureau.tsx`, `DS-09-nav-menu-and-mobile-menu.tsx`, `DS-09-header-footer-telephone.tsx`; assets in `.design-refs/assets/design-system/site-header/`.

---

## 11. Using `tokens.css` with Tailwind v4 + Next.js

```ts
// src/app/layout.tsx
import { Outfit, JetBrains_Mono } from "next/font/google";
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });          // 100–900 variable
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" }); // 100–800 variable
// <html lang="fr" className={`${outfit.variable} ${mono.variable}`}>
```

```css
/* src/app/globals.css */
@import "tailwindcss";
@import "./tokens.css";             /* copy of docs/figma/tokens.css */
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); }
```

- **Roles → utilities** (`@theme inline`, resolved per element so dark scopes flip): `bg-bg`, `text-text`, `text-muted`, `text-accent`, `border-border`, `bg-surface-raised`; statuses `text-success bg-success-pale`, `text-warn bg-warn-pale`, `text-danger bg-danger-pale`, `bg-en-cours`; primitives `bg-ink`, `text-paper`, `bg-accent-on-dark`, `text-near-black`, `border-hairline-on-dark`.
- **Scales** (`@theme static`, also available as plain `var()`): `rounded-sm|md|lg|xl|full` (8/12/20/28/999), `shadow-soft|float`, `ease-out|in-out|emphasis|steady`, `text-6xl … text-xs`, `text-ui`, `text-script`, `text-app-28 … text-app-10`, `tracking-hero|display|title|script|eyebrow|label`, `leading-display|subtitle|body`, `max-w-wrap|narrow|wide|vast`, breakpoints `nav:` (900) `lg:` (1024) `desk:` (1440).
- Durations have no Tailwind namespace: `duration-(--dur-fast)`, `transition-[transform] duration-(--dur-instant)`.
- Spacing: Tailwind's default `--spacing: 0.25rem` equals the DS 4 px base, so `p-4` = `--space-4`, `gap-6` = `--space-6`; use `var(--space-N)` in plain CSS.
- Dark scope: `<pre data-tone="dark" className="bg-bg text-text">` → ink background (terminal), white text, `#a6b9dd` accent automatically; the sidebar is `<aside data-tone="dark" className="bg-near-black text-text">` (its fill is near-black, not ink); `tone-dark:` variant exists for the rare exception.
- Optional strictness: uncomment `--color-*: initial;` in `tokens.css` to delete Tailwind's default palette (enforces « Aucune valeur en dur »).

---

## 12. Open points and known gaps

1. **Gesty Ratio** (display face) is unavailable; Outfit 700 is the documented stand-in everywhere — keep it unless the licence is settled.
2. `--surface` Dark value not captured (never bound in Nuera Dev). `--danger-on-dark` does not exist (gap #2).
3. Focus-ring **colour** is not specified (only 2 px / 3 px) — `--accent` recommended.
4. No disabled/loading/danger states for `Button`; no hover/pressed for `Bouton compact`; skip-link copy absent.
5. The « Type » collection's per-mode variables were not exposed by the MCP (`get_variable_defs` returns only the text styles); phone sizes come from the canvas spec lines (`38 → 104 px`…), which is what `tokens.css` encodes.
6. Screenshot of `Footer — téléphone` (`30:898`) could not be captured cleanly: a child at y −8469 inflates the render bounds to 449 × 8672. Use `DS-09e-footer-bureau.png` + the raw code file. `Header — sur le hero` (`30:454`) contains only the logo (its nav layer is empty in Figma).
7. `30:808` (footer desktop), `30:454`, `30:692` were captured as screenshots only (same patterns as the exported frames).
