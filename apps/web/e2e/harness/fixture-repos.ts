/**
 * TEST-ONLY — fixture GitHub accounts and their repositories, backed by REAL bare git repositories
 * (`remotes/<owner>/<repo>.git`, the runner clones them through NUERA_GIT_REMOTE_BASE=file:///…).
 * Histories carry realistic French conventional commits spread over the last two weeks, a few
 * branches per repository (feature/fix), CLAUDE.md, .env.example and package.json scripts.
 *
 * Built once per day in `.data/stacks/_fixtures/` and copied into each stack (several lots start
 * their stacks at the same time: the build is locked and published by an atomic rename).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CATALOGUE, DEVIS, GITIGNORE, LINT, NOTES, OUTILS, REPORTER, VITRINE, type FileMap } from './fixture-content';
import { FIXTURES_CACHE } from './paths';
import type { FixtureAccount, FixtureRepoState } from './state';

/** Bump when the content or the history of a fixture repository changes. */
export const FIXTURES_VERSION = 3;

export const FIXTURE_ACCOUNTS: readonly FixtureAccount[] = [
  { login: 'atelier-test', id: 5101, type: 'Organization', installationId: 71001 },
  { login: 'dev-test', id: 5202, type: 'User', installationId: 71002 },
];

const AUTHORS = {
  camille: { name: 'Camille Laurent', email: 'camille.laurent@atelier-test.example' },
  hugo: { name: 'Hugo Martin', email: 'hugo.martin@atelier-test.example' },
  ines: { name: 'Inès Moreau', email: 'ines.moreau@dev-test.example' },
} as const;

interface FixtureCommit {
  message: string;
  /** Age of the commit (days, fractions allowed). */
  daysAgo: number;
  author: keyof typeof AUTHORS;
  files?: FileMap;
  remove?: string[];
}

interface FixtureBranch {
  name: string;
  /** Index of the main commit the branch starts from (default: last). */
  from?: number;
  commits: FixtureCommit[];
}

export interface FixtureRepoSpec {
  owner: string;
  name: string;
  id: number;
  displayName: string;
  description: string;
  private: boolean;
  language: string | null;
  failingTests: boolean;
  history: FixtureCommit[];
  branches: FixtureBranch[];
}

const tooling = (bundle: { dev: string; build: string }): FileMap => ({
  'scripts/dev.js': bundle.dev,
  'scripts/build.js': bundle.build,
  'scripts/lint.js': LINT,
  'scripts/rapport-tests.js': REPORTER,
});

export const FIXTURE_REPOS: readonly FixtureRepoSpec[] = [
  {
    owner: 'atelier-test',
    name: 'devis-express',
    id: 610_001,
    displayName: 'Devis Express',
    description: 'Générateur de devis pour artisans : lignes, remises, TVA et relances.',
    private: true,
    language: 'JavaScript',
    failingTests: false,
    history: [
      {
        message: 'chore: initialisation du projet',
        daysAgo: 14.2,
        author: 'camille',
        files: { 'package.json': DEVIS.packageJson, 'package-lock.json': DEVIS.packageLock, '.gitignore': GITIGNORE, 'README.md': DEVIS.readme, ...tooling(DEVIS) },
      },
      { message: 'feat: montants en centimes et formatage', daysAgo: 12.1, author: 'camille', files: { 'src/montants.js': DEVIS.montants, 'test/montants.test.js': DEVIS.montantsTest } },
      { message: 'feat: taux de TVA et calcul du TTC', daysAgo: 9.3, author: 'hugo', files: { 'src/tva.js': DEVIS.tvaInitial, 'test/tva.test.js': DEVIS.tvaTestInitial } },
      {
        message: 'feat: création des devis et ajout de lignes',
        daysAgo: 6.2,
        author: 'camille',
        files: { 'src/devis.js': DEVIS.devis, 'src/index.js': DEVIS.index, 'test/devis.test.js': DEVIS.devisTest },
      },
      {
        message: 'feat: numérotation annuelle des devis',
        daysAgo: 4.4,
        author: 'hugo',
        files: { 'src/numero.js': DEVIS.numero, 'src/index.js': DEVIS.indexWithNumeroOnly, 'test/numero.test.js': DEVIS.numeroTest },
      },
      {
        message: "docs: consignes pour Claude et ancien format d'import",
        daysAgo: 2.3,
        author: 'camille',
        files: { 'CLAUDE.md': DEVIS.claudeMd, 'docs/ancien-format.md': DEVIS.ancienFormat, '.env.example': DEVIS.envExample },
      },
      { message: 'fix: arrondi de la TVA au centime le plus proche', daysAgo: 0.3, author: 'hugo', files: { 'src/tva.js': DEVIS.tva, 'test/tva.test.js': DEVIS.tvaTest } },
      {
        message: 'feat: message de relance des devis en attente',
        daysAgo: 0.11,
        author: 'camille',
        files: { 'src/relance.js': DEVIS.relance, 'src/index.js': DEVIS.indexWithNumero, 'test/relance.test.js': DEVIS.relanceTest },
      },
    ],
    branches: [
      { name: 'feature/export-pdf', from: 4, commits: [{ message: 'feat: export PDF du devis (brouillon)', daysAgo: 3.1, author: 'hugo', files: { 'src/export-pdf.js': DEVIS.exportPdf } }] },
      {
        name: 'fix/remise-globale',
        commits: [{ message: 'fix: plafonne la remise globale à 30 %', daysAgo: 0.06, author: 'hugo', files: { 'src/remise-globale.js': DEVIS.remiseGlobale, 'test/remise-globale.test.js': DEVIS.remiseGlobaleTest } }],
      },
    ],
  },
  {
    owner: 'atelier-test',
    name: 'catalogue-produits',
    id: 610_002,
    displayName: 'Catalogue produits',
    description: 'Catalogue des produits de l\'atelier : tri, recherche et stock.',
    private: true,
    language: 'JavaScript',
    failingTests: true,
    history: [
      {
        message: 'chore: initialisation du catalogue',
        daysAgo: 21.5,
        author: 'hugo',
        files: { 'package.json': CATALOGUE.packageJson, 'package-lock.json': CATALOGUE.packageLock, '.gitignore': GITIGNORE, 'README.md': CATALOGUE.readme, ...tooling(CATALOGUE) },
      },
      { message: 'feat: tri par prix et valeur du stock', daysAgo: 16.2, author: 'hugo', files: { 'src/catalogue.js': CATALOGUE.catalogue, 'test/catalogue.test.js': CATALOGUE.catalogueTest } },
      { message: 'feat: recherche sans accents', daysAgo: 8.4, author: 'camille', files: { 'src/recherche.js': CATALOGUE.recherche, 'test/recherche.test.js': CATALOGUE.rechercheTest } },
      { message: 'docs: consignes pour Claude', daysAgo: 5.2, author: 'camille', files: { 'CLAUDE.md': CATALOGUE.claudeMd, '.env.example': CATALOGUE.envExample } },
    ],
    branches: [{ name: 'feature/recherche-floue', commits: [{ message: 'feat: recherche tolérante aux fautes (brouillon)', daysAgo: 1.4, author: 'camille', files: { 'src/recherche-floue.js': CATALOGUE.rechercheFloue } }] }],
  },
  {
    owner: 'atelier-test',
    name: 'site-vitrine',
    id: 610_003,
    displayName: 'Site vitrine',
    description: 'Site vitrine de l\'atelier (HTML et CSS).',
    private: false,
    language: 'HTML',
    failingTests: false,
    history: [
      {
        message: 'chore: premières pages du site',
        daysAgo: 40.3,
        author: 'camille',
        files: { 'package.json': VITRINE.packageJson, 'package-lock.json': VITRINE.packageLock, '.gitignore': GITIGNORE, 'README.md': VITRINE.readme, 'index.html': VITRINE.index, 'styles.css': VITRINE.styles, 'scripts/dev.js': VITRINE.dev, 'scripts/build.js': VITRINE.build },
      },
      { message: 'docs: consignes pour Claude', daysAgo: 19.6, author: 'camille', files: { 'CLAUDE.md': VITRINE.claudeMd } },
    ],
    branches: [{ name: 'refonte/accueil', commits: [{ message: "feat: bouton « Demander un devis » dans l'en-tête", daysAgo: 6.7, author: 'hugo', files: { 'index.html': VITRINE.indexRefonte } }] }],
  },
  {
    owner: 'dev-test',
    name: 'outils-cli',
    id: 620_001,
    displayName: 'Outils CLI',
    description: 'Petits outils en ligne de commande : CSV et dates en français.',
    private: true,
    language: 'JavaScript',
    failingTests: false,
    history: [
      {
        message: 'chore: squelette de la ligne de commande',
        daysAgo: 30.2,
        author: 'ines',
        files: {
          'package.json': OUTILS.packageJson,
          'package-lock.json': OUTILS.packageLock,
          '.gitignore': GITIGNORE,
          'README.md': OUTILS.readme,
          'bin/outils.js': OUTILS.cli,
          'scripts/build.js': OUTILS.build,
          'scripts/lint.js': LINT,
          'scripts/rapport-tests.js': REPORTER,
        },
      },
      { message: 'feat: lecture des CSV séparés par des points-virgules', daysAgo: 11.4, author: 'ines', files: { 'src/csv.js': OUTILS.csv, 'test/csv.test.js': OUTILS.csvTest } },
      { message: 'feat: dates en toutes lettres', daysAgo: 3.6, author: 'ines', files: { 'src/dates.js': OUTILS.dates, 'test/dates.test.js': OUTILS.datesTest } },
      { message: 'docs: consignes pour Claude', daysAgo: 1.2, author: 'ines', files: { 'CLAUDE.md': OUTILS.claudeMd, '.env.example': OUTILS.envExample } },
    ],
    branches: [{ name: 'feature/option-json', commits: [{ message: 'feat: option --json pour les CSV', daysAgo: 0.8, author: 'ines', files: { 'src/option-json.js': OUTILS.optionJson } }] }],
  },
  {
    owner: 'dev-test',
    name: 'notes-perso',
    id: 620_002,
    displayName: 'Notes',
    description: 'Notes personnelles.',
    private: true,
    language: null,
    failingTests: false,
    history: [
      { message: 'docs: premières notes', daysAgo: 60.1, author: 'ines', files: { 'README.md': NOTES.readme, 'notes/idees.md': NOTES.idees } },
      { message: 'docs: liens utiles', daysAgo: 25.4, author: 'ines', files: { 'notes/liens.md': NOTES.liens } },
    ],
    branches: [],
  },
];

/** Repositories cloned by `seed projects` (keys used in state.json `seeded.projects`). */
export const SEEDED_PROJECTS = [
  { key: 'devis', fullName: 'atelier-test/devis-express' },
  { key: 'catalogue', fullName: 'atelier-test/catalogue-produits' },
  { key: 'outils', fullName: 'dev-test/outils-cli' },
] as const;

export type SeededProjectKey = (typeof SEEDED_PROJECTS)[number]['key'];

// ---------------------------------------------------------------------------------------------
// Git plumbing (fixture building only — the code under test never runs here)
// ---------------------------------------------------------------------------------------------

function gitEnv(emptyConfig: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extra };
}

function git(cwd: string, emptyConfig: string, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, env: gitEnv(emptyConfig, extra) as NodeJS.ProcessEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000 },
  ).trim();
}

function applyCommit(work: string, emptyConfig: string, commit: FixtureCommit, now: number): void {
  for (const [rel, content] of Object.entries(commit.files ?? {})) {
    const abs = path.join(work, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  for (const rel of commit.remove ?? []) rmSync(path.join(work, rel), { force: true });
  const author = AUTHORS[commit.author];
  // Second precision, never in the future.
  const date = new Date(Math.floor((now - commit.daysAgo * 86_400_000) / 1000) * 1000).toISOString();
  git(work, emptyConfig, ['add', '-A']);
  git(work, emptyConfig, ['commit', '--quiet', '-m', commit.message], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

/** Builds `<remotes>/<owner>/<name>.git` (bare) from its spec. Exported for tests. */
export function buildBareRepo(spec: FixtureRepoSpec, remotes: string, tmp: string, now = Date.now()): string {
  const bare = path.join(remotes, spec.owner, `${spec.name}.git`);
  mkdirSync(tmp, { recursive: true });
  const emptyConfig = path.join(tmp, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const work = path.join(tmp, `${spec.owner}-${spec.name}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    git(work, emptyConfig, ['init', '--quiet', '-b', 'main']);
    const mainShas: string[] = [];
    for (const commit of spec.history) {
      applyCommit(work, emptyConfig, commit, now);
      mainShas.push(git(work, emptyConfig, ['rev-parse', 'HEAD']));
    }
    for (const branch of spec.branches) {
      const start = mainShas[branch.from ?? mainShas.length - 1]!;
      git(work, emptyConfig, ['checkout', '--quiet', '-b', branch.name, start]);
      for (const commit of branch.commits) applyCommit(work, emptyConfig, commit, now);
      git(work, emptyConfig, ['checkout', '--quiet', 'main']);
    }
    mkdirSync(path.dirname(bare), { recursive: true });
    rmSync(bare, { recursive: true, force: true });
    git(path.dirname(bare), emptyConfig, ['init', '--quiet', '--bare', '-b', 'main', bare]);
    git(work, emptyConfig, ['push', '--quiet', bare, '--all']);
    git(bare, emptyConfig, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    return bare;
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Short hash of the fixture specs: a change of content rebuilds the cache the same day. */
function specsHash(): string {
  return createHash('sha256').update(JSON.stringify(FIXTURE_REPOS)).digest('hex').slice(0, 10);
}

function todayKey(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

/** Builds (or reuses) today's cache and copies it into `remotes` (replaced entirely). */
export async function installFixtureRemotes(remotes: string, options: { log?: (line: string) => void } = {}): Promise<void> {
  const key = `v${FIXTURES_VERSION}-${todayKey()}-${specsHash()}`;
  const cache = path.join(FIXTURES_CACHE, key);
  if (!existsSync(path.join(cache, '.complete'))) {
    const building = path.join(FIXTURES_CACHE, `${key}.build-${process.pid}`);
    options.log?.('Construction des dépôts de test (une fois par jour)…');
    rmSync(building, { recursive: true, force: true });
    for (const spec of FIXTURE_REPOS) buildBareRepo(spec, path.join(building, 'remotes'), path.join(building, 'tmp'));
    rmSync(path.join(building, 'tmp'), { recursive: true, force: true });
    writeFileSync(path.join(building, '.complete'), new Date().toISOString());
    try {
      renameSync(building, cache);
    } catch {
      // Another stack published the same cache first: use it.
      rmSync(building, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    // Older caches are useless.
    for (const entry of readdirSync(FIXTURES_CACHE)) {
      if (entry !== key && /^v\d+-\d{8}(-[0-9a-f]{10})?$/.test(entry)) rmSync(path.join(FIXTURES_CACHE, entry), { recursive: true, force: true });
    }
  }
  rmSync(remotes, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  cpSync(path.join(cache, 'remotes'), remotes, { recursive: true });
  writeFileSync(path.join(remotes, '.fixtures'), key);
}

/** Branch names of a bare repository (default branch first). */
export function listBareBranches(bare: string): Array<{ name: string; sha: string; date: string }> {
  const out = execFileSync('git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/heads'], {
    cwd: bare,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', date = ''] = line.split('\t');
      return { name, sha, date };
    });
}

export function fixtureRepoStates(remotes: string): FixtureRepoState[] {
  return FIXTURE_REPOS.map((spec) => {
    const account = FIXTURE_ACCOUNTS.find((item) => item.login === spec.owner)!;
    const bare = path.join(remotes, spec.owner, `${spec.name}.git`);
    return {
      fullName: `${spec.owner}/${spec.name}`,
      owner: spec.owner,
      name: spec.name,
      id: spec.id,
      installationId: account.installationId,
      defaultBranch: 'main',
      branches: ['main', ...spec.branches.map((branch) => branch.name)],
      private: spec.private,
      language: spec.language,
      description: spec.description,
      bare,
      displayName: spec.displayName,
      failingTests: spec.failingTests,
    };
  });
}
