# `components/terminal` — terminal partagé (xterm.js)

Terminal du navigateur relié à un vrai terminal du runner (PTY sur le serveur de l'espace) : « Terminal brut » d'une session (W2),
shell d'un worktree, `claude auth login` (« Se reconnecter dans un terminal », T6 / D08), `/status` (« Ouvrir
/status », D08) et connexion d'un serveur MCP (« Reconnecter », Intégrations). Le web ne lance jamais rien
lui-même : tout passe par le runner (`@/server/terminals`, `@/server/mcp`, sessions).

- Import : `import { TerminalView, TerminalDialog, useTerminalLauncher, claudeLoginTerminal, … } from '@/components/terminal'`.
- Client uniquement : xterm (`@xterm/xterm` 6 + `addon-fit`, `addon-unicode11`, `addon-web-links`) est importé
  dynamiquement dans un effet — aucun rendu côté serveur, aucun plantage SSR.
- Ton sombre de la collection Color (`data-tone="dark"`) : thème xterm construit depuis les tokens
  (`--bg`, `--text`, `--muted`, `--accent`, `--danger-on-dark`…), JetBrains Mono 13 / 21 au bureau, 11 / 17 au
  téléphone (≈ 50 colonnes à 390 px). Aucune couleur en dur.
- Jamais d'octet du terminal dans un journal (console comprise) : les terminaux de connexion portent le code collé
  par le propriétaire.

## Inventaire

| Export | Props / signature | Rôle |
|---|---|---|
| `TerminalView` | `terminalId`, `streamUrl?` (déf. `/api/stream/terminals/<id>`), `inputUrl?` (`/api/terminals/<id>/input`), `resizeUrl?` (`/api/terminals/<id>/resize`), `readOnly?`, `autoFocus?`, `className?` (donner la hauteur : `flex-1`, `h-[60dvh]`… ; min. 240 px), `fontSize?`, `onExit?(code)`, `onStateChange?(state)`, `label?` (nom accessible, déf. « Terminal »), `keyBar?: boolean \| 'auto'` | Le terminal lui-même. `state` ∈ `connecting` \| `live` \| `reconnecting` \| `exited` \| `error`, aussi exposé en `data-terminal-state`. |
| `TerminalDialog` | `open`, `onOpenChange`, `title`, `description?`, `create: () => Promise<{ terminalId }>`, `privacyNote?`, `onExit?(code)`, `label?` | Fenêtre (Dialog au bureau, Sheet au téléphone) : crée le terminal à l'ouverture, le ferme (DELETE) à la fermeture ou quand la page s'en va. Échap appartient au terminal (pris par `TerminalView` avant la fenêtre, feuille comprise) : seule « Fermer » ferme. La mise en page (fenêtre / feuille) est figée tant qu'elle est ouverte : passer sous 900 px ne ferme pas le terminal. Échec d'ouverture → `ErrorPanel` (T4) avec « Réessayer ». |
| `useTerminalLauncher()` | → `{ open(launch), close(), isOpen, dialog }` | Un seul `TerminalDialog` piloté par état pour une page à plusieurs boutons « ouvrir un terminal ». Rendre `dialog` une fois. |
| `claudeLoginTerminal({ serverName?, onExit? })` | → `TerminalLaunch` | `claude auth login` (privé, note de confidentialité). |
| `claudeStatusTerminal({ serverName?, onExit? })` | → `TerminalLaunch` | CLI officiel dans un dossier de travail : le propriétaire tape `/status` (privé). |
| `mcpLoginTerminal({ name, label }, { serverName?, onExit? })` | → `TerminalLaunch` | `claude mcp login <nom>` via `POST /api/integrations/mcp/[server]/login` (privé). |
| `shellTerminal({ id, name }, { serverName?, onExit? })` | → `TerminalLaunch` | Shell d'un worktree actif. |
| `TERMINAL_PRIVACY_NOTE` | `string` | « Rien de ce qui s'affiche ou se tape ici n'est enregistré : ni journal, ni historique, tout est effacé à la fermeture. » |
| `createTerminal(body)`, `fetchTerminal(id)`, `closeTerminalRequest(id, { keepalive? })`, `startMcpLoginTerminal(name)`, `terminalUrls(id)`, `TerminalApiError` | | Appels navigateur des routes (erreurs = message français du corps `{ error }`, `untouched`, `raw` pour T4). |

## Câblage

```tsx
// Paramètres · Claude Code (D08, T6)
const terminal = useTerminalLauncher();
const serverName = useOptionalShellData()?.server.name; // serveur de l'espace (« VPS-3 » pour le serveur par défaut)
<CompactButton variant="discret" icon="refresh" onClick={() => terminal.open(claudeLoginTerminal({ serverName, onExit: () => router.refresh() }))}>
  Se reconnecter dans un terminal
</CompactButton>
<CompactButton variant="secondaire" icon="terminal" onClick={() => terminal.open(claudeStatusTerminal({ serverName }))}>
  Ouvrir /status
</CompactButton>
{terminal.dialog}

// Intégrations · serveur MCP OAuth « Reconnecter »
terminal.open(mcpLoginTerminal({ name: server.name, label: server.label }, { serverName, onExit: () => router.refresh() }));

// Workspace · « Terminal brut » d'une session (W2) : le terminal appartient à la session (runner
// `GET /v1/sessions/:id/terminal` → TerminalDto, via une route du lot Workspace) ; ne pas le fermer.
<TerminalView terminalId={sessionTerminal.id} label="Terminal brut de la session" className="flex-1" autoFocus />
```

- Comportement : rend `terminal.snapshot` (écran + historique sérialisés, toujours en premier, aussi après chaque
  reconnexion : rien n'est rejoué) puis `terminal.data` ; suit `terminal.resize` (dernier client qui redimensionne
  gagne ; un onglet reprend la taille quand il reprend le clavier) et `terminal.exit` (« Processus terminé · code N »).
- Saisie : regroupée (~10 ms), dans l'ordre, une requête à la fois ; Échap / Ctrl+C seuls partent seuls et tout de
  suite (le runner y voit « Interrompre » pour une session). Échec → « Saisie non transmise : vérifiez la connexion,
  puis retapez. » (rien n'est rejoué en retard).
- Taille : `ResizeObserver` + envoi différé (120 ms) avec un `clientId` par onglet.
- Reconnexion : 1 → 30 s (± 20 %), 10 s quand le runner ne répond pas (`stream.error` RUNNER_UNAVAILABLE →
  « VPS-3 ne répond pas · nouvel essai dans N s »), chien de garde de silence (2,5 battements), reprise immédiate
  au retour en ligne / au premier plan, « Réessayer maintenant ». 401 / 403 / 404 sont définitifs (`error`).
- Copier / coller : Ctrl+Maj+C, Ctrl+C avec une sélection, Ctrl+V / Maj+Inser (⌘C / ⌘V natifs sur macOS) ; liens
  `http(s)` seulement, nouvel onglet `noopener,noreferrer`.
- Téléphone (ou écran tactile) : barre de touches Échap, Ctrl+C, Tab, flèches (+ « Coller » en contexte sécurisé),
  cibles de 44 px, le focus reste sur le terminal.
- Accessibilité : groupe nommé (`label`), saisie nommée « Saisie · <label> », région `aria-live="polite"` qui
  annonce connexion, perte, reconnexion et fin du processus ; `prefers-reduced-motion` coupe le clignotement du curseur.

## Fichiers

- `protocol.ts` — logique pure testée (`protocol.test.ts`) : lecture SSE, événements du flux, temporisation de
  reconnexion, `InputBatcher`, bornes de taille, séquences de touches, raccourcis presse-papiers, liens, hauteur de
  ligne, thème depuis les tokens, textes d'état.
- `connection.ts` — `TerminalConnection` (flux `fetch`, machine d'états de reconnexion), testée avec de faux flux
  (`connection.test.ts`).
- `dom.ts` — lecture des tokens et de la police dans le DOM, mesure de cellule, `clientId` par onglet.
- `api.ts`, `presets.ts`, `useTerminalLauncher.tsx`, `TerminalView.tsx`, `TerminalDialog.tsx`.
- Démo de développement : `/kit/terminal` (vrais terminaux du runner : `/status` intégré, fenêtres de connexion,
  shell d'un worktree actif). Spécification Playwright : `apps/web/e2e/terminal.spec.ts`.
