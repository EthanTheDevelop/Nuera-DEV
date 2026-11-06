import 'server-only';
import { account, session, user, verification } from '@nuera/db/schema';
import { generateLinkToken, hashToken, isLinkToken } from '@nuera/shared/tokens';
import { and, eq, gt, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { getAuthContext } from '@/server/auth/auth';
import { newRecoveryPasswordSchema } from '@/server/auth/links';
import { AppError, formatZodIssues } from '@/server/errors';
import { escapeHtml, isMailConfigured, sendMail } from '@/server/mail';
import { audit } from '@/server/security/audit';
import { assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';
import { invalidateContextCache } from '@/server/tenancy/context';

/**
 * « Mot de passe oublié » (libre-service, par e-mail) :
 *  - la demande répond toujours la même chose, qu'un compte existe ou non (pas d'énumération des
 *    comptes) ; un e-mail ne part que vers un compte actif (ni désactivé, ni supprimé) ;
 *  - le lien est à usage unique, valable 30 min ; seul le sha256 du jeton est stocké
 *    (`verification.identifier = password-reset:<sha256>`, `value` = id du compte) ; une nouvelle
 *    demande remplace la précédente ;
 *  - il ne change QUE le mot de passe : la double authentification reste exigée à la connexion ;
 *    les accès web et appareils de confiance du compte sont fermés.
 */

export const PASSWORD_RESET_TTL_MINUTES = 30;
const IDENTIFIER_PREFIX = 'password-reset:';

const emailSchema = z.string('e-mail requis').trim().toLowerCase().max(200).pipe(z.email('adresse e-mail invalide'));

function appBaseUrl(): string {
  const value = (process.env.APP_URL || process.env.BETTER_AUTH_URL || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('APP_URL non configurée.');
  return value;
}

function resetMessage(name: string, link: string) {
  const subject = 'Réinitialiser votre mot de passe Nuera Dev';
  const text = [
    `Bonjour ${name},`,
    '',
    'Une demande de réinitialisation du mot de passe de votre compte Nuera Dev a été faite.',
    `Pour choisir un nouveau mot de passe, ouvrez ce lien (valable ${PASSWORD_RESET_TTL_MINUTES} minutes, une seule fois) :`,
    link,
    '',
    "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.",
    'La double authentification restera demandée à la connexion.',
  ].join('\n');
  const html = `<p>Bonjour ${escapeHtml(name)},</p>
<p>Une demande de réinitialisation du mot de passe de votre compte Nuera Dev a été faite.</p>
<p><a href="${escapeHtml(link)}">Choisir un nouveau mot de passe</a> (lien valable ${PASSWORD_RESET_TTL_MINUTES} minutes, une seule fois).</p>
<p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.
La double authentification restera demandée à la connexion.</p>`;
  return { subject, text, html };
}

/**
 * Demande de réinitialisation. Ne lève qu'en cas d'e-mail mal formé, de limite atteinte ou d'envoi
 * non configuré — jamais selon l'existence du compte.
 */
export async function requestPasswordReset(rawEmail: string, requestHeaders: Headers): Promise<void> {
  if (!isMailConfigured()) {
    throw new AppError('FORBIDDEN', "L'envoi d'e-mails n'est pas configuré sur ce serveur.", {
      detail: 'Demandez un lien de récupération à un administrateur de Nuera Dev.',
    });
  }
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) throw new AppError('VALIDATION', 'Adresse e-mail invalide.');
  const email = parsed.data;
  const ip = getClientIp(requestHeaders);
  assertRateLimit('password-reset-ip', ip, AUTH_RATE_LIMITS.passwordResetPerIp);
  assertRateLimit('password-reset', `${ip ?? 'inconnue'}|${email}`, AUTH_RATE_LIMITS.passwordReset);

  const [owner] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(and(eq(user.email, email), isNull(user.disabledAt), isNull(user.deletedAt)))
    .limit(1);
  if (!owner) return;

  const token = generateLinkToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000);
  await db.transaction(async (tx) => {
    await tx.delete(verification).where(and(like(verification.identifier, `${IDENTIFIER_PREFIX}%`), eq(verification.value, owner.id)));
    await tx.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: `${IDENTIFIER_PREFIX}${hashToken(token)}`,
      value: owner.id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  });

  try {
    await sendMail({ to: owner.email, ...resetMessage(owner.name, `${appBaseUrl()}/mot-de-passe-oublie/${token}`) });
  } catch (error) {
    await db.delete(verification).where(eq(verification.identifier, `${IDENTIFIER_PREFIX}${hashToken(token)}`));
    console.error('[mot de passe oublié]', error instanceof Error ? error.message : error);
    await audit({
      action: 'auth.password_reset_mail_failed',
      summary: "mot de passe oublié : l'e-mail n'a pas pu être envoyé",
      actorUserId: owner.id,
      subjectUserId: owner.id,
    });
    return;
  }
  await audit({
    action: 'auth.password_reset_requested',
    summary: 'mot de passe oublié : lien de réinitialisation envoyé par e-mail',
    actorUserId: owner.id,
    subjectUserId: owner.id,
  });
}

export type PasswordResetState = { kind: 'invalid' } | { kind: 'expired' } | { kind: 'valid'; email: string };

async function findReset(token: string) {
  if (!isLinkToken(token)) return null;
  const [row] = await db
    .select({ id: verification.id, userId: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, `${IDENTIFIER_PREFIX}${hashToken(token)}`))
    .limit(1);
  if (!row) return null;
  const [owner] = await db
    .select({ id: user.id, name: user.name, email: user.email, disabledAt: user.disabledAt, deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, row.userId))
    .limit(1);
  if (!owner || owner.disabledAt || owner.deletedAt) return null;
  return { row, owner };
}

export async function getPasswordResetState(token: string): Promise<PasswordResetState> {
  const found = await findReset(token);
  if (!found) return { kind: 'invalid' };
  if (found.row.expiresAt.getTime() <= Date.now()) return { kind: 'expired' };
  return { kind: 'valid', email: found.owner.email };
}

/** Nouveau mot de passe par lien : lien consommé, accès web et appareils de confiance fermés. */
export async function resetPasswordWithToken(
  token: string,
  rawInput: { password: string; passwordConfirmation: string },
  requestHeaders: Headers,
): Promise<void> {
  assertRateLimit('link-token', getClientIp(requestHeaders), AUTH_RATE_LIMITS.linkToken);
  const found = await findReset(token);
  const unusable = new AppError('FORBIDDEN', "Ce lien n'est plus utilisable.", {
    detail: 'Il a expiré ou a déjà servi. Faites une nouvelle demande depuis la page de connexion.',
  });
  if (!found || found.row.expiresAt.getTime() <= Date.now()) throw unusable;
  const { owner } = found;
  const parsed = newRecoveryPasswordSchema.safeParse({ ...rawInput, email: owner.email, name: owner.name });
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error, 6) });
  }

  const context = await getAuthContext();
  const passwordHash = await context.password.hash(parsed.data.password);
  const consumed = await db.transaction(async (tx) => {
    const [link] = await tx
      .delete(verification)
      .where(and(eq(verification.id, found.row.id), gt(verification.expiresAt, new Date())))
      .returning({ id: verification.id });
    if (!link) return false;
    const now = new Date();
    const [updated] = await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(and(eq(account.userId, owner.id), eq(account.providerId, 'credential')))
      .returning({ id: account.id });
    if (!updated) {
      await tx.insert(account).values({
        id: context.generateId({ model: 'account' }) || crypto.randomUUID(),
        userId: owner.id,
        accountId: owner.id,
        providerId: 'credential',
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    }
    await tx.delete(session).where(eq(session.userId, owner.id));
    await tx.delete(verification).where(and(like(verification.identifier, 'trust-device-%'), eq(verification.value, owner.id)));
    return true;
  });
  if (!consumed) throw unusable;
  invalidateContextCache(owner.id);
  await audit({
    action: 'auth.password_reset',
    summary: 'mot de passe réinitialisé par lien e-mail (accès web fermés)',
    actorUserId: owner.id,
    subjectUserId: owner.id,
  });
}
