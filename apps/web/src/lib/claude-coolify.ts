import type { InstanceMcpConfig } from '@nuera/db/schema';

/**
 * Coolify tools of the common configuration (lot K1), shared by the server (permission rules of the
 * sessions) and the administration (what each listed tool becomes). Pure: no Node import.
 */

export type CoolifyToolClass = 'read' | 'sensitive' | 'write' | 'destructive';

/**
 * Class of a Coolify MCP tool, from its name. Unknown names count as `write` (never auto-allowed).
 *   read        get_/list_/search_… — allowed without asking
 *   sensitive   reads secrets (environment values) — always a permission request
 *   write       deploy, control, restart, manage_/create_/update_… — permission request (when offered)
 *   destructive delete/remove/destroy… — refused, or a permission request when the owner allows it
 */
export function classifyCoolifyTool(name: string): CoolifyToolClass {
  const tool = name.toLowerCase();
  if (/(^|_)(delete|remove|destroy|purge|drop|wipe|prune)(_|$)/.test(tool)) return 'destructive';
  if (/(^|_)(env_values|secret|secrets|password|private_key|credentials?)(_|$)/.test(tool)) return 'sensitive';
  if (/^(get|list|search|read|show|view|describe|find|fetch|check)(_|$)/.test(tool) && !/(^|_)(deploy|restart|start|stop)(_|$)/.test(tool)) return 'read';
  return 'write';
}

export interface McpPermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

/** Permission rules of the Coolify server for its known tools (`lastTools`). */
export function coolifyPermissionRules(name: string, tools: readonly string[], config: Pick<InstanceMcpConfig, 'allowWrite' | 'allowDestructive'>): McpPermissionRules {
  const rules: McpPermissionRules = { allow: [], ask: [], deny: [] };
  for (const tool of [...new Set(tools)].sort()) {
    const rule = `mcp__${name}__${tool}`;
    switch (classifyCoolifyTool(tool)) {
      case 'read':
        rules.allow.push(rule);
        break;
      case 'sensitive':
        rules.ask.push(rule);
        break;
      case 'write':
        (config.allowWrite ? rules.ask : rules.deny).push(rule);
        break;
      case 'destructive':
        (config.allowWrite && config.allowDestructive ? rules.ask : rules.deny).push(rule);
        break;
    }
  }
  return rules;
}

