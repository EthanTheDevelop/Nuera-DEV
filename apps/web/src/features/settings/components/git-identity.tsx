'use client';

import { useState, type FormEvent } from 'react';
import { Card, CompactButton, Field, Input, TileHeader } from '@/components/ui';
import { SECTION_IDS } from '../lib/tabs';
import { InlineError } from './parts';
import { useSettings } from './SettingsContext';

/** Same rules as the server (`userPreferencesSchema`): no « < », « > » nor control character. */
const NAME_FORBIDDEN = /[<>\p{Cc}]/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * « Identité Git » (Compte et sécurité; not drawn in Figma, built from the D08 tiles): author of the
 * commits made from Nuera Dev — sessions, terminals, Workspace commits. Empty = the account's name and
 * e-mail. Saved in the account's own preferences (never shared with another account).
 */
export function GitIdentityTile() {
  const { data, settings, save, pending, errorFor } = useSettings();
  const savedName = settings.gitAuthorName ?? '';
  const savedEmail = settings.gitAuthorEmail ?? '';
  const [name, setName] = useState(savedName);
  const [email, setEmail] = useState(savedEmail);
  const [snapshot, setSnapshot] = useState({ savedName, savedEmail });
  if (snapshot.savedName !== savedName || snapshot.savedEmail !== savedEmail) {
    setSnapshot({ savedName, savedEmail });
    setName(savedName);
    setEmail(savedEmail);
  }
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== savedName || email.trim().toLowerCase() !== savedEmail;
  const custom = settings.gitAuthorName !== null || settings.gitAuthorEmail !== null;
  const busy = pending.has('gitAuthorName') || pending.has('gitAuthorEmail');
  const author = `${settings.gitAuthorName ?? data.profile.name} <${settings.gitAuthorEmail ?? data.profile.email}>`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    const nextEmail = email.trim().toLowerCase();
    if (nextName.length > 100 || NAME_FORBIDDEN.test(nextName)) return setError('Nom invalide : 100 caractères au plus, sans « < » ni « > ».');
    if (nextEmail && (nextEmail.length > 254 || !EMAIL.test(nextEmail))) return setError('Adresse e-mail invalide.');
    setError(null);
    await save({ gitAuthorName: nextName || null, gitAuthorEmail: nextEmail || null }, 'Identité Git enregistrée');
  }

  async function reset() {
    setError(null);
    await save({ gitAuthorName: null, gitAuthorEmail: null }, 'Identité Git : celle du compte');
  }

  return (
    <Card as="section" id={SECTION_IDS.gitIdentity} aria-label="Identité Git" className="scroll-mt-6 gap-3">
      <TileHeader icon="git-commit" title="Identité Git" />
      <p className="m-0 font-sans text-app-12 text-muted">
        Auteur des commits faits depuis Nuera Dev : sessions Claude Code, terminaux et commits du Workspace. Vide, c'est le nom et
        l'e-mail de votre compte.
      </p>
      <p className="m-0 font-mono text-app-12 break-words text-text">{author}</p>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Nom">
          <Input value={name} maxLength={100} autoComplete="name" placeholder={data.profile.name} onChange={(e) => { setName(e.target.value); setError(null); }} />
        </Field>
        <Field
          label="E-mail"
          hint="Pour garder votre adresse privée, utilisez l'adresse noreply de GitHub (identifiant@users.noreply.github.com, dans les réglages « Emails » de GitHub)."
        >
          <Input
            type="email"
            value={email}
            maxLength={254}
            autoComplete="email"
            spellCheck={false}
            placeholder={data.profile.email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <InlineError>{error ?? errorFor('gitAuthorName') ?? errorFor('gitAuthorEmail')}</InlineError>
        <div className="flex flex-wrap gap-2">
          {dirty ? (
            <CompactButton type="submit" variant="principal" loading={busy}>
              Enregistrer
            </CompactButton>
          ) : null}
          {custom && !dirty ? (
            <CompactButton type="button" variant="secondaire" onClick={reset} loading={busy}>
              Revenir à l'identité du compte
            </CompactButton>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
