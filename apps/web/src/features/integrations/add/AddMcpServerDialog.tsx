'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';
import {
  Banner,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Pastille,
  SecretField,
  SectionLabel,
  SegmentedControl,
  Select,
  toast,
} from '@/components/ui';
import { integrationsApi, toApiError, type CreateMcpServerBody, type IntegrationsApiError } from '../api';
import { headerNameProblem, iconOf, mcpHref, serverNameProblem, slugifyServerName } from '../model';
import type { McpServerView } from '../types';

type Transport = 'http' | 'sse';
type Auth = 'none' | 'bearer' | 'header' | 'oauth';

const AUTH_OPTIONS = [
  { value: 'none', label: 'Aucune', description: 'Serveur ouvert, sans identifiant.' },
  { value: 'bearer', label: 'Jeton', description: 'Envoyé en Authorization: Bearer par Nuera Dev.' },
  { value: 'header', label: 'En-tête secret', description: 'Un en-tête nommé, par exemple X-Api-Key.' },
  { value: 'oauth', label: 'OAuth dans Claude Code', description: 'Connexion ensuite dans un terminal (claude mcp login).' },
] as const;

const TRANSPORTS = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
] as const;

const URL_HINT = 'Adresse https du serveur MCP (http seulement sur cette machine, en développement).';

export interface AddMcpServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Built-in servers enabled in no project: offered first (« Serveurs intégrés »). */
  presets: McpServerView[];
  /** « chiffrés sur VPS-3 » (default server) or « chiffrés par Nuera Dev ». */
  secretsPlace: string;
  onCreated: () => void;
}

/**
 * « Ajouter un serveur MCP » (D07 header button and add tile, M07 last row — form not designed):
 * the built-in servers still unused, then a custom HTTP / SSE server (name, address, secret header
 * typed in a SecretField that is never pre-filled). `POST /api/integrations/mcp`, then the new
 * server's drawer opens so that it can be enabled project by project and tested.
 */
export function AddMcpServerDialog({ open, onOpenChange, presets, secretsPlace, onCreated }: AddMcpServerDialogProps) {
  const router = useRouter();
  const formId = useId();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<Transport>('http');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<Auth>('none');
  const [token, setToken] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<IntegrationsApiError | null>(null);

  const reset = () => {
    setLabel('');
    setName('');
    setNameEdited(false);
    setDescription('');
    setTransport('http');
    setUrl('');
    setAuth('none');
    setToken('');
    setHeaderName('');
    setHeaderValue('');
    setSubmitted(false);
    setError(null);
  };

  const effectiveName = nameEdited ? name : slugifyServerName(label);
  const problems = {
    label: label.trim() ? null : 'Nom requis.',
    name: serverNameProblem(effectiveName),
    url: /^https?:\/\/\S+$/i.test(url.trim()) ? null : 'Adresse http(s) requise.',
    token: auth === 'bearer' && !token.trim() ? 'Jeton requis.' : auth === 'bearer' && /\s/.test(token.trim()) ? "Le jeton ne contient pas d'espace." : null,
    headerName: auth === 'header' ? headerNameProblem(headerName.trim()) : null,
    headerValue: auth === 'header' && !headerValue ? "Valeur de l'en-tête requise." : null,
  };
  const invalid = Object.values(problems).some(Boolean);
  const show = (key: keyof typeof problems) => (submitted ? (problems[key] ?? undefined) : undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (invalid || pending) return;
    setPending(true);
    setError(null);
    const body: CreateMcpServerBody = {
      name: effectiveName,
      label: label.trim(),
      description: description.trim() || null,
      transport,
      url: url.trim(),
      authKind: auth,
      ...(auth === 'bearer' ? { bearerToken: token.trim() } : {}),
      ...(auth === 'header' ? { headers: { [headerName.trim()]: headerValue } } : {}),
    };
    try {
      const { server } = await integrationsApi.createMcpServer(body);
      toast({ message: `Serveur MCP « ${server.label} » ajouté` });
      reset();
      onOpenChange(false);
      onCreated();
      router.push(mcpHref(server.name));
    } catch (failure) {
      setError(toApiError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="Ajouter un serveur MCP"
        description={`Proposé aux sessions des seuls projets où vous l'activez. Les secrets sont ${secretsPlace} et ne sont plus jamais affichés.`}
        dismissible={!pending}
        footer={
          <>
            <Button
              variant="default"
              onClick={() => {
                // Never keep a typed secret for the next opening.
                reset();
                onOpenChange(false);
              }}
              disabled={pending}
            >
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={pending} loadingLabel="Ajout en cours…">
              Ajouter le serveur
            </Button>
          </>
        }
      >
        {presets.length ? (
          <section aria-labelledby={`${formId}-presets`} className="flex flex-col gap-2">
            <SectionLabel as="h3" id={`${formId}-presets`}>
              Serveurs intégrés
            </SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {presets.map((preset) => (
                <li key={preset.id}>
                  <Link
                    href={mcpHref(preset.name)}
                    onClick={() => {
                      reset();
                      onOpenChange(false);
                    }}
                    className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2.5 transition-colors duration-(--dur-fast) hover:bg-hover"
                  >
                    <Pastille icon={iconOf(preset.icon)} size={28} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-sans text-app-14 font-medium text-text">{preset.label}</span>
                      <span className="truncate font-sans text-app-12 text-muted">{preset.description}</span>
                    </span>
                    <span className="font-sans text-app-13 font-medium text-accent">Activer</span>
                    <Icon name="chevron" size={16} className="text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4" aria-labelledby={`${formId}-custom`}>
          <SectionLabel as="h3" id={`${formId}-custom`}>
            Serveur personnalisé
          </SectionLabel>
          {error ? (
            <Banner tone="danger" title={error.message}>
              {[error.detail, error.untouched ?? "Aucun serveur n'a été ajouté."].filter(Boolean).join(' ')}
            </Banner>
          ) : null}
          <div className="grid gap-4 nav:grid-cols-2">
            <Field label="Nom" error={show('label')}>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} autoComplete="off" required />
            </Field>
            <Field
              label="Identifiant"
              error={show('name')}
              hint={show('name') ? undefined : `Nom des outils pour Claude : mcp__${effectiveName || 'identifiant'}__…`}
            >
              <Input
                value={effectiveName}
                onChange={(event) => {
                  setNameEdited(true);
                  setName(event.target.value.toLowerCase());
                }}
                mono
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                required
              />
            </Field>
          </div>
          <Field label="Description (facultatif)">
            <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span id={`${formId}-transport`} className="font-sans text-app-13 font-medium text-text">
              Transport
            </span>
            <SegmentedControl items={TRANSPORTS} value={transport} onValueChange={setTransport} aria-label="Transport" className="self-start" />
          </div>
          <Field label="Adresse" error={show('url')} hint={show('url') ? undefined : URL_HINT}>
            <Input
              type="url"
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              mono
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={2048}
              required
            />
          </Field>
          <Field label="Authentification" hint={AUTH_OPTIONS.find((option) => option.value === auth)?.description}>
            <Select options={AUTH_OPTIONS} value={auth} onValueChange={(value) => setAuth(value as Auth)} aria-label="Authentification" />
          </Field>
          {auth === 'bearer' ? (
            <Field label="Jeton" error={show('token')} hint={show('token') ? undefined : "Chiffré à l'enregistrement, jamais réaffiché."}>
              <SecretField value={token} onChange={(event) => setToken(event.target.value)} leadingIcon="key" maxLength={4096} />
            </Field>
          ) : null}
          {auth === 'header' ? (
            <div className="grid gap-4 nav:grid-cols-2">
              <Field label="Nom de l'en-tête" error={show('headerName')}>
                <Input value={headerName} onChange={(event) => setHeaderName(event.target.value)} mono maxLength={64} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Valeur" error={show('headerValue')} hint={show('headerValue') ? undefined : "Chiffrée à l'enregistrement, jamais réaffichée."}>
                <SecretField value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} leadingIcon="key" maxLength={4096} />
              </Field>
            </div>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
