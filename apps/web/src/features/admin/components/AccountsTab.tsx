'use client';

import { useState, type FormEvent } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  CompactButton,
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
import { formatDateTimeShort, plural } from '@nuera/shared/format';
import type { AdminAccountView, AdminInvitationView, CreatedInvitation, RecoveryLinkView } from '@/server/admin';
import {
  changeRoleAction,
  deleteAccountAction,
  disableAccountAction,
  enableAccountAction,
  inviteAccountAction,
  recoveryLinkAction,
  revokeInvitationAction,
} from '../actions';
import { accessesText, expiresText, lastSeenText, liveSessionsOption, ROLE_LABELS, ROLE_TONES, VALIDITY_OPTIONS } from '../lib/copy';
import { SectionError, useAdmin } from './AdminView';
import { OnceSecret } from './OnceSecret';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

type AccountDialog =
  | { kind: 'role'; account: AdminAccountView; role: 'admin' | 'member' }
  | { kind: 'disable'; account: AdminAccountView }
  | { kind: 'delete'; account: AdminAccountView }
  | { kind: 'recovery'; account: AdminAccountView }
  | { kind: 'revoke'; invitation: AdminInvitationView };

/** Administration › Comptes: invitations in progress, then every account. */
export function AccountsTab() {
  const { data } = useAdmin();
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const close = () => setDialog(null);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {data.invitations.ok ? (
        data.invitations.data.length > 0 ? (
          <section aria-labelledby="admin-invitations" className="flex flex-col gap-2">
            <SectionLabel as="h2" id="admin-invitations">{`Invitations en cours · ${data.invitations.data.length}`}</SectionLabel>
            <InvitationsList invitations={data.invitations.data} onRevoke={(invitation) => setDialog({ kind: 'revoke', invitation })} />
          </section>
        ) : null
      ) : (
        <SectionError title="Les invitations n'ont pas pu être lues" message={data.invitations.error.message} />
      )}

      <section aria-labelledby="admin-accounts" className="flex flex-col gap-2">
        {data.accounts.ok ? (
          <>
            <SectionLabel as="h2" id="admin-accounts">{`Comptes · ${data.accounts.data.length}`}</SectionLabel>
            <AccountsList accounts={data.accounts.data} onAction={setDialog} />
          </>
        ) : (
          <SectionError title="Les comptes n'ont pas pu être lus" message={data.accounts.error.message} />
        )}
      </section>

      <RoleDialog dialog={dialog?.kind === 'role' ? dialog : null} onClose={close} />
      <DisableDialog dialog={dialog?.kind === 'disable' ? dialog : null} onClose={close} />
      <DeleteDialog dialog={dialog?.kind === 'delete' ? dialog : null} onClose={close} />
      <RecoveryDialog account={dialog?.kind === 'recovery' ? dialog.account : null} onClose={close} />
      <RevokeDialog invitation={dialog?.kind === 'revoke' ? dialog.invitation : null} onClose={close} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------------------------------

function InvitationsList({ invitations, onRevoke }: { invitations: AdminInvitationView[]; onRevoke: (invitation: AdminInvitationView) => void }) {
  const { data } = useAdmin();
  const status = (item: AdminInvitationView) =>
    item.status === 'activation' ? (
      <Badge tone="warn">Activation en cours</Badge>
    ) : item.status === 'expired' ? (
      <Badge tone="neutral">Expirée</Badge>
    ) : (
      <Badge tone="accent">En attente</Badge>
    );
  const revoke = (item: AdminInvitationView) =>
    item.status === 'activation' ? null : (
      <CompactButton variant="secondaire" onClick={() => onRevoke(item)} aria-label={`Annuler l'invitation de ${item.email}`}>
        Annuler
      </CompactButton>
    );
  const columns: DataTableColumn<AdminInvitationView>[] = [
    { key: 'email', header: 'E-mail', cell: (item) => <span className="truncate font-sans text-app-14 text-text">{item.email}</span> },
    { key: 'role', header: 'Rôle', width: 140, cell: (item) => <Badge tone={ROLE_TONES[item.role]}>{ROLE_LABELS[item.role]}</Badge> },
    { key: 'server', header: 'Serveur', width: 140, hideBelowLg: true, cell: (item) => <span className="font-sans text-app-13 text-muted">{item.server?.name ?? 'Aucun'}</span> },
    { key: 'expires', header: 'Validité', width: 190, cell: (item) => <span className="font-sans text-app-13 text-muted">{expiresText(item.expiresAt, data.now)}</span> },
    { key: 'status', header: 'État', width: 160, cell: status },
    { key: 'action', header: 'Action', width: 120, align: 'right', cell: revoke },
  ];
  return (
    <>
      <DataTable className="hidden nav:block" caption="Invitations en cours" columns={columns} rows={invitations} getRowKey={(item) => item.id} />
      <ul className="m-0 flex list-none flex-col gap-2 p-0 nav:hidden">
        {invitations.map((item) => (
          <Card key={item.id} as="li" variant="card" padding="md" className="flex flex-col gap-2">
            <p className="m-0 truncate font-sans text-app-15 text-text">{item.email}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={ROLE_TONES[item.role]}>{ROLE_LABELS[item.role]}</Badge>
              {status(item)}
            </div>
            <p className="m-0 font-sans text-app-12 text-muted">
              {item.server ? `Serveur ${item.server.name} · ` : ''}
              {expiresText(item.expiresAt, data.now)}
            </p>
            {revoke(item)}
          </Card>
        ))}
      </ul>
    </>
  );
}

function AccountIdentity({ account }: { account: AdminAccountView }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={account.name} size={32} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-sans text-app-14 font-medium text-text">{account.name}</span>
        <span className="truncate font-sans text-app-12 text-muted">{account.email}</span>
      </div>
    </div>
  );
}

function AccountBadges({ account }: { account: AdminAccountView }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={ROLE_TONES[account.role]}>{ROLE_LABELS[account.role]}</Badge>
      {account.isSelf ? <Badge tone="neutral">Vous</Badge> : null}
      {account.disabledAt ? <Badge tone="danger">Désactivé</Badge> : null}
    </div>
  );
}

function AccountMenu({ account, onAction }: { account: AdminAccountView; onAction: (dialog: AccountDialog) => void }) {
  const { refresh } = useAdmin();
  // The owner is never demoted, disabled nor deleted; nobody acts on their own account here.
  if (account.role === 'owner' || account.isSelf) return null;
  async function enable() {
    const result = await enableAccountAction(account.id);
    if (!result.ok) return toast({ message: result.error.message, icon: 'alert' });
    toast({ message: `Compte de ${firstName(account.name)} réactivé` });
    refresh();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more" label={`Actions sur le compte de ${account.name}`} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={260}>
        {account.role === 'member' ? (
          <DropdownMenuItem icon="shield" onSelect={() => onAction({ kind: 'role', account, role: 'admin' })}>
            Nommer administrateur…
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon="shield" onSelect={() => onAction({ kind: 'role', account, role: 'member' })}>
            Retirer le rôle administrateur…
          </DropdownMenuItem>
        )}
        {account.disabledAt ? null : (
          <DropdownMenuItem icon="key" onSelect={() => onAction({ kind: 'recovery', account })}>
            Créer un lien de récupération…
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {account.disabledAt ? (
          <DropdownMenuItem icon="refresh" onSelect={() => void enable()}>
            Réactiver le compte
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon="lock" onSelect={() => onAction({ kind: 'disable', account })}>
            Désactiver le compte…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon="trash" destructive onSelect={() => onAction({ kind: 'delete', account })}>
          Supprimer le compte…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountsList({ accounts, onAction }: { accounts: AdminAccountView[]; onAction: (dialog: AccountDialog) => void }) {
  const { data } = useAdmin();
  const twoFactor = (account: AdminAccountView) =>
    account.twoFactorEnabled ? <Badge tone="success">Activée</Badge> : <Badge tone="warn">À activer</Badge>;
  const columns: DataTableColumn<AdminAccountView>[] = [
    { key: 'account', header: 'Compte', cell: (account) => <AccountIdentity account={account} /> },
    { key: 'role', header: 'Rôle', width: 200, cell: (account) => <AccountBadges account={account} /> },
    { key: '2fa', header: 'Double auth.', width: 120, cell: twoFactor },
    { key: 'server', header: 'Serveur', width: 130, hideBelowLg: true, cell: (account) => <span className="font-sans text-app-13 text-muted">{account.server?.name ?? 'Aucun'}</span> },
    {
      key: 'last',
      header: 'Dernière connexion',
      width: 170,
      hideBelowLg: true,
      cell: (account) => (
        <span className="flex flex-col font-sans text-app-13 text-muted">
          <span>{lastSeenText(account.lastSignInAt, data.now)}</span>
          <span className="text-app-12">{accessesText(account.openAccesses)}</span>
        </span>
      ),
    },
    { key: 'action', header: 'Action', width: 72, align: 'right', cell: (account) => <AccountMenu account={account} onAction={onAction} /> },
  ];
  if (accounts.length === 0) {
    return (
      <EmptyState icon="shield" title="Aucun compte" variant="plain">
        Les comptes apparaissent ici dès qu'une invitation est acceptée.
      </EmptyState>
    );
  }
  return (
    <>
      <DataTable className="hidden nav:block" caption="Comptes de l'instance" columns={columns} rows={accounts} getRowKey={(account) => account.id} />
      <ul className="m-0 flex list-none flex-col gap-2 p-0 nav:hidden">
        {accounts.map((account) => (
          <Card key={account.id} as="li" variant="card" padding="md" className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <AccountIdentity account={account} />
              </div>
              <AccountMenu account={account} onAction={onAction} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <AccountBadges account={account} />
              {twoFactor(account)}
            </div>
            <p className="m-0 font-sans text-app-12 text-muted">
              {`Serveur ${account.server?.name ?? 'aucun'} · dernière connexion ${lastSeenText(account.lastSignInAt, data.now)} · ${accessesText(account.openAccesses)}`}
            </p>
          </Card>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------------------------

function useMutation() {
  const { refresh } = useAdmin();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    reset: () => setError(null),
    /** Runs the action: `{ value }` on success (the page data is read again), null on a refusal (shown in the dialog). */
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

function RoleDialog({ dialog, onClose }: { dialog: { account: AdminAccountView; role: 'admin' | 'member' } | null; onClose: () => void }) {
  const mutation = useMutation();
  const name = dialog ? firstName(dialog.account.name) : '';
  const promote = dialog?.role === 'admin';
  return (
    <ConfirmDialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          mutation.reset();
        }
      }}
      tone="warn"
      icon="shield"
      title={promote ? `Nommer ${name} administrateur ?` : `Retirer le rôle administrateur de ${name} ?`}
      consequences={
        promote
          ? [
              { kind: 'risk', text: `${name} pourra inviter, désactiver et supprimer des comptes, et gérer les serveurs.` },
              { kind: 'kept', text: 'Les projets et sessions des autres comptes lui restent invisibles.' },
            ]
          : [
              { kind: 'risk', text: `${name} n'aura plus accès à l'administration.` },
              { kind: 'kept', text: 'Son espace, ses projets et son serveur restent intacts.' },
            ]
      }
      confirmLabel={promote ? 'Nommer administrateur' : 'Retirer le rôle'}
      error={mutation.error}
      onConfirm={async () => {
        if (!dialog) return;
        if (await mutation.run(() => changeRoleAction(dialog.account.id, dialog.role))) {
          onClose();
          toast({ message: promote ? `${name} est administrateur` : `${name} est membre` });
        }
      }}
    />
  );
}

function DisableDialog({ dialog, onClose }: { dialog: { account: AdminAccountView } | null; onClose: () => void }) {
  const mutation = useMutation();
  const [stopSessions, setStopSessions] = useState(true);
  const account = dialog?.account ?? null;
  const name = account ? firstName(account.name) : '';
  return (
    <ConfirmDialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setStopSessions(true);
          mutation.reset();
        }
      }}
      tone="warn"
      icon="lock"
      title={`Désactiver le compte de ${name} ?`}
      consequences={[
        { kind: 'risk', text: `${name} ne peut plus se connecter : ses accès ouverts sont fermés tout de suite.` },
        { kind: 'risk', text: account?.server ? `Son serveur ${account.server.name} est suspendu : il n'accepte plus de nouveau travail.` : "Ses appareils ne reçoivent plus ses notifications." },
        { kind: 'kept', text: 'Ses projets et son serveur restent intacts : réactiver le compte lui rend tout.' },
      ]}
      confirmLabel="Désactiver le compte"
      error={mutation.error}
      onConfirm={async () => {
        if (!account) return;
        const done = await mutation.run(() => disableAccountAction(account.id, stopSessions));
        if (!done) return;
        onClose();
        // Checked again by default for the next account (closing programmatically skips onOpenChange).
        setStopSessions(true);
        const failed = done.value.failedSessions;
        toast({
          message: failed > 0 ? `Compte de ${name} désactivé · ${plural(failed, 'session non arrêtée', 'sessions non arrêtées')}` : `Compte de ${name} désactivé`,
        });
      }}
    >
      {account?.server ? (
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox id="admin-disable-stop-sessions" checked={stopSessions} onCheckedChange={setStopSessions} />
          <label htmlFor="admin-disable-stop-sessions" className="cursor-pointer font-sans text-app-14 text-text">
            {liveSessionsOption(account.liveSessions)}
          </label>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

function DeleteDialog({ dialog, onClose }: { dialog: { account: AdminAccountView } | null; onClose: () => void }) {
  const mutation = useMutation();
  const account = dialog?.account ?? null;
  const name = account ? firstName(account.name) : '';
  return (
    <ConfirmDialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          mutation.reset();
        }
      }}
      tone="danger"
      icon="trash"
      title={`Supprimer le compte de ${name} ?`}
      consequences={[
        { kind: 'risk', text: 'Le compte est anonymisé, son espace archivé et son serveur retiré : rien ne peut être rouvert.' },
        { kind: 'kept', text: 'Les dépôts GitHub ne sont jamais touchés.' },
        { kind: 'kept', text: "Le journal garde l'historique de ses actions." },
      ]}
      typedConfirmation={account ? { expected: account.email, label: `Tapez ${account.email} pour confirmer` } : undefined}
      confirmDisabled={account && !account.disabledAt ? "Désactivez d'abord le compte." : undefined}
      confirmLabel="Supprimer le compte"
      error={mutation.error}
      onConfirm={async () => {
        if (!account) return;
        if (await mutation.run(() => deleteAccountAction(account.id))) {
          onClose();
          toast({ message: `Compte de ${name} supprimé` });
        }
      }}
    />
  );
}

function RevokeDialog({ invitation, onClose }: { invitation: AdminInvitationView | null; onClose: () => void }) {
  const mutation = useMutation();
  return (
    <ConfirmDialog
      open={invitation !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          mutation.reset();
        }
      }}
      tone="warn"
      icon="x"
      title={`Annuler l'invitation de ${invitation?.email ?? ''} ?`}
      consequences={[
        { kind: 'risk', text: 'Le lien transmis ne fonctionnera plus.' },
        { kind: 'kept', text: 'Vous pourrez inviter de nouveau cette adresse.' },
      ]}
      confirmLabel="Annuler l'invitation"
      cancelLabel="Garder"
      error={mutation.error}
      onConfirm={async () => {
        if (!invitation) return;
        if (await mutation.run(() => revokeInvitationAction(invitation.id))) {
          onClose();
          toast({ message: 'Invitation annulée' });
        }
      }}
    />
  );
}

function RecoveryDialog({ account, onClose }: { account: AdminAccountView | null; onClose: () => void }) {
  const { data, refresh } = useAdmin();
  const [password, setPassword] = useState('');
  const [removePasskeys, setRemovePasskeys] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<RecoveryLinkView | null>(null);
  const name = account ? firstName(account.name) : '';

  function close(open: boolean) {
    if (open) return;
    setPassword('');
    setRemovePasskeys(false);
    setError(null);
    setLink(null);
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account) return;
    if (!password) return setError('Saisissez votre mot de passe.');
    setBusy(true);
    const result = await recoveryLinkAction(account.id, password, removePasskeys);
    setBusy(false);
    setPassword('');
    if (!result.ok) return setError(result.error.message);
    setLink(result.data);
    refresh();
  }

  return (
    <Dialog open={account !== null} onOpenChange={close}>
      <DialogContent
        size="sm"
        title={link ? 'Lien de récupération créé' : `Créer un lien de récupération pour ${name} ?`}
        description={
          link
            ? `Transmettez-le à ${name} seul, par un canal de confiance. Ce lien ne sera plus affiché.`
            : `Ses accès ouverts, ses appareils approuvés et sa double authentification sont fermés tout de suite. Le lien permet de choisir un nouveau mot de passe et de réactiver la double authentification. Ses projets et ses sessions restent intacts.`
        }
        footer={
          link ? (
            <Button variant="accent" onClick={() => close(false)}>
              Terminé
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => close(false)}>
                Annuler
              </Button>
              <Button variant="accent" type="submit" form="admin-recovery" loading={busy} loadingLabel="Création…">
                Créer le lien
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="flex flex-col gap-3">
            <OnceSecret label="Lien de récupération" value={link.url} copyLabel="Copier le lien" />
            <p className="m-0 font-sans text-app-12 text-muted">{`Il ${expiresText(link.expiresAt, data.now)}.`}</p>
          </div>
        ) : (
          <form id="admin-recovery" onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <Field label="Votre mot de passe" hint="Confirmez qu'il s'agit bien de vous avant de reprendre l'accès d'un autre compte." error={error ?? undefined}>
              <SecretField value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" revealable={false} mono={false} />
            </Field>
            <div className="flex min-h-11 items-center gap-3">
              <Checkbox id="admin-recovery-passkeys" checked={removePasskeys} onCheckedChange={setRemovePasskeys} />
              <label htmlFor="admin-recovery-passkeys" className="cursor-pointer font-sans text-app-14 text-text">
                Supprimer aussi ses clés d'accès (appareil perdu)
              </label>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Inviter un compte
// ---------------------------------------------------------------------------------------------

export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data, refresh } = useAdmin();
  const defaultValidity = String(data.instance.ok ? data.instance.data.settings.invitationTtlHours : 48);
  const validityOptions = VALIDITY_OPTIONS.some((option) => option.value === defaultValidity)
    ? [...VALIDITY_OPTIONS]
    : [{ value: defaultValidity, label: `${defaultValidity} h` }, ...VALIDITY_OPTIONS];
  const freeServers = data.servers.ok ? data.servers.data.filter((server) => server.status === 'pending') : [];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [server, setServer] = useState('');
  const [validity, setValidity] = useState(defaultValidity);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  function change(next: boolean) {
    if (!next) {
      setEmail('');
      setRole('member');
      setServer('');
      setValidity(defaultValidity);
      setError(null);
      setCreated(null);
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await inviteAccountAction({ email, role, environmentId: server || null, validityHours: Number(validity) });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setCreated(result.data);
    refresh();
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        size="sm"
        title={created ? "Lien d'invitation créé" : 'Inviter un compte'}
        description={
          created
            ? `Transmettez ce lien à ${created.email}, par un canal de confiance. Ce lien ne sera plus affiché.`
            : "Le lien est à usage unique. Nuera Dev n'envoie aucun e-mail : transmettez-le vous-même, par un canal de confiance."
        }
        footer={
          created ? (
            <Button variant="accent" onClick={() => change(false)}>
              Terminé
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => change(false)}>
                Annuler
              </Button>
              <Button variant="accent" type="submit" form="admin-invite" loading={busy} loadingLabel="Création…">
                Créer le lien
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="flex flex-col gap-3">
            <OnceSecret label="Lien d'invitation" value={created.url} copyLabel="Copier le lien" />
            <p className="m-0 font-sans text-app-12 text-muted">{`Il expire le ${formatDateTimeShort(created.expiresAt, data.now)}.`}</p>
          </div>
        ) : (
          <form id="admin-invite" onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {error ? (
              <p role="alert" className="m-0 font-sans text-app-13 text-danger">
                {error.detail ? `${error.message} ${error.detail}` : error.message}
              </p>
            ) : null}
            <Field label="E-mail">
              <Input type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} required />
            </Field>
            <Field label="Rôle" hint={role === 'admin' ? 'Gère aussi les comptes, les serveurs et le journal de l\'instance.' : 'Ses projets, ses sessions, son serveur.'}>
              <Select
                value={role}
                onValueChange={(value) => setRole(value === 'admin' ? 'admin' : 'member')}
                options={[
                  { value: 'member', label: 'Membre' },
                  { value: 'admin', label: 'Administrateur' },
                ]}
              />
            </Field>
            <Field label="Serveur" hint="Un serveur jamais utilisé, attribué à son espace dès l'acceptation.">
              <Select
                value={server || 'aucun'}
                onValueChange={(value) => setServer(value === 'aucun' ? '' : value)}
                options={[{ value: 'aucun', label: "Aucun pour l'instant" }, ...freeServers.map((item) => ({ value: item.id, label: item.name }))]}
              />
            </Field>
            <Field label="Validité">
              <Select value={validity} onValueChange={setValidity} options={validityOptions} />
            </Field>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
