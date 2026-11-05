/**
 * Copy helpers for `Dev · Demande d'autorisation` (203:423) and its phone variant (222:2731).
 * The card shows what the CLI asks; the buttons map 1:1 to the CLI's options, in its order (max 3).
 */
import type { PermissionMode, PermissionRequestStatus } from '@nuera/db';
import { joinParts } from './format';

export type { PermissionMode, PermissionRequestStatus };

/** One choice of the CLI permission prompt, in the CLI's order. */
export interface PermissionOption {
  /** Stable id sent back with the decision (`allow`, `allow_always`, `deny`…). */
  id: string;
  /** Drives the button style: Principal (allow), Secondaire (allow_always), Discret (deny). */
  kind: 'allow' | 'allow_always' | 'deny';
  /** Visible label (`Autoriser`, `Toujours pour npm run test`, `Refuser`). */
  label: string;
}

/**
 * The three Figma choices. `alwaysFor` is the rule prefix proposed by the CLI
 * (`permission_suggestions`); without it the « Toujours » choice is not offered.
 */
export function defaultPermissionOptions(alwaysFor?: string | null): PermissionOption[] {
  const options: PermissionOption[] = [{ id: 'allow', kind: 'allow', label: 'Autoriser' }];
  if (alwaysFor) options.push({ id: 'allow_always', kind: 'allow_always', label: `Toujours pour ${alwaysFor}` });
  options.push({ id: 'deny', kind: 'deny', label: 'Refuser' });
  return options;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Card title by tool (Figma: Bash → `Claude demande à exécuter une commande`). */
export function permissionTitle(toolName: string): string {
  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'PowerShell') {
    return 'Claude demande à exécuter une commande';
  }
  if (EDIT_TOOLS.has(toolName)) return 'Claude demande à modifier un fichier';
  if (toolName === 'WebFetch') return 'Claude demande à consulter une page web';
  if (toolName === 'WebSearch') return 'Claude demande à faire une recherche web';
  if (toolName.startsWith('mcp__')) return 'Claude demande à utiliser un outil MCP';
  return `Claude demande à utiliser ${toolName}`;
}

/** Whether the dark block shows a shell prompt (`$ npm run test -- crm`). */
export function isCommandTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'PowerShell';
}

/** Feminine noun used by the collapsed one-liner (`Commande autorisée une fois · …`). */
function subjectNoun(toolName: string | undefined): string {
  if (!toolName || isCommandTool(toolName)) return 'Commande';
  if (EDIT_TOOLS.has(toolName)) return 'Modification';
  return 'Action';
}

/**
 * Collapsed one-liner once the request is decided (Figma `État=Autorisée` / `État=Refusée`).
 * Returns null for the states that keep the full card (`pending`, `expired`).
 */
export function permissionSummary(
  status: PermissionRequestStatus,
  target?: string | null,
  toolName?: string,
): string | null {
  const noun = subjectNoun(toolName);
  switch (status) {
    case 'allowed':
      return joinParts(`${noun} autorisée une fois`, target);
    case 'allowed_always':
      return joinParts(`${noun} toujours autorisée`, target);
    case 'denied':
      return joinParts(`${noun} refusée`, 'Claude a été prévenu');
    case 'answered_in_terminal':
      return joinParts('Réponse donnée dans le terminal', target);
    case 'cancelled':
      return joinParts('Demande annulée', target);
    default:
      return null;
  }
}

/**
 * Human label of the CLI permission mode, as in `Mode : demander avant d'agir`
 * (D05 composer badge, permission footer, D08 « Mode de permission »).
 * The CLI reports Manual as `default` in hook payloads (`permission_mode`).
 */
export function permissionModeLabel(mode: PermissionMode | 'default'): string {
  switch (mode) {
    case 'manual':
    case 'default':
      return "demander avant d'agir";
    case 'acceptEdits':
      return 'accepter les modifications';
    case 'plan':
      return 'planifier sans modifier';
    case 'auto':
      return 'automatique';
    case 'dontAsk':
      return 'refuser sans demander';
    case 'bypassPermissions':
      return 'sans autorisation';
  }
}

/** `Mode : demander avant d'agir` */
export function permissionModeText(modeLabel: string): string {
  return `Mode : ${modeLabel}`;
}
