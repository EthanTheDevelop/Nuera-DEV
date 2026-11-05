import type { PermissionRequestDto } from '@nuera/shared/runner';
import { redactSecrets } from '../safety/redact';
import { relativeTo, toolTarget } from './tool-meta';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** French title of the permission card, by tool (Figma D05 `Dev · Demande d'autorisation`). */
export function permissionTitle(tool: string): string {
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'BashOutput') return 'Claude demande à exécuter une commande';
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return 'Claude demande à modifier un fichier';
  if (tool === 'Read' || tool === 'NotebookRead') return 'Claude demande à lire un fichier';
  if (tool === 'Glob' || tool === 'Grep' || tool === 'LS') return 'Claude demande à parcourir des fichiers';
  if (tool === 'WebFetch') return 'Claude demande à consulter une page web';
  if (tool === 'WebSearch') return 'Claude demande à faire une recherche web';
  if (tool === 'Task' || tool === 'Agent') return 'Claude demande à lancer un sous-agent';
  if (tool === 'ExitPlanMode') return 'Claude propose de quitter le mode plan';
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  if (mcp) return `Claude demande à utiliser ${mcp[2]} (${mcp[1]})`;
  return `Claude demande à utiliser ${tool}`;
}

/** Command / path shown in the dark block of the card. */
export function permissionTarget(tool: string, input: unknown, cwd: string | null): string | null {
  if (!isObj(input)) return null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = str(input.command);
    return command ? redactSecrets(command).slice(0, 4000) : null;
  }
  if (tool.startsWith('mcp__')) {
    try {
      return redactSecrets(JSON.stringify(input)).slice(0, 1000);
    } catch {
      return null;
    }
  }
  const target = toolTarget(tool, input, cwd);
  return target ? redactSecrets(target) : null;
}

/** Human explanation (`description` of the tool input, written by Claude). */
export function permissionDetail(tool: string, input: unknown): string | null {
  if (!isObj(input)) return null;
  const description = str(input.description) ?? (tool === 'ExitPlanMode' ? str(input.plan) : null);
  return description ? redactSecrets(description).slice(0, 2000) : null;
}

interface RuleValue {
  toolName?: string;
  ruleContent?: string;
}

/** « Toujours pour npm run test » from the CLI's own `permission_suggestions` (addRules allow). */
export function alwaysLabelFrom(suggestions: unknown[] | null, cwd: string | null): string | null {
  if (!suggestions || suggestions.length === 0) return null;
  for (const suggestion of suggestions) {
    if (!isObj(suggestion)) continue;
    if (suggestion.type === 'addRules' && Array.isArray(suggestion.rules)) {
      const rule = suggestion.rules.find((r): r is RuleValue => isObj(r)) as RuleValue | undefined;
      if (!rule) continue;
      const content = rule.ruleContent?.trim();
      if (content) {
        // Bash prefix rules end with `:*` (or ` *`): « npm run test:* » → « npm run test ».
        const cleaned = content.replace(/(:\*|\s\*)$/, '').trim();
        return `Toujours pour ${relativeTo(cwd, cleaned) || cleaned}`;
      }
      if (rule.toolName) return `Toujours pour ${rule.toolName}`;
    }
    if (suggestion.type === 'setMode' && suggestion.mode === 'acceptEdits') return 'Toujours pour les modifications de fichiers';
    if (suggestion.type === 'addDirectories' && Array.isArray(suggestion.directories) && typeof suggestion.directories[0] === 'string') {
      return `Toujours pour ${relativeTo(cwd, suggestion.directories[0])}`;
    }
  }
  return 'Toujours autoriser';
}

export function permissionOptions(alwaysLabel: string | null): PermissionRequestDto['options'] {
  return [
    { id: 'allow', label: 'Autoriser' },
    ...(alwaysLabel ? [{ id: 'allow_always' as const, label: alwaysLabel }] : []),
    { id: 'deny', label: 'Refuser' },
  ];
}

/** Feminine nouns only, so that « autorisée / refusée » always agree. */
function actionNoun(tool: string): string {
  if (tool === 'Bash' || tool === 'PowerShell') return 'Commande';
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return 'Modification';
  if (tool === 'Read' || tool === 'NotebookRead') return 'Lecture';
  if (tool === 'Glob' || tool === 'Grep' || tool === 'WebSearch') return 'Recherche';
  if (tool === 'WebFetch') return 'Consultation';
  return 'Action';
}

/** One-line label of a decided request (Figma « Commande autorisée une fois · npm run test -- crm »). */
export function resolvedLabel(tool: string, status: PermissionRequestDto['status'], target: string | null): string | null {
  const what = actionNoun(tool);
  const suffix = target ? ` · ${target.split('\n')[0]!.slice(0, 200)}` : '';
  switch (status) {
    case 'allowed':
      return `${what} autorisée une fois${suffix}`;
    case 'allowed_always':
      return `${what} toujours autorisée${suffix}`;
    case 'denied':
      return `${what} refusée · Claude a été prévenu`;
    case 'answered_in_terminal':
      return `Réponse attendue dans le terminal${suffix}`;
    case 'expired':
      return `Demande expirée${suffix}`;
    case 'cancelled':
      return `Demande annulée${suffix}`;
    default:
      return null;
  }
}

export const DEFAULT_DENY_MESSAGE = "Refusé par l'utilisateur depuis Nuera Dev.";
