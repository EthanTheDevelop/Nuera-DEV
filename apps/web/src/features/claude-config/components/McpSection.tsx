'use client';

import { useId, useState, type FormEvent } from 'react';
import { formatDateTimeShort } from '@nuera/shared/format';
import { Banner, Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, IconButton, Input, Label, SecretField, SegmentedControl, Select, Switch, Textarea, TileHeader, toast } from '@/components/ui';
import { classifyCoolifyTool, coolifyPermissionRules } from '@/lib/claude-coolify';
import type { McpItem, McpTestResult } from '@/server/claude-config';
import { claudeApi, errorText } from '../lib/api';
import { AUDIENCE_OPTIONS, COOLIFY_WARNING, ENFORCEMENT_OPTIONS, plural } from '../lib/copy';
import { SectionIntro, useClaudeAdmin } from './AdminClaudeTab';
import { InlineError, ItemBadges, VersionsDialog } from './parts';

/**
 * MCP communs: servers added to the `--mcp-config` of every session whose account is in their
 * audience. Secrets stay encrypted in the web and reach Claude only through the headers helper of the
 * runner, for a live session of an account in the audience. « Coolify (administrateurs) »: the
 * instance Coolify, administrators only, write tools always behind a permission request.
 */

const CLASS_LABELS = { read: 'lecture · permis', sensitive: 'secrets · demande', write: 'écriture · demande', destructive: 'suppression · refusé' } as const;

export function McpSection() {
  const { overview, reload } = useClaudeAdmin();
  const servers = overview.rows.mcp;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpItem | null>(null);
  const [versions, setVersions] = useState<McpItem | null>(null);
  const [deleting, setDeleting] = useState<McpItem | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasCoolify = servers.some((server) => server.kind === 'coolify');
  const [now] = useState(() => new Date().toISOString());

  async function test(server: McpItem) {
    setTesting(server.id);
    setError(null);
    const result = await claudeApi<McpTestResult>('POST', `/api/admin/claude/mcp/${server.id}/test`);
    setTesting(null);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: result.data.ok ? `« ${server.label} » répond : ${plural(result.data.tools.length, 'outil', 'outils')}` : `« ${server.label} » : ${result.data.message ?? 'test échoué'}` });
    await reload();
  }

  async function toggle(server: McpItem, enabled: boolean) {
    const result = await claudeApi('PATCH', `/api/admin/claude/mcp/${server.id}`, { enabled, expectedVersion: server.version });
    if (!result.ok) return setError(errorText(result.error));
    await reload();
  }

  return (
    <Card as="section" aria-label="MCP communs" className="gap-3">
      <TileHeader
        icon="plug"
        title="Serveurs MCP communs"
        action={
          <Button variant="accent" onClick={() => setAdding(true)}>
            Ajouter un serveur
          </Button>
        }
      />
      <SectionIntro>
        Ajoutés à chaque session des comptes visés, en plus des serveurs MCP du projet (un serveur du projet du même nom est alors
        ignoré). Les jetons restent chiffrés dans Nuera Dev : le CLI les demande au runner à chaque connexion, jamais dans un fichier.
      </SectionIntro>
      {servers.length === 0 ? (
        <EmptyState icon="plug" title="Aucun serveur MCP commun" variant="plain" action={<Button onClick={() => setAdding(true)}>Ajouter un serveur</Button>}>
          Documentation interne, outils d'équipe, ou Coolify pour les administrateurs.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {servers.map((server) => {
            const rules = server.kind === 'coolify' ? coolifyPermissionRules(server.name, server.lastTools, server.config) : null;
            return (
              <li key={server.id} className="flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="m-0 font-sans text-app-14 font-medium text-text">
                      {server.label} <span className="font-mono text-app-12 text-muted">mcp__{server.name}</span>
                    </p>
                    <ItemBadges
                      locked={server.enforcement === 'locked'}
                      admins={server.audience === 'admins'}
                      disabled={!server.enabled}
                      extra={
                        <>
                          <Badge tone={server.status === 'connected' ? 'success' : server.status === 'unknown' ? 'neutral' : 'danger'}>
                            {server.status === 'connected' ? 'Testé' : server.status === 'unknown' ? 'Jamais testé' : 'Échec du test'}
                          </Badge>
                          <span className="font-mono text-app-11 text-muted">
                            {server.transport === 'stdio' ? `stdio · ${server.command}` : server.kind === 'coolify' ? `${server.url}/mcp` : server.url}
                            {server.secretKeys.length ? ` · secrets : ${server.secretKeys.join(', ')}` : ''}
                          </span>
                        </>
                      }
                    />
                    {server.lastCheckedAt ? (
                      <p className="m-0 font-sans text-app-12 text-muted">
                        Testé {formatDateTimeShort(server.lastCheckedAt, now)} · {plural(server.lastTools.length, 'outil', 'outils')}
                        {server.lastError ? ` · ${server.lastError}` : ''}
                      </p>
                    ) : null}
                    {rules ? (
                      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
                        {server.lastTools.map((tool) => (
                          <li key={tool} className="font-mono text-app-11 text-muted">
                            {tool} · {CLASS_LABELS[classifyCoolifyTool(tool)].replace('demande', rules.ask.includes(`mcp__${server.name}__${tool}`) ? 'demande' : 'refusé')}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <Switch checked={server.enabled} onCheckedChange={(next) => void toggle(server, next)} aria-label={`Activer « ${server.label} »`} />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {server.transport !== 'stdio' ? (
                    <Button variant="default" onClick={() => void test(server)} loading={testing === server.id} loadingLabel="Test…">
                      Tester la connexion
                    </Button>
                  ) : null}
                  <IconButton icon="edit" label={`Modifier « ${server.label} »`} onClick={() => setEditing(server)} />
                  <IconButton icon="history" label={`Versions de « ${server.label} »`} onClick={() => setVersions(server)} />
                  <IconButton icon="trash" label={`Supprimer « ${server.label} »`} onClick={() => setDeleting(server)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <InlineError>{error}</InlineError>
      {adding ? <AddMcpDialog hasCoolify={hasCoolify} isOwner={overview.isOwner} onClose={() => setAdding(false)} onDone={reload} /> : null}
      {editing ? <EditMcpDialog key={`${editing.id}:${editing.version}`} server={editing} isOwner={overview.isOwner} onClose={() => setEditing(null)} onDone={reload} /> : null}
      <VersionsDialog
        open={versions !== null}
        onOpenChange={(open) => !open && setVersions(null)}
        title={versions ? `Versions de « ${versions.label} »` : 'Versions'}
        kind="mcp"
        {...(versions ? { itemId: versions.id } : {})}
        onRestored={() => void reload()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        tone="danger"
        icon="trash"
        title={deleting ? `Supprimer « ${deleting.label} » ?` : 'Supprimer le serveur ?'}
        consequences={[
          { kind: 'risk', text: 'Les prochaines sessions ne le reçoivent plus ; ses secrets sont effacés.' },
          { kind: 'kept', text: "Ses réglages non secrets restent dans l'historique." },
        ]}
        confirmLabel="Supprimer le serveur"
        onConfirm={async () => {
          if (!deleting) return;
          const result = await claudeApi('DELETE', `/api/admin/claude/mcp/${deleting.id}`);
          if (!result.ok) throw new Error(errorText(result.error));
          toast({ message: `« ${deleting.label} » supprimé` });
          setDeleting(null);
          await reload();
        }}
      />
    </Card>
  );
}

type AddKind = 'custom' | 'stdio' | 'coolify';

function AddMcpDialog({ hasCoolify, isOwner, onClose, onDone }: { hasCoolify: boolean; isOwner: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const formId = useId();
  const writeId = useId();
  const destructiveId = useId();
  const [kind, setKind] = useState<AddKind>(hasCoolify ? 'custom' : 'custom');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<'http' | 'sse'>('http');
  const [authKind, setAuthKind] = useState<'none' | 'bearer'>('none');
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [askTools, setAskTools] = useState('');
  const [audience, setAudience] = useState<'all' | 'admins'>('all');
  const [enforcement, setEnforcement] = useState<'default' | 'locked'>('default');
  const [allowWrite, setAllowWrite] = useState(false);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tools = (value: string) =>
    value
      .split(/[\s,]+/)
      .map((tool) => tool.trim())
      .filter(Boolean);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body =
      kind === 'coolify'
        ? { kind, baseUrl: url, token, allowWrite, allowDestructive: allowWrite && allowDestructive, enforcement, ...(label ? { label } : {}) }
        : kind === 'stdio'
          ? { kind, name, label: label || name, command, args: args ? args.split('\n').map((line) => line.trim()).filter(Boolean) : [], audience, enforcement, askTools: tools(askTools) }
          : { kind, name, label: label || name, transport, url, authKind, ...(authKind === 'bearer' ? { bearerToken: token } : {}), audience, enforcement, askTools: tools(askTools) };
    setBusy(true);
    setError(null);
    const result = await claudeApi<{ server: McpItem }>('POST', '/api/admin/claude/mcp', body);
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: `« ${result.data.server.label} » ajouté${result.data.server.transport !== 'stdio' ? ' : testez la connexion' : ''}` });
    onClose();
    await onDone();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Ajouter un serveur MCP commun"
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Ajout…">
              Ajouter
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          <SegmentedControl<AddKind>
            aria-label="Type de serveur"
            value={kind}
            onValueChange={setKind}
            items={[
              { value: 'custom', label: 'HTTP', icon: 'globe2' },
              { value: 'stdio', label: 'Commande', icon: 'terminal' },
              { value: 'coolify', label: 'Coolify', icon: 'rocket', disabled: hasCoolify },
            ]}
          />
          {kind === 'coolify' ? (
            <>
              <Banner tone="warn" icon="shield" title="Réservé aux administrateurs">
                {COOLIFY_WARNING}
              </Banner>
              <Field label="Adresse de Coolify" hint="https://coolify.exemple.fr (le serveur MCP est /mcp).">
                <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" inputMode="url" />
              </Field>
              <Field label="Jeton d'API Coolify" hint="Chiffré dans Nuera Dev, jamais affiché ni écrit dans un fichier.">
                <SecretField value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
              </Field>
              <div className="flex items-start gap-3">
                <Checkbox id={writeId} checked={allowWrite} onCheckedChange={setAllowWrite} />
                <Label htmlFor={writeId}>Proposer les outils d'écriture (déployer, redémarrer, modifier) : chaque appel demande votre autorisation</Label>
              </div>
              {allowWrite && isOwner ? (
                <div className="flex items-start gap-3">
                  <Checkbox id={destructiveId} checked={allowDestructive} onCheckedChange={setAllowDestructive} />
                  <Label htmlFor={destructiveId}>Proposer aussi les outils de suppression (toujours avec demande d'autorisation)</Label>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 nav:grid-cols-2">
                <Field label="Identifiant" hint="Minuscules, chiffres et tirets : mcp__identifiant__outil.">
                  <Input value={name} onChange={(event) => setName(event.target.value.trim())} maxLength={40} placeholder="docs-equipe" />
                </Field>
                <Field label="Nom affiché">
                  <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} placeholder="Documentation de l'équipe" />
                </Field>
              </div>
              {kind === 'custom' ? (
                <>
                  <Field label="Adresse">
                    <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" inputMode="url" />
                  </Field>
                  <div className="grid grid-cols-1 gap-4 nav:grid-cols-2">
                    <Field label="Transport">
                      <Select
                        options={[
                          { value: 'http', label: 'HTTP' },
                          { value: 'sse', label: 'SSE' },
                        ]}
                        value={transport}
                        onValueChange={(value) => setTransport(value as 'http' | 'sse')}
                        aria-label="Transport"
                      />
                    </Field>
                    <Field label="Authentification">
                      <Select
                        options={[
                          { value: 'none', label: 'Aucune' },
                          { value: 'bearer', label: 'Jeton (Bearer)' },
                        ]}
                        value={authKind}
                        onValueChange={(value) => setAuthKind(value as 'none' | 'bearer')}
                        aria-label="Authentification"
                      />
                    </Field>
                  </div>
                  {authKind === 'bearer' ? (
                    <Field label="Jeton" hint="Chiffré, servi au CLI par le runner pour les sessions des comptes visés seulement.">
                      <SecretField value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
                    </Field>
                  ) : null}
                </>
              ) : (
                <>
                  <Field label="Commande" hint="Lancée sur chaque serveur par le CLI, sans shell.">
                    <Input value={command} onChange={(event) => setCommand(event.target.value.trim())} placeholder="npx" />
                  </Field>
                  <Field label="Arguments" hint="Un par ligne.">
                    <Textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} mono />
                  </Field>
                </>
              )}
              <Field label="Outils à demander" hint="Noms d'outils séparés par des virgules : chaque appel demande une autorisation.">
                <Input value={askTools} onChange={(event) => setAskTools(event.target.value)} placeholder="create_page, delete_page" />
              </Field>
              <Field label="Pour">
                <Select options={AUDIENCE_OPTIONS} value={audience} onValueChange={(value) => setAudience(value as 'all' | 'admins')} aria-label="Pour" />
              </Field>
            </>
          )}
          <Field label="Application">
            <Select options={ENFORCEMENT_OPTIONS} value={enforcement} onValueChange={(value) => setEnforcement(value as 'default' | 'locked')} aria-label="Application" />
          </Field>
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditMcpDialog({ server, isOwner, onClose, onDone }: { server: McpItem; isOwner: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const formId = useId();
  const writeId = useId();
  const destructiveId = useId();
  const coolify = server.kind === 'coolify';
  const [label, setLabel] = useState(server.label);
  const [url, setUrl] = useState(server.url ?? '');
  const [token, setToken] = useState('');
  const [audience, setAudience] = useState(server.audience);
  const [enforcement, setEnforcement] = useState(server.enforcement);
  const [allowWrite, setAllowWrite] = useState(Boolean(server.config.allowWrite));
  const [allowDestructive, setAllowDestructive] = useState(Boolean(server.config.allowDestructive));
  const [askTools, setAskTools] = useState((server.config.askTools ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, unknown> = { label, enforcement, expectedVersion: server.version };
    if (coolify) {
      if (url !== server.url) body.baseUrl = url;
      body.allowWrite = allowWrite;
      if (isOwner) body.allowDestructive = allowWrite && allowDestructive;
    } else {
      body.audience = audience;
      if (server.transport !== 'stdio' && url !== server.url) body.url = url;
      body.askTools = askTools.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean);
    }
    if (token) body.token = token;
    setBusy(true);
    setError(null);
    const result = await claudeApi('PATCH', `/api/admin/claude/mcp/${server.id}`, body);
    setBusy(false);
    if (!result.ok) return setError(errorText(result.error));
    toast({ message: `« ${label} » enregistré${token || (coolify && url !== server.url) ? ' : testez de nouveau la connexion' : ''}` });
    onClose();
    await onDone();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={`Modifier « ${server.label} »`}
        dismissible={!busy}
        footer={
          <>
            <Button variant="default" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button variant="accent" type="submit" form={formId} loading={busy} loadingLabel="Enregistrement…">
              Enregistrer
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          <Field label="Nom affiché">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} />
          </Field>
          {server.transport !== 'stdio' ? (
            <Field label={coolify ? 'Adresse de Coolify' : 'Adresse'}>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} inputMode="url" />
            </Field>
          ) : null}
          {coolify || server.hasSecrets ? (
            <Field label="Nouveau jeton" hint="Laissez vide pour garder le jeton actuel. Un nouveau jeton n'est servi qu'après un test réussi.">
              <SecretField value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
            </Field>
          ) : null}
          {coolify ? (
            <>
              <div className="flex items-start gap-3">
                <Checkbox id={writeId} checked={allowWrite} onCheckedChange={setAllowWrite} />
                <Label htmlFor={writeId}>Proposer les outils d'écriture : chaque appel demande votre autorisation</Label>
              </div>
              {allowWrite && isOwner ? (
                <div className="flex items-start gap-3">
                  <Checkbox id={destructiveId} checked={allowDestructive} onCheckedChange={setAllowDestructive} />
                  <Label htmlFor={destructiveId}>Proposer aussi les outils de suppression (avec demande d'autorisation)</Label>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <Field label="Outils à demander">
                <Input value={askTools} onChange={(event) => setAskTools(event.target.value)} />
              </Field>
              <Field label="Pour">
                <Select options={AUDIENCE_OPTIONS} value={audience} onValueChange={(value) => setAudience(value as 'all' | 'admins')} aria-label="Pour" />
              </Field>
            </>
          )}
          <Field label="Application">
            <Select options={ENFORCEMENT_OPTIONS} value={enforcement} onValueChange={(value) => setEnforcement(value as 'default' | 'locked')} aria-label="Application" />
          </Field>
          <InlineError>{error}</InlineError>
        </form>
      </DialogContent>
    </Dialog>
  );
}
