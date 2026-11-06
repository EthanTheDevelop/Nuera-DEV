/**
 * TEST-ONLY — scripted turns of the fake Claude Code CLI (apps/runner/test/fixtures/fake-claude.mjs).
 *
 * An instruction containing `scenario:<name>` runs `<CLAUDE_CONFIG_DIR>/nuera-fake-scenarios/<name>.json`
 * (the stack's isolated config dir). Steps, in order:
 *   { plan: [{ content, status: 'pending'|'in_progress'|'completed', activeForm? }] }   TodoWrite
 *   { say: '…' }                                    intermediate text of Claude (journal)
 *   { read: 'src/x.js' }                            Read of a real file of the worktree
 *   { grep: { pattern, path? } } / { glob: { pattern } }   real search in the worktree
 *   { edit: { file, old, new } } / { write: { file, content } } / { remove: { file } }
 *                                                   real change (permission asked unless the mode
 *                                                   is acceptEdits/auto/bypassPermissions/dontAsk,
 *                                                   or `ask` says otherwise)
 *   { bash: { command, run?: true, output?, exitCode? } }   `run` really executes it in the worktree
 *   { wait: { command, seconds, every?, output?: [] } }      long step with streaming terminal output
 *                                                   (cancelled by Échap: no hook follows, like the CLI)
 *   { fail: { error: 'authentication_failed'|'rate_limit'|…, details? } }   StopFailure
 *   { fail: { error: 'rate_limit', resetInSeconds } }   usage limit that lasts: every prompt stops on
 *                                                   it (notice, status line at 100 %) until the reset
 *   { final: '…' }                                  last message (Stop hook)
 *   { pause: ms }
 * `denied` = message when the owner refuses a permission. Built-in names `full`, `long`, `fail`
 * belong to the runner tests and cannot be scripted.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEVIS } from './fixture-content';

export interface PlanStep {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type ScriptStep =
  | { plan: PlanStep[] }
  | { say: string }
  | { read: string; durationMs?: number }
  | { grep: { pattern: string; path?: string; ignoreCase?: boolean } }
  | { glob: { pattern: string } }
  | { edit: { file: string; old: string; new: string }; ask?: boolean; suggestions?: unknown[] }
  | { write: { file: string; content: string }; ask?: boolean; suggestions?: unknown[] }
  | { remove: { file: string; description?: string }; ask?: boolean; suggestions?: unknown[] }
  | { bash: { command: string; description?: string; run?: boolean; output?: string; exitCode?: number; durationMs?: number; timeoutSec?: number }; ask?: boolean; suggestions?: unknown[] }
  | { wait: { command: string; description?: string; seconds: number; every?: number; output?: string[] } }
  | { fail: { error: string; details?: string; resetInSeconds?: number } }
  | { final: string }
  | { pause: number };

export interface FakeCliScript {
  description: string;
  /**
   * Instructions in plain French run this script when they contain one of these phrases
   * (case-insensitive); `scenario:<name>` in the instruction always works too.
   */
  match?: string[];
  /** Delay between two steps (ms, default 250). */
  pace?: number;
  /** Final message when the owner refuses a permission. */
  denied?: string;
  steps: ScriptStep[];
}

const plan = (items: Array<[string, PlanStep['status'], string?]>): ScriptStep => ({
  plan: items.map(([content, status, activeForm]) => ({ content, status, ...(activeForm ? { activeForm } : {}) })),
});

// --- Edits of devis-express (exact text of fixture-content.ts) ------------------------------------

export const REMISE_OLD = [
  'export function ajouterLigne(devis, { libelle, quantite = 1, prixUnitaire, tauxTva = 20 }) {',
  "  if (!libelle) throw new Error('Indiquez un libellé');",
  "  if (!Number.isInteger(prixUnitaire)) throw new Error('Indiquez le prix unitaire en centimes');",
  '  return { ...devis, lignes: [...devis.lignes, { libelle, quantite, prixUnitaire, tauxTva }] };',
  '}',
  '',
  'export function totaux(devis) {',
  '  const lignes = devis.lignes.map((ligne) => {',
  '    const ht = ligne.quantite * ligne.prixUnitaire;',
].join('\n');

export const REMISE_NEW = [
  'export function ajouterLigne(devis, { libelle, quantite = 1, prixUnitaire, tauxTva = 20, remise = 0 }) {',
  "  if (!libelle) throw new Error('Indiquez un libellé');",
  "  if (!Number.isInteger(prixUnitaire)) throw new Error('Indiquez le prix unitaire en centimes');",
  "  if (remise < 0 || remise > 100) throw new Error('Indiquez une remise entre 0 et 100 %');",
  '  return { ...devis, lignes: [...devis.lignes, { libelle, quantite, prixUnitaire, tauxTva, remise }] };',
  '}',
  '',
  'export function totaux(devis) {',
  '  const lignes = devis.lignes.map((ligne) => {',
  '    const brut = ligne.quantite * ligne.prixUnitaire;',
  '    const ht = Math.round((brut * (100 - (ligne.remise ?? 0))) / 100);',
].join('\n');

export const FIDELITE = [
  "/** Remise de fidélité selon l'ancienneté du client (en années). */",
  'export const PALIERS_FIDELITE = [',
  '  { anciennete: 5, remise: 8 },',
  '  { anciennete: 3, remise: 5 },',
  '  { anciennete: 1, remise: 2 },',
  '];',
  '',
  'export function remiseFidelite(anciennete) {',
  '  return PALIERS_FIDELITE.find((palier) => anciennete >= palier.anciennete)?.remise ?? 0;',
  '}',
  '',
].join('\n');

export const EXPORT_CSV = [
  "import { totaux } from './devis.js';",
  "import { formaterMontant } from './montants.js';",
  '',
  "const SEPARATEUR = ';';",
  '',
  "/** Export CSV d'un devis : une ligne par article, puis les totaux. */",
  'export function exporterCsv(devis) {',
  "  const entetes = ['Libellé', 'Quantité', 'Prix unitaire', 'TVA (%)'];",
  '  const lignes = devis.lignes.map((ligne) => [ligne.libelle, ligne.quantite, formaterMontant(ligne.prixUnitaire), ligne.tauxTva]);',
  '  const { ht, tva, ttc } = totaux(devis);',
  "  return [entetes, ...lignes, [], ['Total HT', formaterMontant(ht)], ['TVA', formaterMontant(tva)], ['Total TTC', formaterMontant(ttc)]]",
  '    .map((cellules) => cellules.join(SEPARATEUR))',
  "    .join('\\n');",
  '}',
  '',
].join('\n');

export const EXPORT_CSV_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { ajouterLigne, creerDevis } from '../src/devis.js';",
  "import { exporterCsv } from '../src/export-csv.js';",
  '',
  "test('exporte une ligne par article puis les totaux', () => {",
  "  let devis = creerDevis({ client: 'Menuiserie Dupré', numero: 'DEV-2026-0007' });",
  "  devis = ajouterLigne(devis, { libelle: 'Pose de parquet', quantite: 12, prixUnitaire: 4500 });",
  "  const lignes = exporterCsv(devis).split('\\n');",
  "  assert.equal(lignes[0], 'Libellé;Quantité;Prix unitaire;TVA (%)');",
  "  assert.equal(lignes[1], 'Pose de parquet;12;45,00 €;20');",
  "  assert.equal(lignes.at(-1), 'Total TTC;648,00 €');",
  '});',
  '',
].join('\n');

export const INDEX_OLD = "export * from './devis.js';\n";
export const INDEX_NEW = "export * from './devis.js';\nexport * from './export-csv.js';\n";
export const MONTANTS_OLD = 'export function formaterMontant(centimes) {';
export const MONTANTS_NEW = [
  '/** Montant pour un tableur : « 1234,56 », sans symbole. */',
  'export function formaterPourCsv(centimes) {',
  "  return (centimes / 100).toFixed(2).replace('.', ',');",
  '}',
  '',
  'export function formaterMontant(centimes) {',
].join('\n');
export const README_OLD = '## Montants\n';
export const README_NEW = [
  '## Export CSV',
  '',
  '`exporterCsv(devis)` produit un fichier séparé par des points-virgules : une ligne par article, puis les totaux HT, TVA et TTC.',
  '',
  '## Montants',
  '',
].join('\n');

// --- Scripts --------------------------------------------------------------------------------------

export const BUILTIN_SCRIPTS: Record<string, FakeCliScript> = {
  /** Interrupted session (seed `sessions`): a read-only analysis. */
  lecture: {
    description: 'Analyse en lecture seule des relances de devis.',
    match: ['relance automatique des devis non signés'],
    steps: [
      { say: "Je regarde d'abord comment les relances sont construites aujourd'hui." },
      { read: 'src/relance.js' },
      { grep: { pattern: 'messageRelance', path: 'src' } },
      { read: 'CLAUDE.md' },
      {
        final:
          "Les relances sont rédigées par messageRelance() dans src/relance.js, mais rien ne les déclenche. Je propose une tâche quotidienne qui sélectionne les devis envoyés depuis plus de 7 jours et non signés, puis envoie ce message. Je peux l'implémenter si vous êtes d'accord.",
      },
    ],
  },

  /** Finished session (seed `sessions`): plan, reads, an edit allowed in Nuera Dev, real tests. */
  remise: {
    description: 'Remise par ligne de devis (une autorisation de modification).',
    match: ['remise en pourcentage sur chaque ligne'],
    denied: "Modification refusée : je n'ajoute pas la remise par ligne.",
    steps: [
      plan([
        ['Lire les conventions du dépôt', 'in_progress', 'Lecture des conventions du dépôt'],
        ['Ajouter la remise par ligne dans src/devis.js', 'pending', 'Ajout de la remise par ligne'],
        ['Lancer les tests', 'pending', 'Lancement des tests'],
      ]),
      { say: "Je lis d'abord les conventions du dépôt." },
      { read: 'CLAUDE.md' },
      { read: 'src/devis.js' },
      plan([
        ['Lire les conventions du dépôt', 'completed'],
        ['Ajouter la remise par ligne dans src/devis.js', 'in_progress', 'Ajout de la remise par ligne'],
        ['Lancer les tests', 'pending', 'Lancement des tests'],
      ]),
      { say: "La remise s'applique sur le montant brut de chaque ligne, avant la TVA." },
      { edit: { file: 'src/devis.js', old: REMISE_OLD, new: REMISE_NEW } },
      plan([
        ['Lire les conventions du dépôt', 'completed'],
        ['Ajouter la remise par ligne dans src/devis.js', 'completed'],
        ['Lancer les tests', 'in_progress', 'Lancement des tests'],
      ]),
      { bash: { command: 'npm run test', description: 'Lance les tests unitaires.', run: true }, ask: false },
      plan([
        ['Lire les conventions du dépôt', 'completed'],
        ['Ajouter la remise par ligne dans src/devis.js', 'completed'],
        ['Lancer les tests', 'completed'],
      ]),
      { final: "C'est terminé : chaque ligne de devis accepte une remise en pourcentage (de 0 à 100 %), appliquée avant la TVA, et les tests passent." },
    ],
  },

  /** Session waiting for a permission decision (seed `sessions`): `npm run test` asks first. */
  'tests-parcours': {
    description: 'Lance la suite complète (commande soumise à autorisation).',
    match: ['test du parcours complet'],
    denied: "D'accord, je ne lance pas les tests : dites-moi comment vous préférez vérifier le parcours.",
    steps: [
      plan([
        ['Relire les tests existants', 'completed'],
        ['Lancer la suite complète avant de modifier le code', 'in_progress', 'Lancement de la suite complète'],
        ["Écrire le test du parcours complet d'un devis", 'pending', 'Écriture du test du parcours'],
      ]),
      { read: 'test/devis.test.js' },
      { say: 'Je lance la suite complète avant de modifier quoi que ce soit.' },
      {
        bash: { command: 'npm run test', description: 'Lance toute la suite de tests.', run: true },
        ask: true,
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }], behavior: 'allow', destination: 'localSettings' }],
      },
      plan([
        ['Relire les tests existants', 'completed'],
        ['Lancer la suite complète avant de modifier le code', 'completed'],
        ["Écrire le test du parcours complet d'un devis", 'in_progress', 'Écriture du test du parcours'],
      ]),
      { final: 'La suite passe : je peux maintenant écrire le test du parcours complet (création, lignes, remise, totaux).' },
    ],
  },

  /** Long task with a plan (seed `sessions`, mode acceptEdits): watch mode for 6 hours. */
  'remises-fidelite': {
    description: 'Tâche longue avec plan (tests en continu pendant 6 h, Échap pour interrompre).',
    match: ['remises de fidélité selon'],
    steps: [
      plan([
        ['Repérer le calcul des remises', 'completed'],
        ['Ajouter les paliers de fidélité', 'in_progress', 'Ajout des paliers de fidélité'],
        ['Appliquer la remise de fidélité aux totaux', 'pending', 'Application de la remise aux totaux'],
        ['Faire passer les tests en continu', 'pending', 'Tests en continu'],
        ['Rédiger le résumé des changements', 'pending', 'Rédaction du résumé'],
      ]),
      { say: 'Je commence par repérer où les remises sont calculées.' },
      { read: 'src/devis.js' },
      { grep: { pattern: 'prixUnitaire', path: 'src' } },
      { write: { file: 'src/fidelite.js', content: FIDELITE } },
      plan([
        ['Repérer le calcul des remises', 'completed'],
        ['Ajouter les paliers de fidélité', 'completed'],
        ['Appliquer la remise de fidélité aux totaux', 'completed'],
        ['Faire passer les tests en continu', 'in_progress', 'Tests en continu'],
        ['Rédiger le résumé des changements', 'pending', 'Rédaction du résumé'],
      ]),
      { say: "Je laisse les tests tourner en continu pendant que j'ajuste les paliers." },
      {
        wait: {
          command: 'npm run test -- --watch',
          description: 'Tests en continu pendant les modifications.',
          seconds: 6 * 3600,
          every: 6,
          output: [
            ' RERUN  src/fidelite.js',
            ' ✓ test/devis.test.js > devis > calcule le HT, la TVA et le TTC 2ms',
            ' ✓ test/tva.test.js > arrondit la TVA au centime le plus proche 1ms',
            ' ✓ test/relance.test.js > rappelle le numéro et le montant du devis 1ms',
            '      Tests  13 passed (13)',
            ' Waiting for file changes...',
          ],
        },
      },
      { final: 'Les paliers de fidélité (2, 5 et 8 %) sont en place et les tests passent.' },
    ],
  },

  /** Changes, first turn (seed `changes`): files the harness then commits through the runner. */
  'export-csv-1': {
    description: 'Export CSV, première partie (sera commitée).',
    match: ['crée un export csv des devis'],
    steps: [
      plan([
        ["Écrire le module d'export CSV", 'in_progress', "Écriture du module d'export CSV"],
        ["Exposer l'export dans src/index.js", 'pending', "Exposition de l'export"],
        ['Vérifier les tests', 'pending', 'Vérification des tests'],
      ]),
      { read: 'src/devis.js' },
      { write: { file: 'src/export-csv.js', content: EXPORT_CSV } },
      plan([
        ["Écrire le module d'export CSV", 'completed'],
        ["Exposer l'export dans src/index.js", 'in_progress', "Exposition de l'export"],
        ['Vérifier les tests', 'pending', 'Vérification des tests'],
      ]),
      { edit: { file: 'src/index.js', old: INDEX_OLD, new: INDEX_NEW } },
      plan([
        ["Écrire le module d'export CSV", 'completed'],
        ["Exposer l'export dans src/index.js", 'completed'],
        ['Vérifier les tests', 'in_progress', 'Vérification des tests'],
      ]),
      { bash: { command: 'npm run test', description: 'Lance les tests unitaires.', run: true }, ask: false },
      plan([
        ["Écrire le module d'export CSV", 'completed'],
        ["Exposer l'export dans src/index.js", 'completed'],
        ['Vérifier les tests', 'completed'],
      ]),
      { final: "Le module d'export CSV est prêt : une ligne par article, séparateur point-virgule, montants en euros." },
    ],
  },

  /** Changes, second turn (seed `changes`): left uncommitted (added, modified, deleted files). */
  'export-csv-2': {
    description: 'Export CSV, seconde partie (non commitée : ajout, modifications, suppression).',
    match: ['documente le format dans le readme'],
    steps: [
      plan([
        ["Tester l'export CSV", 'in_progress', "Écriture des tests de l'export"],
        ['Documenter le format dans le README', 'pending', 'Documentation du format'],
        ["Supprimer l'ancien format d'import", 'pending', "Suppression de l'ancien format"],
      ]),
      { write: { file: 'test/export-csv.test.js', content: EXPORT_CSV_TEST } },
      { edit: { file: 'src/montants.js', old: MONTANTS_OLD, new: MONTANTS_NEW } },
      plan([
        ["Tester l'export CSV", 'completed'],
        ['Documenter le format dans le README', 'in_progress', 'Documentation du format'],
        ["Supprimer l'ancien format d'import", 'pending', "Suppression de l'ancien format"],
      ]),
      { edit: { file: 'README.md', old: README_OLD, new: README_NEW } },
      plan([
        ["Tester l'export CSV", 'completed'],
        ['Documenter le format dans le README', 'completed'],
        ["Supprimer l'ancien format d'import", 'in_progress', "Suppression de l'ancien format"],
      ]),
      { remove: { file: 'docs/ancien-format.md', description: "Supprime l'ancien format d'import, remplacé par l'export CSV." } },
      plan([
        ["Tester l'export CSV", 'completed'],
        ['Documenter le format dans le README', 'completed'],
        ["Supprimer l'ancien format d'import", 'completed'],
      ]),
      { final: "J'ai ajouté le test de l'export, documenté le format dans le README et supprimé l'ancien format d'import. Rien n'est commité : relisez le diff avant de valider." },
    ],
  },

  /** Short reply (smoke test). */
  essai: {
    description: 'Réponse courte, sans outil.',
    steps: [{ final: 'Bien reçu : la pile de test répond.' }],
  },

  /** T6: the CLI reports a lost login. */
  'echec-auth': {
    description: "Échec d'authentification du CLI (T6).",
    steps: [{ say: 'Je commence.' }, { fail: { error: 'authentication_failed', details: 'OAuth token has expired. Please run /login.' } }],
  },

  /** Usage limit reached. */
  limite: {
    description: "Limite d'utilisation atteinte.",
    steps: [{ fail: { error: 'rate_limit', details: 'You have hit your session limit' } }],
  },

  /**
   * Usage limit with a reset time (« 5-hour limit reached ∙ resets … »), lifted 20 s later: with the
   * stack's margin (NUERA_AUTO_RESUME_MARGIN_SECONDS=2) an automatic resumption fires 22 s after it.
   * `scenario:limit:<s>` (built into the fake CLI) does the same with any delay.
   */
  'limite-levee': {
    description: "Limite d'utilisation atteinte, levée 20 s plus tard.",
    steps: [{ say: 'Je commence la livraison.' }, { fail: { error: 'rate_limit', resetInSeconds: 20 } }],
  },
};

/** Writes the built-in scripts (and `extra`) into the stack's fake CLI config dir. */
export function installScripts(dir: string, extra: Record<string, FakeCliScript> = {}): string[] {
  mkdirSync(dir, { recursive: true });
  const all = { ...BUILTIN_SCRIPTS, ...extra };
  for (const [name, script] of Object.entries(all)) writeScript(dir, name, script);
  return Object.keys(all);
}

export function writeScript(dir: string, name: string, script: FakeCliScript): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || ['full', 'long', 'fail'].includes(name)) {
    throw new Error(`Nom de scénario invalide « ${name} » (a-z, 0-9, tirets ; full/long/fail sont réservés).`);
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(script, null, 2)}\n`, 'utf8');
  return file;
}

/** Sanity check used by the unit tests: every edit of devis-express matches the fixture text. */
export function devisEditTargets(): Array<{ file: string; old: string; content: string }> {
  return [
    { file: 'src/devis.js', old: REMISE_OLD, content: DEVIS.devis },
    { file: 'src/index.js', old: INDEX_OLD, content: DEVIS.indexWithNumero },
    { file: 'src/montants.js', old: MONTANTS_OLD, content: DEVIS.montants },
    { file: 'README.md', old: README_OLD, content: DEVIS.readme },
  ];
}
