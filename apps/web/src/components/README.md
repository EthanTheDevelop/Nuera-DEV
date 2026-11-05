# Composants de Nuera Dev — inventaire

Référence pour tous les lots : **réutiliser avant de créer**. Chaque composant reproduit un nœud Figma
(fichier `nlvRWAtD1x2fKf8gVgcM0g`) ; les specs sont dans `docs/figma/*.md`.

| Dossier | Contenu | Import |
|---|---|---|
| `ui/` | primitives du design system (props uniquement, aucune donnée) | `@/components/ui` |
| `icons/` | jeu d'icônes Figma (`<Icon name size />`) | `@/components/icons` |
| `brand/` | logotype, logo Nuera Dev, pastille DEV | `@/components/brand` |
| `shell/` | navigation, palette ⌘K, cloche, états globaux T5/T6/W7, `AppShell` | `@/components/shell` |
| `dev/` | composites Nuera Dev (fil de session, autorisations, diff, cartes…) — **voir [`dev/README.md`](./dev/README.md)** | `@/components/dev` |

Galeries (développement uniquement, propriétaire connecté — ou `NUERA_KIT_PUBLIC=1` sous `next dev`) :
`/kit` (ce dossier) et `/kit/composites` (`dev/`).

## Règles communes

- **Jetons uniquement** : couleurs, rayons, ombres, durées viennent de `src/styles/tokens.css` (classes Tailwind
  `bg-bg`, `text-muted`, `rounded-md`, `shadow-soft`, `duration-(--dur-fast)`…). Jamais de valeur en dur.
- **Rôles, pas teintes** : `text`, `muted`, `accent`, `border`, `bg`, `surface-raised`. Une zone sombre est un
  **scope** : `data-tone="dark"` (barre latérale, terminal, toast) — tout bascule seul. `text-on-accent` /
  `text-on-pale` = texte posé sur un aplat accent / pâle (bascule aussi).
- **Thème** : `<html data-theme="light|dark|system">` écrit au SSR depuis le cookie `nuera-theme`
  (`server/shell/theme.ts`), modifié par `useTheme()` (`hooks/useTheme.ts` → action serveur
  `setThemePreferenceAction`, enregistre `app_settings.theme` + cookie).
- **Cibles tactiles** : 44 px minimum ; les contrôles dessinés plus petits (bouton compact 36, interrupteur
  36 × 20, liens) portent la classe `nu-hit` (zone invisible de 44 px).
- **Mouvement** : `prefers-reduced-motion` respecté partout (fondu de 150 ms, silhouettes fixes).
- **Copie** : texte Figma à l'identique (apostrophe ASCII `'` des maquettes, `·` U+00B7, `…`, `−` U+2212).
  Dates et nombres : `@nuera/shared/format` (+ `formatShortDay` de `lib/format.ts`, « Mer. 4 nov. »).
- **Liens / boutons** : toute primitive cliquable (`Button`, `CompactButton`, `IconButton`, `LinkButton`) est un
  `<button>` par défaut et un lien si `href` est fourni (`external` → nouvel onglet, `rel=noopener`).

## `icons/`

| Export | Props | Figma |
|---|---|---|
| `Icon` | `name: IconName`, `size` (12–28, défaut 16), `title?` (sinon `aria-hidden`), `className` (couleur via `text-*`) | 37 icônes de la section 04 (`199:13`…`199:222`) + icônes Nuera OS (`57:13`) |
| `ICON_NAMES`, `ICON_PATHS`, `IconName` | liste / géométrie (générée depuis les exports SVG, grille 24, trait 1,8 constant à toutes les tailles) | — |

Noms : `alert archive arrow-left automatisations bell book calendar check chevron chevron-down clients clock cpu
dashboard devis edit euro external eye figma file file-diff filter folder git-branch git-commit git-pull-request
github globe2 history home key link list-checks lock messages minus monitor more panel-right paperclip pause
pipeline play plug plus projets pull refresh reglages rocket search send server shield sites smartphone sparkle
star stop support terminal trash upload wifi-off worktree x`.

## `brand/`

| Export | Props | Figma |
|---|---|---|
| `LogoNueraDev` | `tone: 'auto'\|'papier'\|'encre'` (auto = suit le scope), `size` (taille de base en px : 12 → 176 × 27,6 ; 16,8 = couverture) | `Logo Nuera Dev · papier` 201:41, `· encre` 201:80 |
| `Wordmark` | `height`, `title` (`null` si un parent nomme le logo) — `currentColor`, masque de luminance (le jour N/u est un vrai trou) | DS 08 · Logos |
| `DevBadge` | `tone`, `size` — pastille `DEV` (JetBrains Mono 700 12, 0,08em) | rail 72 px, icône S5 |

SVG statiques : `public/brand/` (`logo-nuera-dev-papier.svg`, `logo-nuera-dev-encre.svg`, `nuera-wordmark.svg`,
`icon-16|32|64|128.svg`).

## `ui/` — primitives

### Actions

| Export | Props principales | Figma |
|---|---|---|
| `Button` | `variant: 'default'\|'accent'\|'on-dark'`, `tone?: 'danger'` (lacune 1 : prêt, **inutilisé** — les confirmations restent Accent), `block`, `loading`, `loadingLabel`, `disabled`, `href`/`external` | `Button` 7:117 (socle near-black, face levée 0,22em → 0,38em au survol → 0,04em au clic) |
| `CompactButton` | `variant: 'principal'\|'secondaire'\|'discret'`, `icon?`, `size: 'md'` (36) `\|'lg'` (44, téléphone), `block`, `loading`, `disabled` (opacité 40 %), `href` | `Bouton compact` 168:6952 |
| `IconButton` | `icon`, `label` (**obligatoire**, aria-label), `variant: 'ghost'\|'outline'\|'accent'\|'tinted'`, `size: 'sm'` (36, zone 44) `\|'md'` (44), `badge?` + `badgeLabel`, `iconClassName`, `loading` | cloche D01/M01, `+` M02, menu « … » D02, `Bouton · Changer de session` S4 |
| `LinkButton` | `size: 13\|14\|15`, `tone: 'accent'\|'muted'\|'text'`, `icon?`, `trailingIcon?`, `href`/`onClick` | liens de tuile « Toutes les sessions », « Gérer », « Tout voir » |

### Libellés et statuts

| Export | Props | Figma |
|---|---|---|
| `Badge` | `tone: 'accent'\|'success'\|'warn'\|'danger'\|'neutral'` (jamais ChatGPT), `icon?` | `Badge` 57:124 |
| `StatusDot` | `tone: 'success'\|'running'\|'warn'\|'danger'\|'neutral'\|'accent'` — décoratif, **toujours suivi d'un texte** ; bascule en *on-dark* dans un scope sombre | `Dev · Point de statut` 202:478 |
| `Avatar` | `name` (initiales via `initials()`), `size: 24\|28\|32\|36\|40`, `labelled` | `Avatar` 57:125 |
| `Pastille` | `icon`, `size: 28\|32\|40\|48\|56`, `tone`, `shape: 'square'\|'circle'`, `iconSize` (D07 : 48 → icône 20, carte MCP 32 → 20) | pastilles d'en-tête de tuile, T2, T5/T6, T8 |
| `SectionLabel` | `variant: 'label'` (mono 11 caps 0,08em) `\|'eyebrow'` (mono 12 0,2em accent), `tone`, `action?` (lien à droite) | « EN COURS · 2 », « SESSIONS ACTIVES · 2 », en-têtes de tableau |
| `Kbd` | `variant: 'plain'\|'boxed'` | « ⌘K » |
| `Spinner` | `size`, `label?` | (non dessiné) |

### Surfaces

| Export | Props | Figma |
|---|---|---|
| `Card` / `Tile` | `variant: 'tile'` (rayon 28, Shadow/Soft, p 20) `\|'card'` (rayon 20, p 16) `\|'outline'` (bordure, sans ombre) `\|'inset'` (surface-raised + bordure, rayon 12), `padding`, `as` | Tuile Nuera OS, cartes téléphone, « Ce qui est sûr » |
| `TileHeader` | `icon`, `title`, `action?`, `titleAs` | `En-tête de tuile` 57:130 |
| `CodeBlock` | `command?` (`$ …`), `children` (sortie brute, jamais reformulée), `size: 'md'\|'sm'`, `tone: 'default'\|'error'`, `wrap`, `label` | `Dev · Sortie de commande` 203:373, bloc commande des autorisations |
| `KeyValueList` | `items: { label, value, mono? }[]` (`<dl>`) | tiroir D1 « ÉTAT », « CONFIGURATION » |
| `DataTable` | `columns: { key, header, width?, align?, cell, hideBelowLg? }[]`, `rows`, `getRowKey`, `caption`, `empty?`, `card` | `Tableau de l'historique` D06, tableau des projets D02 |

### Champs

| Export | Props | Figma |
|---|---|---|
| `Field` | `label`, `hint`, `error` (état Erreur + annonce), `labelAside`, `id` — câble id / aria-describedby / aria-invalid du contrôle enfant | libellé 13 + aide 12 (D03) |
| `Input` | `size: 'md'` (40) `\|'lg'` (44), `leadingIcon`, `trailing`, `invalid`, `mono`, `shellClassName` | `Dev · Champ` 202:503 (Repos / Focus 1,5 px accent / Erreur 1,5 px danger) |
| `Textarea` | `invalid`, `mono` (message de commit 13 / 19) | S3, W5 |
| `SearchField` | `shortcut?` (« ⌘K »), `placeholder` = « Rechercher… » | recherche D02 / M02 |
| `SecretField` | masqué + bouton œil (`revealable`) — pour un **nouveau** secret, jamais pré-rempli | D2 « nouveau jeton » |
| `Select` | `options: { value, label, description? }[]`, `value`/`onValueChange`, `prefix` (« Projet : »), `icon`, `size`, `name` (formulaires) — Radix | « Liste déroulante » (D06 filtres, D08 140 px) |
| `Switch` | `checked`/`onCheckedChange`, `name`, `aria-label` — Radix, `role="switch"`, zone 44 px | `Dev · Interrupteur` 202:459 |

### Navigation locale

| Export | Props | Figma |
|---|---|---|
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `TabsList variant: 'pill'` (Badges, défile au téléphone) `\|'segmented'` (Workspace téléphone) ; `TabsTrigger count?` (« Diff · 4 »), `icon?` | onglets D04 / D08, `Onglets du Workspace` M05 |
| `SegmentedControl` | `items: { value, label, icon? }[]`, `value`, `onValueChange`, `aria-label` (groupe radio) | `Barre de vue` D05 « Conversation / Terminal brut » |
| `ChipGroup` | `items`, `value`, `onValueChange`, `aria-label` (filtres Badges, sélection unique) | filtres D02 / M02 / D06 |

### Superpositions (Radix : focus piégé, Échap, voile near-black 55 %)

| Export | Props | Figma |
|---|---|---|
| `Dialog`, `DialogTrigger`, `DialogContent`, `DialogClose` | `title`, `description`, `header` (stepper), `footer`, `footerNote`, `size: 'sm'` (520) `\|'md'` (640) `\|'lg'` (680), `hideClose`, `role`, `dismissible` — ancré en bas au téléphone ; au bureau, centré sur la zone de contenu (à droite de la barre latérale ou du rail, `--overlay-start`), le voile couvre tout | `Modale · Ajouter un projet` (D03, A1–A4), W5 |
| `Drawer`, `DrawerTrigger`, `DrawerContent`, `DrawerClose` | `title`, `description`, `icon` (pastille 40), `status` (Badge), `footer` — 480 px à droite, pleine largeur au téléphone | `Tiroir` D1 / D2 |
| `Sheet`, `SheetTrigger`, `SheetContent`, `SheetClose` | `title`, `hideTitle`, `meta` (« 2 / 4 »), `description` — poignée glissable, voile, zone sûre | `Feuille · Sessions de Nuera OS` S4 |
| `DropdownMenu`, `…Trigger`, `…Content` (`width`, défaut 248, `bottom-end` + 8), `…Item` (`icon`, `destructive`, `aside`), `…LinkItem` (`href`, `external`), `…Separator`, `…Label` | — | `Menu · Atelier Lune` D02 |
| `Popover`, `PopoverTrigger`, `PopoverContent` (`width`), `PopoverClose`, `PopoverAnchor` | — | sélecteur W6, panneau de notifications |
| `Tooltip` (+ `TooltipProvider`, monté par les shells) | `content`, `side`, `align` | libellés du rail (non dessiné) |
| `ConfirmDialog` | `open`, `onOpenChange`, `tone: 'warn'\|'danger'`, `icon`, `title`, `consequences: { kind: 'kept'\|'risk', text }[]`, `children` (option, liste), `confirmLabel` (**nomme l'action**), `onConfirm` (promesse → chargement, les deux boutons désactivés ; **l'appelant ferme** après succès puis affiche le toast ; un rejet garde la fenêtre ouverte avec `error` ou, à défaut, un bandeau générique), `error`, `typedConfirmation?`, `confirmTone`, `confirmDisabled` (raison affichée au-dessus des boutons et liée au bouton : archiver un projet aux sessions actives) | T8 (520, `alertdialog`, focus initial sur « Annuler ») |
| `Toaster` (monté par le layout racine), `toast({ message, action?: { label, href?, external?, onClick? }, icon?, duration? })`, `dismissToast`, `useToastOffset(px)` | 6 s, pause au survol / focus, en bas à droite (bureau) ou au-dessus de la barre d'onglets / saisie (téléphone) ; **succès uniquement** | `Dev · Toast` 203:709, T3 |

### États (T1–T8)

| Export | Props | Figma |
|---|---|---|
| `Banner` | `tone: 'info'\|'success'\|'warn'\|'danger'`, `title`, `children` (message), `icon?` (wifi-off W7, github T7), `action?`, `dense: 'relaxed'`, `live` — persiste tant qu'il y a une suite | `Dev · Bandeau` 203:703 (T1, T3, T4, T7, A4, D2, W7) |
| `Skeleton`, `SkeletonRow`, `SkeletonList` | `rows`, `label`, `card`, `shimmer` (fixe en mouvement réduit) | `Tableau en chargement` T1 |
| `EmptyState` | `icon` (= icône de la section), `title`, `children` (pourquoi), `action` (la seule action utile), `variant: 'card'\|'plain'` | T2 |
| `ErrorPanel` | `title` (ce qui a échoué), `exitCode`, `excerpt`, `untouched` (ce qui n'a pas été touché), `raw` (sortie brute à un clic), `onRetry`/`retryLabel`/`retrying`, `actions`, `rawLabel` | T4 `Commande échouée` |
| `ProgressBar` | `value` (0–100 ou `null`), `label`, `valueText` | A2 `Barre` |
| `StepProgress` | `total`, `current`, `label` | M03 progression 3 segments |
| `Stepper` | `steps: { label }[]`, `current` (0-based) | stepper de la modale (Dépôt · Configuration · Clonage) |
| `StepList` | `items: { key, label, status: 'pending'\|'running'\|'done'\|'failed'\|'skipped', meta? }[]` (= `operations.steps`) | A2 sous-étapes |
| `Meter` | `label`, `valueLabel` (formaté), `percent` (`null` = inconnu, rien d'inventé), `tone` | jauges Processeur / Mémoire / Stockage D01 |
| `SlotMeter` | `used`, `total`, `label` | `Capacité` D06 (une case par session autorisée) |
| `UptimeBars` | `days: { date, availability (0–1 ou null), incident?, note? }[]`, `label` | `DISPONIBILITÉ · 30 JOURS` D08 |

Utilitaire : `cn()` (`@/lib/cn`, connaît les tailles `text-app-*`).

## `shell/`

Montés par les layouts `(shell)` et `(workspace)` via `AppShell` ; les pages n'ont rien à faire, sauf utiliser
les hooks et composants ci-dessous.

| Export | Props / rôle | Figma |
|---|---|---|
| `AppShell` | `data: ShellData`, `variant: 'sidebar'\|'rail'` — fournit `LiveEventsProvider`, la palette, `TooltipProvider` ; affiche **T5** à la place du contenu quand le runner ne répond pas (navigation conservée, Accueil en rouge), la bannière **T6** et la bannière de **connexion perdue** (variante `sidebar`). Variable CSS `--shell-bottom` = hauteur de la barre d'onglets (barres d'action collantes du téléphone). | shell D01–D08, D05 |
| `Sidebar` | `activeSessions`, `serverUnavailable`, `server` (props de `ServerCard`), `user`, `onOpenSearch`, `active?` | `Dev · Barre latérale` 201:732 (248 px, ESPACE / CONFIGURATION, bulle Sessions) |
| `SidebarRail` | `userName`, `serverUnavailable`, `active?` (« Sessions » dans le Workspace) | `Dev · Barre latérale repliée` 201:893 (72 px, libellés en aria-label + infobulle) |
| `TabBar` | `activeSessions`, `serverUnavailable`, `border`, `active?` — masquée dans le Workspace et sur `/projets/nouveau` | `Dev · Barre d'onglets` 202:452 |
| `ServerCard` | `name`, `location`, `availability`, `metrics`, `claudeState`, `lastContactAt` | `État du serveur` (VPS-3 · OVH Gravelines, CPU · RAM, Claude Code connecté) |
| `UserCard`, `UserMenu` | `name`, `twoFactorEnabled` ; menu : Paramètres, Se déconnecter (`signOutAction` du lot auth) | `Utilisateur` |
| `PageHeader` | `title`, `subtitle`, `actions` (bureau), `mobileAction` (44 px, téléphone) | `En-tête` D01–D08 / M01–M08 |
| `NotificationBell`, `NotificationList` | `size: 'sm'\|'md'` — cloche + panneau (popover bureau, feuille téléphone), lecture via actions serveur | `Bouton · Notifications` D01 / M01 (panneau non dessiné) |
| `CommandPalette` (`open`, `onOpenChange`, `groups?`, `providers?`), `useRegisterCommands(group)`, `useRegisterSearchProvider(provider)` | palette ⌘K / Ctrl K (cmdk), montée par `AppShell` : la navigation est toujours présente ; les fonctionnalités ajoutent, tant qu'elles sont montées, des groupes statiques (`{ id, heading, items: { id, label, description?, icon?, keywords?, href? \| perform? }[] }`) et des recherches asynchrones (`{ id, heading, minQueryLength?, search(query, signal) }`) — à mémoriser (`useMemo`) | « Rechercher… ⌘K » de la barre latérale |
| `ServerUnavailable` | `serverName`, `lastContactAt`, `statusUrl?` (`NUERA_SERVER_STATUS_URL`), `providerName?`, `onRetry`, `retrying` | **T5** 236:5335 |
| `ClaudeDisconnected`, `ClaudeDisconnectedBanner` | `state: 'disconnected'\|'wrong_method'\|'not_installed'`, `reconnectHref` (le shell passe `CLAUDE_RECONNECT_HREF`), `variant: 'card'` (pages qui exigent Claude) `\|'banner'`, `serverName?` (défaut : `app_settings.serverName` du shell) | **T6** 236:5372 |
| `ConnectionLostBanner` | `nextRetryAt`, `onRetry`, `context: 'workspace'` (copie W7) `\|'page'`, `serverName?` (idem) — alerte annoncée une fois, le compte à rebours n'est que visuel | **W7** 231:4370 |
| `ShellAvailability` | `variant: 'long'\|'short'` — « Mercredi 4 novembre 2026 · VPS-3 et Claude Code sont disponibles » / « Mer. 4 nov. · tout est disponible », en direct | en-tête D01 / M01 |
| `useShellData()`, `useOptionalShellData()` | données du layout (`ShellData`, renouvelées à chaque `router.refresh()`) ; la variante optionnelle renvoie `null` hors des shells | — |

### Temps réel — `hooks/useLiveEvents.tsx`

Un seul `EventSource` par onglet sur `/api/stream/events` (relais web du flux global du runner).
`useLiveEvents()` → `{ connection: 'connecting'|'open'|'reconnecting', runner: 'available'|'unavailable'|'unknown',
lastSignalAt, lastRunnerContactAt, nextRetryAt, attempt, metrics, claude, activeSessionIds, notifications, retryNow(),
subscribe(type, handler), markNotificationsRead(ids) }` ; `useLiveEvent(type, handler)` pour s'abonner à un type.

Événements utilisés (`@nuera/shared/events`) : `heartbeat` (preuve de vie), `stream.error` (`RUNNER_UNAVAILABLE` →
T5), `stream.reset`, `system.metrics` (carte serveur), `claude.status` (ligne Claude, T6), `session.status` (bulle
Sessions : actives = `new`, `running`, `waiting_permission`, `waiting_input`), `notification.created` (cloche).
Reconnexion : recul exponentiel 1 → 30 s (± 20 %) quand le navigateur ne joint plus l'application (W7) ;
toutes les 10 s quand l'application signale le runner injoignable (T5) ; connexion muette 2,5 battements ⇒ perdue.
Chaque nouvel `EventSource` reprend après le dernier id reçu (`?lastEventId=`, rejoué par le runner).
Retour du runner ou `stream.reset` ⇒ `router.refresh()` (données serveur relues, sans rechargement complet) ; chaque
nouvel instantané du layout resynchronise l'état (sessions actives, notifications ; les événements plus récents que
l'instantané sont conservés). Jamais de `router.refresh()` à l'aveugle hors ligne (Next ferait une navigation
complète → page d'erreur du navigateur) : après 3 échecs, une sonde du flux ; 401/403 ⇒ retour à `/connexion`.

### Autres hooks

`useTheme()` (thème Clair / Sombre / Système), `useIsDesktopNav()` / `useMediaQuery(q)` (point de rupture `nav`
900 px), `useShortcutLabel()` (« ⌘K » ou « Ctrl K »), `useNow(intervalMs, initial?)`.

### Données serveur — `server/shell/`

`getShellData(user)` (mise en cache par requête) : `app_settings` (nom, emplacement, limite de sessions),
`runner.systemMetrics()` / `runner.claudeStatus()` (4 s max ; `RUNNER_UNAVAILABLE` ⇒ `availability: 'unavailable'`,
dernier contact = dernier échantillon ou `uptime_daily.last_beat_at`), sessions actives (BD), 20 dernières
notifications. Actions serveur : `setThemePreferenceAction`, `markNotificationsReadAction`,
`markAllNotificationsReadAction` (toutes revérifient la session et l'`Origin` de la requête).
