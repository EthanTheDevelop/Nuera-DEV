/**
 * Data contracts of the Intégrations page (D07 / M07) and of the MCP drawers (D1 / D2). Types only:
 * they come from the server modules (`@/server/integrations`, `@/server/mcp`, `@/server/coolify`,
 * `@/server/github`), which the browser never imports at runtime.
 */
import type { CoolifySettingsView } from '@/server/coolify';
import type { AccessibleReposResult, GithubStatus } from '@/server/github';
import type { DiagnosticBanner, IntegrationsOverview } from '@/server/integrations';
import type { CheckHistoryEntry, CheckStep, IntegrationCheck } from '@/server/integrations/model';
import type { McpServerView } from '@/server/mcp';

export type {
  AccessibleReposResult,
  CheckHistoryEntry,
  CheckStep,
  CoolifySettingsView,
  DiagnosticBanner,
  GithubStatus,
  IntegrationCheck,
  IntegrationsOverview,
  McpServerView,
};

/** What the MCP drawer / page needs besides the server itself (no secret). */
export interface McpDetailContext {
  coolify: CoolifySettingsView;
  github: Pick<GithubStatus, 'mode' | 'status' | 'accounts' | 'manageAccessUrl' | 'installUrl' | 'action' | 'app'>;
  /** Automatic check interval (« toutes les 15 min »). */
  checkIntervalMinutes: number;
}

/** Result of the server loaders: data, or the T4 description of what failed. */
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: LoadFailure };

export interface LoadFailure {
  message: string;
  code: string;
  detail?: string;
  raw?: string;
}

/** Answer of PUT /api/integrations/coolify. */
export interface CoolifyReconnectResult {
  settings: CoolifySettingsView;
  validation: { warnings: string[]; scope: string; abilities: string[]; productionVisible: boolean };
  mcp: { status: string; badge: { label: string; tone: string } } | null;
}
