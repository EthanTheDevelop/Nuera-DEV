import 'server-only';
import type { Transaction } from '@nuera/db';
import { account, environments, spaceMembers, spaceSettings, spaces, user, userPreferences } from '@nuera/db/schema';
import type { InstanceRole } from '@nuera/db/schema';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { personalSpaceName } from '@/server/tenancy/names';

/**
 * Account creation of the multi-account model (docs/MULTICOMPTE.md §6), inside the caller's
 * transaction: Better Auth never creates accounts (`user.create.before` refuses), so the first owner
 * (/configuration) and invited accounts are written here, all at once:
 *
 *   user + credential (password hashed by Better Auth's own hasher, by the caller)
 *   → personal space (or, for the owner, adoption of the ownerless « Espace initial » of a database
 *     that had data but no account, MULTICOMPTE §14 F1-4) + owner membership + space_settings
 *   → user_preferences
 *   → the server: the default server for the owner, the `pending` server pre-assigned by an invitation
 *     otherwise — attached to the space and set `active`.
 *
 * The MCP presets of the space are ensured by the MCP registry when it is first read (not here).
 */

export interface NewAccountInput {
  userId: string;
  credentialId: string;
  name: string;
  /** Lower case. */
  email: string;
  passwordHash: string;
  role: InstanceRole;
  /** Owner: adopt the ownerless « Espace initial » and attach the default server. */
  owner?: boolean;
  /** Invitation: `pending` server pre-assigned to the new space (ignored when no longer pending). */
  environmentId?: string | null;
  now?: Date;
}

export interface NewAccount {
  userId: string;
  spaceId: string;
  /** Server attached to the space by this creation (null: none). */
  environmentId: string | null;
}

async function ownerlessInitialSpace(tx: Transaction): Promise<string | null> {
  const [row] = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(isNull(spaces.ownerUserId), eq(spaces.kind, 'personal'), isNull(spaces.archivedAt)))
    .orderBy(asc(spaces.createdAt))
    .limit(1)
    .for('update');
  return row?.id ?? null;
}

export async function insertAccount(tx: Transaction, input: NewAccountInput): Promise<NewAccount> {
  const now = input.now ?? new Date();
  await tx.insert(user).values({
    id: input.userId,
    name: input.name,
    email: input.email,
    emailVerified: false,
    twoFactorEnabled: false,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(account).values({
    id: input.credentialId,
    userId: input.userId,
    accountId: input.userId,
    providerId: 'credential',
    password: input.passwordHash,
    createdAt: now,
    updatedAt: now,
  });

  let spaceId: string | null = input.owner ? await ownerlessInitialSpace(tx) : null;
  if (spaceId) {
    await tx.update(spaces).set({ ownerUserId: input.userId, name: personalSpaceName(input.name) }).where(eq(spaces.id, spaceId));
  } else {
    const [created] = await tx
      .insert(spaces)
      .values({ name: personalSpaceName(input.name), kind: 'personal', ownerUserId: input.userId })
      .returning({ id: spaces.id });
    spaceId = created!.id;
  }
  await tx.insert(spaceMembers).values({ spaceId, userId: input.userId, role: 'owner' }).onConflictDoNothing();
  await tx.insert(spaceSettings).values({ spaceId }).onConflictDoNothing();
  await tx.insert(userPreferences).values({ userId: input.userId }).onConflictDoNothing();

  let environmentId: string | null = null;
  if (input.owner) {
    // The existing runner becomes the server of the owner's space (« VPS-3 », unchanged).
    const [attached] = await tx
      .update(environments)
      .set({ spaceId, status: 'active' })
      .where(
        and(
          eq(environments.isDefault, true),
          ne(environments.status, 'retired'),
          or(isNull(environments.spaceId), eq(environments.spaceId, spaceId)),
        ),
      )
      .returning({ id: environments.id });
    environmentId = attached?.id ?? null;
  } else if (input.environmentId) {
    // A server already used is never reassigned: only a `pending` one that nobody holds.
    const [attached] = await tx
      .update(environments)
      .set({ spaceId, status: 'active' })
      .where(
        and(
          eq(environments.id, input.environmentId),
          eq(environments.status, 'pending'),
          isNull(environments.spaceId),
          sql`not exists (select 1 from ${environments} as other where other.space_id = ${spaceId} and other.status <> 'retired')`,
        ),
      )
      .returning({ id: environments.id });
    environmentId = attached?.id ?? null;
  }
  return { userId: input.userId, spaceId, environmentId };
}

/** true when an account (deleted or not) already uses this e-mail. */
export async function emailTaken(tx: Pick<Transaction, 'select'>, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return Boolean(row);
}
