# Workspace survey — existing style guide & components Nuera Dev must reuse

> Source of truth: Figma file **Nuera Design** — file key `nlvRWAtD1x2fKf8gVgcM0g`.
> Survey date: 2026-11-04. Scope: pages **Sandbox** (`0:1`), **Website Mockups** (`1:835`), **Nuera OS** (`57:3`), **Nuera OS · Prototype** (`59:3`), plus the parts of **Design System** (`1:834`) and **NUERA DEV — WEB APP** (`199:3`) needed to say *what is reused*.
> All UI copy below is **verbatim French** from Figma (keep accents, `’` vs `'`, `·`, `«  »`, `…` exactly as written; see §4.1 and §7 item 1 — the two pages do not use the same apostrophe).
> Raw `get_design_context` outputs: `.design-refs/code/SURVEY-*.tsx` · assets: `.design-refs/assets/survey/SURVEY-*` · screenshots: `.design-refs/screens/survey-*.png`.

---

## 0. TL;DR — the reuse contract

The NUERA DEV page itself states the contract on canvas, in **“Note · Extensions et lacunes”** (`240:5890`, section `199:8` “04 — Extensions to Existing Components”). Verbatim (this note uses straight apostrophes):

> **Extensions au système de design**
> Tout ce qui est ici est local à cette page et construit uniquement avec les variables existantes (Color, Spacing, Radius, App · statuts) et les styles Shadow/Soft et Shadow/Float. Aucun composant maître de Nuera OS ou du Design System n'a été modifié.
>
> **RÉUTILISÉS TELS QUELS**
> Button (Default, Accent) · Bouton compact (Principal, Secondaire, Discret) · Badge (les 6 tons, sauf ChatGPT) · Avatar · En-tête de tuile · 25 icônes de Nuera OS · Logo Nuera · mode Dark de la collection Color pour les zones de terminal.
>
> **DÉRIVÉS DE NUERA OS**
> Dev · Barre latérale (instance détachée de la Barre latérale de Nuera OS, entrées et carte serveur remplacées) · Logo Nuera Dev (pastille DEV, construction de la pastille OS) · Dev · Interrupteur (dessin de l'interrupteur des Réglages, passé à l'accent).
>
> **CRÉÉS POUR NUERA DEV**
> Barre latérale repliée, Barre d'onglets, Barre d'état, Indicateur d'accueil, Point de statut, Champ · Message (instruction, Claude), Ligne d'outil, Sortie de commande, Demande d'autorisation (bureau et téléphone), Plan de travail, Compositeur, Ligne de diff, Fichier modifié, Carte de session, Ligne de projet, Ligne d'historique, Bandeau, Toast.
>
> **LACUNES À ARBITRER**
> 1. Pas de variante destructive du Button : les confirmations (arrêter, archiver, supprimer) utilisent Accent. Proposer une variante Danger avec les jetons danger / danger-pale.
> 2. Pas de jeton danger-on-dark : les erreurs dans le terminal (mode Dark) utilisent danger-pale. À créer à côté de warn-on-dark et success-on-dark.
> 3. surface et surface-raised valent toutes deux paper en mode Light : les fonds de champs et de blocs se distinguent par une bordure, pas par une teinte.
> 4. Aucun style de texte n'est appliqué dans les écrans de Nuera OS (tailles posées à la main) : Nuera Dev suit la même échelle (28, 22, 18, 16, 14, 13, 12, 11) ; une rampe de styles « App » serait à formaliser.
> 5. Le Badge ChatGPT est propre à ChatGPT ; il n'est jamais utilisé pour Claude.

(Code: `SURVEY-00-note-extensions-et-lacunes.tsx`.)

**What this means for the codebase**

| Build once, in `components/ui` (shared primitives) | Figma source | Survey code |
|---|---|---|
| `Button` (variants `default`, `accent`; `on-dark` exists but unused by Dev) — 3-D “edge” press | Design System `7:117` | SURVEY-05 |
| `CompactButton` (`principal`, `secondaire`, `discret`) | Nuera OS `168:6952` | SURVEY-04 |
| `Badge` (tones `accent`, `succes`, `alerte`, `danger`, `neutre`; **no** `chatgpt` in Dev) | Nuera OS `57:124` | SURVEY-02 |
| `Avatar` (initials) | Nuera OS `57:125` | SURVEY-01 (embedded) |
| `TileHeader` (“En-tête de tuile”: 28 px pastille + title) | Nuera OS `57:130` | SURVEY-03 |
| `Icon` set (Nuera OS 38 glyphs + 37 Dev glyphs) | `57:13` row + `199:8` row | §5.13 |
| `Logo` (Nuera · papier/encre → Nuera Dev · papier/encre) | `62:367`/`68:1214`/`90:4084`/`90:4098` → `201:41`/`201:80` | §5.12 |
| `Sidebar` (derive from Nuera OS sidebar) | `57:578` → Dev `201:732` | SURVEY-01 |
| `Switch` (derive Réglages toggle, ON = accent) | `67:979` → Dev `202:459` | SURVEY-07 |
| Overlay primitives: `Dialog` (Fenêtre) + `Scrim` (Voile), `Menu`, `FloatingPanel` | `141:7330`, `141:6794`, `88:2784`, `67:1564` | SURVEY-11/09/10 |
| Patterns: data `Table`, list toolbar (search + chips), page header, KPI card, dashboard tile grid, thread + composer, login card | `87:2341`, `87:2327`, `58:242`, `100:5730`, `58:261`, `63:569`, `88:3061` | SURVEY-13/15/08/14/17 |

No Nuera component or variable is published as a library: `get_libraries` lists only community kits (Material 3 Design Kit, Simple Design System, iOS and iPadOS 26/27, watchOS 26, visionOS 26, macOS 26/27) and `search_design_system` returns nothing for “Bouton compact”, “Barre latérale”, “accent-pale”. **All Nuera components are local to this file** and none of the community kits is instantiated by Nuera OS or Nuera Dev. Code Connect is not set up.

---

## 1. Page inventory

| Page | Node | Content | Relevance to Nuera Dev |
|---|---|---|---|
| Sandbox | `0:1` | Brand/logo exploration board (180 top-level nodes): sections “Laning parfaite”, “Création de website”, “INSPI”; device mock-ups (“iPad Mockup Dark”, “MacBook”, “3D Render - iphone”); logo studies (“Complete Logo”, “PRIMARY”, “SECONDARY”, “submark ”, “favicon”, “Logo Design Concept Color”, “Logo Design Concept B/W”, “nuera txt logo”, kerning tests “original”, “-10px” … “-55px”, “-20 pixel perfect”); colour notes; informal chat notes. Only 1 instance (“Place your design here”). | Brand history only. No UI component. See §8. |
| Design System | `1:834` | Website design system: Intro, 01 Couleurs, 02 Typographie, 03 Espacement, 04 Rayons et ombres, 05 Mouvement, 06 Bouton (component `Button` `7:117`), 07 Téléphone et accessibilité, 08 Logos, site headers/footers. | **Tokens + Button** reused (documented by the Design System spec; key rules recalled in §3/§4). |
| Website Mockups | `1:835` | Marketing site, 11 pages × Bureau 1440 / Téléphone 390 (22 frames, ~9 000 nodes, 0 component instances). | Not documented (out of scope by instruction). Brand look only. See §8. |
| **Nuera OS** | `57:3` | The agency back-office app (“Nuera OS”) — **the workspace app Nuera Dev descends from**: section “Composants de l’app” (`57:13`), 24 team screens, 9 client-space screens (C1–C9), 4 frozen motion instants (M1–M4), 15 motion notes. | **Primary source** of reused components & patterns (§4–§5). |
| **Nuera OS · Prototype** | `59:3` | “Tuiles vivantes (composants)” (`59:4`, 6 tile families × 3 sizes) + “Prototype · Tableau de bord vivant” (`59:481`). | Tile resize behaviour reference for the Dev home (§5.8). |
| NUERA DEV — WEB APP | `199:3` | The app to build (documented in the other spec files). | Consumer of everything above. |

### 1.1 Nuera OS frame index (page `57:3`)

All team screens are 1440 × 1120 = `Barre latérale` instance (248) + content column (1192).

| Node | Frame | Patterns worth reusing |
|---|---|---|
| `58:152` | 01 · Tableau de bord | page header, 6-column tile grid, tiles, “Ajouter une tuile” empty tile |
| `63:398` | 02 · Messages | 3-pane layout (list 340 / thread 552 / side panel 300), bubbles, AI suggestion card, composer |
| `65:542` | 03 · Pipeline | kanban columns + 172-px cards |
| `66:704` | 04 · Fiche client | detail page with cards (“Carte · Projet · Site vitrine”, “Carte · Historique”, “Carte · Contact”…) |
| `67:845` | 05 · Réglages · Connexions | Badge-chip tabs, connection cards, **Interrupteur** (toggle) |
| `67:1104` | 06 · Tableau de bord · mode édition | edit mode, “Bouton · Retirer la tuile”, floating right panel “Galerie de tuiles” |
| `87:1921` | 07 · Clients | table (`87:2049`) |
| `87:2215` | 08 · Projets | list toolbar (search + chips), **Tableau** (`87:2341`), chart card |
| `87:2469` | 09 · Devis | table + editor |
| `87:2699` | 10 · Sites et CMS | site cards, “Ouvrir Coolify”, “Voir le site”, “Ouvrir le CMS” buttons |
| `88:2147` | 11 · Support | kanban of requests |
| `88:2315` | 12 · Automatisations | rule rows with **Interrupteur** |
| `88:2543` | 13 · Menu du profil (ouvert) | **Menu** popover over a **Voile** |
| `88:2840` | 14 · Personnaliser son profil | form, notification toggles |
| `88:3060` | 15 · Connexion de l’équipe | **login card** on near-black |
| `100:4397` | 16 · Reporting | KPI cards (“Carte · null” ×4), charts, period tabs |
| `100:4782` | 17 · Projet · Atelier Lune | milestones card, tasks |
| `100:5170` | 18 · Temps et capacité | KPI cards, capacity charts |
| `100:5562` | 19 · Site · kine-rive-gauche.fr | KPI cards, availability, backups, “Déployer”, “Ouvrir dans Coolify” |
| `100:5932` | 20 · Contrats et abonnements | KPI cards, maintenance log |
| `101:5299` | 21 · Finances et rentabilité | KPI cards (“Carte · chiffre”) |
| `101:5672` | 22 · Équipe | cards |
| `101:5945` | 23 · Documents et connaissances | templates, checklists, knowledge base |
| `101:6288` | 24 · Administration et sécurité | users/permissions/**sensitive-actions log** tables, connection status list, “Réversibilité” |
| `68:1215`…`89:3326` | C1 · E-mail d’invitation, C2 · Connexion, C3 · Espace client · Mon projet, C4 · Espace client · Messages, C5 · Espace client · Menu du profil, C6 · Espace client · Documents, C7 · Espace client · Mon site, C8 · Espace client · Mon profil, C9 · Lien expiré | client portal (dark capsule header “En-tête client”), expired-link state |
| `138:6073`, `138:6515`, `141:6485`, `141:6999` | M1 · 01 Tableau de bord · arrivée, instant 0,9 s · M2 · 16 Reporting · onglet Revenus récurrents, survol d’octobre · M3 · 19 Site · fenêtre Santé du site ouverte · M4 · 17 Projet · tâche ouverte, commentaire avec mention | frozen motion instants; M3/M4 show the **Fenêtre + Voile** overlay |

Screenshots saved: `survey-os-01-tableau-de-bord.png`, `survey-os-02-messages.png`, `survey-os-05-reglages-connexions.png`, `survey-os-06-mode-edition.png`, `survey-os-08-projets.png`, `survey-os-13-menu-du-profil.png`, `survey-os-15-connexion-equipe.png`, `survey-os-24-administration.png`, `survey-os-M4-fenetre-tache.png`, `survey-os-composants-de-l-app.png` (whole components section, 2400 px), `survey-proto-tableau-de-bord-vivant.png`.

### 1.2 “Composants de l’app” (`57:13`, 4819 × 2012) — the component library of Nuera OS

| Node | Component | Kind / variants |
|---|---|---|
| `57:19`…`57:111` (row y=60) | 25 icons: `icon/dashboard`, `messages`, `pipeline`, `clients`, `projets`, `devis`, `sites`, `support`, `automatisations`, `reglages`, `search`, `bell`, `plus`, `sparkle`, `send`, `calendar`, `check`, `edit`, `minus`, `link`, `euro`, `server`, `clock`, `chevron`, `paperclip` | 24 × 24 symbols |
| `99:3206`…`99:3251`, `172:6957` (row y=20) | 13 icons: `icon/chart`, `contrat`, `book`, `shield`, `equipe`, `wallet`, `flag`, `rocket`, `globe2`, `database`, `alert`, `download`, `micro` | 24 × 24 symbols |
| `57:124` | **Badge** | `Ton=Accent \| Succes \| Alerte \| Danger \| Neutre \| ChatGPT` |
| `57:125` | **Avatar** | single (prop `initiales`) 36 × 36 |
| `57:127` | **Poignée de taille** | single 22 × 22 (tile resize handle) |
| `57:130` | **En-tête de tuile** | single 300 × 28 (props `icone`, `titre`) |
| `57:578` | **Barre latérale** | `Actif=` 17 values (see SURVEY-01) |
| `62:367` / `68:1214` | **Logo Nuera · papier** / **Logo Nuera · encre** | 136 × 27.6 |
| `90:4084` / `90:4098` | **Logo Nuera OS · papier** / **Logo Nuera OS · encre** | 168 × 27.6 (logo + “OS” pastille) |
| `69:1289` | **En-tête client** | `Actif=Mon projet \| Messages \| Documents \| Mon site \| Aucun` (1440 × 104) |
| `137:6040` | **Note · Mouvement** | canvas annotation (props Repère, Titre, Texte) |
| `150:6910` | **Bouton · Retirer la tuile** | single 24 × 24 |
| `168:6952` | **Bouton compact** | `Style=Principal \| Secondaire \| Discret` |

Usage counts across the Nuera OS page: Badge 276, Avatar 100, En-tête de tuile 96, Poignée de taille 48, Barre latérale 27, Bouton · Retirer la tuile 12, Design System `Button` 76 (54 px high; renamed “Bouton · <libellé>” or left as “Button”), Bouton compact 24 (36 px, renamed “Bouton · <libellé>”, client space).
Usage counts on the NUERA DEV page (top-level instances): Badge 185, Bouton compact 104 (+ 7 renamed “Bouton · …” and stretched to 44 px × full width on phone), Design System `Button` 35 (54 px), En-tête de tuile 17, icons (see §5.13).

---

## 2. App shell anatomy (Nuera OS → Nuera Dev desktop)

```
┌──────────── 1440 ─────────────────────────────────────────────────────────┐
│ Barre latérale 248 │ Content column 1192                                  │
│ near-black #141830 │ bg --bg (#fff), padding 28 top / 32 sides (space-7/8)│
│ pt 20 px16 pb16    │ ┌ Page header (1128 wide) ───────────────────────┐   │
│ gap 16             │ │ Title 28 SemiBold ink  ·  subtitle 14 muted    │   │
│ Logo               │ │                         [bell 36] [Btn] [Btn]  │   │
│ Recherche  ⌘K      │ └────────────────────────────────────────────────┘   │
│ Navigation groups  │ gap 24 (space-6)                                      │
│ … flexible spacer  │ Body (cards / table / tile grid 6 × 168, gutter 24)   │
│ Utilisateur card   │                                                       │
└────────────────────┴───────────────────────────────────────────────────────┘
```

- **Page header** (`58:242`, 1128 × 62; `67:945`, `87:2315`): left stack gap 4 — title Outfit SemiBold 28 `--ink`; subtitle Outfit Regular 14 `--muted` (+ optional Badge Neutre, e.g. dashboard “Mardi 3 novembre 2026 · l'agence aujourd'hui” + Badge “Données d'exemple”). Right: optional 36 × 36 “Notifications” square with 18-px `icon/bell`, then Design System `Button` Default then Accent (gap 12). Examples: “Bonjour Nezar” / “Modifier le tableau” + “+ Nouvelle affaire”; “Projets” / “4 projets · 1 en retard · charge 14 / 18 journées” / “Vue calendrier” + “+ Nouveau projet”; “Administration et sécurité” / “Comptes, rôles, journal des actions sensibles, connexions et export des données” / “Exporter les données” + “+ Inviter un utilisateur”.
- **Body**: vertical gap 24; cards 1128 wide or grids of 264/360/380/552/728/748-wide cards with 24 gutters (multiples of the 168/24 grid).
- **Overlays** sit on a full-frame **Voile** (light veil) — §5.10.
- Nuera Dev keeps this shell (Dev · Barre latérale 248, collapsed 72) — see the Dev desktop spec for exact Dev values.

---

## 3. Tokens observed in Nuera OS (resolved in Light mode)

Collected with `get_variable_defs` on `57:13`, `58:152`, `141:6999`. Figma variables carry CSS code syntax (`var(--name)`), except the status collection **“App · statuts”** whose variables have **no code syntax** (they appear as bare names: `success`, `warn`…). Recommendation: expose them as `--success`, `--warn`, … in CSS (the generated code already references `var(--success,#2f6f4f)` etc.).

### 3.1 Colour (collection “Color”, mode Light)

| Token | Value | Role (Design System wording where available) |
|---|---|---|
| `--ink` | `#233353` | “Fonds sombres, texte sur clair” (brand night blue) |
| `--text` | `#233353` | “Texte principal” |
| `--paper` | `#ffffff` | “Fond du site, texte sur sombre” |
| `--bg` | `#ffffff` | page / card background |
| `--surface-raised` | `#ffffff` | = paper in Light (lacune 3) — Badge Neutre fill, gauge track, menu hover, table header |
| `--accent` | `#4368b1` | “Accent : liens, eyebrows, détails” (= `--accent-on-light`) |
| `--accent-on-dark` | `#a6b9dd` | “Accent sur sombre” — sidebar labels, “OS” pastille |
| `--accent-pale` | `#dee5f2` | “Aplats, fonds de badge” — icon pastilles, avatars, Badge Accent, Note · Mouvement |
| `--near-black` | `#141830` | “Contour et ombre des boutons” — sidebar, client capsule, login page |
| `--btn-edge` | `#141830` | Button edge/border/label |
| `--muted` | `#645e78` | “Texte secondaire” (= `--muted-on-light`) |
| `--border` / `--border-on-light` | `#d9dade` | “Bordures et filets” |
| `--muted-on-dark` | `#ffffff9e` (white 62 %) | also the **Voile** fill |
| `--border-on-dark` | `#ffffff24` (white 14 %) | separators on dark |
| `--hairline-on-dark` | `#ffffff1a` (white 10 %) | active sidebar item, “Prochaine action” pill |
| `--surface-raised-dark` | `#ffffff0d` (white 5 %) | sidebar search, user card, dark pills |

Design System rule (layer text, `5:132`): “Sur sombre, les variantes sont des blancs transparents : muted 62 %, border 14 %, filet 10 %, carte 5 %.”
The collection also has a **Dark** mode (used by Nuera Dev “pour les zones de terminal”); its resolved values are not exposed by the Light-mode screens surveyed here — read them from the Dev terminal frames / Design System colour page.

### 3.2 Status colours (collection “App · statuts”, no code syntax)

| Name | Value | Pale | On dark |
|---|---|---|---|
| success | `#2f6f4f` | success-pale `#e4f1ea` | success-on-dark `#5fc48b` |
| warn | `#8a6516` | warn-pale `#fbf1dc` | warn-on-dark `#f2c14e` |
| danger | `#b4451f` | danger-pale `#f8e6de` | — (missing, lacune 2) |
| chatgpt | `#10a37f` | chatgpt-pale `#e3f5ef` | — (ChatGPT-only, never Claude) |

### 3.3 Spacing (collection “Spacing”)

`--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-7` 28 · `--space-8` 32 · `--space-10` 40 (no `--space-9` observed). Hand-set values that also occur: 2, 6, 10, 14, 26 (button face padding-x), 48 (comment reply indent).

### 3.4 Radius (collection “Radius”)

`--radius-sm` 8 (“Champs, petits badges”) · `--radius-md` 12 (“Boutons”) · `--radius-lg` 20 (“Cartes, capsule du header”) · `--radius-xl` 28 (“Grands blocs” — **dashboard tiles**) · `--radius-full` 999 (“Pilules” — badges, avatars, counters). Hand-set 4 px for 8-px-high gauges/progress bars.

### 3.5 Effects (styles)

| Style | Value | Design System wording |
|---|---|---|
| `Shadow/Soft` (`--shadow-soft`) | drop-shadow `0 14 34 -22` `#14183047` (near-black 28 %) | “Décolle une carte du papier, ne la fait jamais léviter.” — cards, tiles, tables, login card |
| `Shadow/Float` (`--shadow-float`) | drop-shadow `0 24 50 -18` `#1418308C` (near-black 55 %) | “Ce qui flotte au-dessus de la page.” — Fenêtre (modal), Galerie de tuiles (panel), mention suggestions popover |
| hand-set (not a style) | `0 16 40 0 rgba(20,23,48,0.25)` | Menu du profil — **inconsistent**, prefer Shadow/Float |
| hand-set | `0 12 32 0 rgba(20,23,48,0.22)` | En-tête client capsule |
| hand-set | `0 6 16 0 rgba(0,0,0,0.25)` | active pill tab in En-tête client |

### 3.6 Typography

Families in the app: **Outfit** (everything) and **JetBrains Mono** (eyebrows, table headers, timestamps, figures in lists, keyboard shortcuts, chart axes, tile sizes “1×1”). Design System says JetBrains Mono is for “Les eyebrows, et rien d'autre. Capitales, 0.2em.” — Nuera OS deliberately extends it to tabular/technical data. (Display font “Gesty Ratio” and accent “Pinyon Script” are website-only; Outfit Bold stands in for Gesty Ratio in Figma.)

Text styles that exist (Design System) and are detected in Nuera OS nodes: `Mono/Eyebrow` (JetBrains Mono Regular 12 / 1.25 / letter-spacing 20 % = 2.4 px, uppercase), `Text/Body` (Outfit Regular 16 / 1.6), `Text/Label` (Outfit Regular 14 / 1.25), `Text/Caption` (Outfit Regular 12 / 1.6), `Text/UI` (Outfit Bold 15 / 1.25 — buttons). Most app text is **hand-set** (lacune 4). De-facto app scale:

| Size | Weight / family | Used for |
|---|---|---|
| 28 | Outfit SemiBold, `--ink` | page title |
| 24 | Outfit Bold (modal) / SemiBold (login) | Fenêtre title, login title |
| 22 | Outfit Bold | Note · Mouvement title |
| 20 | Outfit SemiBold | floating-panel title |
| 17 | Outfit SemiBold | featured connection card title |
| 16 | Outfit Regular 1.6 / SemiBold | body (Text/Body), thread header name |
| 15 | Outfit SemiBold / Bold / Regular | card title / button (Text/UI) / input value |
| 14 | Outfit Medium / SemiBold / Regular | nav item, menu item, tile title, table primary, subtitle |
| 13 | Outfit Regular / Medium / SemiBold | secondary text, form label, toggle-row title, sidebar search |
| 12 | Outfit Medium / Regular | Badge label, meta, captions |
| 11 | JetBrains Mono Medium / Outfit SemiBold | table header & section eyebrow (uppercase) / counter pill |
| 10 | JetBrains Mono Medium, opacity 60 % | sidebar group label (uppercase) |
| 26 / 30 / ~40 | Outfit SemiBold | KPI value / tile figure / hero figure |

Nuera Dev uses the subset 28, 22, 18, 16, 14, 13, 12, 11 (lacune 4).

### 3.7 Motion

**Design System (`7:35`, layer texts)** — “Une seule famille de courbes. Une animation qui réclame une courbe absente d'ici est presque toujours une animation à revoir.”

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | “Entrées : la signature du site” |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | “Aller-retours” |
| `--ease-emphasis` | `cubic-bezier(0.32, 0.72, 0, 1)` | “Morphings d'interface” |
| `--ease-steady` | `cubic-bezier(0.4, 0, 0.2, 1)` | “Progressions régulières” |
| `--dur-instant` | 60 ms | “Retour au clic” |
| `--dur-fast` | 180 ms | “Survols” |
| `--dur-base` | 350 ms | “Transitions d'état” |
| `--dur-reveal` | 750 ms | “Révélations au scroll (600 à 900)” |
| `--dur-slow` | 900 ms | “Remplissage de la capsule du header” |

Plus: “Tout effet a une version prefers-reduced-motion : ce qu'une animation cache doit rester visible sans elle.” (Lenis/GSAP/motion notes are website-specific.)

**Nuera OS — “Note · Mouvement · Règles communes”** (`137:6044`, verbatim, title “Comment bouge Nuera OS”, repère “MOUVEMENT · RÈGLES COMMUNES”):

> Rien n’apparaît d’un coup : le cadre, puis les titres, puis les données.
> Entrée type : opacité de 0 à 1, flou de 6 px à 0, glissement de 6 px vers le haut, en 350 ms.
> Réaction à un clic ou un survol : 150 ms au plus. Élément : 200 à 400 ms. Graphique ou compteur : 500 à 800 ms. Page entière : 2 s au plus.
> Cascade : 25 ms entre deux barres, 30 ms entre deux entrées de menu, 60 ms entre deux cartes.
> Entrée en forte décélération, sortie deux fois plus courte. Aucun rebond.
> Fenêtre de détail : fond flouté sous un voile clair, jamais noir.
> Ne bouge jamais : le texte qu’on lit, la barre latérale une fois arrivée, une page déjà vue dans la session.
> Réglage « réduire les animations » du système : tout devient un fondu de 150 ms.
> Les notes bleues au-dessus des écrans décrivent leur mouvement. Les écrans M1 à M4, sous l’espace client, en montrent un instant figé.
> Spécification complète : sources/etudes/2026-11-03-motion-nuera-os.md (dépôt du business plan).

**“Note · Mouvement · 02 · Messages”** (`137:6052`; repère “MOUVEMENT · 2.7 MESSAGES ET MENTIONS”, titre “Les messages arrivent, la réponse ChatGPT s’écrit”) — directly relevant to streaming Claude output in the Workspace:

> Message envoyé : il entre en bas du fil (fondu et glissement de 8 px, 250 ms), le champ se vide.
> Message reçu : même entrée ; dans la liste de gauche, la conversation remonte en haut et la pastille du compteur roule (4 à 5).
> Réponse proposée par ChatGPT : le cadre apparaît en fondu, le texte s’écrit mot à mot, puis « Envoyer » s’active.
> Taper @ dans le champ ouvre la liste Ethan / Nezar ; le nom choisi devient une mention en couleur.
> Clic sur une conversation : le fil change par fondu croisé (200 ms), le panneau projet à droite ne bouge pas.

**“Note · Mouvement · M3”** (`142:6918`; repère “INSTANT FIGÉ · FENÊTRE OUVERTE”, titre “M3 · Santé du site, depuis « Détails »”) — modal behaviour:

> L’écran 19 est passé sous un flou de 6 px et un voile clair. La fenêtre est arrivée de 90 % à 100 % de sa taille en 300 ms.
> Ses quatre jauges se sont remplies l’une après l’autre, segment par segment, de gauche à droite.
> Chiffres d’exemple, à brancher sur Uptime Kuma et sur les sauvegardes de Coolify.
> Prototype : « Fermer » revient à l’écran 19 (fermeture en 200 ms, sans cascade).

→ Implementation defaults for Nuera Dev: enter = opacity 0→1 + blur 6→0 px + translateY 6→0, 350 ms `--ease-out`; exit = half duration; stagger 30 ms (menus) / 60 ms (cards); modal = scale 0.9→1 in 300 ms over backdrop-blur 6 px + `--muted-on-dark` veil, close 200 ms; new message = fade + 8 px slide, 250 ms; thread switch = 200 ms cross-fade; `prefers-reduced-motion` → 150 ms fade only; never animate reading text or the arrived sidebar.

---

## 4. Brand & usage rules (cross-page)

1. **Three brand hues only** — “Trois teintes de marque, et rien d'autre : le bleu de nuit, le blanc, le bleu. Les autres valeurs en sont dérivées.” (`5:25`). Status colours (App · statuts) are functional, not brand.
2. **Roles, not hues** — “On écrit text, accent, muted, border, jamais ink ou le bleu. C'est ce qui permet à une section sombre de tout rebasculer seule.” (`5:16`). “Aucune valeur en dur … Un besoin sans token, on ajoute le token, pas l'exception.” (`5:12`). Note: Nuera OS screens themselves reference `--ink` and `--paper` directly in places (titles, active nav) — follow the role tokens in code where a role exists.
3. **Accent flips with the surface** — `#4368b1` on light, `#a6b9dd` on dark: “#4368b1 tombe à 2.31 de contraste sur l'ink (sous le 3.0 de WCAG 1.4.11), #a6b9dd remonte à 6.35.” (`5:129`). On the near-black sidebar every label/icon uses `--accent-on-dark`, active = `--paper`.
4. **Dark vs light usage in the app**: content canvas is light (`--bg` white); dark (`--near-black`) is reserved for navigation chrome (sidebar, client capsule header, logo plate on the login card) and the login page background; overlays use a **light** veil + blur, never black; Nuera Dev adds Dark-mode Color tokens **only for terminal zones**. The profile menu exposes a “Thème sombre” switch (OFF) — a full dark theme is not designed.
5. **Accessibility** (Design System `7:146`): “Toute cible tactile fait au moins 44 px de côté.” · “viser 4.5 pour le texte courant, 3.0 pour les éléments d'interface” · “l'anneau de focus fait 2 px, décalé de 3 px.” · “Téléphone conçu à 390 px, tenu jusqu'à 320 px.” · “Une rangée de cartes devient un rail : défilement aimanté, aperçu de la carte suivante, pastilles d'indication.” Bouton compact: “Zone cliquable 44 px en code.” `--muted` #645e78 = 6.10 on paper, 4.86 on accent-pale.
6. **ChatGPT vs Claude** — chatgpt green, the ChatGPT Badge tone and the dashed “Suggestion ChatGPT” card are reserved for ChatGPT; “il n'est jamais utilisé pour Claude.”
7. **Sample data is labelled** — screens show Badge Neutre “Données d'exemple” next to sample figures.
8. **Iconography** — single outline family: 24 × 24 canvas, stroke **1.8 px constant at every rendered size** (strokes are not scaled: the 16-px and 18-px exports also carry `stroke-width="1.8"`), round caps; rendered at 14 / 15 / 16 / 18 / 24 / 28 px; colour inherited from context (white = active nav, `--accent-on-dark` = idle nav, `--accent` inside `--accent-pale` pastilles, `--text` in menus, `--muted` for the resize handle). Glyph style and names (git-branch, panel-right, list-checks, wifi-off…) look Lucide-like; do **not** substitute library glyphs without checking them against the exported SVGs.
9. **Imagery** — none in the app: no photos/illustrations; people are **initials Avatars** on `--accent-pale`; charts are flat rounded bars (from screenshots — fills not fetched): light-blue bars (≈ `--accent-on-dark`) with an `--ink` cap for the recurring share and the current period in `--accent`, a warn-brown bar for over-capacity (08 · Projets, “S46”), axis labels in JetBrains Mono; legends use 8-px dots (“Projets”, “Récurrent”). Device mock-ups and paper grain (“bruit fractal statique, opacité 0.22”) belong to the website only.
10. **Logo** (Design System `29:85`): “Le logotype suit la couleur du texte de son contexte : il n’a jamais de couleur figée.” · “Le N chevauche le u : le jour entre eux est un vrai trou, pas un contour.” · “Hauteur dans le header : 32 px au bureau, 21 à 25 px au téléphone.” Product variants append a mono pastille (“OS”, Dev uses “DEV”).

### 4.1 Tone of voice & copy conventions (observed in Nuera OS)

- French, plain and direct; subtitles explain *why* (“Les outils branchés à Nuera OS. Tout tourne sur notre serveur, sauf ce que la loi impose (facturation, paiement) et ChatGPT.”); internal voice uses first names (“Ethan et Nezar”, “À confirmer avec Ethan”), “notre serveur”; client space addresses “vous” (“À vous : déposer les photos”).
- Separators: spaced middle dot “ · ” for compound labels (“Atelier Lune · Site vitrine · P-2026-007”, “Connecté · nezar@…”, “Commentaires · 2”).
- Punctuation: French spacing before `:` `?` `!` (regular spaces in Figma — no NBSP found in any surveyed text), guillemets « … » with inner spaces, ellipsis character “…” (“Rechercher…”, “Écrire à Claire…”), typographic apostrophe `’` on the Nuera OS page (86 occurrences vs 12 straight), but **straight `'` everywhere on the NUERA DEV page** — copy verbatim per page.
- Numbers: space thousands separator (“11 700 € HT”, “7 800 € HT”), decimal comma (“99,98 %”, “2,4 Mo”), space before % (“78 %”), fractions with spaced slash (“14 / 18”, “5 / 12 j”, “3 / 3 en ligne”), units abbreviated (“12 j”, “30 min”, “2 h”).
- Time: 24 h “9:42”, relative “il y a 2 h”, “hier 17:40”, “aujourd’hui 9:12”, “maintenant”, weekday abbreviations “Ven. 16:10”, “Lun.”, “jeu. 20 nov. 10:00”, dates “18 nov.”, “28 oct.”, “31 oct. 18:02”.
- Actions: verbs (“Déconnecter”, “Enregistrer”, “Annuler”, “Se connecter”, “Exporter maintenant”, “Relancer sans doublon”), creation prefixed with “+ ” (“+ Nouveau projet”, “+ Nouvelle affaire”); modal close is the text link “Fermer” (no ✕ in Nuera OS; Dev adds `icon/x`).
- Status labels are short adjectives/nouns, gender-agreed with their subject: “Connecté”, “Bloquée”, “En attente”, “Dans les temps”, “En retard · 2 j”, “API à vérifier”, “À confirmer”, “Activée”, “1 échec”.
- Shortcuts shown in mono: “⌘K” (search), “⌘J” (ask AI), and helper “Entrée pour choisir · Échap pour fermer”.

---

## 5. Component & pattern catalogue

Each entry: node · size · variants/props → exact spec (tokens) → verbatim copy → behaviour/states → how Nuera Dev uses it. Raw code in `.design-refs/code/`.

### 5.1 SURVEY-01 — Barre latérale (Nuera OS sidebar) → source of “Dev · Barre latérale”

- **Node**: component set `57:578` “Barre latérale”, variant shown `57:138` “Actif=Tableau de bord”, 248 × 1120. 17 variants: `Actif=Tableau de bord | Messages | Pipeline | Clients | Réglages | Projets | Devis | Sites et CMS | Support | Automatisations | Reporting | Temps et capacité | Contrats | Finances | Équipe | Documents | Administration`. Code: `SURVEY-01-barre-laterale-os.tsx`; assets `SURVEY-01-*` (logo vectors + 18 nav icons + search).
- **Skeleton**: column, bg `--near-black`, padding 20 top / 16 sides / 16 bottom, gap 16:
  1. Logo — “Logo Nuera OS · papier” (logo 136 × 27.6 + “OS” pastille: bg `--accent-on-dark`, px 4 py 2, `--radius-sm`, JetBrains Mono Bold 12, tracking 0.96 px, colour `--near-black`), left padding 8.
  2. Recherche — bg `--surface-raised-dark`, px 12 py 8, `--radius-sm`, gap 8: 16-px `icon/search`, placeholder “Rechercher…” Outfit Regular 13 `--accent-on-dark` (flex 1), shortcut “⌘K” JetBrains Mono Medium 11 `--accent-on-dark`.
  3. Navigation — groups gap 16; group label JetBrains Mono Medium 10, uppercase, `--accent-on-dark`, opacity 60 %, pl 12 pb 8: “PILOTAGE”, “COMMERCIAL”, “PRODUCTION”, “SITES ET SUIVI”, “GESTION”, “OUTILS”. Item (`<a>`): px 12 py 8, `--radius-sm`, gap 12, 18-px icon, label Outfit Medium 14 `--accent-on-dark`; **active**: bg `--hairline-on-dark`, label Outfit SemiBold 14 `--paper`, icon white. Counter pill: bg `--accent`, px 4 py 1, `--radius-full`, Outfit SemiBold 11 `--paper` (“4” on Messages, “2” on Support).
     Items: Tableau de bord, Reporting · Messages, Clients, Pipeline, Devis · Projets, Temps et capacité · Sites et CMS, Contrats, Support · Finances, Équipe, Documents · Automatisations, Administration, Réglages.
  4. Espace (flex 1).
  5. Utilisateur card (`<a>`) — bg `--surface-raised-dark`, p 8, `--radius-md`, gap 8: two 36-px Avatars overlapping (−10 px) “EN”, “NZ”; “Ethan et Nezar” Outfit SemiBold 13 `--paper`; “Nuera Studio · 2 associés” Outfit Regular 11 `--accent-on-dark`. Click opens “Menu du profil” (§5.9).
- **Behaviour**: nav items are links (route per entry); active state = current route; ⌘K focuses search; counters reflect unread items; motion rule: the sidebar never moves once arrived.
- **Nuera Dev**: “Dev · Barre latérale” `201:732` (`Actif=Accueil | Projets | Sessions | Intégrations | Paramètres`) is a *detached* copy: same container/tokens, entries replaced, user card replaced by a **server card** (VPS-3); logo becomes “Logo Nuera Dev · papier” (“DEV” pastille). “Dev · Barre latérale repliée” (72 wide) is new. Mobile has no sidebar (Dev · Barre d'onglets).

### 5.2 SURVEY-02 — Badge (reused as-is)

- **Node**: `57:124` set; variants `Ton=Accent` `57:112`, `Succes` `57:114`, `Alerte` `57:116`, `Danger` `57:118`, `Neutre` `57:120`, `ChatGPT` `57:122`; 23 px high. Prop `label`. Code: `SURVEY-02-badge.tsx`.
- **Spec**: inline-flex, px 8 (`--space-2`) py 4 (`--space-1`), `--radius-full`; label Outfit Medium 12, line-height normal, no wrap.

| Ton | Fill | Label |
|---|---|---|
| Accent | `--accent-pale` | `--accent` |
| Succes | success-pale | success |
| Alerte | warn-pale | warn |
| Danger | danger-pale | danger |
| Neutre | `--surface-raised` (white) | `--muted` |
| ChatGPT | chatgpt-pale | chatgpt — **not for Nuera Dev** |

- **Uses in Nuera OS**: statuses (“Contenus attendus” Alerte, “Dans les temps” Succes, “En retard · 2 j” Danger, “En attente” Neutre, “Connecté” Succes, “Bloquée” Alerte), counts (“3”, “2”), tile deltas (“+12 % vs octobre” Succes, “78 %” Alerte), source tags (“ChatGPT”, “Uptime Kuma”, “Cal.diy”), **filter chips and tab rows** (selected = Accent, others = Neutre — §5.14), “Données d'exemple” (Neutre).
- **Naming caveat**: the variant is spelled `Succes` (no accent) in Nuera OS; Dev-local sets use `Succès`. Map both to one `tone="success"` prop.

### 5.3 SURVEY-03 — En-tête de tuile (reused as-is)

- **Node**: `57:130`, 300 × 28; props `icone` (instance swap), `titre`. Code: `SURVEY-03-en-tete-de-tuile.tsx`.
- **Spec**: row gap 8 (instances in tiles override to 10), height 28. “Pastille” 28 × 28, bg `--accent-pale`, `--radius-sm`, centred 16-px icon in `--accent`. Title Outfit SemiBold 14 `--ink`, flex 1. In tiles, a trailing Badge sits right (row gap 8).
- **Copy examples**: “Chiffre d'affaires”, “Pipeline”, “Charge du mois”, “MRR”, “Encaissé”, “En retard”, “Frais 50/50”, “Messages à traiter”, “Prochains rendez-vous”, “État des sites”, “Devis à signer”, “Demandes”.
- **Nuera Dev**: 17 instances (home tiles / cards headers). Same 28-px pastille idiom appears in “Galerie de tuiles” rows (14-px icon) and connection cards (34-px chip, 18-px icon, `--radius-md`).

### 5.4 SURVEY-04 — Bouton compact (reused as-is)

- **Node**: `168:6952`; `Style=Principal` `168:6940` (93 × 36), `Secondaire` `168:6944` (95 × 36), `Discret` `168:6948` (67 × 36); props `avecIcone`, `icone`, `libelle` (default “Valider”). Code: `SURVEY-04-bouton-compact.tsx`.
- **Figma description** (verbatim): “Bouton de l'espace client : 36 px, texte 14 px, icône 16 px qui dit l'action. Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action mineure (annuler, déplacer). Zone cliquable 44 px en code.”
- **Spec**: height 36, gap 6, `--radius-md`, label Outfit Medium 14, icon 16.
  - Principal: bg `--accent`, pl 12 pr 14, label/icon `--paper`.
  - Secondaire: bg `--paper`, border 1 px `--border-on-light`, pl 12 pr 14, label/icon `--ink`.
  - Discret: no fill/border/padding, label/icon `--accent`.
- **States**: only Rest is drawn — derive hover/pressed/focus (focus ring 2 px offset 3) and disabled in code; keep a 44-px hit area.
- **Nuera Dev**: 104 instances — the default small action in cards, rows, banners, permission prompts. **Phone**: the primary action is a Bouton compact Principal stretched to **44 px high × full width** (324–358 px), label centred, no icon — verified on `220:2443` “Bouton · Répondre”; same for “Reprendre la session”, “Continuer”, “Ouvrir le Workspace”, “Reconnecter”.

### 5.5 SURVEY-05 — Button (Design System, reused as-is: Default + Accent)

- **Node**: `7:117` (page Design System); `Variant=Default | Accent | On dark` × `State=Rest | Hover | Pressed`. In screens, instances are renamed “Bouton · <libellé>”. Code: `SURVEY-05-button-ds.tsx`.
- **Figma description** (verbatim): “Bouton du site (src/components/ui/Button). Default sur clair neutre, Accent sur fond clair, On dark dans une section sombre. Couper le burst près d'un bord : ses rayons débordent de 26 px.”
- **Anatomy (3-D edge)**: wrapper (padding-top 3 Rest / 0 Hover / 5 Pressed) → **Edge** (bg `--btn-edge`, `--radius-md`, padding-bottom 3 / 6 / 1) → **Face** (border 1.5 px `--btn-edge`, `--radius-md`, px 26 py 13; fill `--paper` Default, `--accent` Accent, `--accent-on-dark` On dark) → label `Text/UI` Outfit Bold 15 / 1.25, colour `--btn-edge` (Default, On dark) or `--paper` (Accent). Total height constant 54: the face rises 3 px on hover, sinks 2 px when pressed. Transition with `--dur-instant` (60 ms, click) / `--dur-fast` (180 ms, hover).
- **Usage pattern**: page header right = Default + Accent (Accent = primary, rightmost); modal/panel footers = “Annuler” (Default) + primary (Accent) right-aligned, gap 12; full-width Accent in login card. “burst” = website hover decoration (motion lib) — not used in the app.
- **Gap**: no Danger variant (lacune 1) — destructive confirmations currently use Accent.

### 5.6 SURVEY-06 — Avatar (reused as-is)

- **Node**: `57:125`, 36 × 36 default; prop `initiales` (default “CL”). Code inside SURVEY-01/09/11/13/14.
- **Spec**: circle (`--radius-full`), bg `--accent-pale`, initials Outfit SemiBold 13 `--ink`, centred. Sizes used: 24 (suggestion row), 28 (field value, footers), 32 (comments, table rows), 36 (sidebar card, thread header), 40 (menu header). Stacks overlap −8 (28 px) / −10 (36 px).
- **Data**: person/entity initials (2 letters) — “EN”, “NZ”, “CM”, “AL”, “KR”, “BP”, “RC”.

### 5.7 SURVEY-07 — Réglages · Connexions: Interrupteur, connection cards, chip tabs

- **Node**: content column `67:944` of frame `67:845` “05 · Réglages · Connexions”; screenshot `survey-os-05-reglages-connexions.png`; code `SURVEY-07-reglages-connexions.tsx`; assets `SURVEY-07-*` (incl. `SURVEY-07-imgInterrupteur.svg` ON and `SURVEY-07-imgInterrupteur1.svg` OFF).
- **Layout**: column, px 32 (`--space-8`) py 28 (`--space-7`), gap 24. Header: “Réglages” / “Les outils branchés à Nuera OS. Tout tourne sur notre serveur, sauf ce que la loi impose (facturation, paiement) et ChatGPT.” Tab row (Badges, gap 4): “Agence”, “Associés”, **“Connexions”** (Accent = selected), “Modèles de messages”, “Espace client”.
- **Featured connection card** “Connexion · ChatGPT” (1128 wide): bg `--bg`, border 1.5 px chatgpt, p 24, `--radius-lg`, Shadow/Soft, gap 16. Row: 48-px chip (chatgpt-pale, p 12, `--radius-md`, 24-px `icon/sparkle`) · title “ChatGPT · rédaction des réponses” Outfit SemiBold 17 `--ink` + text “Utilise votre propre compte ChatGPT (Plus ou Pro) : aucune clé d’API à payer à part. Connecté par « Sign in with ChatGPT ».” 13 `--muted` · Badge ChatGPT “Connecté · nezar@…” · Button Default “Déconnecter”. Then 3 toggle tiles (flex 1 each, gap 16; bg `--surface-raised`, p 12, `--radius-md`, gap 12): title Outfit SemiBold 13 `--text` + sub 12 `--muted` + Interrupteur — “Suggérer une réponse” / “sur chaque nouveau message client” (ON), “Lire le contexte du projet” / “planning, contenus, devis” (ON), “Envoyer sans relecture” / “jamais : un associé valide toujours” (OFF). Footer: Badge Alerte “À confirmer avec Ethan” + “Secours si OpenAI ne nous ouvre pas l’accès : une clé d’API OpenAI payée à l’usage. Seul le message traité est envoyé.” 12 `--muted`.
- **Section eyebrow**: “OUTILS BRANCHÉS” JetBrains Mono Medium 11 `--muted`.
- **Connection card** (264 wide, wrap grid gap 24): bg `--bg`, p 24, `--radius-lg`, Shadow/Soft, gap 12; header row gap 8 = 34-px chip (`--accent-pale`, p 8, `--radius-md`, 18-px icon) + name Outfit SemiBold 15 `--ink`; description 12 `--muted`; badge row gap 4 (status + hosting). Data: Twenty / “CRM · contacts, affaires, tâches” / “Connecté”, “Notre serveur” · Payload / “CMS des sites clients” / “4 sites”, “Notre serveur” · DocuSeal / “Signature des devis” / “Connecté”, “Notre serveur” · Indy / “Factures et comptabilité” / “API à vérifier”, “Externe, imposé” · Uptime Kuma / “Surveillance des sites” / “3 / 3 en ligne”, “Notre serveur” · n8n / “Automatisations entre outils” / “Optionnel”, “Notre serveur” · Cal.diy / “Prise de rendez-vous” / “Connecté”, “Notre serveur” · Coolify / “Mise en ligne et sauvegardes” / “Connecté”, “Notre serveur”.
- **Interrupteur** (`67:979`/`67:985`/`67:991`, also `88:2439`…, `88:2826`, `88:3004`…): flattened 36 × 20 vector (not a component in Nuera OS): pill radius 10; ON fill `#10A37F` (chatgpt) with white knob r 8 at x 26; OFF fill `#D9DADE` (`--border-on-light`) knob at x 10. **Dev · Interrupteur** (`202:459`, `Actif=Oui|Non`) = same drawing with ON = `--accent`. Implement as `role="switch"`, `aria-checked`, 44-px hit area, knob slide `--dur-fast`.
- **Nuera Dev mapping**: Intégrations screen (GitHub, Figma MCP, Coolify, VPS-3 …) follows the connection-card + featured-card pattern; Paramètres uses toggle tiles.

### 5.8 SURVEY-08 — Dashboard tile, tile grid, KPI card

- **Tile** `58:377` “Tuile · Charge · 2×1” (360 × 168) in “Grille de tuiles · 6 colonnes” `58:261` (1128 × 936). Code `SURVEY-08-tuile-et-carte-chiffre.tsx`; screenshot `survey-os-01-tableau-de-bord.png`.
  - Grid: 6 columns × 168, gutter 24 (1128). Sizes: 1×1 = 168 × 168, 2×1 = 360 × 168, 2×2 = 360 × 360, 4×2 = 744 × 360. Tile names encode size: “Tuile · Chiffre d'affaires · 4×2”, “Tuile · Pipeline · 2×2”, “Tuile · MRR · 1×1”…
  - Tile: bg `--bg`, **`--radius-xl` (28)**, p 20, gap 12, Shadow/Soft. Header = En-tête de tuile + Badge. Figure Outfit SemiBold 30 `--ink` + unit 13 `--muted` (“14 / 18” “journées vendues”); gauge 8 px (track `--surface-raised`, fill `--accent`, radius 4); footnote 12 `--muted` (“Nezar 10 / 14 · Ethan 4 / 4”).
  - **Poignée de taille** `57:127` (22 × 22): quarter-arc stroke 3 px `#645E78` round cap, pinned 8 px from bottom-right (x 330 y 138 on a 360 × 168 tile). Edit mode: accent coloured.
  - “Tuile · Ajouter · 1×1” (`58:621`): dashed placeholder with 34-px `icon/plus` chip and “Ajouter une tuile”.
- **Edit mode** (`67:1104`, screenshot `survey-os-06-mode-edition.png`): subtitle “Mode édition · glissez pour déplacer, la poignée change la taille, le rond retire la tuile”; tiles get a 2-px `--accent` outline; “Bouton · Retirer la tuile” (`150:6910`, 24 × 24 white circle with red minus, top-left corner of each tile); right floating panel “Galerie de tuiles” (§5.11).
- **Prototype** (`59:481` on page `59:3`): copy “Tableau de bord” / “Cliquez sur la poignée en bas à droite d’une tuile : petite → moyenne → grande. Les autres tuiles se replacent.” Component sets “Tuile vivante/Chiffre d'affaires | Pipeline | Charge du mois | Messages | MRR | État des sites” (`59:81`, `59:163`, `59:243`, `59:319`, `59:395`, `59:477`), each `Taille=Petite` (168 × 168) | `Moyenne` (360 × 168) | `Grande` (360 × 360); grid “Grille qui se replace” 1128 × 744. → Behaviour: clicking the handle cycles S→M→L and the grid reflows (motion: ≤ 400 ms, cards cascade 60 ms).
- **KPI card** `100:5730` “Carte · null” (264 × 119; also “Carte · chiffre” on 21/22): bg `--bg`, p 24, gap 4, `--radius-lg`, Shadow/Soft; label Outfit Medium 12 `--muted` (“Disponibilité 30 jours”), value Outfit SemiBold 26 `--ink` (“100 %”), delta 12 in a status colour (“0 incident”, success). Row of 4 × 264 with 24 gutters.
- **Nuera Dev**: Accueil reuses En-tête de tuile inside cards; adopt `--radius-xl` for home tiles if the Dev frames do (check Dev spec), KPI-card idiom for project stats.

### 5.9 SURVEY-09 — Menu (Menu du profil)

- **Node**: `88:2784` (300 × 406) in `88:2543` “13 · Menu du profil (ouvert)”, anchored bottom-left at x 16 y 608 (over the sidebar user card) above a full-frame “Voile” `88:2783`. Code `SURVEY-09-menu-du-profil.tsx`; screenshot `survey-os-13-menu-du-profil.png`.
- **Spec**: bg `--bg`, p 8, gap 4, `--radius-lg`, shadow `0 16 40 0 rgba(20,23,48,.25)` (hand-set). Header p 12 gap 12: Avatar 40 “NZ”, “Nezar Zakaria” Outfit SemiBold 14 `--ink`, “nezar@nuera.studio · associé” 12 `--muted`. Separator 1 px `--border`. Item: px 12 py 8, `--radius-sm`, gap 12, 18-px icon, label Outfit Medium 14 `--text`, optional trailing Badge/Interrupteur; hovered item bg `--surface-raised` (invisible in Light — lacune 3; use a real hover tint in code). Destructive item label `--danger`.
- **Items (verbatim)**: “Mon profil” (`icon/clients`), “Personnaliser” (`icon/edit`, hovered), “Notifications” + Badge “3”, “ChatGPT” + Badge ChatGPT “Connecté”, “Réglages de l’agence” (`icon/reglages`), “Thème sombre” + Interrupteur OFF, separator, “Passer sur le compte d’Ethan” (`icon/clients`), “Se déconnecter” (`icon/chevron`, danger).
- **Behaviour**: opens from the user card; Voile behind; Esc / outside click closes; items cascade 30 ms (motion rule). **Nuera Dev**: pattern for `icon/more` row menus and the server-card menu.

### 5.10 SURVEY-11 — Fenêtre (modal) + Voile (scrim)

- **Nodes**: “Fenêtre · Tâche” `141:7330` (640 × 779, at x 400 y 171) in `141:6999` (M4); “Fenêtre · Santé du site” `141:6795` (560 × 696) in `141:6485` (M3); “Voile” `141:6794` / `141:7329` / `88:2783` (1440 × 1120). Code `SURVEY-11-fenetre-tache.tsx`, `SURVEY-11-voile.tsx`; screenshot `survey-os-M4-fenetre-tache.png`.
- **Voile**: fill `--muted-on-dark` (white 62 %) + backdrop blur 6 px (from note M3) — light, never black.
- **Fenêtre**: bg `--bg`, p 24, gap 16, `--radius-lg`, Shadow/Float. Header row gap 12: title Outfit Bold 24 `--text` (“Intégrer la page Galerie”) + text link “Fermer” Outfit Medium 14 `--accent`. Context line `Text/Label` `--muted` (“Atelier Lune · Site vitrine · P-2026-007”).
  - **Champs** (gap 8): row gap 12, label `Text/Label` `--muted` fixed 140 wide; value `Text/Body`: “Responsable” → Avatar 28 “EN” + “Ethan”; “Échéance” → “10 nov.”; “Statut” → Badge Alerte “Bloquée”; “Dépend de” → “Photos client · attendues depuis le 31 oct.”.
  - **Onglets** (underline tabs): row gap 24, border-bottom 1 px `--border-on-light`; tab = label 14 + 2-px bar (gap 8); selected = Outfit SemiBold `--text` + bar `--text`; others Outfit Regular `--muted`, no bar. Labels: “Description”, “Commentaires · 2”, “Historique”.
  - **Fil de commentaires** (gap 16): Avatar 32 + meta (“Nezar” Medium 14 `#233353` + “ · hier 17:40” 14 `--muted`) + body `Text/Body` (“J’ai relancé Atelier Lune pour les photos des compositions. Réponse promise jeudi.”); reply indented 48 (“Ethan” · “ · il y a 2 h”, “@Nezar” mention Outfit Medium `--accent` + “ je prépare la grille en attendant les photos. Tu peux valider la maquette de la galerie ?”); attachment chip: bg `--surface-raised`, pl 10 pr 12 py 6, `--radius-sm`, 16-px paperclip, “galerie-grille-v2.fig · 2,4 Mo” 12.
  - **Saisie**: Avatar 32 + “Champ · focus” (bg `--bg`, **border 1.5 px `--text`** = focus, p 12, `--radius-md`, `Text/Body`, caret 1.5 × 18 `--text`) with value “Merci ! Je valide ce soir. ” + mention “@Eth”; **Suggestions** popover (w 300, p 4, gap 4, `--radius-md`, Shadow/Float): active row bg `--accent-pale` p 8 `--radius-sm` gap 8 (Avatar 24 “EN”, “Ethan” Medium 14, “design et front-end” 12 `--muted`) + helper “Entrée pour choisir · Échap pour fermer” 12 `--muted`.
  - **Actions**: “Associés” label + overlapping Avatars 28; spacer; Button Default “Annuler” + Button Accent “Enregistrer”.
- **Behaviour** (note M3): opens scaling 90 %→100 % in 300 ms over blur + veil; closes in 200 ms without cascade; “Fermer”, Esc and veil click close; focus trapped; Annuler discards.
- **Nuera Dev**: base for every confirmation of “actions sensibles” (arrêter la session, archiver, supprimer des worktrees, committer et ouvrir la PR) and detail windows; the comment composer + @-suggestions popover is the closest precedent for the Workspace composer and slash/@ pickers.

### 5.11 SURVEY-10 — Floating side panel (Galerie de tuiles)

- **Node**: `67:1564` (360 × 1096) floating at 12 px from the top/right/bottom edges of `67:1104`. Code `SURVEY-10-galerie-de-tuiles.tsx`.
- **Spec**: bg `--paper`, border 1 px `--border-on-light`, pt 32 px 24 pb 20, gap 16, `--radius-lg`, Shadow/Float. Title “Ajouter une tuile” Outfit SemiBold 20 `--ink`; helper “Glissez une tuile sur le tableau, ou cliquez pour l’ajouter à la fin.” 13 `--ink` 70 %; list gap 8 of rows (bg `--bg`, border 1 px `--border-on-light`, `--radius-md`, pl 8 pr 12 py 8, gap 12): 28-px Pastille (`--accent-pale`, `--radius-sm`, 14-px `icon/plus`) + label Outfit Medium 14 `--text` + size JetBrains Mono 12 `--muted`. Rows: “Projets en retard” 1×1, “Temps passé / devis” 2×1, “Abonnements” 2×1, “Contenus manquants” 2×1, “Factures Indy” 2×2, “Automatisations n8n” 2×1, “Trésorerie” 2×1, “Rapport mensuel” 2×2. Spacer; footer (h 60, right-aligned, gap 12): Button Default “Annuler” + Accent “Terminé”.
- **Nuera Dev**: precedent for the right panel toggled by `icon/panel-right` in the Workspace (files/diff/plan) and for sheet-like lists on desktop. The 300-px “Panneau client” of 02 · Messages (`63:628`) is the docked variant (eyebrows “PROJET”, “CONTENUS ATTENDUS”, “PROCHAIN RENDEZ-VOUS”, key/value rows “Offre / Site vitrine”, “Montant / 7 800 € HT”, “Acompte 30 % / payé”, “Mise en ligne / 18 nov.”, “Associés / Ethan et Nezar”).

### 5.12 SURVEY-18 — Logos (reused / derived)

- “Logo Nuera · papier” `62:367` / “· encre” `68:1214` (136 × 27.6, vector + luminance-mask group — exported as `SURVEY-01-imgVector.svg`, `SURVEY-01-imgGroup.svg` (mask), `SURVEY-01-imgGroup1.svg`); “Logo Nuera OS · papier” `90:4084` / “· encre” `90:4098` (168 × 27.6 = logo + gap 8 + “OS” pastille). Papier = for dark backgrounds (sidebar, login plate); encre = for light (C9 · Lien expiré). Frame `91:4092` “Logo Nuera OS · encre” sits above the page.
- Nuera Dev: “Logo Nuera Dev · papier” `201:41` / “· encre” `201:80` (176 × 27.6) — “pastille DEV, construction de la pastille OS” (same pastille spec: `--accent-on-dark` fill on dark, JetBrains Mono Bold 12, tracking 0.96, `--near-black` text). Use the Dev exports from the Extensions spec; keep the mask construction (the N/u gap must show the background).

### 5.13 SURVEY-19 — Icons (reused + extended)

- **Nuera OS (38)**: `alert, automatisations, bell, book, calendar, chart, check, chevron, clients, clock, contrat, dashboard, database, devis, download, edit, equipe, euro, flag, globe2, link, messages, micro, minus, paperclip, pipeline, plus, projets, reglages, rocket, search, send, server, shield, sites, sparkle, support, wallet` (`icon/…`).
- **Directly instantiated on the NUERA DEV page (19, lower bound — instances nested inside Dev components are not visible in metadata; the canvas note says 25)**: `alert ×17, bell ×4, book ×5, check ×37, chevron ×53, clock ×5, edit ×1, globe2 ×4, messages ×7, minus ×1, paperclip ×4, plus ×9, projets ×12, reglages ×2, rocket ×7, search ×1, send ×4, server ×1, shield ×7`.
- **New in Dev (37, `199:8`)**: `archive, arrow-left, chevron-down, cpu, external, eye, figma, file, file-diff, filter, folder, git-branch, git-commit, git-pull-request, github, history, home, key, list-checks, lock, monitor, more, panel-right, pause, play, plug, pull, refresh, smartphone, star, stop, terminal, trash, upload, wifi-off, worktree, x`.
- Exported SVGs available from this survey (baked colour/size, convert to `currentColor` components without editing paths): `SURVEY-01-imgIcon{Search,Dashboard,Chart,Messages,Clients,Pipeline,Devis,Projets,Clock,Sites,Contrat,Support,Wallet,Equipe,Book,Automatisations,Shield,Reglages}.svg`, `SURVEY-07-imgIcon{Sparkle,Clients,Sites,Devis,Euro,Server,Automatisations,Calendar,Link}.svg`, `SURVEY-09-imgIcon{Clients,Edit,Bell,Sparkle,Reglages,Chevron}.svg`, `SURVEY-10-imgIconPlus.svg`, `SURVEY-11-imgIconPaperclip.svg`, `SURVEY-14-imgIcon{Sparkle,Link,Paperclip,Send}.svg`, `SURVEY-15-imgIconSearch.svg`, `SURVEY-04-imgIconCheck.svg` (30 of the 38 Nuera OS glyphs). **Not exported by this survey**: `alert, database, download, flag, globe2, micro, minus, rocket` — take them from the Dev spec exports (the Dev frames instantiate `alert`, `globe2`, `minus`, `rocket`) or fetch the `57:13` icon symbols when needed. Exports carry the colour/size of their context (e.g. 18 px `#A6B9DD` in the sidebar, 16 px `#4368B1` in pastilles, 24 px `#233353` default) — normalise to `currentColor` + size props in code without editing paths.

### 5.14 SURVEY-15 — List toolbar: search field + filter chips

- **Node**: `87:2327` (522 × 36) in `87:2215` “08 · Projets”. Code `SURVEY-15-recherche-et-filtres.tsx`; screenshot `survey-os-08-projets.png`.
- **Search**: 260 × 36, bg `--bg`, border 1 px `--border`, `--radius-md`, px 12 py 8, gap 8, 15-px `icon/search`, placeholder “Rechercher…” Outfit Regular 13 `--muted`.
- **Chips**: Badges, gap 8: “En cours” (Accent, selected), “À venir”, “Livrés”, “En retard” (Neutre). Single-select filter; same convention as the Réglages tab row (`67:948`, gap 4). Other search placeholders: “Chercher un client, un message…” (02 · Messages list).
- **Nuera Dev**: Projets / Sessions filters.

### 5.15 SURVEY-13 — Tableau (data table)

- **Node**: `87:2341` (1128 × 309) in “08 · Projets”. Code `SURVEY-13-tableau-projets.tsx`.
- **Spec**: container bg `--bg`, `--radius-lg`, Shadow/Soft, overflow clip. Header row: bg `--surface-raised`, border-bottom 1 px `--border`, px 20 py 12, gap 16; labels JetBrains Mono Medium 11 `--muted` uppercase: “PROJET” (flex 1), “ÉTAPE” (170), “AVANCEMENT” (150), “MISE EN LIGNE” (110), “STATUT” (170), “ÉQUIPE” (80). Body rows (`<a>` = whole row clickable): border-bottom 1 px `--border`, px 20 py 16 (66 high), gap 16; primary cell = Avatar 32 + name Outfit SemiBold 14 `--text` + meta 12 `--muted`; other cells Outfit Regular 13 `--muted`; progress = 80 × 8 track (`--surface-raised`, radius 4) + `--accent` fill + “5 / 12 j” 12 `--muted`; status Badge.
- **Rows (verbatim)**: “Atelier Lune” / “Site vitrine · 12 j” / “2 · On démarre” / 5 / 12 j / “18 nov.” / Badge Alerte “Contenus attendus” / “EN · NZ” · “Kiné Rive Gauche” / “Site vitrine · 12 j” / “1 · On se rencontre” / 2 / 12 j / “5 déc.” / Succes “Dans les temps” / “NZ” · “Bistrot du Port” / “Reprise + 4 pages · 7 j” / “3 · Retours” / 5 / 7 j / “12 nov.” / Danger “En retard · 2 j” / “EN” · “Roux Conseil” / “Landing · 4 j” / “—” / 0 / 4 j / “à signer” / Neutre “En attente” / “NZ”.
- Variant in 24 · Administration (`survey-os-24-administration.png`): permission matrix with check marks in success-pale circles; “ACTION SENSIBLE / AUTEUR / DATE” log (“Déploiement de kine-rive-gauche.fr” · NZ Nezar · “aujourd’hui 10:41”; “Export des données clients” · EN Ethan · “31 oct. 18:02”; “Rôle modifié : Claire Martin → portail” · NZ Nezar · “24 oct. 11:15”).
- **Nuera Dev**: precedent for “Dev · Ligne de projet” / “Dev · Ligne d'historique” (1088 wide rows) and the sensitive-actions log.

### 5.16 SURVEY-14 — Thread + composer (02 · Messages)

- **Node**: “Fil de discussion” `63:569` (552 × 1120) between “Conversations” (340, `63:497`) and “Panneau client” (300, `63:628`). Code `SURVEY-14-fil-de-discussion.tsx`; screenshot `survey-os-02-messages.png`.
- **Header**: bg `--bg`, border-bottom 1 px `--border`, px 28 py 24, gap 12: Avatar 36 “CM”, “Claire Martin” SemiBold 16 `--ink` / “Atelier Lune · fleuriste” 12 `--muted`, Badge Accent “Vitrine · étape 2 / 4”, Button Default “Voir la fiche”.
- **Messages** (px 28 py 24, gap 16): outgoing bubble right-aligned, bg `--accent`, px 16 py 12, `--radius-lg`, text Outfit Regular 14 `--paper` (420 max) + meta JetBrains Mono 11 (“Nezar · Ven. 16:10”); incoming bubble left, bg `--bg`, border 1 px `--border`, text `--text`, meta `--muted` (“Claire · 9:42”).
- **AI suggestion card** (ChatGPT-only styling): bg chatgpt-pale, border 1 px dashed chatgpt, p 16, `--radius-lg`, gap 12; “Réponse proposée par ChatGPT” SemiBold 13 chatgpt + 16-px sparkle; Badges Neutre “Ton : chaleureux”, “Votre compte ChatGPT”; proposal 14; context line 11 `--muted` with 12-px link icon “Contexte lu : planning du projet, contenus attendus, règle « la date recule d’autant »”; Buttons “Utiliser la réponse” (Accent), “Reformuler”, “Plus court” (Default).
- **Composer** (px 28, pt 16, pb 20): field bg `--bg`, border 1 px `--border`, `--radius-md`, pl 16 pr 8 py 8, gap 8: 18-px paperclip, placeholder “Écrire à Claire…  (⌘J : demander une réponse à ChatGPT)” 14 `--muted` (two spaces before the parenthesis), send button 34 × 34 bg `--accent` p 8 `--radius-md` with 18-px white `icon/send`.
- **List items** (`63:497`): “Claire · Atelier Lune” 9:42 “On peut décaler la remise des photos à lundi ?” + “Réponse suggérée”; “Karim · Kiné Rive Gauche” Hier …; “Nathalie · Roux Conseil” Hier …; “Julien · Menuiserie Dupré” Lun. …; “Sophie · Bistrot du Port” 28 oct. ….
- **Nuera Dev**: closest precedent for the Workspace (sessions list | Claude conversation | right panel), “Dev · Message · Instruction” (≈ outgoing) / “Dev · Message · Claude”, and “Dev · Compositeur”. Streaming = “le texte s’écrit mot à mot” rule. Do **not** reuse chatgpt colours for Claude.

### 5.17 SURVEY-17 — Connexion de l’équipe (login card)

- **Node**: `88:3061` (440 × 475) centred on near-black page `88:3060`. Code `SURVEY-17-connexion-equipe.tsx`; screenshot `survey-os-15-connexion-equipe.png`.
- **Spec**: card bg `--bg`, p 24, gap 20, `--radius-lg`, Shadow/Soft. Logo plate bg `--near-black`, px 16 py 12, `--radius-md` with “Logo Nuera OS · papier”. Title “Espace de l’agence” SemiBold 24 `--ink`; “Réservé à Ethan et Nezar.” 14 `--muted`. Fields (gap 8): label Outfit Medium 13 `--text` (“E-mail”, “Mot de passe”), input bg `--bg`, border 1 px `--border`, **`--radius-sm`**, px 16 py 12 (45 high), value Outfit Regular 15 `--text` (“nezar@nuera.studio”, “••••••••••••”). Full-width Button Accent “Se connecter”. Footnote “Double authentification demandée à chaque nouvel appareil.” 12 `--muted`.
- **Nuera Dev**: no login frame exists in the Dev page; if auth is needed (single developer, VPS), reuse this card with the Dev logo (“Réservé à …” copy to be decided). Dev · Champ (`202:503`, `État=Repos | Focus | Erreur`, 320 × 40) is the Dev input; this card is the visual precedent.
- Related state: **C9 · Lien expiré** (`89:3326`): card 480 × 423 on light page — “Logo Nuera OS · encre”, 52-px clock chip, “Ce lien a expiré”, “Pour votre sécurité, un lien de connexion n’est valable que 24 heures. Demandez-en un nouveau : il arrive en quelques secondes.”, Bouton compact “Recevoir un nouveau lien”, “Vous avez été déconnectée ? Même chemin : un nouveau lien suffit.” → precedent for full-page error/empty states.

### 5.18 SURVEY-16 — En-tête client (not reused; dark pill nav reference)

- **Node**: `69:1289` set, variant `69:1231` “Actif=Mon projet” (1440 × 104). Code `SURVEY-16-en-tete-client.tsx`.
- **Description** (verbatim): “Avancement : anneau en 4 quarts (fait / en cours / à venir) + nom de l'étape en cours ; c'est un bouton qui mène à « Mon projet ». Nom accessible : « Avancement : étape 2 sur 4, maquettes, mise en ligne le 18 novembre ». Au survol, une bulle donne la date de mise en ligne.”
- **Spec**: capsule bg `--near-black`, `--radius-full`, px 16 py 8, gap 12, shadow `0 12 32 0 rgba(20,23,48,.22)`, in a 104-high bar with px 40. Segmented “Onglets”: container bg `--surface-raised-dark`, p 4, gap 4, `--radius-full`; active tab bg `--paper`, h 40, pl 14 pr 16, SemiBold 14 `--ink`, shadow `0 6 16 rgba(0,0,0,.25)`; idle tabs Medium 14 `--accent-on-dark` + 18-px icon; counter pill as sidebar. “Prochaine action” pill bg `--hairline-on-dark` with 8-px dot “Point · à faire” + “À vous : déposer les photos”. Labels: “Maquettes”, “Mon projet”, “Messages” (2), “Documents”, “Mon site”.
- **Nuera Dev**: none directly (Dev · Barre d'onglets is a new mobile bottom bar); useful precedent for a dark segmented control and for the 8-px status dot (→ Dev · Point de statut).

### 5.19 SURVEY-12 — Note · Mouvement (canvas annotation component)

- **Node**: `137:6040` (instances above screens). Description: “Note de mouvement posée à côté d'un écran de Nuera OS : décrit comment l'écran s'anime (sources/etudes/2026-11-03-motion-nuera-os.md). Renseigner Repère, Titre et Texte.” Spec: bg `--accent-pale`, border 1 px dashed `--accent`, p 24, gap 12, `--radius-lg`; repère `Mono/Eyebrow` `--accent`; title Outfit Bold 22; text `Text/Body`. Code `SURVEY-12-note-mouvement.tsx`, `SURVEY-12-notes-mouvement-ecrans.tsx`. Design intent only (not UI).

---

## 6. Nuera Dev element → existing source (decision table)

| Nuera Dev element (Dev page) | Existing source | Relationship / guidance |
|---|---|---|
| Dev · Barre latérale (`201:732`) | Barre latérale `57:578` | Derived — same container, groups, item states, counter pill; server card replaces user card |
| Dev · Barre latérale repliée (`201:893`, 72 wide) | — | New; reuse item tokens (icon 18, active `--hairline-on-dark`) |
| Dev · Barre d'onglets (`202:452`, 390 × 91) | (dark pill nav of En-tête client) | New |
| Dev · Barre d'état / Indicateur d'accueil (`202:248`, `202:251`) | — | New (mobile OS chrome) |
| Dev · Interrupteur (`202:459`) | Interrupteur drawing `67:979` | Derived — ON = `--accent` instead of chatgpt |
| Dev · Point de statut (`202:478`, 8 × 8, `Ton=Succès \| En cours \| Alerte \| Danger \| Neutre \| Accent`) | “Point · à faire” 8-px dot (`152:6938`), État des sites dots | New |
| Dev · Champ (`202:503`) | login inputs `88:3078`, “Champ · focus” `141:7383` | New, consistent: focus = 1.5 px `--text` border |
| Dev · Message · Instruction / Claude (`203:318`, `203:329`) | Messages bubbles `63:583`/`63:587` | New; never chatgpt styling for Claude |
| Dev · Compositeur (`203:497`) | composer `63:620`, Saisie `141:7379` | New, same idiom (paperclip, placeholder, accent send) |
| Dev · Demande d'autorisation (`203:423`, `222:2731`) | (featured card with coloured border, `67:959`) | New |
| Dev · Ligne de projet / d'historique (`210:674`, `215:1791`) | Tableau rows `87:2341` | New, row idiom |
| Dev · Carte de session (`203:655`) | KPI / connection cards | New |
| Dev · Bandeau (`203:703`), Dev · Toast (`203:709`) | — (no banner/toast in Nuera OS) | New |
| Confirm / detail dialogs (“actions sensibles”) | Fenêtre `141:7330` + Voile `141:6794` | Pattern — light veil + 6 px blur, Shadow/Float, footer Default + Accent (Danger variant missing) |
| Row / overflow menus (`icon/more`) | Menu du profil `88:2784` | Pattern |
| Right panel (`icon/panel-right`) | Galerie de tuiles `67:1564`, Panneau client `63:628` | Pattern |
| Tabs | Onglets `141:7352` (underline) · Badge chip row `67:948` | Pattern |
| Search + filters | `87:2327` | Pattern |
| Home tiles / stats | Tuile `58:377`, grid `58:261`, KPI card `100:5730` | Pattern |
| Login (if added) / expired session | `88:3061`, C9 `89:3326` | Pattern |

---

## 7. Gaps, inconsistencies & open questions

1. **Apostrophes**: Nuera OS copy uses `’` (86) with a few `'` (e.g. “Mardi 3 novembre 2026 · l'agence aujourd'hui”, “Données d'exemple”); the NUERA DEV page uses only `'` (146, 0 `’`). Copy is reproduced verbatim per page; ask whether Dev should be normalised to `’` like Nuera OS.
2. **Non-breaking spaces**: none present in any surveyed Figma text (regular spaces before `:`/`?`/`%`/`€`). Implementers may add NBSPs for line-breaking quality without changing visible copy — needs a team decision.
3. **No Danger button / no danger-on-dark** (lacunes 1–2): destructive confirmations use Accent in Figma.
4. **surface = surface-raised = paper in Light** (lacune 3): hover states drawn with `--surface-raised` (menu item, table header, gauge track) are invisible — code needs a visible hover tint (e.g. `--accent-pale` at low opacity) → design decision.
5. **Text styles not applied** (lacune 4): implement an “App” type ramp (28, 22, 18, 16, 14, 13, 12, 11) as CSS utilities.
6. **Shadow drift**: Menu du profil uses a hand-set shadow instead of Shadow/Float; client capsule and active pill too. Prefer the two styles.
7. **Token aliases**: `--border` and `--border-on-light` both `#d9dade`; `--accent` vs `--accent-on-light`; `--muted` vs `--muted-on-light`; App · statuts variables lack code syntax. Pick one CSS name per role.
8. **Badge naming**: `Succes` (Nuera OS) vs `Succès` (Dev sets).
9. **Interrupteur in Nuera OS is a flattened vector**, not a component; Dev made a real component — use the Dev one.
10. **Dark mode values** of the Color collection were not resolvable from the surveyed (Light) frames — take them from the Dev terminal frames / Design System colour page.
11. **“Thème sombre”** switch exists in the Nuera OS profile menu but no dark theme is designed; Nuera Dev is light-only except terminal zones.
12. **No phone layouts in Nuera OS**: every Nuera OS / client-space frame is 1440 wide (C-frames 1440 or 1000). All phone patterns of Nuera Dev (Barre d'onglets, Barre d'état, Indicateur d'accueil, Demande d'autorisation · téléphone, 44-px full-width Bouton compact) are new; the only upstream phone rules are the Design System ones (390 px design width, 320 px minimum, 44-px targets, card rows become snapping rails).
13. **Hover/pressed states** are only drawn for the Design System Button; Bouton compact, Badge chips, nav items, table rows and menu items need hover/focus/disabled states defined in code (stay within tokens; focus ring 2 px offset 3).

---

## 8. Website Mockups & Sandbox (summary only)

- **Website Mockups** (`1:835`): “Accueil”, “Création de site”, “Refonte de site”, “SEO / GEO”, “À propos”, “Tarifs”, “Réalisations”, “Blog”, “Article de blog”, “Contact”, “Mentions légales” — each “— Bureau 1440” and “— Téléphone 390” (frames `30:932` … `30:10902`). No component instances (detached). Marketing art direction only; not a source for Nuera Dev UI.
- **Sandbox** (`0:1`): early brand work. Colour notes written on canvas: “accent-on-dark : #a6b9dd”, “accent-on-light : #4368b1”, “surface-dark and text-on-light #233353”, “HAVE TO CHECK WITH ACCESSIBILITY” (resolved by the Design System contrast notes). Logo explorations (“PRIMARY”, “SECONDARY”, “submark ”, “favicon”, “Complete Logo”, colour and B/W concept boards, kerning tests) and device mock-ups (“iPad Mockup Dark”, “MacBook”, “3D Render - iphone”, “plugin name : free mockup 3d”). Nothing to implement.

---

## 9. File index

- Code (raw MCP output, temp URLs replaced by local asset paths):
  `SURVEY-00-note-extensions-et-lacunes.tsx`, `SURVEY-01-barre-laterale-os.tsx`, `SURVEY-02-badge.tsx`, `SURVEY-03-en-tete-de-tuile.tsx`, `SURVEY-04-bouton-compact.tsx`, `SURVEY-05-button-ds.tsx`, `SURVEY-07-reglages-connexions.tsx`, `SURVEY-08-tuile-et-carte-chiffre.tsx`, `SURVEY-08-entetes-dashboard.tsx` (page-header subtitle + tile header, verifies straight `'` in “Données d'exemple”, “Chiffre d'affaires”), `SURVEY-09-menu-du-profil.tsx`, `SURVEY-10-galerie-de-tuiles.tsx`, `SURVEY-11-fenetre-tache.tsx`, `SURVEY-11-voile.tsx`, `SURVEY-12-note-mouvement.tsx`, `SURVEY-12-notes-mouvement-ecrans.tsx`, `SURVEY-13-tableau-projets.tsx`, `SURVEY-14-fil-de-discussion.tsx`, `SURVEY-15-recherche-et-filtres.tsx`, `SURVEY-16-en-tete-client.tsx`, `SURVEY-17-connexion-equipe.tsx` (all in `.design-refs/code/`; Avatar = inside SURVEY-01).
- Assets: `.design-refs/assets/survey/SURVEY-<nn>-<figmaConstName>.svg` (67 files: logo parts, icons, Interrupteur ON/OFF, Poignée de taille, Anneau étape 2 sur 4, Point à faire; `SURVEY-08b-imgIconEuro.svg` belongs to `SURVEY-08-entetes-dashboard.tsx`).
- Screenshots: `.design-refs/screens/survey-*.png` (11 files, see §1.1).
