import { auth } from '@/server/auth/auth';

/**
 * Better Auth HTTP endpoints (/api/auth/*): passkey ceremonies, session reads, sign-out…
 * Password, TOTP and setup steps go through server actions; unused flows are disabled in auth.ts.
 */
export const dynamic = 'force-dynamic';

function handler(request: Request): Promise<Response> {
  return auth.handler(request);
}

export { handler as GET, handler as POST };
