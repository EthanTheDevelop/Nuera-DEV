'use client';

import { useCallback, useState } from 'react';
import { toast } from '@/components/ui';
import { plural } from '@nuera/shared/format';
import { integrationsApi, toApiError, type IntegrationsApiError } from '../api';
import { markIntegrationsStale } from '../refresh';
import type { McpDetailContext, McpServerView } from '../types';

export interface McpServerState {
  server: McpServerView;
  context: McpDetailContext;
  setContext: (update: (context: McpDetailContext) => McpDetailContext) => void;
  /** « Tester la connexion ». */
  testing: boolean;
  /** Last test that did not end « Connecté » (T4 panel), or the request error. */
  testFailure: { server: McpServerView } | { error: IntegrationsApiError } | null;
  test: (options?: { successMessage?: string }) => Promise<McpServerView | null>;
  /** Projects whose switch is being saved, and the per-row errors. */
  toggling: Record<string, boolean>;
  toggleErrors: Record<string, string>;
  toggle: (projectId: string, enabled: boolean) => Promise<void>;
  disableEverywhere: () => Promise<void>;
  remove: () => Promise<void>;
  /** Replace the server view after a mutation made elsewhere (secret replaced, reconnection). */
  replace: (server: McpServerView) => void;
  reload: () => Promise<void>;
}

/**
 * State of one MCP server in the D1 / D2 drawer and its full page. The drawer never calls
 * `router.refresh()` (it would re-render the intercepted route as a full page): it keeps the view
 * returned by each mutation, re-reads it with `GET /api/integrations/mcp/<nom>` when needed, and marks
 * the Intégrations page stale so that it re-reads its data once the drawer closes.
 */
export function useMcpServer(initial: { server: McpServerView; context: McpDetailContext }): McpServerState {
  const [server, setServer] = useState(initial.server);
  const [context, setContextState] = useState(initial.context);
  const [testing, setTesting] = useState(false);
  const [testFailure, setTestFailure] = useState<McpServerState['testFailure']>(null);
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});

  const replace = useCallback((next: McpServerView) => {
    setServer(next);
    markIntegrationsStale();
  }, []);

  const test = useCallback(
    async (options: { successMessage?: string } = {}) => {
      setTesting(true);
      setTestFailure(null);
      try {
        const result = await integrationsApi.checkMcpServer(server.name);
        replace(result);
        if (result.status === 'connected') toast({ message: options.successMessage ?? `Connexion à ${result.label} vérifiée` });
        else setTestFailure({ server: result });
        return result;
      } catch (error) {
        setTestFailure({ error: toApiError(error) });
        return null;
      } finally {
        setTesting(false);
      }
    },
    [server.name, replace],
  );

  const toggle = useCallback(
    async (projectId: string, enabled: boolean) => {
      const previous = server;
      // Optimistic switch, rolled back on failure.
      setServer((current) => {
        const projects = current.projects.map((project) => (project.id === projectId ? { ...project, enabled } : project));
        return { ...current, projects, projectCount: projects.filter((project) => project.enabled).length };
      });
      setToggling((current) => ({ ...current, [projectId]: true }));
      setToggleErrors(({ [projectId]: _dropped, ...rest }) => rest);
      try {
        replace(await integrationsApi.setProjectEnabled(server.name, projectId, enabled));
      } catch (error) {
        setServer(previous);
        const failure = toApiError(error);
        setToggleErrors((current) => ({ ...current, [projectId]: `${failure.message} Le réglage du projet n'a pas changé.` }));
      } finally {
        setToggling(({ [projectId]: _done, ...rest }) => rest);
      }
    },
    [server, replace],
  );

  const disableEverywhere = useCallback(async () => {
    const result = await integrationsApi.disableEverywhere(server.name);
    replace(result.server);
    toast({ message: `${result.server.label} désactivé dans ${plural(result.disabledProjects, 'projet')}` });
  }, [server.name, replace]);

  const remove = useCallback(async () => {
    await integrationsApi.deleteMcpServer(server.name);
    markIntegrationsStale();
    toast({ message: `Serveur MCP « ${server.label} » supprimé` });
  }, [server.name, server.label]);

  const reload = useCallback(async () => {
    try {
      replace(await integrationsApi.getMcpServer(server.name));
    } catch {
      // The view stays as it was; the next action reports the problem.
    }
  }, [server.name, replace]);

  const setContext = useCallback((update: (context: McpDetailContext) => McpDetailContext) => setContextState(update), []);

  return { server, context, setContext, testing, testFailure, test, toggling, toggleErrors, toggle, disableEverywhere, remove, replace, reload };
}
