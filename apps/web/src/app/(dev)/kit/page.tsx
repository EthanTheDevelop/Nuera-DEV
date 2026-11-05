'use client';

/**
 * /kit — gallery of the design-system primitives, the brand and the shell, in every designed state.
 * Developer-only (see (dev)/layout.tsx). This is the ONLY place where sample props are allowed: every
 * section carries the « Données d'exemple » badge. Composites (components/dev) live on /kit/composites.
 */

import { useState, type ReactNode } from 'react';
import { DevBadge, LogoNueraDev, Wordmark } from '@/components/brand';
import { Icon, ICON_NAMES } from '@/components/icons';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  ChipGroup,
  CodeBlock,
  CompactButton,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogTrigger,
  Drawer,
  DrawerContent,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorPanel,
  Field,
  IconButton,
  Input,
  Kbd,
  KeyValueList,
  LinkButton,
  Meter,
  Pastille,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  SearchField,
  SecretField,
  SectionLabel,
  SegmentedControl,
  Select,
  Sheet,
  SheetContent,
  SheetTrigger,
  SkeletonList,
  SlotMeter,
  StatusDot,
  StepList,
  StepProgress,
  Stepper,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  TileHeader,
  toast,
  Tooltip,
  TooltipProvider,
  UptimeBars,
} from '@/components/ui';
import {
  ClaudeDisconnected,
  CommandPalette,
  CommandRegistryProvider,
  ConnectionLostBanner,
  NotificationList,
  PageHeader,
  ServerCard,
  ServerUnavailable,
  Sidebar,
  SidebarRail,
  TabBar,
  UserCard,
  type ShellNotification,
} from '@/components/shell';
import { THEME_LABELS, THEME_PREFERENCES, parseThemePreference, type ThemePreference } from '@/lib/theme';

/* ----------------------------------------------------------------------------------------------- */
/* Sample data — gallery only.                                                                      */
/* ----------------------------------------------------------------------------------------------- */

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const GB = 1024 ** 3;

const SAMPLE_METRICS = {
  cpuPercent: 23,
  memoryUsedBytes: 5.1 * GB,
  memoryTotalBytes: 16 * GB,
  diskUsedBytes: 61 * GB,
  diskTotalBytes: 160 * GB,
  sampledAt: minutesAgo(0),
};

const SAMPLE_NOTIFICATIONS: ShellNotification[] = [
  {
    id: '1',
    kind: 'permission_request',
    severity: 'warning',
    title: 'Tests e2e du devis attend votre accord',
    body: 'npm run test -- e2e · Nuera OS · touchez pour répondre',
    href: null,
    read: false,
    createdAt: minutesAgo(1),
  },
  {
    id: '2',
    kind: 'session_finished',
    severity: 'success',
    title: 'Galerie photos est terminée',
    body: '3 fichiers modifiés · prête pour un commit',
    href: null,
    read: true,
    createdAt: minutesAgo(64),
  },
];

const HISTORY = [
  { id: 'h1', session: 'Galerie photos', projet: 'Atelier Lune', branche: 'feature/galerie-photos', debut: 'hier 16:20 · 48 min', statut: { tone: 'success', label: 'Terminée' }, action: { v: 'discret', label: 'Voir le résumé' } },
  { id: 'h2', session: 'Correctif tarifs mobile', projet: 'Kiné Rive Gauche', branche: 'fix/tarifs-mobile', debut: 'lun. 2 nov. 21:05 · 1 h 12', statut: { tone: 'warn', label: 'Interrompue · reprise possible' }, action: { v: 'secondaire', label: 'Reprendre' } },
  { id: 'h3', session: 'Migration Next 16', projet: 'Site Nuera Studio', branche: 'chore/next-16', debut: '28 oct. 09:40 · 2 h 40', statut: { tone: 'neutral', label: 'Archivée' }, action: { v: 'discret', label: 'Voir' } },
  { id: 'h4', session: 'Audit des contrastes', projet: 'Site Nuera Studio', branche: 'fix/contrastes', debut: '21 oct. 14:10 · 35 min', statut: { tone: 'danger', label: 'Reprise impossible' }, action: { v: 'discret', label: 'Pourquoi ?' } },
] as const;

const UPTIME = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(NOW - (29 - i) * 86_400_000);
  return {
    date: d.toISOString().slice(0, 10),
    availability: i === 23 ? 0.9986 : 1,
    incident: i === 23,
    note: i === 23 ? 'redémarrage automatique, 2 min' : undefined,
  };
});

/* ----------------------------------------------------------------------------------------------- */
/* Gallery scaffolding                                                                              */
/* ----------------------------------------------------------------------------------------------- */

function Section({ id, title, figma, children }: { id: string; title: string; figma: string; children: ReactNode }) {
  return (
    <section id={id} data-kit={id} className="flex scroll-mt-6 flex-col gap-5 border-t border-border pt-8">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 font-sans text-app-22 font-semibold text-text">{title}</h2>
        <Badge tone="neutral">Données d'exemple</Badge>
        <span className="font-mono text-app-11 text-muted">{figma}</span>
      </div>
      {children}
    </section>
  );
}

function Demo({ label, children, className, dark = false }: { label: string; children: ReactNode; className?: string; dark?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      <div
        {...(dark ? { 'data-tone': 'dark' } : {})}
        className={`flex flex-wrap items-center gap-4 rounded-lg ${dark ? 'bg-bg p-6' : 'border border-dashed border-border bg-bg p-5'} ${className ?? ''}`}
      >
        {children}
      </div>
    </div>
  );
}

const SECTIONS: Array<[string, string]> = [
  ['icones', 'Icônes'],
  ['logo', 'Logo'],
  ['boutons', 'Boutons'],
  ['badges', 'Badges et statuts'],
  ['cartes', 'Cartes et blocs'],
  ['champs', 'Champs'],
  ['onglets', 'Onglets'],
  ['superpositions', 'Superpositions'],
  ['etats', 'États (T1–T8)'],
  ['donnees', 'Jauges et données'],
  ['shell', 'Shell'],
  ['global', 'États globaux'],
];

/* ----------------------------------------------------------------------------------------------- */

export default function KitPage() {
  // Gallery only: previews a theme on <html data-theme> without saving it (Paramètres saves it with useTheme()).
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    typeof document === 'undefined' ? 'light' : parseThemePreference(document.documentElement.dataset.theme),
  );
  const setTheme = (next: ThemePreference) => {
    document.documentElement.dataset.theme = next;
    setThemeState(next);
  };
  const [view, setView] = useState<'conversation' | 'terminal'>('conversation');
  const [chip, setChip] = useState('tous');
  const [switchOn, setSwitchOn] = useState(true);
  const [switchOff, setSwitchOff] = useState(false);
  const [select, setSelect] = useState('cli');
  const [confirm, setConfirm] = useState<null | 'stop' | 'archive' | 'worktrees'>(null);
  const [palette, setPalette] = useState(false);
  const [retrying, setRetrying] = useState(false);

  return (
    <TooltipProvider delayDuration={300}>
      <CommandRegistryProvider>
        <div className="mx-auto flex max-w-[1180px] flex-col gap-10 px-4 py-8 nav:px-8">
          <header className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <LogoNueraDev tone="encre" />
              <h1 className="m-0 font-sans text-app-28 font-semibold text-text">Kit du design system</h1>
            </div>
            <p className="m-0 max-w-[760px] font-sans text-app-14 leading-5 text-muted">
              Primitives (components/ui), marque (components/brand), icônes et shell, dans leurs états Figma.
              Galerie de développement : les valeurs affichées sont des données d'exemple. Composites :{' '}
              <LinkButton href="/kit/composites" size={14}>
                /kit/composites
              </LinkButton>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-sans text-app-13 font-medium text-text">Thème</span>
              <Select
                aria-label="Thème"
                className="w-[160px]"
                value={theme}
                onValueChange={(v) => setTheme(v as ThemePreference)}
                options={THEME_PREFERENCES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
              />
              <span className="font-sans text-app-12 text-muted">aperçu, non enregistré</span>
            </div>
            <nav aria-label="Sections du kit" className="flex flex-wrap gap-2">
              {SECTIONS.map(([id, label]) => (
                <LinkButton key={id} href={`#${id}`} size={13}>
                  {label}
                </LinkButton>
              ))}
            </nav>
          </header>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="icones" title="Icônes" figma="section 04 · 37 ajouts + icônes de Nuera OS · 24 px, trait 1,8">
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2 p-0">
              {ICON_NAMES.map((name) => (
                <li key={name} className="flex flex-col items-center gap-2 rounded-md border border-border bg-bg px-2 py-3">
                  <div className="flex items-end gap-2 text-text">
                    <Icon name={name} size={16} />
                    <Icon name={name} size={20} />
                    <Icon name={name} size={24} />
                  </div>
                  <span className="font-mono text-app-11 text-muted">{name}</span>
                </li>
              ))}
            </ul>
            <Demo label="Couleur par contexte">
              <Icon name="check" size={18} className="text-success" />
              <Icon name="clock" size={18} className="text-en-cours" />
              <Icon name="alert" size={18} className="text-warn" />
              <Icon name="alert" size={18} className="text-danger" />
              <Icon name="x" size={18} className="text-muted" />
              <Icon name="terminal" size={18} className="text-accent" />
            </Demo>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="logo" title="Logo" figma="Logo Nuera Dev · papier 201:41 · encre 201:80">
            <div className="grid gap-4 nav:grid-cols-2">
              <Demo label="Papier (fonds sombres)" dark>
                <span data-kit="logo-papier">
                  <LogoNueraDev tone="papier" />
                </span>
                <LogoNueraDev tone="papier" size={16.8} />
                <DevBadge tone="papier" />
              </Demo>
              <Demo label="Encre (fonds clairs)">
                <span data-kit="logo-encre">
                  <LogoNueraDev tone="encre" />
                </span>
                <DevBadge tone="encre" />
                <Wordmark height={32} className="text-text" />
              </Demo>
            </div>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="boutons" title="Boutons" figma="Button 7:117 · Bouton compact 168:6952">
            <Demo label="Button · Default / Accent">
              <Button>Prendre rendez-vous</Button>
              <Button variant="accent">Prendre rendez-vous</Button>
              <Button variant="accent" loading>
                Réessayer maintenant
              </Button>
              <Button disabled>Annuler</Button>
              <Button variant="accent" tone="danger">
                Danger (prêt, inutilisé)
              </Button>
            </Demo>
            <Demo label="Button · On dark (section sombre)" dark>
              <Button variant="on-dark">Prendre rendez-vous</Button>
              <Button variant="accent">Accent dans une section sombre</Button>
            </Demo>
            <Demo label="Bouton compact · Principal / Secondaire / Discret">
              <CompactButton icon="check">Autoriser</CompactButton>
              <CompactButton variant="secondaire" icon="play">
                Reprendre la session
              </CompactButton>
              <CompactButton variant="discret" icon="x">
                Refuser
              </CompactButton>
              <CompactButton variant="secondaire" icon="refresh" loading>
                Relancer
              </CompactButton>
              <CompactButton disabled icon="upload">
                Commit et push
              </CompactButton>
            </Demo>
            <Demo label="Téléphone · pleine largeur 44 px" className="max-w-[390px]">
              <CompactButton size="lg" block>
                Répondre
              </CompactButton>
              <CompactButton size="lg" block variant="secondaire" icon="play">
                Reprendre la session
              </CompactButton>
            </Demo>
            <Demo label="Boutons icône · liens">
              <IconButton icon="bell" label="Notifications" variant="outline" size="sm" />
              <IconButton icon="bell" label="Notifications" variant="outline" />
              <IconButton icon="plus" label="Ajouter un projet" variant="accent" />
              <IconButton icon="more" label="Actions du projet" size="sm" iconClassName="text-muted" />
              <IconButton icon="worktree" label="Changer de session" badge={2} badgeLabel="2 sessions" />
              <IconButton icon="panel-right" label="Panneau contextuel" variant="outline" size="sm" iconClassName="text-accent" />
              <LinkButton href="#boutons">Toutes les sessions</LinkButton>
              <LinkButton href="https://github.com" external trailingIcon="external">
                Ouvrir sur GitHub
              </LinkButton>
            </Demo>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="badges" title="Badges et statuts" figma="Badge 57:124 · Dev · Point de statut 202:478 · Avatar 57:125">
            <Demo label="Badge · 5 tons (jamais ChatGPT)">
              <span data-kit="badges" className="flex flex-wrap gap-2">
                <Badge tone="accent">En cours</Badge>
                <Badge tone="success">À jour</Badge>
                <Badge tone="warn">2 en retard</Badge>
                <Badge tone="danger">Expiré</Badge>
                <Badge tone="neutral">Mode : demander avant d'agir</Badge>
              </span>
            </Demo>
            <Demo label="Point de statut (toujours avec un texte)">
              {(
                [
                  ['success', 'Succès'],
                  ['running', 'En cours'],
                  ['warn', 'Alerte'],
                  ['danger', 'Danger'],
                  ['neutral', 'Neutre'],
                  ['accent', 'Accent'],
                ] as const
              ).map(([tone, label]) => (
                <span key={tone} className="flex items-center gap-2 font-sans text-app-13 text-text">
                  <StatusDot tone={tone} /> {label}
                </span>
              ))}
            </Demo>
            <Demo label="Avatar · Pastilles">
              <Avatar name="Nezar" size={24} />
              <Avatar name="Nezar" size={28} />
              <Avatar name="Nezar" size={32} />
              <Avatar name="Nezar" size={36} />
              <Avatar name="Ethan Ngo" size={40} />
              <Pastille icon="server" />
              <Pastille icon="stop" size={40} tone="warn" />
              <Pastille icon="trash" size={40} tone="danger" />
              <Pastille icon="wifi-off" size={48} tone="danger" />
              <Pastille icon="projets" size={56} shape="circle" />
              <Kbd>⌘K</Kbd>
              <Kbd variant="boxed">Échap</Kbd>
            </Demo>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="cartes" title="Cartes et blocs" figma="Tuile · En-tête de tuile 57:130 · Dev · Sortie de commande 203:373">
            <div className="grid gap-6 nav:grid-cols-3">
              <Card data-kit="tile" className="gap-4">
                <TileHeader icon="server" title="Serveur VPS-3" action={<Badge tone="success">En ligne</Badge>} />
                <Meter label="Processeur" valueLabel="23 %" percent={23} />
                <Meter label="Mémoire" valueLabel="5,1 / 16 Go" percent={31.9} />
                <Meter label="Stockage" valueLabel="61 / 160 Go" percent={38.1} />
              </Card>
              <Card className="gap-3">
                <TileHeader icon="history" title="Reprise rapide" action={<LinkButton href="#cartes">Toutes les sessions</LinkButton>} />
                <Card variant="inset" className="gap-1">
                  <SectionLabel>Dernière instruction</SectionLabel>
                  <p className="m-0 font-sans text-app-13 leading-[18px] text-text">
                    « Termine le module pipeline du CRM : colonnes glissables, total par étape et tests unitaires. »
                  </p>
                </Card>
                <CompactButton icon="play">Reprendre la session</CompactButton>
              </Card>
              <Card variant="card" className="gap-2">
                <SectionLabel action={<LinkButton href="#cartes">Tout voir</LinkButton>}>Sessions actives · 2</SectionLabel>
                <p className="m-0 font-sans text-app-13 text-muted">Carte téléphone (rayon 20, Shadow/Soft, padding 16).</p>
              </Card>
            </div>
            <div className="grid gap-4 nav:grid-cols-2">
              <CodeBlock command="npm run test -- crm" label="Sortie de npm run test">
                {` ✓ pipeline-totals.test.ts (6 tests) 41 ms
 ✓ PipelineBoard.test.tsx (4 tests) 212 ms

 Test Files  2 passed (2)
      Tests  10 passed (10)`}
              </CodeBlock>
              <div className="flex flex-col gap-3">
                <CodeBlock size="sm" command="npm run test -- crm" />
                <CodeBlock tone="error" wrap>
                  {"Type error: Property 'amount' does not exist on type 'Deal'."}
                </CodeBlock>
              </div>
            </div>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="champs" title="Champs" figma="Dev · Champ 202:503 · Dev · Interrupteur 202:459">
            <div className="grid gap-6 nav:grid-cols-2">
              <div className="flex flex-col gap-4">
                <Field label="Branche de départ" hint="La branche par défaut du dépôt.">
                  <Input mono defaultValue="main" leadingIcon="git-branch" />
                </Field>
                <Field label="Destination sur VPS-3" error="Ce dossier existe déjà et n'est pas vide.">
                  <Input mono defaultValue="/srv/dev/roux-conseil" leadingIcon="folder" />
                </Field>
                <SearchField aria-label="Rechercher un projet" placeholder="Rechercher un projet…" shortcut="⌘K" />
                <SearchField aria-label="Recherche (téléphone)" size="lg" />
              </div>
              <div className="flex flex-col gap-4">
                <Field label="Nouveau jeton Coolify" hint="Limité au périmètre de développement. Jamais renvoyé au navigateur.">
                  <SecretField placeholder="Coller le jeton…" leadingIcon="key" />
                </Field>
                <Field label="Message de commit" labelAside={<Badge>Proposé par Claude</Badge>}>
                  <Textarea mono defaultValue="crm : ajoute le tableau glissable et les totaux par étape" rows={2} />
                </Field>
                <Field label="Modèle par défaut">
                  <Select
                    value={select}
                    onValueChange={setSelect}
                    options={[
                      { value: 'cli', label: 'Défaut du CLI' },
                      { value: 'opus', label: 'Opus', description: 'claude-opus' },
                      { value: 'sonnet', label: 'Sonnet', description: 'claude-sonnet' },
                    ]}
                  />
                </Field>
                <Select aria-label="Filtrer par projet" prefix="Projet : " defaultValue="tous" className="w-[180px]" options={[{ value: 'tous', label: 'tous' }, { value: 'nuera-os', label: 'Nuera OS' }]} />
                <div data-kit="switches" className="flex items-center gap-6">
                  <label className="flex items-center gap-3 font-sans text-app-14 text-text">
                    <Switch checked={switchOn} onCheckedChange={setSwitchOn} /> Pousser sur origin
                  </label>
                  <label className="flex items-center gap-3 font-sans text-app-14 text-text">
                    <Switch checked={switchOff} onCheckedChange={setSwitchOff} /> Ouvrir une pull request
                  </label>
                  <Switch aria-label="Interrupteur désactivé" disabled defaultChecked />
                </div>
              </div>
            </div>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="onglets" title="Onglets" figma="Badges en onglets (D04, D08) · Onglets du Workspace (M05) · Barre de vue (D05)">
            <Tabs defaultValue="ensemble" className="flex flex-col gap-3">
              <TabsList aria-label="Sections des paramètres">
                <TabsTrigger value="ensemble">Vue d'ensemble</TabsTrigger>
                <TabsTrigger value="compte">Compte et sécurité</TabsTrigger>
                <TabsTrigger value="claude">Claude Code</TabsTrigger>
                <TabsTrigger value="serveur">Serveur</TabsTrigger>
                <TabsTrigger value="prefs">Préférences</TabsTrigger>
              </TabsList>
              <TabsContent value="ensemble" className="font-sans text-app-13 text-muted">
                Onglet actif = Badge Accent, les autres = Badge Neutre.
              </TabsContent>
            </Tabs>
            <div className="max-w-[390px]">
              <Tabs defaultValue="session">
                <TabsList variant="segmented" aria-label="Workspace">
                  <TabsTrigger value="session">Session</TabsTrigger>
                  <TabsTrigger value="fichiers">Fichiers</TabsTrigger>
                  <TabsTrigger value="diff" count={4}>
                    Diff
                  </TabsTrigger>
                  <TabsTrigger value="git">Git</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <SegmentedControl
                aria-label="Vue"
                value={view}
                onValueChange={setView}
                items={[
                  { value: 'conversation', label: 'Conversation', icon: 'messages' },
                  { value: 'terminal', label: 'Terminal brut', icon: 'terminal' },
                ]}
              />
              <ChipGroup
                aria-label="Filtrer les projets"
                value={chip}
                onValueChange={setChip}
                items={[
                  { value: 'tous', label: 'Tous · 5' },
                  { value: 'favoris', label: 'Favoris' },
                  { value: 'sessions', label: 'Avec sessions' },
                ]}
              />
            </div>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="superpositions" title="Superpositions" figma="Fenêtre + Voile · Tiroir (D1) · Feuille (S4) · Menu (D02) · Toast 203:709">
            <Demo label="Ouvrir">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="accent">Fenêtre</Button>
                </DialogTrigger>
                <DialogContent
                  title="Ajouter un projet"
                  description="Le dépôt est cloné sur VPS-3, là où Claude Code travaille."
                  header={<Stepper steps={[{ label: 'Dépôt' }, { label: 'Configuration' }, { label: 'Clonage' }]} current={1} />}
                  footerNote="L'accès GitHub passe par l'application installée."
                  footer={
                    <>
                      <Button>Retour</Button>
                      <Button variant="accent">Cloner sur VPS-3</Button>
                    </>
                  }
                >
                  <Field label="Nom">
                    <Input defaultValue="Roux Conseil" />
                  </Field>
                </DialogContent>
              </Dialog>
              <Drawer>
                <DrawerTrigger asChild>
                  <Button>Tiroir</Button>
                </DrawerTrigger>
                <DrawerContent
                  title="Figma"
                  description="serveur MCP · HTTP distant"
                  icon="figma"
                  status={<Badge tone="success">Connecté</Badge>}
                  footer={<CompactButton variant="secondaire" icon="refresh">Vérifier</CompactButton>}
                >
                  <SectionLabel>Configuration</SectionLabel>
                  <KeyValueList
                    items={[
                      { label: 'Transport', value: 'HTTP distant' },
                      { label: 'Authentification', value: 'autorisation Figma (OAuth)', mono: false },
                    ]}
                  />
                </DrawerContent>
              </Drawer>
              <Sheet>
                <SheetTrigger asChild>
                  <Button>Feuille</Button>
                </SheetTrigger>
                <SheetContent title="Sessions de Nuera OS" meta="2 / 4">
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    <li className="flex min-h-16 items-center gap-3 rounded-md bg-accent-pale p-3">
                      <StatusDot tone="warn" />
                      <span className="flex-1 font-sans text-app-15 font-semibold text-text">Module CRM · pipeline</span>
                      <Badge tone="warn">Autorisation</Badge>
                    </li>
                    <li className="flex min-h-16 items-center gap-3 rounded-md p-3">
                      <StatusDot tone="running" />
                      <span className="flex-1 font-sans text-app-15 font-semibold text-text">Tests e2e du devis</span>
                      <Badge>En cours</Badge>
                    </li>
                  </ul>
                </SheetContent>
              </Sheet>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton icon="more" label="Menu · Atelier Lune" variant="outline" size="sm" iconClassName="text-muted" />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem icon="star">Retirer des favoris</DropdownMenuItem>
                  <DropdownMenuItem icon="refresh">Synchroniser maintenant</DropdownMenuItem>
                  <DropdownMenuItem icon="git-branch">Nouvelle branche…</DropdownMenuItem>
                  <DropdownMenuItem icon="terminal">Nouvelle session ici</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem icon="archive" destructive>
                    Archiver le projet…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button>Panneau flottant</Button>
                </PopoverTrigger>
                <PopoverContent className="p-4" width={320}>
                  <p className="m-0 font-sans text-app-14 text-text">Popover sur clair (rayon 20, Shadow/Float).</p>
                </PopoverContent>
              </Popover>
              <Tooltip content="Accueil">
                <IconButton icon="home" label="Accueil" variant="outline" size="sm" />
              </Tooltip>
              <Button onClick={() => toast({ message: 'Commit poussé sur origin/feature/crm-core', action: { label: 'Voir sur GitHub', href: 'https://github.com', external: true } })}>
                Toast
              </Button>
              <Button onClick={() => setPalette(true)}>Palette ⌘K</Button>
            </Demo>
            <Demo label="Confirmations (T8)">
              <Button variant="accent" onClick={() => setConfirm('stop')}>
                Arrêter la session
              </Button>
              <Button variant="accent" onClick={() => setConfirm('archive')}>
                Archiver
              </Button>
              <Button variant="accent" onClick={() => setConfirm('worktrees')}>
                Supprimer 2 worktrees
              </Button>
            </Demo>
            <ConfirmDialog
              open={confirm === 'stop'}
              onOpenChange={(o) => setConfirm(o ? 'stop' : null)}
              icon="stop"
              title="Arrêter « Module CRM · pipeline » ?"
              consequences={[
                { kind: 'risk', text: "Claude Code reçoit Échap puis s'arrête, même au milieu d'une étape." },
                { kind: 'kept', text: 'Les fichiers modifiés et le worktree crm-core sont conservés.' },
                { kind: 'kept', text: 'La conversation reste reprenable depuis Sessions.' },
              ]}
              confirmLabel="Arrêter la session"
              onConfirm={() => new Promise<void>((resolve) => setTimeout(() => { setConfirm(null); resolve(); }, 900))}
            />
            <ConfirmDialog
              open={confirm === 'archive'}
              onOpenChange={(o) => setConfirm(o ? 'archive' : null)}
              icon="archive"
              title="Archiver Atelier Lune ?"
              consequences={[
                { kind: 'kept', text: 'Le projet quitte la liste ; il reste dans Archivés.' },
                { kind: 'kept', text: "Le dépôt GitHub n'est jamais touché." },
                { kind: 'risk', text: '1 session terminée sera archivée avec lui.' },
              ]}
              confirmLabel="Archiver"
              onConfirm={() => setConfirm(null)}
            >
              <label className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5 font-sans text-app-13 text-text">
                <input type="checkbox" className="size-[18px] accent-[var(--accent)]" /> Supprimer aussi le clone de VPS-3 (2,1 Go)
              </label>
            </ConfirmDialog>
            <ConfirmDialog
              open={confirm === 'worktrees'}
              onOpenChange={(o) => setConfirm(o ? 'worktrees' : null)}
              tone="danger"
              icon="trash"
              title="Supprimer 2 worktrees inactifs ?"
              consequences={[
                { kind: 'kept', text: 'Libère 1,8 Go sur VPS-3.' },
                { kind: 'risk', text: "Un worktree avec des modifications non commitées est exclu d'office." },
                { kind: 'risk', text: 'Les sessions liées ne pourront plus être reprises.' },
              ]}
              confirmLabel="Supprimer 2 worktrees"
              onConfirm={() => setConfirm(null)}
              error="La suppression a échoué : le worktree contrastes est verrouillé."
            />
            <CommandPalette open={palette} onOpenChange={setPalette} />
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="etats" title="États (T1–T8)" figma="Dev · Bandeau 203:703 · T1 · T2 · T3 · T4">
            <div data-kit="banners" className="flex max-w-[640px] flex-col gap-3">
              <Banner tone="info" title="Synchronisation en cours" live>
                Récupération de 3 commits depuis origin/main…
              </Banner>
              <Banner tone="success" title="Projet cloné sur VPS-3" action={<CompactButton variant="secondaire">Ouvrir</CompactButton>}>
                nuera-os est prêt dans /srv/dev/nuera-os.
              </Banner>
              <Banner tone="warn" title="Autorisation GitHub bientôt expirée" action={<CompactButton variant="secondaire">Renouveler</CompactButton>}>
                Renouvelez l'accès avant le 12 novembre.
              </Banner>
              <Banner tone="danger" title="La synchronisation a échoué" action={<CompactButton variant="secondaire" icon="refresh">Réessayer</CompactButton>}>
                origin/main n'a pas pu être récupéré : délai dépassé.
              </Banner>
              <Banner
                tone="danger"
                icon="github"
                dense="relaxed"
                title="L'accès GitHub a été retiré"
                action={<CompactButton variant="secondaire" icon="external">Réautoriser sur GitHub</CompactButton>}
              >
                Synchronisation, push et pull requests suspendus. Le travail local continue.
              </Banner>
            </div>
            <div data-kit="skeleton" className="max-w-[656px]">
              <SkeletonList rows={4} />
            </div>
            <div data-kit="empty" className="grid gap-5 nav:grid-cols-3">
              <EmptyState icon="projets" title="Aucun projet pour l'instant" action={<Button variant="accent">Ajouter un projet</Button>}>
                Ajoutez un dépôt GitHub : il sera cloné sur VPS-3, prêt pour Claude Code.
              </EmptyState>
              <EmptyState icon="terminal" title="Aucune session en cours" action={<CompactButton icon="plus">Nouvelle session</CompactButton>}>
                Démarrez-en une depuis un projet. Elle continue même navigateur fermé.
              </EmptyState>
              <EmptyState icon="plug" title="Aucun serveur MCP" action={<CompactButton variant="secondaire" icon="plus">Ajouter un serveur MCP</CompactButton>}>
                Ajoutez Figma, GitHub ou Coolify, puis activez-les projet par projet.
              </EmptyState>
            </div>
            <div className="max-w-[656px]">
              <ErrorPanel
                title="npm run build a échoué"
                exitCode={1}
                excerpt="Type error: Property 'amount' does not exist on type 'Deal'. · src/modules/crm/pipeline-totals.ts:11"
                untouched="Rien n'a été écrasé."
                raw={"> nuera-os@0.1.0 build\n> next build\n\nType error: Property 'amount' does not exist on type 'Deal'.\n  11 |   return deals.reduce((sum, d) => sum + d.amount, 0);"}
                onRetry={() => toast('Relance demandée (exemple)')}
                actions={<CompactButton>Demander à Claude de corriger</CompactButton>}
              />
            </div>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="donnees" title="Jauges et données" figma="A2 Barre · M03 Progression · D06 Capacité · D08 Disponibilité · D06 Tableau">
            <div className="grid gap-6 nav:grid-cols-2">
              <Card variant="outline" className="gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex-1 font-sans text-app-16 font-semibold text-text">Clonage de nuera-studio/roux-conseil</span>
                  <Badge>64 %</Badge>
                </div>
                <ProgressBar value={64} label="Clonage de nuera-studio/roux-conseil" />
                <StepList
                  items={[
                    { key: 'clone', label: 'Cloner le dépôt', status: 'done', meta: '84 Mo · 12 s' },
                    { key: 'npm', label: 'Installer les dépendances (npm ci)', status: 'running', meta: 'en cours · 31 s' },
                    { key: 'md', label: 'Lire CLAUDE.md et détecter les commandes', status: 'pending', meta: 'en attente' },
                  ]}
                />
                <StepProgress total={3} current={1} label="Étape" />
              </Card>
              <Card variant="outline" className="gap-4">
                <div className="flex flex-col gap-1">
                  <span className="font-sans text-app-15 font-semibold text-text">2 sessions actives sur 4 autorisées</span>
                  <span className="font-sans text-app-12 text-muted">Limite réglable dans Paramètres · Serveur</span>
                </div>
                <SlotMeter used={2} total={4} label="2 sessions actives sur 4 autorisées" />
                <div className="flex items-center justify-between">
                  <SectionLabel>Disponibilité · 30 jours</SectionLabel>
                  <span className="font-mono text-app-12 font-medium text-text">99,95 %</span>
                </div>
                <UptimeBars days={UPTIME} label="Disponibilité sur 30 jours" />
              </Card>
            </div>
            <DataTable
              caption="Historique des sessions"
              rows={HISTORY}
              getRowKey={(r) => r.id}
              columns={[
                {
                  key: 'session',
                  header: 'SESSION',
                  cell: (r) => (
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      <Icon name="terminal" size={16} className="text-muted" />
                      <span className="truncate text-app-14">{r.session}</span>
                    </span>
                  ),
                },
                { key: 'projet', header: 'PROJET', width: 140, cell: (r) => r.projet },
                {
                  key: 'branche',
                  header: 'BRANCHE',
                  width: 170,
                  hideBelowLg: true,
                  cell: (r) => (
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-app-11 text-muted">
                      <Icon name="git-branch" size={13} />
                      <span className="truncate">{r.branche}</span>
                    </span>
                  ),
                },
                { key: 'debut', header: 'DÉBUT · DURÉE', width: 160, hideBelowLg: true, cell: (r) => <span className="text-muted">{r.debut}</span> },
                { key: 'statut', header: 'STATUT', width: 200, cell: (r) => <Badge tone={r.statut.tone}>{r.statut.label}</Badge> },
                {
                  key: 'action',
                  header: 'ACTION',
                  width: 120,
                  align: 'right',
                  cell: (r) => <CompactButton variant={r.action.v}>{r.action.label}</CompactButton>,
                },
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="shell" title="Shell" figma="Dev · Barre latérale 201:732 · repliée 201:893 · Barre d'onglets 202:452">
            <div className="flex flex-wrap items-start gap-6">
              <div data-kit="sidebar" className="h-[760px] overflow-hidden rounded-lg">
                <Sidebar
                  className="relative h-full"
                  active="accueil"
                  activeSessions={2}
                  onOpenSearch={() => setPalette(true)}
                  user={{ name: 'Nezar', twoFactorEnabled: true }}
                  server={{
                    name: 'VPS-3',
                    location: 'OVH Gravelines',
                    availability: 'available',
                    metrics: SAMPLE_METRICS,
                    claudeState: 'connected',
                    lastContactAt: SAMPLE_METRICS.sampledAt,
                  }}
                />
              </div>
              <div data-kit="rail" className="h-[760px] overflow-hidden rounded-lg">
                <SidebarRail className="relative h-full" active="sessions" userName="Nezar" />
              </div>
              <div className="flex flex-col gap-4">
                <div data-tone="dark" className="flex w-[248px] flex-col gap-3 rounded-lg bg-near-black p-4">
                  <ServerCard name="VPS-3" location="OVH Gravelines" availability="unavailable" metrics={null} claudeState="unknown" lastContactAt={minutesAgo(3)} />
                  <ServerCard name="VPS-3" location="OVH Gravelines" availability="available" metrics={SAMPLE_METRICS} claudeState="disconnected" lastContactAt={null} />
                  <ServerCard name="VPS-3" location={null} availability="unknown" metrics={null} claudeState="unknown" lastContactAt={null} />
                  <UserCard name="Nezar" twoFactorEnabled />
                </div>
              </div>
            </div>
            <div data-kit="tabbar" className="w-[390px] overflow-hidden rounded-lg border border-border">
              <TabBar className="relative" active="accueil" activeSessions={2} />
            </div>
            <div className="w-[390px] overflow-hidden rounded-lg border border-border">
              <TabBar className="relative" active="sessions" activeSessions={2} serverUnavailable />
            </div>
            <Card variant="outline" className="gap-4">
              <PageHeader
                title="Bonjour Nezar"
                subtitle="Mercredi 4 novembre 2026 · VPS-3 et Claude Code sont disponibles"
                actions={
                  <>
                    <IconButton icon="bell" label="Notifications" variant="outline" size="sm" />
                    <Button variant="accent">Nouvelle session</Button>
                  </>
                }
                mobileAction={<IconButton icon="bell" label="Notifications" variant="outline" />}
              />
            </Card>
            <div className="max-w-[380px] rounded-lg border border-border bg-bg p-2 shadow-float">
              <NotificationList items={SAMPLE_NOTIFICATIONS} unread={1} onOpenItem={() => undefined} onMarkAll={() => undefined} now={NOW} />
            </div>
          </Section>

          {/* ------------------------------------------------------------------------------------ */}
          <Section id="global" title="États globaux" figma="T5 236:5335 · T6 236:5372 · W7 231:4370">
            <div data-kit="t5">
              <ServerUnavailable
                serverName="VPS-3"
                lastContactAt={minutesAgo(3)}
                statusUrl="https://www.ovhcloud.com/fr/"
                providerName="OVH"
                retrying={retrying}
                onRetry={() => {
                  setRetrying(true);
                  setTimeout(() => setRetrying(false), 1500);
                }}
              />
            </div>
            <div data-kit="t6">
              <ClaudeDisconnected state="disconnected" reconnectHref="#global" />
            </div>
            <div className="flex max-w-[908px] flex-col gap-3">
              <ClaudeDisconnected state="disconnected" reconnectHref="#global" variant="banner" />
              <div data-kit="w7">
                <ConnectionLostBanner nextRetryAt={NOW + 4_000} onRetry={() => undefined} />
              </div>
              <ConnectionLostBanner nextRetryAt={null} onRetry={() => undefined} context="page" />
            </div>
          </Section>
        </div>
      </CommandRegistryProvider>
    </TooltipProvider>
  );
}
