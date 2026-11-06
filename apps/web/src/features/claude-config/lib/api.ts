/**
 * Browser calls of the « Configuration Claude commune » routes (same origin, session cookie). Every
 * answer is a result (`{ ok, data } | { ok: false, error }`) with the French message of the body, shown
 * inline next to the action that failed.
 */

export interface ApiError {
  status: number;
  code: string | null;
  message: string;
  detail?: string;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const NETWORK = 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.';

export async function claudeApi<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    const form = typeof FormData !== 'undefined' && body instanceof FormData;
    response = await fetch(url, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: form ? (body as FormData) : JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: { status: 0, code: 'NETWORK', message: NETWORK } };
  }
  if (response.status === 204) return { ok: true, data: undefined as T };
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = ((payload as { error?: Record<string, unknown> } | null)?.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      error: {
        status: response.status,
        code: typeof error.code === 'string' ? error.code : null,
        message: typeof error.message === 'string' && error.message ? error.message : "L'action n'a pas abouti.",
        ...(typeof error.detail === 'string' && error.detail ? { detail: error.detail } : {}),
      },
    };
  }
  return { ok: true, data: payload as T };
}

/** « message · détail » for an inline error. */
export function errorText(error: ApiError): string {
  return error.detail ? `${error.message} ${error.detail}` : error.message;
}
