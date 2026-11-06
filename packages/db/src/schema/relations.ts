import { relations } from 'drizzle-orm';
import { session, user } from './auth';
import { githubSources } from './github';
import { mcpServers, projectMcpServers } from './integrations';
import { commandRuns, projectEnvVars, projects, pullRequests, worktrees } from './projects';
import { permissionRequests, sessionEvents, sessions } from './sessions';
import { environmentSpaces, environments, invitations, spaceMembers, spaceSettings, spaces, userPreferences } from './tenancy';

export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  spaceMemberships: many(spaceMembers),
  preferences: one(userPreferences),
}));

export const authSessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const spaceRelations = relations(spaces, ({ one, many }) => ({
  owner: one(user, { fields: [spaces.ownerUserId], references: [user.id] }),
  members: many(spaceMembers),
  settings: one(spaceSettings),
  environments: many(environments),
  environmentLinks: many(environmentSpaces),
  githubSources: many(githubSources),
  projects: many(projects),
}));

export const environmentSpaceRelations = relations(environmentSpaces, ({ one }) => ({
  environment: one(environments, { fields: [environmentSpaces.environmentId], references: [environments.id] }),
  space: one(spaces, { fields: [environmentSpaces.spaceId], references: [spaces.id] }),
}));

export const spaceMemberRelations = relations(spaceMembers, ({ one }) => ({
  space: one(spaces, { fields: [spaceMembers.spaceId], references: [spaces.id] }),
  user: one(user, { fields: [spaceMembers.userId], references: [user.id] }),
}));

export const spaceSettingsRelations = relations(spaceSettings, ({ one }) => ({
  space: one(spaces, { fields: [spaceSettings.spaceId], references: [spaces.id] }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(user, { fields: [userPreferences.userId], references: [user.id] }),
}));

export const environmentRelations = relations(environments, ({ one, many }) => ({
  space: one(spaces, { fields: [environments.spaceId], references: [spaces.id] }),
  spaceLinks: many(environmentSpaces),
  projects: many(projects),
}));

export const invitationRelations = relations(invitations, ({ one }) => ({
  user: one(user, { fields: [invitations.userId], references: [user.id] }),
  environment: one(environments, { fields: [invitations.environmentId], references: [environments.id] }),
}));

export const githubSourceRelations = relations(githubSources, ({ one, many }) => ({
  space: one(spaces, { fields: [githubSources.spaceId], references: [spaces.id] }),
  projects: many(projects),
}));

export const projectRelations = relations(projects, ({ one, many }) => ({
  space: one(spaces, { fields: [projects.spaceId], references: [spaces.id] }),
  environment: one(environments, { fields: [projects.environmentId], references: [environments.id] }),
  githubSource: one(githubSources, { fields: [projects.githubSourceId], references: [githubSources.id] }),
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
