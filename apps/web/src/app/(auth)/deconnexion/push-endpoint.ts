/**
 * Push endpoint of this browser (null when push is unavailable, not subscribed or too slow to
 * answer). Posted as `pushEndpoint` with the sign-out form so that the server deletes this device's
 * subscription for the account that signs out (docs/MULTICOMPTE.md §9). Browser only.
 *
 *   const form = new FormData();
 *   form.set('pushEndpoint', (await currentPushEndpoint()) ?? '');
 *   await signOutAction(form);
 */
export async function currentPushEndpoint(timeoutMs = 1_500): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const lookup = (async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    return subscription?.endpoint ?? null;
  })().catch(() => null);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([lookup, timeout]);
}
