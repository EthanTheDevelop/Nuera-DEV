import 'server-only';
import { instanceConfigProposals, instanceRules, instanceSkillFiles, instanceSkills, user } from '@nuera/db/schema';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { assertAdmin, type AdminActor } from '@/server/admin/common';
import type { CurrentUser } from '@/server/auth/session';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { createNotification } from '@/server/notifications';
import { audit } from '@/server/security/audit';
import { assertRateLimit } from '@/server/security/rate-limit';
import { inAudience, proposalDecisionSchema, proposalInputSchema, type ProposalInput } from './model';
import { validateSkillFiles } from './skill-files';
import { assertConfigWriter, createRule, parseInput, updateRule, writeSkill } from './store';

/**
 * « Proposer une règle / un skill » (lot K1): any account suggests a new rule or skill, or a change of
 * one that applies to it; nothing reaches the sessions until an administrator approves it (the change
 * is then applied as a normal versioned change, authored by the approver, and the author is told).
 * A skill proposal carries its SKILL.md only (no script, no extra file).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROPOSAL_NOT_FOUND = 'Proposition introuvable.';
const PROPOSAL_LIMIT = { limit: 10, windowMs: 60 * 60_000 } as const;
const ADMIN_HREF = '/administration?onglet=claude&section=propositions';

type ProposalRow = typeof instanceConfigProposals.$inferSelect;

export interface ProposalView {
  id: string;
  kind: 'rule' | 'skill';
  targetId: string | null;
  title: string;
  payload: Record<string, unknown>;
  note: string | null;
  status: ProposalRow['status'];
  author: { id: string; name: string | null; email: string | null };
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  appliedItemId: string | null;
}

async function views(rows: ProposalRow[]): Promise<ProposalView[]> {
  const ids = [...new Set(rows.map((row) => row.authorUserId))];
  const authors = ids.length ? await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, ids)) : [];
  const byId = new Map(authors.map((author) => [author.id, author]));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    targetId: row.targetId,
    title: row.title,
    payload: row.payload,
    note: row.note,
    status: row.status,
    author: { id: row.authorUserId, name: byId.get(row.authorUserId)?.name ?? null, email: byId.get(row.authorUserId)?.email ?? null },
    reviewNote: row.reviewNote,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    appliedItemId: row.appliedItemId,
  }));
}

async function adminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.role, ['owner', 'admin']), isNull(user.deletedAt), isNull(user.disabledAt)));
  return rows.map((row) => row.id);
}

export async function createProposal(author: Pick<CurrentUser, 'id' | 'email' | 'role' | 'name'>, input: ProposalInput | unknown): Promise<ProposalView> {
  assertRateLimit('claude-config:proposal', author.id, PROPOSAL_LIMIT);
  const data = parseInput(proposalInputSchema, input, 'Proposition invalide.');
  if (data.targetId) {
    // A change of an item outside the author's audience answers like an unknown one.
    const [target] =
      data.kind === 'rule'
        ? await db.select({ audience: instanceRules.audience }).from(instanceRules).where(eq(instanceRules.id, data.targetId)).limit(1)
        : await db.select({ audience: instanceSkills.audience }).from(instanceSkills).where(eq(instanceSkills.id, data.targetId)).limit(1);
    if (!target || !inAudience(target.audience, author.role)) {
      throw new AppError('NOT_FOUND', data.kind === 'rule' ? 'Règle introuvable.' : 'Skill introuvable.');
    }
  }
  let payload: Record<string, unknown>;
  let title: string;
  if (data.kind === 'rule') {
    payload = { title: data.title, body: data.body };
    title = data.title;
  } else {
    const validated = validateSkillFiles([{ path: 'SKILL.md', content: data.skillMd }], { allowScripts: false, expectedName: data.name });
    payload = { name: validated.name, description: validated.description, skillMd: data.skillMd };
    title = validated.name;
  }
  const [row] = await db
    .insert(instanceConfigProposals)
    .values({ kind: data.kind, targetId: data.targetId ?? null, title, payload, note: data.note ?? null, authorUserId: author.id })
    .returning();
  await audit({
    action: 'instance.claude_proposal_created',
    summary: `proposition de ${data.kind === 'rule' ? 'règle' : 'skill'} commun : « ${title} »`,
    actorUserId: author.id,
    targetType: 'claude_proposal',
    targetId: row!.id,
    metadata: { kind: data.kind, change: Boolean(data.targetId) },
  });
  const recipients = (await adminIds()).filter((id) => id !== author.id);
  if (recipients.length) {
    await createNotification(
      {
        kind: 'claude_config',
        severity: 'info',
        title: `Proposition de ${data.kind === 'rule' ? 'règle' : 'skill'} commun : « ${title.slice(0, 120)} »`,
        body: `${author.name || author.email} propose ${data.targetId ? 'une modification' : 'un ajout'} à la configuration Claude commune.`,
        href: ADMIN_HREF,
        dedupKey: `claude-config:proposal:${row!.id}`,
      },
      { userIds: recipients },
    ).catch(() => undefined);
  }
  return (await views([row!]))[0]!;
}

export async function listMyProposals(author: Pick<CurrentUser, 'id'>): Promise<ProposalView[]> {
  const rows = await db.select().from(instanceConfigProposals).where(eq(instanceConfigProposals.authorUserId, author.id)).orderBy(desc(instanceConfigProposals.createdAt)).limit(50);
  return views(rows);
}

export async function withdrawProposal(author: Pick<CurrentUser, 'id'>, id: string): Promise<void> {
  if (!UUID.test(id)) throw new AppError('NOT_FOUND', PROPOSAL_NOT_FOUND);
  const [row] = await db
    .update(instanceConfigProposals)
    .set({ status: 'withdrawn', reviewedAt: new Date() })
    .where(and(eq(instanceConfigProposals.id, id), eq(instanceConfigProposals.authorUserId, author.id), eq(instanceConfigProposals.status, 'pending')))
    .returning({ id: instanceConfigProposals.id });
  if (!row) throw new AppError('NOT_FOUND', PROPOSAL_NOT_FOUND);
}

export async function listProposals(actor: AdminActor, status: 'pending' | 'all' = 'pending'): Promise<ProposalView[]> {
  assertAdmin(actor);
  const rows = await db
    .select()
    .from(instanceConfigProposals)
    .where(status === 'pending' ? eq(instanceConfigProposals.status, 'pending') : undefined)
    .orderBy(desc(instanceConfigProposals.createdAt))
    .limit(100);
  return views(rows);
}

/** « Approuver » applies the proposal (new version, journal); « Refuser » keeps nothing. The author is told. */
export async function decideProposal(actor: AdminActor, id: string, input: unknown): Promise<ProposalView> {
  assertConfigWriter(actor);
  const { decision, note } = parseInput(proposalDecisionSchema, input, 'Décision invalide.');
  if (!UUID.test(id)) throw new AppError('NOT_FOUND', PROPOSAL_NOT_FOUND);
  const [row] = await db.select().from(instanceConfigProposals).where(eq(instanceConfigProposals.id, id)).limit(1);
  if (!row) throw new AppError('NOT_FOUND', PROPOSAL_NOT_FOUND);
  if (row.status !== 'pending') throw new AppError('CONFLICT', 'Cette proposition a déjà été traitée.');
  // Claimed first: two administrators deciding at once never both apply it.
  const [claimed] = await db
    .update(instanceConfigProposals)
    .set({ status: decision === 'approve' ? 'approved' : 'rejected', reviewerUserId: actor.id, reviewNote: note ?? null, reviewedAt: new Date() })
    .where(and(eq(instanceConfigProposals.id, id), eq(instanceConfigProposals.status, 'pending')))
    .returning();
  if (!claimed) throw new AppError('CONFLICT', 'Cette proposition a déjà été traitée.');
  let appliedItemId: string | null = null;
  if (decision === 'approve') {
    try {
      appliedItemId = await applyProposal(actor, row);
    } catch (error) {
      // Nothing applied: the proposal goes back to the pending list.
      await db.update(instanceConfigProposals).set({ status: 'pending', reviewerUserId: null, reviewNote: null, reviewedAt: null }).where(eq(instanceConfigProposals.id, id));
      throw error;
    }
    await db.update(instanceConfigProposals).set({ appliedItemId }).where(eq(instanceConfigProposals.id, id));
  }
  await audit({
    action: decision === 'approve' ? 'instance.claude_proposal_approved' : 'instance.claude_proposal_rejected',
    summary: `proposition « ${row.title} » ${decision === 'approve' ? 'approuvée' : 'refusée'}`,
    actorUserId: actor.id,
    subjectUserId: row.authorUserId,
    targetType: 'claude_proposal',
    targetId: row.id,
    metadata: { kind: row.kind, appliedItemId },
  });
  if (row.authorUserId !== actor.id) {
    await createNotification(
      {
        kind: 'claude_config',
        severity: decision === 'approve' ? 'success' : 'info',
        title: decision === 'approve' ? `Proposition approuvée : « ${row.title.slice(0, 120)} »` : `Proposition refusée : « ${row.title.slice(0, 120)} »`,
        body: note ? note.slice(0, 500) : decision === 'approve' ? 'Elle s\'applique aux prochaines sessions.' : null,
        href: '/parametres?onglet=claude-code',
        dedupKey: `claude-config:decision:${row.id}`,
      },
      { userIds: [row.authorUserId] },
    ).catch(() => undefined);
  }
  return (await views([{ ...claimed, appliedItemId }]))[0]!;
}

async function applyProposal(actor: AdminActor, row: ProposalRow): Promise<string> {
  const payload = row.payload;
  if (row.kind === 'rule') {
    const input = { title: String(payload.title ?? row.title), body: String(payload.body ?? '') };
    if (row.targetId) return (await updateRule(actor, row.targetId, input)).id;
    return (await createRule(actor, input)).id;
  }
  const skillMd = String(payload.skillMd ?? '');
  const name = String(payload.name ?? row.title);
  if (row.targetId) {
    const [target] = await db.select().from(instanceSkills).where(eq(instanceSkills.id, row.targetId)).limit(1);
    if (!target) throw new AppError('CONFLICT', "Le skill visé par la proposition n'existe plus.");
    const others = (await db.select().from(instanceSkillFiles).where(eq(instanceSkillFiles.skillId, target.id)))
      .filter((file) => file.path !== 'SKILL.md')
      .map((file) => ({ path: file.path, content: file.content }));
    const validated = validateSkillFiles([{ path: 'SKILL.md', content: skillMd }, ...others], { allowScripts: target.allowScripts, expectedName: target.name });
    return (await writeSkill(actor, validated, { allowScripts: target.allowScripts, replace: true, source: 'proposal' })).skill.id;
  }
  const validated = validateSkillFiles([{ path: 'SKILL.md', content: skillMd }], { allowScripts: false, expectedName: name });
  return (await writeSkill(actor, validated, { allowScripts: false, source: 'proposal' })).skill.id;
}
