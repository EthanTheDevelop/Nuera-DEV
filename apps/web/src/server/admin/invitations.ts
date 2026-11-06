import 'server-only';
import { environments, invitations, user } from '@nuera/db/schema';
import type { InstanceRole } from '@nuera/db/schema';
import { SHARED_SERVER_CONTRACT_VERSION } from '@nuera/shared/runner';
import { generateLinkToken, hashToken } from '@nuera/shared/tokens';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@/server/db';
import { getAppOrigin } from '@/server/auth/auth';
import { AppError } from '@/server/errors';
import { audit } from '@/server/security/audit';
import { getInstanceSettings } from '@/server/settings';
import { assertAdmin, assertAdminMutation, NOT_FOUND_INVITATION, NOT_FOUND_SERVER, UUID_PATTERN, type AdminActor } from './common';
import { sharedServerOutdatedMessage } from './servers';

/**
 * Administration › Comptes › invitations (docs/MULTICOMPTE.md §6): an owner or administrator invites
 * an e-mail with a role (`admin` | `member`), a validity (instance setting, 48 h by default) and
 * optionally a `pending` server pre-assigned to the space the invitation will create. Nuera Dev sends
 * no e-mail: the link `/invitation/<jeton>` is shown ONCE (only its sha256 is stored) and the
 * administrator passes it on. A pending invitation can be revoked; inviting the same e-mail again
 * replaces the previous pending link.
 */

export const VALIDITY_CHOICES = [24, 48, 168] as const;

export const createInvitationSchema = z.object({
  email: z.string('e-mail requis').trim().toLowerCase().max(200, '200 caractères au maximum').pipe(z.email('adresse e-mail invalide')),
  role: z.enum(['admin', 'member'], 'rôle attendu : admin ou member').default('member'),
  environmentId: z.uuid('serveur invalide').nullish(),
  /** Hours (1–168); default: the instance setting « Validité des invitations ». */
  validityHours: z.number().int().min(1, '1 h au minimum').max(168, '7 jours au maximum').optional(),
});
export type CreateInvitationInput = z.input<typeof createInvitationSchema>;

export interface AdminInvitationView {
  id: string;
  email: string;
  role: InstanceRole;
  server: { id: string; name: string } | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** `pending`: link not used yet · `expired` · `activation`: account created, second factor not enrolled yet. */
  status: 'pending' | 'expired' | 'activation';
}

export interface CreatedInvitation {
  id: string;
  /** The link, shown once. */
  url: string;
  email: string;
  role: InstanceRole;
  expiresAt: string;
  server: { id: string; name: string } | null;
}

/** `<APP_URL>/invitation/<jeton>`. */
export function invitationUrl(token: string, appOrigin = getAppOrigin()): string {
  return new URL(`/invitation/${token}`, appOrigin).toString();
}

/** Invitations still in progress (not revoked; not used, or accepted without the second factor yet). */
export async function listInvitations(actor: AdminActor): Promise<AdminInvitationView[]> {
  assertAdmin(actor);
  const creator = alias(user, 'creator');
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      serverId: environments.id,
      serverName: environments.name,
      createdBy: creator.name,
    })
    .from(invitations)
    .leftJoin(environments, eq(environments.id, invitations.environmentId))
    .leftJoin(creator, eq(creator.id, invitations.createdByUserId))
    .where(and(eq(invitations.kind, 'invite'), isNull(invitations.revokedAt), isNull(invitations.completedAt)))
    .orderBy(desc(invitations.createdAt))
    .limit(200);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    server: row.serverId && row.serverName ? { id: row.serverId, name: row.serverName } : null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.acceptedAt ? 'activation' : row.expiresAt.getTime() <= now ? 'expired' : 'pending',
  }));
}

/** Creates an invitation and returns its link (shown once). */
export async function createInvitation(actor: AdminActor, rawInput: CreateInvitationInput): Promise<CreatedInvitation> {
  assertAdminMutation(actor);
  const parsed = createInvitationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', {
      detail: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'invitation'} : ${issue.message}`).join(' ; '),
    });
  }
  const input = parsed.data;
  const validityHours = input.validityHours ?? (await getInstanceSettings()).invitationTtlHours;
  const token = generateLinkToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + validityHours * 3_600_000);

  const created = await db.transaction(async (tx) => {
    // One invitation per e-mail at a time: serialises two administrators inviting the same address.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`nuera:invitation:${input.email}`}))`);
    const [existing] = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${input.email}`).limit(1);
    if (existing) throw new AppError('CONFLICT', 'Un compte existe déjà avec cette adresse e-mail.');

    let server: { id: string; name: string } | null = null;
    if (input.environmentId) {
      const [row] = await tx
        .select({
          id: environments.id,
          name: environments.name,
          status: environments.status,
          spaceId: environments.spaceId,
          contractVersion: environments.contractVersion,
        })
        .from(environments)
        .where(eq(environments.id, input.environmentId))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
      // Shared servers (lot P1): a server in service may also welcome the invited account, which will
      // have its own space and its own Claude Code connection there.
      const shared = row.status === 'active' && row.spaceId !== null;
      if (shared && (row.contractVersion ?? 1) < SHARED_SERVER_CONTRACT_VERSION) {
        throw new AppError('CONFLICT', sharedServerOutdatedMessage(row.name), { reason: 'RUNNER_OUTDATED' });
      }
      if (!shared && (row.status !== 'pending' || row.spaceId)) {
        throw new AppError('CONFLICT', "Ce serveur n'est plus libre : choisissez un serveur jamais utilisé ou un serveur en service.");
      }
      const [promised] = shared ? [] : await tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.environmentId, row.id),
            eq(invitations.kind, 'invite'),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, now),
            sql`lower(${invitations.email}) <> ${input.email}`,
          ),
        )
        .limit(1);
      if (promised) throw new AppError('CONFLICT', 'Ce serveur est déjà promis à une autre invitation en cours.');
      server = { id: row.id, name: row.name };
    }

    // Inviting again replaces the previous link (expired or not): it frees invitations_pending_email_idx.
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(and(eq(invitations.kind, 'invite'), eq(invitations.email, input.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const [row] = await tx
      .insert(invitations)
      .values({
        kind: 'invite',
        email: input.email,
        role: input.role,
        environmentId: server?.id ?? null,
        tokenHash: hashToken(token),
        expiresAt,
        createdByUserId: actor.id,
        createdAt: now,
      })
      .returning({ id: invitations.id });
    return { id: row!.id, server };
  });

  await audit({
    action: 'admin.invitation_created',
    summary: `invitation créée pour ${input.email} (${input.role === 'admin' ? 'administrateur' : 'membre'}, ${validityHours} h)${created.server ? ` · serveur « ${created.server.name} »` : ''}`,
    actorUserId: actor.id,
    targetType: 'invitation',
    targetId: created.id,
    environmentId: created.server?.id ?? null,
    metadata: { email: input.email, role: input.role, validityHours, expiresAt: expiresAt.toISOString() },
  });
  return {
    id: created.id,
    url: invitationUrl(token),
    email: input.email,
    role: input.role,
    expiresAt: expiresAt.toISOString(),
    server: created.server,
  };
}

/** Revokes an invitation whose link has not been used. Unknown or used: NOT_FOUND « Invitation introuvable. ». */
export async function revokeInvitation(actor: AdminActor, invitationId: string): Promise<void> {
  assertAdminMutation(actor);
  if (!UUID_PATTERN.test(invitationId)) throw new AppError('NOT_FOUND', NOT_FOUND_INVITATION);
  const [revoked] = await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, invitationId), eq(invitations.kind, 'invite'), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id, email: invitations.email });
  if (!revoked) throw new AppError('NOT_FOUND', NOT_FOUND_INVITATION);
  await audit({
    action: 'admin.invitation_revoked',
    summary: `invitation annulée pour ${revoked.email}`,
    actorUserId: actor.id,
    targetType: 'invitation',
    targetId: revoked.id,
    metadata: { email: revoked.email },
  });
}
