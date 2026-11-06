import 'server-only';
import { GitIdentitySchema, type GitIdentity } from '@nuera/shared/runner';
import type { CurrentUser } from '@/server/auth/session';
import { getUserPreferences } from '@/server/settings';

/**
 * Git identity of an account (docs/MULTICOMPTE.md §4 « Identité Git », §8): the name and e-mail
 * chosen in Paramètres (`user_preferences.git_author_*`), else the account's own name and e-mail.
 * It signs the commits of the Workspace (W5) and is sent to the runner in the launch options of
 * the sessions this account starts or resumes, and with its shell terminals (GIT_AUTHOR_* /
 * GIT_COMMITTER_*).
 *
 *   const identity = await getGitIdentity(ctx.user);   // null when nothing valid can be built
 */

/** Pure resolution (tested): preference first, then the account, validated like the runner. */
export function resolveGitIdentity(
  account: Pick<CurrentUser, 'name' | 'email'>,
  preferences: { gitAuthorName: string | null; gitAuthorEmail: string | null } | null,
): GitIdentity | null {
  const email = preferences?.gitAuthorEmail?.trim() || account.email.trim();
  const name = preferences?.gitAuthorName?.trim() || account.name.trim() || email;
  const parsed = GitIdentitySchema.safeParse({ name, email });
  return parsed.success ? parsed.data : null;
}

export async function getGitIdentity(account: Pick<CurrentUser, 'id' | 'name' | 'email'>): Promise<GitIdentity | null> {
  const preferences = await getUserPreferences(account.id);
  return resolveGitIdentity(account, preferences);
}
