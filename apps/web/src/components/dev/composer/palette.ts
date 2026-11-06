/**
 * Palette « / » and « @ » of the composers (pure, tested). Selecting an item only inserts text into
 * the field — the official CLI interprets slash commands, skills and `@<chemin>` mentions when the
 * instruction is sent. Nothing is ever sent from the palette.
 */

export type PaletteGroup = 'commands' | 'skills' | 'mcp' | 'files';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  /** Shown in mono (`/compact`, `revue`, `src/index.ts`). */
  label: string;
  description: string | null;
  /** Text inserted in place of the typed trigger (`/compact `, `@src/`). */
  insert: string;
  /** A folder: inserting keeps the palette open on its content. */
  folder?: boolean;
  /** Extra words the search also matches (French name of a command…). */
  keywords?: string;
}

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  commands: 'Commandes du CLI',
  skills: 'Skills',
  mcp: 'Outils MCP du projet',
  files: 'Fichiers du worktree',
};

export const PALETTE_COPY = {
  button: 'Commandes, skills et fichiers',
  search: 'Rechercher une commande, un skill… (@ pour un fichier)',
  title: "Insérer dans l'instruction",
  empty: 'Aucun résultat.',
  loadingFiles: 'Lecture du dossier…',
  filesUnavailable: 'Fichiers du worktree indisponibles.',
  terminal: "s'ouvre dans le terminal de la session",
  hint: "Entrée ou Tab insère · Échap ferme · rien n'est envoyé",
} as const;

/**
 * Interactive commands of the official CLI that make sense from a phone or a browser (docs
 * « Slash commands »). No cost or usage command (règle 1 : aucune métrique de coût ou de quota).
 * `terminal`: the CLI answers with a menu or a screen of its own, visible in the raw terminal.
 */
export const CURATED_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  keywords: string;
  args?: boolean;
  terminal?: boolean;
}> = [
  {
    name: 'compact',
    description: 'Résumer la conversation pour libérer du contexte (consigne facultative)',
    keywords: 'compacter résumer contexte',
    args: true,
  },
  {
    name: 'clear',
    description: 'Repartir sur une conversation vide (le worktree reste)',
    keywords: 'effacer vider nouvelle conversation',
  },
  {
    name: 'model',
    description: 'Changer de modèle (opus, sonnet, haiku…)',
    keywords: 'modèle',
    args: true,
  },
  {
    name: 'review',
    description: 'Relire une pull request',
    keywords: 'revue relire pull request',
    args: true,
  },
  {
    name: 'security-review',
    description: 'Revue de sécurité des modifications de la branche',
    keywords: 'sécurité revue',
  },
  {
    name: 'init',
    description: 'Créer ou compléter CLAUDE.md pour ce dépôt',
    keywords: 'claude.md initialiser',
  },
  {
    name: 'context',
    description: "Voir l'occupation du contexte",
    keywords: 'contexte',
    terminal: true,
  },
  {
    name: 'memory',
    description: 'Modifier les fichiers de mémoire (CLAUDE.md)',
    keywords: 'mémoire',
    terminal: true,
  },
  {
    name: 'mcp',
    description: 'Serveurs MCP de la session et leur état',
    keywords: 'serveurs outils',
    terminal: true,
  },
  {
    name: 'agents',
    description: 'Sous-agents disponibles',
    keywords: 'sous-agents',
    terminal: true,
  },
  {
    name: 'add-dir',
    description: 'Ajouter un dossier de travail',
    keywords: 'dossier répertoire',
    args: true,
  },
];

export interface PaletteSourceData {
  skills?: ReadonlyArray<{
    name: string;
    description: string | null;
    source: 'project' | 'user';
  }> | null;
  mcp?: ReadonlyArray<{ name: string; label: string; tools: readonly string[] }>;
}

/** Commands, then skills, then MCP servers and their known tools. */
export function buildPaletteItems(data: PaletteSourceData = {}): PaletteItem[] {
  const items: PaletteItem[] = CURATED_COMMANDS.map((c) => ({
    id: `command:${c.name}`,
    group: 'commands',
    label: `/${c.name}`,
    description: c.terminal ? `${c.description} · ${PALETTE_COPY.terminal}` : c.description,
    insert: `/${c.name} `,
    keywords: c.keywords,
  }));
  for (const skill of data.skills ?? []) {
    items.push({
      id: `skill:${skill.source}:${skill.name}`,
      group: 'skills',
      label: `/${skill.name}`,
      description: [skill.description, skill.source === 'project' ? 'projet' : 'serveur']
        .filter(Boolean)
        .join(' · '),
      insert: `/${skill.name} `,
    });
  }
  for (const server of data.mcp ?? []) {
    items.push({
      id: `mcp:${server.name}`,
      group: 'mcp',
      label: server.name,
      description: server.tools.length
        ? `${server.label} · ${server.tools.length} outils`
        : `${server.label} · outils connus après un test de connexion`,
      insert: `le serveur MCP ${server.name} `,
      keywords: server.label,
    });
    for (const tool of server.tools) {
      items.push({
        id: `mcp:${server.name}:${tool}`,
        group: 'mcp',
        label: `mcp__${server.name}__${tool}`,
        description: server.label,
        insert: `mcp__${server.name}__${tool} `,
      });
    }
  }
  return items;
}

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Items matching a query: label prefix first, then label contains, then description / keywords. */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
  limit = 50,
): PaletteItem[] {
  const q = fold(query.trim().replace(/^\//, ''));
  if (!q) return items.slice(0, limit);
  const scored: Array<{ item: PaletteItem; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const label = fold(item.label.replace(/^\//, ''));
    const extra = fold(`${item.description ?? ''} ${item.keywords ?? ''}`);
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : extra.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ item, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}

export interface PaletteTrigger {
  kind: '/' | '@';
  /** Text typed after the trigger. */
  query: string;
  /** Index of the trigger character in the field. */
  start: number;
  /** End of the token (the caret). */
  end: number;
}

/**
 * Trigger under the caret: `/` or `@` at the start of a word (start of the field or after a space or
 * a line break), followed by the word being typed. `/` is only a command at the very start of the
 * instruction or of a line (« a/b » or a path never opens the palette).
 */
export function paletteTriggerAt(value: string, caret: number): PaletteTrigger | null {
  if (caret < 0 || caret > value.length) return null;
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(value[i]!)) i -= 1;
  const start = i + 1;
  const token = value.slice(start, caret);
  const kind = token[0];
  if (kind !== '/' && kind !== '@') return null;
  if (kind === '/') {
    const before = value.slice(0, start);
    if (before.trim() !== '' && !/\n[ \t]*$/.test(before)) return null;
    if (token.slice(1).includes('/')) return null;
  }
  return { kind, query: token.slice(1), start, end: caret };
}

/** Field after inserting `text` in place of [start, end) — or at the caret — and the new caret. */
export function insertPaletteText(
  value: string,
  range: { start: number; end: number },
  text: string,
): { value: string; caret: number } {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const glue = before && !/\s$/.test(before) ? ' ' : '';
  const trimmedAfter = text.endsWith(' ') ? after.replace(/^ /, '') : after;
  const next = `${before}${glue}${text}${trimmedAfter}`;
  return { value: next, caret: before.length + glue.length + text.length };
}

/** `src/comp` → dir `src`, filter `comp`; `src/` → dir `src`, filter ''; `ind` → dir '', filter `ind`. */
export function fileQueryParts(query: string): { dir: string; filter: string } {
  const clean = query.replace(/^\.\/+/, '');
  const slash = clean.lastIndexOf('/');
  if (slash === -1) return { dir: '', filter: clean };
  return { dir: clean.slice(0, slash).replace(/\/+$/, ''), filter: clean.slice(slash + 1) };
}

export interface TreeEntryLike {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  ignored: boolean;
}

/** Entries of a folder as palette items (folders first, ignored entries last), filtered by name. */
export function fileItems(
  entries: readonly TreeEntryLike[],
  filter: string,
  limit = 50,
): PaletteItem[] {
  const f = fold(filter);
  return entries
    .filter((e) => e.kind === 'file' || e.kind === 'dir')
    .filter((e) => !f || fold(e.name).includes(f))
    .map((e) => ({
      e,
      rank:
        (fold(e.name).startsWith(f) ? 0 : 1) + (e.ignored ? 2 : 0) + (e.kind === 'dir' ? 0 : 0.5),
    }))
    .sort((a, b) => a.rank - b.rank || a.e.name.localeCompare(b.e.name, 'fr'))
    .slice(0, limit)
    .map(({ e }) => ({
      id: `file:${e.path}`,
      group: 'files' as const,
      label: e.kind === 'dir' ? `${e.path}/` : e.path,
      description: e.ignored ? 'ignoré par Git' : null,
      insert: e.kind === 'dir' ? `@${e.path}/` : `@${e.path} `,
      folder: e.kind === 'dir',
    }));
}
