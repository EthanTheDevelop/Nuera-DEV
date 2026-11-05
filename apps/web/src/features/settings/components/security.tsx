'use client';

import { useId, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';
import {
  Avatar,
  Badge,
  Banner,
  Card,
  CompactButton,
  ConfirmDialog,
  Dialog,
  DialogContent,
  ErrorPanel,
  Field,
  Input,
  LinkButton,
  SecretField,
  SectionLabel,
  TileHeader,
  toast,
} from '@/components/ui';
import { authClient, passkeyErrorMessage, passkeysSupported } from '@/lib/auth-client';
import { formatShortDate, plural } from '@nuera/shared/format';
import { PASSWORD_RULES_TEXT } from '@/server/auth/password-policy';
import {
  changePasswordAction,
  deletePasskeyAction,
  loadJournalAction,
  loadPasskeysAction,
  reauthenticateAction,
  regenerateBackupCodesAction,
  renamePasskeyAction,
  revokeOtherSessionsAction,
  revokeWebSessionAction,
} from '../actions';
import { accessPolicyText, backupCodesText, formatJournalDate, twoFactorCaption, webSessionCaption } from '../lib/copy';
import { SECTION_IDS } from '../lib/tabs';
import type { JournalEntry, JournalPage, PasskeyView, WebSessionView } from '../lib/types';
import { InfoBox, SettingsRow, SettingsRows } from './parts';
import { useSettings } from './SettingsContext';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const DEVICE_ICON = { desktop: 'monitor', phone: 'smartphone', tablet: 'smartphone', unknown: 'monitor' } as const;

function useRevoke() {
  const { refresh } = useSettings();
  const [target, setTarget] = useState<WebSessionView | 'others' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [othersCount, setOthersCount] = useState(0);
  const dialog = (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      tone="warn"
      icon="lock"
      title={
        target === 'others'
          ? `Fermer ${othersCount > 1 ? `les ${othersCount} autres accès` : "l'autre accès"} ?`
          : target
            ? `Révoquer l'accès « ${target.deviceLabel} » ?`
            : ''
      }
      consequences={[
        {
          kind: 'risk',
          text:
            target === 'others'
              ? 'Chaque autre appareil devra se reconnecter avec le mot de passe et le code.'
              : 'Cet appareil devra se reconnecter avec le mot de passe et le code.',
        },
        { kind: 'kept', text: 'Cet appareil reste connecté.' },
        { kind: 'kept', text: 'Les sessions Claude continuent sur le serveur.' },
      ]}
      confirmLabel={target === 'others' ? `Fermer ${plural(othersCount, 'accès', 'accès')}` : 'Révoquer'}
      error={error}
      onConfirm={async () => {
        setError(null);
        if (target === 'others') {
          const result = await revokeOtherSessionsAction();
          if (!result.ok) return setError(result.error.message);
          setTarget(null);
          toast({ message: result.data.revoked === 1 ? '1 autre accès fermé' : `${result.data.revoked} autres accès fermés` });
        } else if (target) {
          const result = await revokeWebSessionAction(target.id);
          if (!result.ok) return setError(result.error.message);
          setTarget(null);
          toast({ message: `Accès révoqué : ${target.deviceLabel}` });
        }
        refresh();
      }}
    />
  );
  return {
    dialog,
    revoke: (session: WebSessionView) => {
      setError(null);
      setTarget(session);
    },
    revokeOthers: (count: number) => {
      setError(null);
      setOthersCount(count);
      setTarget('others');
    },
  };
}

function DeviceRow({ session, onRevoke }: { session: WebSessionView; onRevoke: () => void }) {
  const { now, settings } = useSettings();
  return (
    <SettingsRow
      icon={DEVICE_ICON[session.deviceKind]}
      title={session.deviceLabel}
      caption={webSessionCaption(session, now, settings.webSessionIdleHours)}
      control={
        session.current ? (
          <Badge tone="accent">Cet appareil</Badge>
        ) : (
          <CompactButton variant="discret" onClick={onRevoke} aria-label={`Révoquer ${session.deviceLabel}`}>
            Révoquer
          </CompactButton>
        )
      }
    />
  );
}

function JournalLines({ items, limit }: { items: JournalEntry[]; limit?: number }) {
  const { now } = useSettings();
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) return <p className="m-0 font-sans text-app-12 text-muted">Aucun événement pour le moment.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-[3px] p-0">
      {shown.map((item) => (
        <li key={item.id} className="font-mono text-app-11 leading-[18px] break-words text-text">
          {formatJournalDate(item.at, now)} · {item.summary}
        </li>
      ))}
    </ul>
  );
}

/** D08 `Tuile · Compte et sécurité`. */
export function SecurityTile({ onShowJournal, onShowAccess }: { onShowJournal: () => void; onShowAccess: () => void }) {
  const { data, settings, refresh } = useSettings();
  const revoke = useRevoke();
  const journalTitle = useId();
  const account = data.account;
  return (
    <Card as="section" aria-labelledby={`${journalTitle}-tuile`} className="gap-1">
      <TileHeader icon="shield" title={<span id={`${journalTitle}-tuile`}>Compte et sécurité</span>} />
      {account.ok ? (
        <>
          <SettingsRows>
            <SettingsRow
              className="last:border-b"
              title="Double facteur"
              caption={twoFactorCaption(account.data.twoFactor.backupCodesRemaining)}
              control={account.data.twoFactor.enabled ? <Badge tone="success">Actif</Badge> : <Badge tone="danger">Inactif</Badge>}
            />
          </SettingsRows>
          <SectionLabel className="pt-1">Accès ouverts</SectionLabel>
          <SettingsRows label="Accès ouverts">
            {account.data.sessions.slice(0, 3).map((session) => (
              <DeviceRow key={session.id} session={session} onRevoke={() => revoke.revoke(session)} />
            ))}
          </SettingsRows>
          {account.data.sessions.length > 3 ? (
            <LinkButton size={13} onClick={onShowAccess} className="self-start">
              {`Voir les ${account.data.sessions.length} accès`}
            </LinkButton>
          ) : null}
        </>
      ) : (
        <ErrorPanel title="Le compte n'a pas pu être lu" excerpt={account.error.message} untouched="Aucun accès n'a été modifié." onRetry={refresh} retryLabel="Réessayer" />
      )}
      <p className="m-0 pt-1 pb-2 font-sans text-app-12 text-muted">{accessPolicyText(settings.webSessionIdleHours, settings.webSessionMaxDays)}</p>
      <InfoBox labelledBy={journalTitle}>
        <div className="flex items-center gap-2">
          <Icon name="history" size={14} className="text-muted" />
          <h3 id={journalTitle} className="m-0 flex-1 font-mono text-app-11 font-normal tracking-label text-muted uppercase">
            Journal de sécurité
          </h3>
          <LinkButton size={13} onClick={onShowJournal} className="text-app-12">
            Tout voir
          </LinkButton>
        </div>
        {data.journal.ok ? (
          <JournalLines items={data.journal.data.items} limit={3} />
        ) : (
          <p className="m-0 font-sans text-app-12 text-danger">Journal illisible : {data.journal.error.message}</p>
        )}
      </InfoBox>
      {revoke.dialog}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Onglet « Compte et sécurité »
// ---------------------------------------------------------------------------------------------

export function SecurityTab() {
  const { data } = useSettings();
  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <IdentityTile />
        <TwoFactorTile />
        <PasskeysTile />
        <PasswordTile />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <AccessTile />
        <JournalTile initial={data.journal} />
      </div>
    </div>
  );
}

function IdentityTile() {
  const { data } = useSettings();
  const twoFactor = data.account.ok ? data.account.data.twoFactor.enabled : null;
  return (
    <Card as="section" aria-label="Propriétaire" className="gap-3">
      <TileHeader icon="lock" title="Propriétaire" />
      <div className="flex items-center gap-3">
        <Avatar name={data.owner.name} size={40} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 truncate font-sans text-app-15 font-semibold text-text">{data.owner.name}</p>
          <p className="m-0 truncate font-sans text-app-13 text-muted">{data.owner.email}</p>
        </div>
      </div>
      <p className="m-0 font-sans text-app-12 text-muted">
        {twoFactor === false ? 'Propriétaire · double facteur inactif' : 'Propriétaire · double facteur actif'} · un seul propriétaire, aucun
        autre compte.
      </p>
    </Card>
  );
}

function TwoFactorTile() {
  const { data, refresh } = useSettings();
  const [open, setOpen] = useState(false);
  const account = data.account;
  return (
    <Card as="section" id={SECTION_IDS.twoFactor} aria-label="Double facteur" className="scroll-mt-6 gap-2">
      <TileHeader icon="shield" title="Double facteur" />
      {account.ok ? (
        <SettingsRows>
          <SettingsRow
            title="Application d'authentification"
            caption={capitalize(backupCodesText(account.data.twoFactor.backupCodesRemaining) ?? 'codes de secours illisibles')}
            control={account.data.twoFactor.enabled ? <Badge tone="success">Actif</Badge> : <Badge tone="danger">Inactif</Badge>}
          />
        </SettingsRows>
      ) : (
        <p className="m-0 font-sans text-app-13 text-danger">{account.error.message}</p>
      )}
      <p className="m-0 font-sans text-app-12 text-muted">
        Un code de secours remplace le code de l'application une seule fois. En générer de nouveaux invalide les anciens.
      </p>
      <CompactButton variant="secondaire" icon="refresh" className="self-start" onClick={() => setOpen(true)}>
        Régénérer les codes de secours
      </CompactButton>
      <BackupCodesDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) refresh();
        }}
        account={data.owner.email}
      />
    </Card>
  );
}

function BackupCodesDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (open: boolean) => void; account: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [feedback, setFeedback] = useState('');

  function reset(next: boolean) {
    if (!next) {
      setPassword('');
      setError(null);
      setCodes(null);
      setFeedback('');
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) return setError('Mot de passe requis.');
    setBusy(true);
    const result = await regenerateBackupCodesAction(password);
    setBusy(false);
    setPassword('');
    if (!result.ok) return setError(result.error.message);
    setCodes(result.data.codes);
    toast({ message: 'Codes de secours régénérés' });
  }

  async function copy() {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setFeedback('Codes copiés.');
    } catch {
      setFeedback('Copie impossible : sélectionnez les codes.');
    }
  }

  function download() {
    if (!codes) return;
    const text = ['Nuera Dev — codes de secours', `Compte : ${account}`, "Chaque code ne sert qu'une fois.", '', ...codes, ''].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nuera-dev-codes-de-secours.txt';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setFeedback('Fichier téléchargé.');
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent
        size="sm"
        title={codes ? 'Nouveaux codes de secours' : 'Régénérer les codes de secours'}
        description={
          codes
            ? "Ils ne s'afficheront plus : conservez-les maintenant, hors de cet appareil. Les anciens codes ne fonctionnent plus."
            : 'Confirmez avec votre mot de passe. Les codes actuels cesseront de fonctionner.'
        }
        footer={
          codes ? (
            <CompactButton variant="principal" onClick={() => reset(false)}>
              J'ai conservé mes codes
            </CompactButton>
          ) : (
            <>
              <CompactButton variant="secondaire" onClick={() => reset(false)}>
                Annuler
              </CompactButton>
              <CompactButton variant="principal" type="submit" form="nu-backup-codes" loading={busy}>
                Régénérer
              </CompactButton>
            </>
          )
        }
      >
        {codes ? (
          <div className="flex flex-col gap-3">
            <ul aria-label={`${codes.length} codes de secours`} data-testid="backup-codes" className="m-0 grid list-none grid-cols-2 gap-2 rounded-md border border-border p-4 select-all">
              {codes.map((code) => (
                <li key={code} className="font-mono text-app-13 leading-5 font-medium tracking-label text-text">
                  {code}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <CompactButton variant="secondaire" onClick={copy}>
                Copier les codes
              </CompactButton>
              <CompactButton variant="secondaire" icon="file" onClick={download}>
                Télécharger (.txt)
              </CompactButton>
              <span role="status" className="font-sans text-app-12 text-muted">
                {feedback}
              </span>
            </div>
          </div>
        ) : (
          <form id="nu-backup-codes" onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Mot de passe" error={error}>
              <SecretField autoComplete="current-password" autoFocus value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} />
            </Field>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PasskeysTile() {
  const { data } = useSettings();
  const initial = data.account.ok ? data.account.data.passkeys : [];
  const [passkeys, setPasskeys] = useState<PasskeyView[]>(initial);
  const [snapshot, setSnapshot] = useState(data.account);
  if (snapshot !== data.account) {
    setSnapshot(data.account);
    if (data.account.ok) setPasskeys(data.account.data.passkeys);
  }
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<{ message: string; stale: boolean } | null>(null);
  const [renaming, setRenaming] = useState<PasskeyView | null>(null);
  const [deleting, setDeleting] = useState<PasskeyView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const suggestedName = data.account.ok ? (data.account.data.sessions.find((s) => s.current)?.deviceLabel ?? 'Cet appareil') : 'Cet appareil';
  const [supported] = useState(() => (typeof window === 'undefined' ? true : passkeysSupported()));

  async function add() {
    setAdding(true);
    setAddError(null);
    const { error } = await authClient.passkey.addPasskey({ name: suggestedName });
    setAdding(false);
    if (error) {
      setAddError({ message: passkeyErrorMessage(error), stale: 'code' in error && error.code === 'SESSION_NOT_FRESH' });
      return;
    }
    toast({ message: `Clé d'accès enregistrée : ${suggestedName}` });
    const list = await loadPasskeysAction();
    if (list.ok) setPasskeys(list.data);
  }

  return (
    <Card as="section" id={SECTION_IDS.passkeys} aria-label="Clés d'accès" className="scroll-mt-6 gap-2">
      <TileHeader icon="key" title="Clés d'accès" />
      <p className="m-0 font-sans text-app-12 text-muted">
        Face ID, Touch ID, Windows Hello ou une clé de sécurité remplacent le mot de passe et le code en une seule étape.
      </p>
      {passkeys.length === 0 ? (
        <p className="m-0 rounded-md border border-dashed border-border px-3.5 py-3 font-sans text-app-13 text-muted">
          Aucune clé d'accès : la connexion se fait par mot de passe et code.
        </p>
      ) : (
        <SettingsRows label="Clés d'accès enregistrées">
          {passkeys.map((key) => (
            <SettingsRow
              key={key.id}
              icon="key"
              title={key.name ?? "Clé d'accès sans nom"}
              caption={[key.provider, key.createdAt ? `ajoutée le ${formatShortDate(key.createdAt)}` : null, key.backedUp ? 'synchronisée' : 'sur cet appareil seulement']
                .filter(Boolean)
                .join(' · ')}
              control={
                <>
                  <CompactButton variant="discret" onClick={() => setRenaming(key)} aria-label={`Renommer ${key.name ?? "la clé d'accès"}`}>
                    Renommer
                  </CompactButton>
                  <CompactButton variant="discret" onClick={() => { setDeleteError(null); setDeleting(key); }} aria-label={`Supprimer ${key.name ?? "la clé d'accès"}`}>
                    Supprimer
                  </CompactButton>
                </>
              }
            />
          ))}
        </SettingsRows>
      )}
      {addError ? (
        <Banner
          tone="danger"
          title={addError.message}
          action={
            addError.stale ? (
              <form action={reauthenticateAction}>
                <CompactButton type="submit" variant="secondaire">
                  Se reconnecter
                </CompactButton>
              </form>
            ) : undefined
          }
        >
          {addError.stale ? 'Une clé ne s\'ajoute que dans l\'heure qui suit une connexion.' : undefined}
        </Banner>
      ) : null}
      {supported ? (
        <CompactButton variant="secondaire" icon="plus" className="self-start" onClick={add} loading={adding}>
          {adding ? "En attente de l'appareil…" : "Ajouter une clé d'accès"}
        </CompactButton>
      ) : (
        <p className="m-0 font-sans text-app-12 text-muted">Ce navigateur ne prend pas en charge les clés d'accès.</p>
      )}
      <RenamePasskeyDialog
        passkey={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={(list) => {
          setPasskeys(list);
          setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        tone="danger"
        icon="trash"
        title={`Supprimer la clé « ${deleting?.name ?? "sans nom"} » ?`}
        consequences={[
          { kind: 'risk', text: 'Elle ne permettra plus de se connecter à Nuera Dev.' },
          { kind: 'kept', text: "Le mot de passe, le code et les autres clés d'accès restent valables." },
        ]}
        confirmLabel="Supprimer la clé"
        error={deleteError}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await deletePasskeyAction(deleting.id);
          if (!result.ok) return setDeleteError(result.error.message);
          setPasskeys(result.data);
          toast({ message: `Clé d'accès supprimée : ${deleting.name ?? 'sans nom'}` });
          setDeleting(null);
        }}
      />
    </Card>
  );
}

function RenamePasskeyDialog({ passkey, onClose, onRenamed }: { passkey: PasskeyView | null; onClose: () => void; onRenamed: (list: PasskeyView[]) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forId, setForId] = useState<string | null>(null);
  if (passkey && passkey.id !== forId) {
    setForId(passkey.id);
    setName(passkey.name ?? '');
    setError(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!passkey) return;
    setBusy(true);
    const result = await renamePasskeyAction(passkey.id, name);
    setBusy(false);
    if (!result.ok) return setError(result.error.detail ?? result.error.message);
    toast({ message: `Clé d'accès renommée : ${name.trim()}` });
    onRenamed(result.data);
  }
  return (
    <Dialog open={passkey !== null} onOpenChange={(open) => { if (!open) { setForId(null); onClose(); } }}>
      <DialogContent
        size="sm"
        title="Renommer la clé d'accès"
        footer={
          <>
            <CompactButton variant="secondaire" onClick={onClose}>
              Annuler
            </CompactButton>
            <CompactButton variant="principal" type="submit" form="nu-rename-passkey" loading={busy}>
              Renommer
            </CompactButton>
          </>
        }
      >
        <form id="nu-rename-passkey" onSubmit={submit}>
          <Field label="Nom" error={error}>
            <Input autoFocus maxLength={60} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordTile() {
  const [open, setOpen] = useState(false);
  return (
    <Card as="section" id={SECTION_IDS.password} aria-label="Mot de passe" className="scroll-mt-6 gap-2">
      <TileHeader icon="lock" title="Mot de passe" />
      <p className="m-0 font-sans text-app-12 text-muted">{PASSWORD_RULES_TEXT}</p>
      <CompactButton variant="secondaire" icon="edit" className="self-start" onClick={() => setOpen(true)}>
        Changer le mot de passe
      </CompactButton>
      <PasswordDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { refresh } = useSettings();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [closeOthers, setCloseOthers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checkboxId = useId();

  function close(value: boolean) {
    if (!value) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
    }
    onOpenChange(value);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) return setError('Les deux nouveaux mots de passe ne sont pas identiques.');
    setBusy(true);
    const result = await changePasswordAction({ currentPassword: current, newPassword: next, revokeOtherSessions: closeOthers });
    setBusy(false);
    if (!result.ok) return setError(result.error.detail ? `${result.error.message} ${result.error.detail}` : result.error.message);
    toast({ message: closeOthers ? 'Mot de passe changé · autres accès fermés' : 'Mot de passe changé' });
    close(false);
    refresh();
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        size="sm"
        title="Changer le mot de passe"
        description={PASSWORD_RULES_TEXT}
        footer={
          <>
            <CompactButton variant="secondaire" onClick={() => close(false)}>
              Annuler
            </CompactButton>
            <CompactButton variant="principal" type="submit" form="nu-password" loading={busy}>
              Changer le mot de passe
            </CompactButton>
          </>
        }
      >
        <form id="nu-password" onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Mot de passe actuel">
            <SecretField autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="Nouveau mot de passe">
            <SecretField autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirmer le nouveau mot de passe">
            <SecretField autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-center gap-2.5 font-sans text-app-13 text-text">
            <input id={checkboxId} type="checkbox" checked={closeOthers} onChange={(e) => setCloseOthers(e.target.checked)} className="size-[18px] accent-(--accent)" />
            Fermer les autres accès ouverts
          </label>
          {error ? (
            <p role="alert" className="m-0 font-sans text-app-13 text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccessTile() {
  const { data, settings, refresh } = useSettings();
  const revoke = useRevoke();
  const account = data.account;
  const others = account.ok ? account.data.sessions.filter((session) => !session.current).length : 0;
  return (
    <Card as="section" id={SECTION_IDS.sessions} aria-label="Accès ouverts" className="scroll-mt-6 gap-1">
      <TileHeader
        icon="monitor"
        title="Accès ouverts"
        action={account.ok ? <span className="font-mono text-app-12 text-muted">{account.data.sessions.length}</span> : null}
      />
      {account.ok ? (
        <SettingsRows label="Accès ouverts">
          {account.data.sessions.map((session) => (
            <DeviceRow key={session.id} session={session} onRevoke={() => revoke.revoke(session)} />
          ))}
        </SettingsRows>
      ) : (
        <ErrorPanel title="Les accès n'ont pas pu être lus" excerpt={account.error.message} untouched="Aucun accès n'a été modifié." onRetry={refresh} retryLabel="Réessayer" />
      )}
      <p className="m-0 pt-1 pb-2 font-sans text-app-12 text-muted">{accessPolicyText(settings.webSessionIdleHours, settings.webSessionMaxDays)}</p>
      {others > 0 ? (
        <CompactButton variant="secondaire" icon="x" className="self-start" onClick={() => revoke.revokeOthers(others)}>
          Fermer les autres accès
        </CompactButton>
      ) : (
        <p className="m-0 font-sans text-app-12 text-muted">Aucun autre accès ouvert.</p>
      )}
      {revoke.dialog}
    </Card>
  );
}

function JournalTile({ initial }: { initial: ReturnType<typeof useSettings>['data']['journal'] }) {
  const { refresh } = useSettings();
  const [pages, setPages] = useState<JournalPage[]>(initial.ok ? [initial.data] : []);
  const [snapshot, setSnapshot] = useState(initial);
  if (snapshot !== initial) {
    setSnapshot(initial);
    if (initial.ok) setPages([initial.data]);
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = pages.flatMap((page) => page.items);
  const cursor = pages.at(-1)?.nextCursor ?? null;

  async function more() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    const result = await loadJournalAction(cursor);
    setLoading(false);
    if (!result.ok) return setError(result.error.message);
    setPages((current) => [...current, result.data]);
  }

  return (
    <Card as="section" id={SECTION_IDS.journal} aria-label="Journal de sécurité" className="scroll-mt-6 gap-3">
      <TileHeader icon="history" title="Journal de sécurité" />
      {initial.ok ? (
        <JournalLines items={items} />
      ) : (
        <ErrorPanel title="Le journal n'a pas pu être lu" excerpt={initial.error.message} onRetry={refresh} retryLabel="Réessayer" />
      )}
      {error ? <p role="alert" className="m-0 font-sans text-app-12 text-danger">{error}</p> : null}
      {cursor ? (
        <CompactButton variant="secondaire" className="self-start" onClick={more} loading={loading}>
          Afficher les événements précédents
        </CompactButton>
      ) : items.length > 0 ? (
        <p className="m-0 font-sans text-app-12 text-muted">Début du journal.</p>
      ) : null}
    </Card>
  );
}
