import 'server-only';

/** Private runner endpoint and shared bearer token (never exposed to the browser). */
export function getRunnerConfig(): { baseUrl: string; token: string | null } {
  const baseUrl = (process.env.RUNNER_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
  const token = process.env.RUNNER_TOKEN?.trim() || null;
  return { baseUrl, token };
}
