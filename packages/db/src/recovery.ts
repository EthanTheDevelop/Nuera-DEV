import { and, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { Database } from './index';
import { auditLog, invitations, passkey, session, twoFactor, user, verification } from './schema';
import { generateLinkToken, sha256Hex } from './tokens';

/**
 * Recovery link of an account (docs/MULTICOMPTE.md §6): closes every web access of the account,
 * forgets its trusted devices and its second factor, revokes its previous recovery links, then
 * creates a single-use link `/recuperation/<jeton>` (new password + TOTP). Only the sha256 of the
 * token is stored. Passkeys are kept unless `removePasskeys` (lost device). Used by the break-glass
 * command line (`recovery-link`); an administrator action may reuse it with `actor`.
 */

export const RECOVERY_LINK_TTL_HOURS = 24;

export type RecoveryLinkErrorCode = 'UNKNOWN_ACCOUNT' | 'ACCOUNT_DELETED' | 'ACCOUNT_DISABLED' | 'INVALID_APP_URL';

export class RecoveryLinkError extends Error {
  constructor(
    readonly code: RecoveryLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecoveryLinkError';
  }
}

export interface RecoveryLinkInput {
  email: string;
  /** Public URL of Nuera Dev (APP_URL). */
  appUrl: string;
  /** Administrator creating the link; null/absent for the command line. */
  actor?: { userId: string; label: string } | null;
  /** Also delete the account's passkeys (the device holding them is lost). Default false. */
  removePasskeys?: boolean;
  now?: Date;
}

export interface RecoveryLink {
  url: string;
  /** Clear token (only in the link shown once). */
  token: string;
  expiresAt: Date;
  invitationId: string;
  userId: string;
  email: string;
  closedSessions: number;
  removedTrustedDevices: number;
  removedPasskeys: number;
}

/** `<appUrl>/recuperation/<token>`, keeping a base path; http(s) only. */
export function recoveryLinkUrl(appUrl: string, token: string): string {
  let base: URL;
  try {
    base = new URL(appUrl.trim());
  } catch {
    throw new RecoveryLinkError('INVALID_APP_URL', `Adresse de Nuera Dev invalide : ${appUrl}`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new RecoveryLinkError('INVALID_APP_URL', `Adresse de Nuera Dev invalide (http ou https attendu) : ${appUrl}`);
  }
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  return new URL(`recuperation/${token}`, base).toString();
}

export async function createRecoveryLink(db: Database, input: RecoveryLinkInput): Promise<RecoveryLink> {
  const email = input.email.trim().toLowerCase();
  const now = input.now ?? new Date();
  const token = generateLinkToken();
  const url = recoveryLinkUrl(input.appUrl, token);
  const expiresAt = new Date(now.getTime() + RECOVERY_LINK_TTL_HOURS * 3_600_000);
  const actor = input.actor ?? null;

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: user.id, email: user.email, role: user.role, disabledAt: user.disabledAt, deletedAt: user.deletedAt })
      .from(user)
      .where(sql`lower(${user.email}) = ${email}`)
      .for('update');
    if (!account) throw new RecoveryLinkError('UNKNOWN_ACCOUNT', `Aucun compte ne correspond à l'adresse ${email}.`);
    if (account.deletedAt) {
      throw new RecoveryLinkError('ACCOUNT_DELETED', 'Ce compte a été supprimé : aucun lien de récupération ne peut être créé.');
    }
    if (account.disabledAt) {
      throw new RecoveryLinkError('ACCOUNT_DISABLED', 'Ce compte est désactivé : réactivez-le avant de créer un lien de récupération.');
    }

    await tx.delete(twoFactor).where(eq(twoFactor.userId, account.id));
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, account.id));
    const closed = await tx.delete(session).where(eq(session.userId, account.id)).returning({ id: session.id });
    // Better Auth 1.7 trusted devices: verification rows `trust-device-<random>` whose value is the user id.
    const trusted = await tx
      .delete(verification)
      .where(and(like(verification.identifier, 'trust-device-%'), eq(verification.value, account.id)))
      .returning({ id: verification.id });
    const passkeys = input.removePasskeys
      ? await tx.delete(passkey).where(eq(passkey.userId, account.id)).returning({ id: passkey.id })
      : [];
    // Older recovery links can no longer be used, even to resume an activation. A link never
    // accepted is revoked whatever its other dates (it would still hold invitations_pending_email_idx).
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.kind, 'recovery'),
          isNull(invitations.revokedAt),
          or(isNull(invitations.completedAt), isNull(invitations.acceptedAt)),
          or(eq(invitations.userId, account.id), eq(invitations.email, account.email.toLowerCase())),
        ),
      );
    const [invitation] = await tx
      .insert(invitations)
      .values({
        kind: 'recovery',
        email: account.email.toLowerCase(),
        role: account.role,
        userId: account.id,
        tokenHash: sha256Hex(token),
        expiresAt,
        createdByUserId: actor?.userId ?? null,
        createdAt: now,
      })
      .returning({ id: invitations.id });
    const invitationId = invitation!.id;
    await tx.insert(auditLog).values({
      actorUserId: actor?.userId ?? null,
      actorKind: actor ? 'user' : 'system',
      actorLabel: actor?.label ?? null,
      action: actor ? 'admin.recovery_link_created' : 'admin.recovery_link_cli',
      targetType: 'user',
      targetId: account.id,
      subjectUserId: account.id,
      summary: actor
        ? `lien de récupération créé pour ${account.email} : double authentification réinitialisée, accès web fermés`
        : `lien de récupération créé en ligne de commande pour ${account.email} : double authentification réinitialisée, accès web fermés`,
      metadata: {
        invitationId,
        expiresAt: expiresAt.toISOString(),
        closedSessions: closed.length,
        removedTrustedDevices: trusted.length,
        removedPasskeys: passkeys.length,
      },
      createdAt: now,
    });

    return {
      url,
      token,
      expiresAt,
      invitationId,
      userId: account.id,
      email: account.email,
      closedSessions: closed.length,
      removedTrustedDevices: trusted.length,
      removedPasskeys: passkeys.length,
    };
  });
}
