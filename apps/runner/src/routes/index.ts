import type { FastifyInstance } from 'fastify';
import { encodeHeartbeat, encodeSseEvent, HEARTBEAT_INTERVAL_MS, SSE_RETRY_MS, type RunnerEvent } from '@nuera/shared/events';
import { GLOBAL, operationChannel, runChannel, sessionChannel } from '../events/bus';
import { RunnerError } from '../errors';
import { defineRoute } from '../http/route';
import { openSseStream, snapshot } from '../http/sse';
import type { RunnerServices } from '../services';

/** Every /v1 route of the shared contract (`RUNNER_ROUTES`). */
export function registerRoutes(app: FastifyInstance, s: RunnerServices): void {
  // --- Health & system ------------------------------------------------------------------------
  defineRoute(app, 'health', async () => s.health());
  defineRoute(app, 'systemMetrics', async () => s.metrics.collect());
  defineRoute(app, 'systemUptime', async ({ query }) => s.uptime.report(query.days));

  // --- Events ---------------------------------------------------------------------------------
  defineRoute(app, 'events', async ({ request, reply, query }) => {
    // The account of the stream (lot P1): its own Claude status only, never another account's.
    const account = await s.accounts.forRequest(query.spaceId).catch(() => null);
    await openSseStream({
      request,
      reply,
      bus: s.bus,
      channel: GLOBAL,
      replayable: true,
      filter: (event) => event.type !== 'claude.status' || (account !== null && (event.data.spaceId ?? null) === account.spaceId),
      initial: async () => {
        const items = [snapshot('system.metrics', await s.metrics.collect())];
        const claude = account ? s.claude.cached(account) : null;
        if (claude) items.push(snapshot('claude.status', claude));
        return items;
      },
    });
  });
  defineRoute(app, 'publishEvent', async ({ body }) => {
    s.bus.publish(body.type, body.data, { channels: [GLOBAL] });
    return { ok: true as const };
  });

  // --- Repositories ---------------------------------------------------------------------------
  defineRoute(app, 'checkDestination', async ({ body }) => s.clone.checkDestination(body));
  defineRoute(app, 'cloneRepo', async ({ body }) => {
    const op = await s.clone.start(body);
    return { operationId: op.id, operation: op.snapshot };
  });
  defineRoute(app, 'fetchRepo', async ({ params, body }) => s.git.fetch(params.projectId, body));
  defineRoute(app, 'pullRepo', async ({ params, body }) => s.git.pull(params.projectId, body));
  defineRoute(app, 'repoStatus', async ({ params, query }) => s.git.repoStatus(params.projectId, query.worktreeId));
  defineRoute(app, 'repoSync', async ({ params }) => s.git.syncStatus(params.projectId));
  defineRoute(app, 'listBranches', async ({ params, query }) => s.git.branches(params.projectId, query.protected));
  defineRoute(app, 'createBranch', async ({ params, body }) => s.git.createBranch(params.projectId, body));
  defineRoute(app, 'checkoutBranch', async ({ params, body }) => s.git.checkout(params.projectId, body));
  defineRoute(app, 'repoLog', async ({ params, query }) => s.git.log(params.projectId, query));

  // --- Worktrees ------------------------------------------------------------------------------
  defineRoute(app, 'listWorktrees', async ({ params, query }) => s.git.listWorktrees(params.projectId, { sizes: query.sizes ?? false }));
  defineRoute(app, 'removeClone', async ({ params, query }) => s.git.removeClone(params.projectId, { actorUserId: query.actorUserId ?? null }));
  defineRoute(app, 'createWorktree', async ({ params, body }) => s.git.worktreeDto(await s.git.createWorktree(params.projectId, body)));
  defineRoute(app, 'removeWorktree', async ({ params, query }) => s.git.removeWorktree(params.worktreeId, { force: query.force, deleteBranch: query.deleteBranch, actorUserId: query.actorUserId ?? null }));
  defineRoute(app, 'worktreeStatus', async ({ params }) => s.git.worktreeStatus(params.worktreeId));

  // --- Changes --------------------------------------------------------------------------------
  defineRoute(app, 'worktreeChanges', async ({ params, query }) => s.git.changes(params.worktreeId, query));
  defineRoute(app, 'worktreeDiff', async ({ params, query }) => s.git.diff(params.worktreeId, query));
  defineRoute(app, 'stagePaths', async ({ params, body }) => s.git.stage(params.worktreeId, body.paths));
  defineRoute(app, 'unstagePaths', async ({ params, body }) => s.git.unstage(params.worktreeId, body.paths));
  defineRoute(app, 'commit', async ({ params, body }) => s.git.commit(params.worktreeId, body));
  defineRoute(app, 'push', async ({ params, body }) => s.git.push(params.worktreeId, body));
  defineRoute(app, 'aheadBehind', async ({ params, query }) => s.git.aheadBehind(params.worktreeId, query));

  // --- Files ----------------------------------------------------------------------------------
  defineRoute(app, 'fileTree', async ({ params, query }) => s.files.tree(params.worktreeId, query.path));
  defineRoute(app, 'readFile', async ({ params, query }) => s.files.read(params.worktreeId, query.path));
  defineRoute(app, 'readClaudeMd', async ({ params, query }) => s.git.readClaudeMd(params.projectId, query.worktreeId));
  defineRoute(app, 'writeClaudeMd', async ({ params, body }) => s.git.writeClaudeMd(params.projectId, body));

  // --- Operations -----------------------------------------------------------------------------
  defineRoute(app, 'getOperation', async ({ params }) => {
    const op = await s.ops.get(params.operationId);
    if (!op) throw new RunnerError('NOT_FOUND', 'Opération introuvable.');
    return op;
  });
  defineRoute(app, 'operationStream', async ({ params, request, reply }) => {
    const op = await s.ops.get(params.operationId);
    if (!op) throw new RunnerError('NOT_FOUND', 'Opération introuvable.');
    await openSseStream({
      request,
      reply,
      bus: s.bus,
      channel: operationChannel(params.operationId),
      replayable: true,
      initial: async ({ replayed }) => {
        if (replayed) return [];
        const current = await s.ops.get(params.operationId);
        if (!current) return [];
        const { log, liveLine, ...operation } = current;
        return [snapshot('operation.progress', { operation, log, liveLine })];
      },
    });
  });

  // --- Terminals ------------------------------------------------------------------------------
  defineRoute(app, 'createTerminal', async ({ body }) => (await s.terminals.create(body)).toDto());
  defineRoute(app, 'listTerminals', async () => ({ terminals: s.terminals.list() }));
  defineRoute(app, 'getTerminal', async ({ params }) => s.terminals.get(params.terminalId).toDto());
  defineRoute(app, 'terminalStream', async ({ params, reply }) => {
    const terminal = s.terminals.get(params.terminalId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = (end = false) => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      if (end) res.end();
    };
    res.on('close', () => cleanup());
    unsubscribe = terminal.subscribe((frame) => {
      if (closed) return;
      const event = { seq: 0, at: new Date().toISOString(), ...frame } as RunnerEvent;
      res.write(encodeSseEvent(event, { withId: false }));
      // A client that does not read is dropped (it reconnects and gets a fresh snapshot).
      if (res.writableLength > 16 * 1024 * 1024) cleanup(true);
    });
    heartbeat = setInterval(() => res.write(encodeHeartbeat()), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
  });
  defineRoute(app, 'terminalInput', async ({ params, body }) => {
    const terminal = s.terminals.get(params.terminalId);
    if (!terminal.alive) throw new RunnerError('CONFLICT', 'Le terminal est fermé.', { reason: 'TERMINAL_CLOSED' });
    terminal.write(body.data);
    // Échap / Ctrl+C typed in the raw terminal of a session: same as « Interrompre » (no hook follows).
    if (terminal.kind === 'session' && terminal.sessionId && /^(?:\u001b|\u0003)$/.test(body.data)) s.sessions.noteInterrupt(terminal.sessionId);
    return { ok: true as const };
  });
  defineRoute(app, 'terminalResize', async ({ params, body }) => {
    s.terminals.get(params.terminalId).resize(body.cols, body.rows, body.clientId);
    return { ok: true as const };
  });
  defineRoute(app, 'closeTerminal', async ({ params }) => {
    s.terminals.close(params.terminalId);
    return { ok: true as const };
  });

  // --- Claude sessions ------------------------------------------------------------------------
  defineRoute(app, 'createSession', async ({ body }) => s.sessions.create(body));
  defineRoute(app, 'listSessions', async () => s.sessions.list());
  defineRoute(app, 'getSession', async ({ params }) => s.sessions.dto(params.sessionId));
  defineRoute(app, 'startSession', async ({ params, body }) => s.sessions.start(params.sessionId, body.launch));
  defineRoute(app, 'resumeSession', async ({ params, body }) => s.sessions.resume(params.sessionId, body.launch, [], body.fresh ? { fresh: body.fresh } : {}));
  defineRoute(app, 'sendInstruction', async ({ params, body }) => s.sessions.sendInstruction(params.sessionId, body.text));
  defineRoute(app, 'interruptSession', async ({ params }) => s.sessions.interrupt(params.sessionId));
  defineRoute(app, 'announceSession', async ({ params }) => s.sessions.announce(params.sessionId));
  defineRoute(app, 'setSessionAutoResume', async ({ params, body }) => s.sessions.setAutoResume(params.sessionId, body));
  defineRoute(app, 'sessionAttachment', async ({ params, body }) => s.composer.saveAttachment(params.sessionId, body));
  defineRoute(app, 'sessionCommand', async ({ params, body }) => s.sessions.runSlashCommand(params.sessionId, body));
  defineRoute(app, 'sessionPermissionMode', async ({ params, body }) => s.sessions.switchPermissionMode(params.sessionId, body.mode));
  defineRoute(app, 'sessionSkills', async ({ params }) => s.composer.listSkills(params.sessionId));
  defineRoute(app, 'stopSession', async ({ params, body }) => s.sessions.stop(params.sessionId, body));
  defineRoute(app, 'sessionEvents', async ({ params, query }) => {
    await s.sessions.dto(params.sessionId);
    const page = await s.store.list(params.sessionId, query.afterVersion, query.limit);
    return { sessionId: params.sessionId, ...page };
  });
  defineRoute(app, 'sessionStream', async ({ params, request, reply }) => {
    await s.sessions.dto(params.sessionId);
    await openSseStream({
      request,
      reply,
      bus: s.bus,
      channel: sessionChannel(params.sessionId),
      replayable: true,
      initial: async () => {
        const dto = await s.sessions.dto(params.sessionId);
        const items = [
          snapshot('session.status', {
            sessionId: dto.id,
            projectId: dto.projectId,
            status: dto.status,
            live: dto.live,
            currentActivity: dto.currentActivity,
            lastInstruction: dto.lastInstruction,
            lastActivityAt: dto.lastActivityAt,
            startedAt: dto.startedAt,
            endedAt: dto.endedAt,
            planDone: dto.planDone,
            planTotal: dto.planTotal,
            errorCode: dto.errorCode,
            errorMessage: dto.errorMessage,
            cliStatus: dto.cliStatus,
            pendingPermissionId: dto.pendingPermission?.id ?? null,
            remoteControlUrl: dto.remoteControlUrl,
            queuedInstructions: dto.queuedInstructions,
          }),
        ];
        if (dto.pendingPermission) items.push(snapshot('session.permission', { sessionId: dto.id, permission: dto.pendingPermission }));
        return items;
      },
    });
  });
  defineRoute(app, 'sessionTerminal', async ({ params }) => {
    await s.sessions.dto(params.sessionId);
    const terminal = s.sessions.terminalFor(params.sessionId);
    return { terminalId: terminal?.id ?? null, live: Boolean(terminal?.alive) };
  });
  defineRoute(app, 'permissionDecision', async ({ params, body }) => s.sessions.decide(params.permissionId, body));

  // --- Project processes ----------------------------------------------------------------------
  defineRoute(app, 'createRun', async ({ body }) => s.runs.create(body));
  defineRoute(app, 'getRun', async ({ params }) => s.runs.get(params.runId));
  defineRoute(app, 'runStream', async ({ params, request, reply }) => {
    await s.runs.get(params.runId);
    await openSseStream({
      request,
      reply,
      bus: s.bus,
      channel: runChannel(params.runId),
      replayable: false,
      initial: async () => [
        snapshot('run.status', { run: await s.runs.get(params.runId) }),
        snapshot('run.output', { runId: params.runId, data: await s.runs.outputTail(params.runId), replay: true }),
      ],
    });
  });
  defineRoute(app, 'stopRun', async ({ params }) => s.runs.stop(params.runId));

  // --- Claude CLI -----------------------------------------------------------------------------
  // Every Claude route acts for ONE account of the server (its CLI config folder, lot P1).
  defineRoute(app, 'claudeStatus', async ({ query }) => s.publishClaudeStatus(await s.accounts.forRequest(query.spaceId), { refresh: query.refresh }));
  defineRoute(app, 'claudeMcpSync', async ({ body }) => s.claude.mcpSync(await s.accounts.forRequest(body.spaceId), body));
  defineRoute(app, 'claudeConfigStatus', async ({ query }) => s.commonConfig.for(await s.accounts.forRequest(query.spaceId)).current());
  defineRoute(app, 'claudeConfigSync', async ({ body }) => {
    s.accounts.invalidate();
    if (body.spaceId) return s.commonConfig.for(await s.accounts.forSpace(body.spaceId)).sync(body.reason);
    return s.commonConfig.syncAll(body.reason);
  });
  defineRoute(app, 'claudeMcpGet', async ({ params, query }) => s.claude.mcpGet(await s.accounts.forRequest(query.spaceId), params.name, { refresh: true }));
  defineRoute(app, 'claudeAccountForget', async ({ params, body }) =>
    s.accounts.forget(params.spaceId, (account) => s.claude.signOut(account), { deleted: body.deleted }),
  );
}
