import { relations } from 'drizzle-orm';
import { session, user } from './auth';
import { mcpServers, projectMcpServers } from './integrations';
import { commandRuns, projectEnvVars, projects, pullRequests, worktrees } from './projects';
import { permissionRequests, sessionEvents, sessions } from './sessions';

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
}));

export const authSessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const projectRelations = relations(projects, ({ many }) => ({
  worktrees: many(worktrees),
  sessions: many(sessions),
  envVars: many(projectEnvVars),
  commandRuns: many(commandRuns),
  pullRequests: many(pullRequests),
  mcpServers: many(projectMcpServers),
}));

export const worktreeRelations = relations(worktrees, ({ one, many }) => ({
  project: one(projects, { fields: [worktrees.projectId], references: [projects.id] }),
  sessions: many(sessions),
}));

export const projectEnvVarRelations = relations(projectEnvVars, ({ one }) => ({
  project: one(projects, { fields: [projectEnvVars.projectId], references: [projects.id] }),
}));

export const commandRunRelations = relations(commandRuns, ({ one }) => ({
  project: one(projects, { fields: [commandRuns.projectId], references: [projects.id] }),
  worktree: one(worktrees, { fields: [commandRuns.worktreeId], references: [worktrees.id] }),
}));

export const pullRequestRelations = relations(pullRequests, ({ one }) => ({
  project: one(projects, { fields: [pullRequests.projectId], references: [projects.id] }),
}));

export const sessionRelations = relations(sessions, ({ one, many }) => ({
  project: one(projects, { fields: [sessions.projectId], references: [projects.id] }),
  worktree: one(worktrees, { fields: [sessions.worktreeId], references: [worktrees.id] }),
  events: many(sessionEvents),
  permissionRequests: many(permissionRequests),
}));

export const sessionEventRelations = relations(sessionEvents, ({ one }) => ({
  session: one(sessions, { fields: [sessionEvents.sessionId], references: [sessions.id] }),
}));

export const permissionRequestRelations = relations(permissionRequests, ({ one }) => ({
  session: one(sessions, { fields: [permissionRequests.sessionId], references: [sessions.id] }),
}));

export const mcpServerRelations = relations(mcpServers, ({ many }) => ({
  projects: many(projectMcpServers),
}));

export const projectMcpServerRelations = relations(projectMcpServers, ({ one }) => ({
  project: one(projects, { fields: [projectMcpServers.projectId], references: [projects.id] }),
  mcpServer: one(mcpServers, { fields: [projectMcpServers.mcpServerId], references: [mcpServers.id] }),
}));
