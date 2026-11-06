'use client';

import { useState, type FormEvent } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  SecretField,
  SectionLabel,
  Select,
  toast,
  type DataTableColumn,
} from '@/components/ui';
import type { AdminServerView, RegisteredServer, RestrictedDatabaseAccess, RotatedToken } from '@/server/admin';
import {
  assignServerAction,
  registerServerAction,
  restrictDatabaseAction,
  retireServerAction,
  rotateServerTokenAction,
  updateServerAction,
  verifyServerAction,
} from '../actions';
import { claudeText, lastSeenText, SERVER_FOOTNOTE, serverHealth, serverStatusLabel } from '../lib/copy';
import { SectionError, useAdmin } from './AdminView';
import { OnceSecret } from './OnceSecret';

type ServerDialog =
  | { kind: 'assign'; server: AdminServerView }
  | { kind: 'edit'; server: AdminServerView }
  | { kind: 'rotate'; server: AdminServerView }
  | { kind: 'restrict'; server: AdminServerView }
  | { kind: 'retire'; server: AdminServerView };

/** Administration › Serveurs: every runner instance, its account, its health, its database access. */
export function ServersTab({ openRegister }: { openRegister: boolean }) {
  const { data } = useAdmin();
  const [registering, setRegistering] = useState(openRegister);
  const [dialog, setDialog] = useState<ServerDialog | null>(null);
  const close = () => setDialog(null);

  if (!data.servers.ok) return <SectionError title="Les serveurs n'ont pas pu être lus" message={data.servers.error.message} />;
  const servers = data.servers.data;
  const warnings = servers.filter((server) => server.warning);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {warnings.map((server) => (
        <Banner
          key={server.id}
          tone="warn"
          icon="server"
          title={server.warning}
          action={
            <Button variant="default" onClick={() => setDialog({ kind: 'restrict', server })}>
              Restreindre l'accès base
            </Button>
          }
        >
          Ses sessions Claude Code et son terminal peuvent lire tout l'environnement du runner : donnez-lui un accès restreint
          (RUNNER_DATABASE_URL), puis redéployez-le. L'avertissement disparaît dès que le runner l'utilise.
        </Banner>
      ))}
      <section aria-labelledby="admin-servers" className="flex flex-col gap-2">
        <SectionLabel
          as="h2"
          id="admin-servers"
          action={
            <Button variant="accent" onClick={() => setRegistering(true)}>
              Ajouter un serveur
            </Button>
          }
        >{`Serveurs · ${servers.length}`}</SectionLabel>
        <ServersList servers={servers} onAction={setDialog} />
        <p className="m-0 font-sans text-app-12 text-muted">{SERVER_FOOTNOTE}</p>
      </section>
      <RegisterDialog open={registering} onOpenChange={setRegistering} />
      <AssignDialog server={dialog?.kind === 'assign' ? dialog.server : null} onClose={close} />
      <EditDialog server={dialog?.kind === 'edit' ? dialog.server : null} onClose={close} />
      <RotateDialog server={dialog?.kind === 'rotate' ? dialog.server : null} onClose={close} />
      <RestrictDialog server={dialog?.kind === 'restrict' ? dialog.server : null} onClose={close} />
      <RetireDialog server={dialog?.kind === 'retire' ? dialog.server : null} onClose={close} />
    </div>
  );
}

function ServerMenu({ server, onAction }: { server: AdminServerView; onAction: (dialog: ServerDialog) => void }) {
  const [checking, setChecking] = useState(false);
  const { refresh } = useAdmin();
  if (server.status === 'retired') return null;
  async function verify() {
    setChecking(true);
    const result = await verifyServerAction(server.id);
    setChecking(false);
    if (!result.ok) return toast({ message: result.error.message, icon: 'alert' });
    toast({
      message: result.data.ok ? result.data.message : [result.data.message, ...result.data.problems].join(' '),
      icon: result.data.ok ? 'check' : 'alert',
    });
    refresh();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more" label={`Actions sur le serveur ${server.name}`} loading={checking} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={270}>
        <DropdownMenuItem icon="refresh" onSelect={() => void verify()}>
          Vérifier la connexion
        </DropdownMenuItem>
        {server.status === 'pending' ? (
          <DropdownMenuItem icon="link" onSelect={() => onAction({ kind: 'assign', server })}>
            Attribuer à un compte…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon="edit" onSelect={() => onAction({ kind: 'edit', server })}>
          Modifier…
        </DropdownMenuItem>
        {server.configSource === 'db' ? (
          <DropdownMenuItem icon="key" onSelect={() => onAction({ kind: 'rotate', server })}>
            Renouveler le jeton…
          </DropdownMenuItem>
        ) : null}
        {server.databaseRestricted ? null : (
          <DropdownMenuItem icon="lock" onSelect={() => onAction({ kind: 'restrict', server })}>
            {server.hasDatabaseRole ? "Renouveler l'accès base restreint…" : "Restreindre l'accès base…"}
          </DropdownMenuItem>
        )}
        {server.isDefault ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon="archive" destructive onSelect={() => onAction({ kind: 'retire', server })}>
              Retirer le serveur…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ServersList({ servers, onAction }: { servers: AdminServerView[]; onAction: (dialog: ServerDialog) => void }) {
  const { data } = useAdmin();
  if (servers.length === 0) {
    return (
      <EmptyState icon="server" title="Aucun serveur" variant="plain">
        Ajoutez un serveur pour chaque compte : c'est la machine où ses dépôts sont clonés et où Claude Code travaille.
      </EmptyState>
    );
  }
  const health = (server: AdminServerView) => {
    const verdict = serverHealth(server, data.now);
    return <Badge tone={verdict.tone}>{verdict.label}</Badge>;
  };
  const identity = (server: AdminServerView) => (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-sans text-app-14 font-medium text-text">{server.name}</span>
      <span className="truncate font-sans text-app-12 text-muted">
        {[server.location, server.isDefault ? 'défini par RUNNER_URL et RUNNER_TOKEN' : null].filter(Boolean).join(' · ') || serverStatusLabel(server.status)}
      </span>
    </div>
  );
  const columns: DataTableColumn<AdminServerView>[] = [
    { key: 'name', header: 'Serveur', cell: identity },
    { key: 'url', header: 'Adresse interne', width: 200, hideBelowLg: true, cell: (server) => <span className="truncate font-mono text-app-12 text-muted">{server.url ?? 'RUNNER_URL'}</span> },
    {
      key: 'account',
      header: 'Compte',
      width: 170,
      cell: (server) => (server.account ? <span className="truncate font-sans text-app-13 text-text">{server.account.name}</span> : <Badge tone="neutral">{serverStatusLabel(server.status)}</Badge>),
    },
    { key: 'state', header: 'État', width: 130, cell: health },
    { key: 'claude', header: 'Claude Code', width: 120, hideBelowLg: true, cell: (server) => <span className="font-sans text-app-13 text-muted">{claudeText(server.claudeInstalled)}</span> },
    {
      key: 'contact',
      header: 'Dernier contact',
      width: 150,
      hideBelowLg: true,
      cell: (server) => (
        <span className="flex flex-col font-sans text-app-13 text-muted">
          <span>{lastSeenText(server.lastSeenAt, data.now)}</span>
          {server.runnerVersion ? <span className="font-mono text-app-11">{`runner ${server.runnerVersion}`}</span> : null}
        </span>
      ),
    },
    { key: 'action', header: 'Action', width: 72, align: 'right', cell: (server) => <ServerMenu server={server} onAction={onAction} /> },
  ];
  return (
    <>
      <DataTable className="hidden nav:block" caption="Serveurs de l'instance" columns={columns} rows={servers} getRowKey={(server) => server.id} />
      <ul className="m-0 flex list-none flex-col gap-2 p-0 nav:hidden">
        {servers.map((server) => (
          <Card key={server.id} as="li" variant="card" padding="md" className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">{identity(server)}</div>
              <ServerMenu server={server} onAction={onAction} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {health(server)}
              {server.account ? <Badge tone="accent">{server.account.name}</Badge> : null}
            </div>
            <p className="m-0 font-sans text-app-12 text-muted">
              {`Dernier contact ${lastSeenText(server.lastSeenAt, data.now)} · Claude Code : ${claudeText(server.claudeInstalled).toLowerCase()}`}
            </p>
          </Card>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogues
// ---------------------------------------------------------------------------------------------

function useServerMutation() {
  const { refresh } = useAdmin();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    setError,
    /** `{ value }` on success (the page data is read again), null on a refusal (shown in the dialog). */
    run: async <T,>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string; detail?: string } }>): Promise<{ value: T } | null> => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.error.detail ? `${result.error.message} ${result.error.detail}` : result.error.message);
        return null;
      }
      refresh();
      return { value: result.data };
    },
  };
}

function RegisterDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const mutation = useServerMutation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredServer | null>(null);

  function change(next: boolean) {
    if (!next) {
      setName('');
      setUrl('');
      setLocation('');
      setRegistered(null);
      mutation.setError(null);
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await mutation.run(() => registerServerAction({ name, url, location: location || null }));
    setBusy(false);
    if (result) setRegistered(result.value);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        size="md"
        title={registered ? `Serveur ${registered.name} enregistré` : 'Ajouter un serveur'}
        description={
          registered
            ? 'Copiez ces valeurs dans les variables du runner de ce serveur, puis déployez-le. Elles ne seront plus affichées.'
            : 'Un serveur est un runner de Nuera Dev, déployé à part. Il reçoit un jeton et un accès restreint à la base, affichés une seule fois.'
        }
        footer={
          registered ? (
            <Button variant="accent" onClick={() => change(false)}>
              Terminé
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => change(false)}>
                Annuler
              </Button>
              <Button variant="accent" type="submit" form="admin-register" loading={busy} loadingLabel="Enregistrement…">
                Enregistrer
              </Button>
            </>
          )
        }
      >
        {registered ? (
          <div className="flex flex-col gap-3">
            <OnceSecret
              label="Variables du runner"
              value={[`RUNNER_TOKEN=${registered.token}`, `NUERA_ENVIRONMENT_ID=${registered.environmentId}`, `RUNNER_DATABASE_URL=${registered.databaseUrl}`].join('\n')}
              copyLabel="Copier les variables"
            />
            <p className="m-0 font-sans text-app-12 text-muted">
              Ensuite, « Vérifier la connexion » dans le menu du serveur, puis attribuez-le à un compte (ou choisissez-le dans une invitation).
            </p>
          </div>
        ) : (
          <form id="admin-register" onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {mutation.error ? (
              <p role="alert" className="m-0 font-sans text-app-13 text-danger">
                {mutation.error}
              </p>
            ) : null}
            <Field label="Nom affiché" hint="Les comptes le voient ainsi : « VPS-4 ».">
              <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} />
            </Field>
            <Field label="Adresse interne du runner" hint="Adresse joignable depuis le service web, jamais depuis les navigateurs (ex. http://runner-vps-4:4100).">
              <Input value={url} onChange={(event) => setUrl(event.target.value)} required mono autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label="Emplacement (facultatif)">
              <Input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={80} />
            </Field>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ server, onClose }: { server: AdminServerView | null; onClose: () => void }) {
  const { data } = useAdmin();
  const mutation = useServerMutation();
  const candidates = data.accounts.ok ? data.accounts.data.filter((account) => !account.server) : [];
  const [userId, setUserId] = useState('');
  return (
    <ConfirmDialog
      open={server !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setUserId('');
          mutation.setError(null);
        }
      }}
      tone="warn"
      icon="server"
      title={`Attribuer ${server?.name ?? ''} à un compte ?`}
      consequences={[
        { kind: 'risk', text: 'Ce serveur appartiendra à ce compte pour toujours : il ne sera jamais réattribué, seulement retiré.' },
        { kind: 'kept', text: 'Les autres comptes et leurs serveurs ne changent pas.' },
      ]}
      confirmLabel="Attribuer"
      confirmDisabled={candidates.length === 0 ? "Tous les comptes ont déjà un serveur." : !userId ? 'Choisissez un compte.' : undefined}
      error={mutation.error}
      onConfirm={async () => {
        if (!server || !userId) return;
        if ((await mutation.run(() => assignServerAction(server.id, userId))) !== null) {
          onClose();
          setUserId('');
          toast({ message: `${server.name} attribué` });
        }
      }}
    >
      {candidates.length > 0 ? (
        <Field label="Compte">
          <Select value={userId || undefined} onValueChange={setUserId} placeholder="Choisir un compte…" options={candidates.map((account) => ({ value: account.id, label: account.name, description: account.email }))} />
        </Field>
      ) : null}
    </ConfirmDialog>
  );
}

function EditDialog({ server, onClose }: { server: AdminServerView | null; onClose: () => void }) {
  const mutation = useServerMutation();
  const [values, setValues] = useState<{ id: string; name: string; location: string; url: string; cap: string; password: string } | null>(null);
  const current =
    server && values?.id === server.id
      ? values
      : server
        ? { id: server.id, name: server.name, location: server.location ?? '', url: server.url ?? '', cap: String(server.maxConcurrentSessionsCap), password: '' }
        : null;
  const [busy, setBusy] = useState(false);
  const [renewed, setRenewed] = useState<{ name: string; token: string } | null>(null);
  const urlChanged = Boolean(server && current && server.configSource === 'db' && current.url.trim().replace(/\/+$/, '') !== (server.url ?? ''));
  const renewsToken = Boolean(server && urlChanged && server.status !== 'retired' && (server.account || server.status !== 'pending'));
  const needsPassword = Boolean(server && urlChanged && server.ownedByOther);

  function change(open: boolean) {
    if (open) return;
    setValues(null);
    mutation.setError(null);
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!server || !current) return;
    const cap = Number(current.cap);
    const patch = {
      ...(current.name !== server.name ? { name: current.name } : {}),
      ...(current.location !== (server.location ?? '') ? { location: current.location || null } : {}),
      ...(server.configSource === 'db' && current.url !== (server.url ?? '') ? { url: current.url } : {}),
      ...(Number.isFinite(cap) && cap !== server.maxConcurrentSessionsCap ? { maxConcurrentSessionsCap: cap } : {}),
    };
    if (Object.keys(patch).length === 0) return change(false);
    if (needsPassword && !current.password) return mutation.setError('Saisissez votre mot de passe.');
    setBusy(true);
    const result = await mutation.run(() => updateServerAction(server.id, needsPassword ? { ...patch, password: current.password } : patch));
    setBusy(false);
    if (result !== null) {
      toast({ message: `Serveur ${current.name} modifié` });
      if (result.value.token) setRenewed({ name: current.name, token: result.value.token });
      change(false);
    }
  }

  const update = (field: 'name' | 'location' | 'url' | 'cap' | 'password', value: string) => current && setValues({ ...current, [field]: value });

  return (
    <>
      <Dialog open={server !== null} onOpenChange={change}>
        <DialogContent
          size="sm"
          title={`Modifier ${server?.name ?? ''}`}
          footer={
            <>
              <Button variant="default" onClick={() => change(false)}>
                Annuler
              </Button>
              <Button variant="accent" type="submit" form="admin-edit-server" loading={busy} loadingLabel="Enregistrement…">
                Enregistrer
              </Button>
            </>
          }
        >
          {current && server ? (
            <form id="admin-edit-server" onSubmit={submit} className="flex flex-col gap-4" noValidate>
              {mutation.error ? (
                <p role="alert" className="m-0 font-sans text-app-13 text-danger">
                  {mutation.error}
                </p>
              ) : null}
              <Field label="Nom affiché">
                <Input value={current.name} onChange={(event) => update('name', event.target.value)} maxLength={60} />
              </Field>
              <Field label="Emplacement">
                <Input value={current.location} onChange={(event) => update('location', event.target.value)} maxLength={80} />
              </Field>
              {server.configSource === 'db' ? (
                <Field
                  label="Adresse interne du runner"
                  hint={renewsToken ? "Changer l'adresse renouvelle le jeton de ce serveur : l'ancien est aussitôt refusé, redéployez le runner avec le nouveau." : undefined}
                >
                  <Input value={current.url} onChange={(event) => update('url', event.target.value)} mono autoCapitalize="none" spellCheck={false} />
                </Field>
              ) : null}
              {needsPassword ? (
                <Field label="Votre mot de passe" hint={`Ce serveur est celui d'un autre compte (${server.account?.name ?? 'compte'}) : il sera prévenu du changement.`}>
                  <SecretField
                    value={current.password}
                    onChange={(event) => update('password', event.target.value)}
                    autoComplete="current-password"
                    revealable={false}
                    mono={false}
                  />
                </Field>
              ) : null}
              <Field label="Plafond de sessions parallèles" hint={`Le compte de ce serveur en règle le nombre (${server.maxConcurrentSessions} aujourd'hui) sans dépasser ce plafond.`}>
                <Input type="number" inputMode="numeric" min={1} max={64} value={current.cap} onChange={(event) => update('cap', event.target.value)} />
              </Field>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <SecretResultDialog
        title={`Nouveau jeton de ${renewed?.name ?? ''}`}
        description="Son adresse a changé : mettez ce jeton dans RUNNER_TOKEN du runner, puis redéployez-le. L'ancien jeton est refusé. Ce jeton ne sera plus affiché."
        label="Nouveau RUNNER_TOKEN"
        value={renewed ? `RUNNER_TOKEN=${renewed.token}` : null}
        onClose={() => setRenewed(null)}
      />
    </>
  );
}

function SecretResultDialog({ title, description, label, value, onClose }: { title: string; description: string; label: string; value: string | null; onClose: () => void }) {
  return (
    <Dialog
      open={value !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        size="md"
        title={title}
        description={description}
        footer={
          <Button variant="accent" onClick={onClose}>
            Terminé
          </Button>
        }
      >
        {value ? <OnceSecret label={label} value={value} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({ server, onClose }: { server: AdminServerView | null; onClose: () => void }) {
  const mutation = useServerMutation();
  const [rotated, setRotated] = useState<{ name: string; result: RotatedToken } | null>(null);
  return (
    <>
      <ConfirmDialog
        open={server !== null}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
            mutation.setError(null);
          }
        }}
        tone="warn"
        icon="key"
        title={`Renouveler le jeton de ${server?.name ?? ''} ?`}
        consequences={[
          { kind: 'risk', text: "Le nouveau jeton s'installe au premier appel du runner qui l'utilise : l'ancien est alors refusé." },
          { kind: 'kept', text: "D'ici là, l'ancien jeton fonctionne : les sessions Claude Code en cours continuent." },
        ]}
        confirmLabel="Renouveler le jeton"
        error={mutation.error}
        onConfirm={async () => {
          if (!server) return;
          const result = await mutation.run(() => rotateServerTokenAction(server.id));
          if (result) {
            setRotated({ name: server.name, result: result.value });
            onClose();
          }
        }}
      />
      <SecretResultDialog
        title={`Nouveau jeton de ${rotated?.name ?? ''}`}
        description="Mettez-le dans RUNNER_TOKEN de ce runner, puis redéployez-le. Ce jeton ne sera plus affiché."
        label="Nouveau RUNNER_TOKEN"
        value={rotated ? `RUNNER_TOKEN=${rotated.result.token}` : null}
        onClose={() => setRotated(null)}
      />
    </>
  );
}

function RestrictDialog({ server, onClose }: { server: AdminServerView | null; onClose: () => void }) {
  const mutation = useServerMutation();
  const [access, setAccess] = useState<{ name: string; result: RestrictedDatabaseAccess } | null>(null);
  return (
    <>
      <ConfirmDialog
        open={server !== null}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
            mutation.setError(null);
          }
        }}
        tone="warn"
        icon="lock"
        title={`Restreindre l'accès base de ${server?.name ?? ''} ?`}
        consequences={
          server?.hasDatabaseRole
            ? [
                { kind: 'risk', text: "Le rôle existant reçoit un nouveau mot de passe : l'ancien DSN cesse de fonctionner et ses connexions ouvertes sont fermées." },
                { kind: 'risk', text: "Le runner perd l'accès à la base jusqu'à son redéploiement avec la nouvelle RUNNER_DATABASE_URL." },
              ]
            : [
                { kind: 'risk', text: 'Un rôle PostgreSQL restreint est créé pour ce runner.' },
                { kind: 'kept', text: "Rien ne change tant que RUNNER_DATABASE_URL n'est pas renseignée et le runner redéployé." },
              ]
        }
        confirmLabel={server?.hasDatabaseRole ? 'Renouveler le DSN' : "Créer l'accès restreint"}
        error={mutation.error}
        onConfirm={async () => {
          if (!server) return;
          const result = await mutation.run(() => restrictDatabaseAction(server.id));
          if (result) {
            setAccess({ name: server.name, result: result.value });
            onClose();
          }
        }}
      />
      <SecretResultDialog
        title={`Accès base restreint de ${access?.name ?? ''}`}
        description="Mettez cette valeur dans RUNNER_DATABASE_URL de ce runner, puis redéployez-le. Elle ne sera plus affichée."
        label="RUNNER_DATABASE_URL"
        value={access ? `RUNNER_DATABASE_URL=${access.result.databaseUrl}` : null}
        onClose={() => setAccess(null)}
      />
    </>
  );
}

function RetireDialog({ server, onClose }: { server: AdminServerView | null; onClose: () => void }) {
  const mutation = useServerMutation();
  return (
    <ConfirmDialog
      open={server !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          mutation.setError(null);
        }
      }}
      tone="danger"
      icon="archive"
      title={`Retirer le serveur ${server?.name ?? ''} ?`}
      consequences={[
        { kind: 'risk', text: "Ce serveur ne sera plus jamais utilisé ni réattribué ; son accès à la base est fermé." },
        { kind: 'kept', text: "Rien n'est effacé sur le serveur lui-même." },
      ]}
      confirmLabel="Retirer le serveur"
      confirmDisabled={server && server.activeProjects > 0 ? `${server.activeProjects} projet(s) actif(s) vivent encore sur ce serveur.` : undefined}
      error={mutation.error}
      onConfirm={async () => {
        if (!server) return;
        if ((await mutation.run(() => retireServerAction(server.id))) !== null) {
          onClose();
          toast({ message: `${server.name} retiré` });
        }
      }}
    />
  );
}
