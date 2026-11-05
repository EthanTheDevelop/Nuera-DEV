/**
 * Fake Coolify v4.6 API (tests only): health, version, team (403 for scoped tokens), projects and
 * environments, applications, deployments, and the built-in MCP server at /mcp whose tools depend
 * on the token's abilities. Records every request (method + path) to prove the client is GET-only.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, newMcpState, type FakeMcpState } from '@/server/mcp/test/fake-mcp';

export interface FakeCoolifyToken {
  value: string;
  scoped: boolean;
  abilities: string[];
  revoked?: boolean;
}

export interface FakeCoolify {
  url: string;
  tokens: FakeCoolifyToken[];
  environments: Array<{ project: string; uuid: string; envs: string[] }>;
  applications: Array<Record<string, unknown>>;
  requests: Array<{ method: string; path: string }>;
  down: boolean;
  mcp: FakeMcpState;
  close(): Promise<void>;
}

const READ_TOOLS = ['list_applications', 'get_application', 'list_deployments', 'get_current_team', 'coolify_help'];

export function toolsFor(abilities: string[]): string[] {
  const tools = [...READ_TOOLS];
  if (abilities.includes('read:sensitive')) tools.push('get_env_values');
  if (abilities.includes('deploy')) tools.push('deploy', 'control', 'cancel_deployment', 'rollback_application');
  if (abilities.includes('write')) tools.push('manage_application', 'create_application');
  return tools;
}

export async function startFakeCoolify(): Promise<FakeCoolify> {
  const mcp = newMcpState({ expectedAuthorization: null, tools: READ_TOOLS, serverName: 'Coolify' });
  const mcpHandler = createMcpHandler(mcp);
  const state = {
    tokens: [] as FakeCoolifyToken[],
    environments: [] as FakeCoolify['environments'],
    applications: [] as FakeCoolify['applications'],
    requests: [] as FakeCoolify['requests'],
    down: false,
    mcp,
  };
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      state.requests.push({ method: req.method ?? 'GET', path: url.pathname });
      if (state.down) {
        res.destroy();
        return;
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const token = state.tokens.find((item) => item.value === bearer && !item.revoked);
      if (url.pathname === '/mcp') {
        // MCP tools follow the abilities of the token presenting itself.
        mcp.expectedAuthorization = token ? `Bearer ${token.value}` : 'Bearer <valid>';
        mcp.tools = token ? toolsFor(token.abilities) : [];
        void mcpHandler(req, res, Buffer.concat(chunks).toString('utf8'));
        return;
      }
      if (req.method !== 'GET') return json(res, 405, { message: 'This endpoint has changed to a POST request.' });
      if (url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }
      if (!token) return json(res, 401, { message: 'Unauthenticated.' });
      if (url.pathname === '/api/v1/version') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('4.6.0');
        return;
      }
      if (url.pathname === '/api/v1/team') {
        if (token.scoped) {
          return json(res, 403, { message: 'This API token is limited to selected projects, environments, or resources, so it cannot use this endpoint.' });
        }
        return json(res, 200, { id: 1, name: 'Développement' });
      }
      if (url.pathname === '/api/v1/projects') return json(res, 200, state.environments.map((item, index) => ({ id: index + 1, uuid: item.uuid, name: item.project })));
      const env = /^\/api\/v1\/projects\/([^/]+)\/environments$/.exec(url.pathname);
      if (env) {
        const project = state.environments.find((item) => item.uuid === env[1]);
        return project ? json(res, 200, project.envs.map((name, index) => ({ id: index + 1, name }))) : json(res, 404, { message: 'Not found.' });
      }
      if (url.pathname === '/api/v1/applications') return json(res, 200, state.applications);
      const deployments = /^\/api\/v1\/deployments\/applications\/([^/]+)$/.exec(url.pathname);
      if (deployments) {
        return json(res, 200, {
          count: 1,
          deployments: [{ id: 1, deployment_uuid: 'dep-1', status: 'finished', commit: 'a3f9c12', commit_message: 'crm', deployment_url: '/deploy/1', logs: '[{"output":"secret log"}]' }],
        });
      }
      return json(res, 404, { message: 'Not found.' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fake = state as FakeCoolify;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
