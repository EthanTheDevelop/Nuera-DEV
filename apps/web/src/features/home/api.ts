/**
 * Browser calls of the Accueil (same origin, session cookie): the favourite star of « Projets récents »
 * (PATCH /api/projects/[id], Projets lot route) and the global search (GET /api/search).
 */

export class HomeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HomeApiError';
    this.status = status;
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' && body.error.message ? body.error.message : fallback;
  } catch {
    return fallback;
  }
}

/** Star / unstar a project (the Projets lot route, audited there except the star). */
export async function setProjectFavorite(projectId: string, favorite: boolean): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ favorite }),
    });
  } catch {
    throw new HomeApiError(0, 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.');
  }
  if (!response.ok) throw new HomeApiError(response.status, await errorMessage(response, "Le favori n'a pas pu être enregistré."));
}
