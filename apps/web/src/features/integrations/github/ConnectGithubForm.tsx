'use client';

import { useEffect, useId, useState } from 'react';
import { Button, Field, Input, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';

const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * « Connecter GitHub » (docs/INTEGRATIONS.md §2.1): a native form POST to
 * `/api/integrations/github/manifest`, which answers with the self-submitting page that sends the App
 * manifest to github.com (the CSP `form-action` allows the GitHub origin). No token is ever typed.
 */
export function ConnectGithubForm({ variant }: { variant: 'desktop' | 'phone' }) {
  const [organization, setOrganization] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const publicId = useId();
  // Back from GitHub through the browser cache: the button must not stay in its loading state.
  useEffect(() => {
    const reset = () => setSubmitting(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  const orgInvalid = organization.trim() !== '' && !ORG_PATTERN.test(organization.trim());
  const phone = variant === 'phone';
  return (
    <form
      method="post"
      action="/api/integrations/github/manifest"
      onSubmit={(event) => {
        if (orgInvalid) {
          event.preventDefault();
          return;
        }
        setSubmitting(true);
      }}
      className={cn('flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4', !phone && 'nav:flex-row nav:items-end nav:gap-4')}
    >
      <Field
        label="Organisation GitHub (facultatif)"
        hint={orgInvalid ? undefined : "Vide : l'application appartient à votre compte GitHub."}
        error={orgInvalid ? "Nom d'organisation GitHub invalide." : undefined}
        className="min-w-0 flex-1"
      >
        <Input
          name="organization"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          mono
          size={phone ? 'lg' : 'md'}
          maxLength={39}
        />
      </Field>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <input type="hidden" name="public" value={isPublic ? 'true' : 'false'} />
        <Switch id={publicId} checked={isPublic} onCheckedChange={setIsPublic} aria-describedby={`${publicId}-hint`} className="mt-0.5" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={publicId} className="font-sans text-app-13 font-medium text-text">
            Application publique
          </label>
          <p id={`${publicId}-hint`} className="m-0 font-sans text-app-12 leading-4 text-muted">
            Installable sur une organisation et sur un compte personnel. Seuls les comptes installés depuis Nuera Dev sont acceptés.
          </p>
        </div>
      </div>
      <Button type="submit" variant="accent" loading={submitting} loadingLabel="Ouverture de GitHub…" block={phone} disabled={orgInvalid}>
        Connecter GitHub
      </Button>
    </form>
  );
}
