import { z } from 'zod';

/**
 * Path parameter of the administration routes. Never validated as a uuid here: a malformed id must
 * answer exactly like an unknown one (404 from the server module), not 422.
 */
export const idParams = z.object({ id: z.string().trim().min(1).max(200) });
