/**
 * Écrans de démarrage du CLI officiel Claude Code validés automatiquement (décision du propriétaire,
 * 6 novembre 2026) : choix du thème (valeur par défaut surlignée), confiance dans le dossier du
 * projet (« Yes »), écrans « Press Enter to continue ». Le runner envoie seulement les touches qu'un
 * humain taperait dans la session interactive ; il ne lit ni n'écrit aucun fichier du CLI.
 * Jamais : connexion du compte, mode sans autorisations, Remote Control.
 */

export type StartupScreenKind = 'theme' | 'trust' | 'continue';

export interface StartupScreenAction {
  kind: StartupScreenKind;
  /** Touches à envoyer au PTY. */
  keys: string;
  /** Ligne système ajoutée au fil de la session. */
  label: string;
}

const THEME = [/choose the text style/i, /\/theme/i, /dark mode/i];
const TRUST = [/do you trust the files in this folder/i, /trust the files/i, /is this a project you (created|trust)/i, /trust this folder/i, /quick safety check/i];
const CONTINUE = /press enter to continue/i;
const NEVER = [/select login method/i, /bypass permissions mode/i, /enable remote control/i, /paste code here/i];

/** Ligne du menu actuellement surlignée (« ❯ 1. Yes, proceed »). */
function selectedLine(screen: string): string | null {
  const line = screen.split('\n').find((l) => /^\s*[❯>›]\s+/.test(l));
  return line ? line.trim() : null;
}

/** Action à mener pour l'écran affiché, ou null (écran normal ou décision réservée à l'humain). */
export function startupScreenAction(rawScreen: string): StartupScreenAction | null {
  // Texte replié (lignes coupées par la largeur du terminal) pour les motifs ; lignes gardées pour le curseur.
  const screen = rawScreen.replace(/\s+/g, ' ');
  if (NEVER.some((pattern) => pattern.test(screen))) return null;
  if (TRUST.some((pattern) => pattern.test(screen))) {
    const selected = selectedLine(rawScreen);
    if (selected && /\byes\b/i.test(selected)) return { kind: 'trust', keys: '\r', label: 'Dossier du projet autorisé automatiquement' };
    // Options numérotées (« 1. Yes ») : « 1 » ; sinon « Yes » est sous le curseur : flèche bas, puis
    // Entrée au prochain rendu de l'écran (curseur sur « Yes »).
    const numbered = /^\s*[❯>›]?\s*1\.\s*yes\b/im.test(rawScreen);
    return { kind: 'trust', keys: numbered ? '1' : '\u001b[B', label: "Curseur placé sur l'autorisation du dossier" };
  }
  if (THEME[0]!.test(screen) || (THEME[1]!.test(screen) && THEME[2]!.test(screen))) {
    return { kind: 'theme', keys: '\r', label: 'Thème du terminal choisi automatiquement (valeur par défaut)' };
  }
  if (CONTINUE.test(screen)) return { kind: 'continue', keys: '\r', label: 'Écran « Appuyez sur Entrée » validé automatiquement' };
  return null;
}
