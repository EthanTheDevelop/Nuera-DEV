'use client';

import Link from 'next/link';
import { useRef, type FormEvent } from 'react';
import { SubmitButton } from '../_components/submit-button';
import { signOutAction } from './actions';
import { currentPushEndpoint } from './push-endpoint';

/**
 * « Se déconnecter » (POST): before the form is sent, the push endpoint of this browser is read from
 * the service worker (at most 1.5 s) and posted with it, so that this device stops receiving the
 * account's notifications. Without JavaScript the form still signs out. `next`: the in-app path
 * /connexion goes to once the next account has signed in (null: the home page).
 */
export function SignOutForm({ next = null }: { next?: string | null }) {
  const endpointRef = useRef<HTMLInputElement>(null);
  const ready = useRef(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (ready.current) return;
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    if (endpointRef.current) endpointRef.current.value = (await currentPushEndpoint()) ?? '';
    ready.current = true;
    form.requestSubmit(submitter instanceof HTMLButtonElement ? submitter : undefined);
  }

  return (
    <form action={signOutAction} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input ref={endpointRef} type="hidden" name="pushEndpoint" defaultValue="" />
      {next ? <input type="hidden" name="suivant" value={next} /> : null}
      <SubmitButton pendingLabel="Déconnexion…">Se déconnecter</SubmitButton>
      <Link href="/" className="text-app-13 text-muted underline-offset-4 hover:underline">
        Revenir à l'Accueil
      </Link>
    </form>
  );
}
