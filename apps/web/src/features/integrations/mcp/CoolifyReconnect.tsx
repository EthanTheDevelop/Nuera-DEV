'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';
import { ErrorPanel, Field, Input, SecretField, SectionLabel, Select, Switch, toast } from '@/components/ui';
import { integrationsApi, toApiError, type IntegrationsApiError } from '../api';
import { COOLIFY_EXPIRY_OPTIONS, DEFAULT_COOLIFY_EXPIRY, expiryToIso, hostOf } from '../model';
import type { CoolifyReconnectResult, CoolifySettingsView } from '../types';

export interface CoolifyReconnectState {
  pending: boolean;
  canSubmit: boolean;
}

export interface CoolifyReconnectProps {
  formId: string;
  coolify: CoolifySettingsView;
  serverName: string;
  onStateChange: (state: CoolifyReconnectState) => void;
  onReconnected: (result: CoolifyReconnectResult) => void;
}

/**
 * D2 « RECONNECTER » + « PÉRIMÈTRE » + garde-fou note: a new Coolify token (SecretField, write-only,
 * never pre-filled or echoed), the Coolify address on the first connection, the expiry chosen in
 * Coolify (the API does not return it), then `PUT /api/integrations/coolify` — validated with GET
 * calls only. A refusal keeps the previous token (`untouched`) and puts the field in its Erreur state.
 */
export function CoolifyReconnect({ formId, coolify, serverName, onStateChange, onReconnected }: CoolifyReconnectProps) {
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [expiry, setExpiry] = useState<string>(DEFAULT_COOLIFY_EXPIRY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<IntegrationsApiError | null>(null);
  const needsUrl = !coolify.configured || !coolify.baseUrl;

  const ready = Boolean(token.trim()) && (!needsUrl || Boolean(baseUrl.trim()));
  // The footer button (« Reconnecter », outside the form) follows the form state.
  useEffect(() => {
    onStateChange({ pending, canSubmit: ready && !pending });
  }, [pending, ready, onStateChange]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await integrationsApi.reconnectCoolify({
        token: token.trim(),
        ...(needsUrl ? { baseUrl: baseUrl.trim() } : {}),
        expiresAt: expiryToIso(expiry),
      });
      setToken('');
      toast({ message: coolify.configured ? 'Coolify reconnecté' : 'Coolify connecté', icon: 'check' });
      onReconnected(result);
    } catch (failure) {
      setError(toApiError(failure));
    } finally {
      setPending(false);
    }
  };

  const fieldError = error && (error.status === 422 || error.status === 409) ? error.message : undefined;
  const host = hostOf(coolify.baseUrl);

  return (
    <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-5">
      <section aria-labelledby={`${formId}-title`} className="flex flex-col gap-2.5">
        <SectionLabel as="h3" id={`${formId}-title`}>
          Reconnecter
        </SectionLabel>
        <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
          {`Créez un nouveau jeton dans Coolify, limité à l'équipe Développement, puis collez-le ici. Il est chiffré sur ${serverName} et n'est plus jamais affiché.`}
        </p>
        {needsUrl ? (
          <Field label="Adresse de Coolify">
            <Input
              type="url"
              inputMode="url"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
              }}
              leadingIcon="globe2"
              mono
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={300}
            />
          </Field>
        ) : null}
        <Field error={fieldError} hint={fieldError ? (error?.detail ?? error?.untouched) : coolify.tokenFingerprint ? `Jeton actuel : ${coolify.tokenFingerprint}${host ? ` · ${host}` : ''}` : undefined}>
          <SecretField
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              if (error) setError(null);
            }}
            leadingIcon="key"
            aria-label="Nouveau jeton Coolify"
            maxLength={500}
            disabled={pending}
            autoFocus
          />
        </Field>
        <Field label="Expiration choisie dans Coolify" hint="Coolify ne la communique pas : elle sert à vous prévenir avant la fin de l'accès.">
          <Select options={COOLIFY_EXPIRY_OPTIONS} value={expiry} onValueChange={setExpiry} aria-label="Expiration choisie dans Coolify" disabled={pending} />
        </Field>
        {coolify.tokensUrl ? (
          <a href={coolify.tokensUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 self-start font-sans text-app-13 font-medium text-accent hover:underline">
            <Icon name="external" size={14} />
            Créer le jeton dans Coolify
          </a>
        ) : null}
        {error && !fieldError ? (
          <ErrorPanel
            title={error.message}
            excerpt={error.detail}
            untouched={error.untouched ?? (coolify.configured ? 'Le jeton précédent est conservé.' : "Aucun jeton n'a été enregistré.")}
            raw={error.raw}
          />
        ) : null}
        {error && fieldError && error.raw ? <ErrorPanel title="Détail de la validation" raw={error.raw} untouched={error.untouched} /> : null}
      </section>

      <section aria-labelledby={`${formId}-scope`} className="flex flex-col gap-1">
        <SectionLabel as="h3" id={`${formId}-scope`} className="pb-1.5">
          Périmètre
        </SectionLabel>
        <div className="flex items-center gap-3 border-b border-border py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p id={`${formId}-dev`} className="m-0 font-sans text-app-14 font-medium text-text">
              Environnements de développement
            </p>
            <p className="m-0 font-sans text-app-12 text-muted">Déploiements de prévisualisation, journaux, variables</p>
          </div>
          <span className="font-sans text-app-12 text-muted">toujours inclus</span>
          <Switch checked disabled aria-labelledby={`${formId}-dev`} className="disabled:opacity-100" />
        </div>
        <div className="flex items-center gap-3 py-2.5 opacity-60">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="m-0 font-sans text-app-14 font-medium text-text">Environnements de production</p>
            <p className="m-0 font-sans text-app-12 text-muted">Non disponible : ces actions restent dans Coolify, avec votre compte.</p>
          </div>
          <Icon name="lock" size={18} className="text-muted" title="Production exclue" />
        </div>
      </section>

      <p className="m-0 flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2.5 font-sans text-app-12 text-muted">
        <Icon name="shield" size={16} className="shrink-0 text-accent" />
        <span>Après reconnexion, chaque projet garde son propre réglage dans Outils MCP.</span>
      </p>
    </form>
  );
}
