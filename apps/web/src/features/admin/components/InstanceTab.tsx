'use client';

import { useId, useState, type FormEvent } from 'react';
import { Badge, Banner, Button, Card, Field, Input, Switch, TileHeader, toast } from '@/components/ui';
import { SettingsRow, SettingsRows } from '@/features/settings/components/parts';
import { updateInstanceAction } from '../actions';
import { SectionError, useAdmin } from './AdminView';

type InstanceKey = 'webSessionIdleHours' | 'webSessionMaxDays' | 'invitationTtlHours';

/**
 * Administration › Instance: web accesses (inactivity and maximum duration), accounts (sign-up closed,
 * 2FA mandatory, validity of the invitations) and the forced block of the bypass mode. Written through
 * the instance keys of the settings patch (journal `instance.settings_updated`).
 */
export function InstanceTab() {
  const { data } = useAdmin();
  if (!data.instance.ok) return <SectionError title="Les réglages de l'instance n'ont pas pu être lus" message={data.instance.error.message} />;
  const { settings, warning } = data.instance.data;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {warning ? (
        <Banner tone="warn" icon="server" title={warning}>
          Donnez-lui un accès restreint depuis l'onglet Serveurs (« Restreindre l'accès base »), puis redéployez son runner.
        </Banner>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <NumbersTile
          icon="lock"
          title="Accès web"
          fields={[
            { key: 'webSessionIdleHours', label: "Expiration après inactivité (h)", value: settings.webSessionIdleHours, min: 1, max: 168 },
            { key: 'webSessionMaxDays', label: "Durée maximale d'un accès (jours)", value: settings.webSessionMaxDays, min: 1, max: 90 },
          ]}
          note="S'applique aux accès de tous les comptes, dès leur prochaine requête."
        />
        <div className="flex min-w-0 flex-col gap-5">
          <Card as="section" aria-label="Comptes" className="gap-2">
            <TileHeader icon="shield" title="Comptes" />
            <SettingsRows>
              <SettingsRow title="Inscription" caption="Sur invitation uniquement" control={<Badge tone="neutral">Fermée</Badge>} />
              <SettingsRow title="Double authentification" caption="Obligatoire pour tous les comptes" control={<Badge tone="success">Exigée</Badge>} />
            </SettingsRows>
            <NumbersForm
              fields={[{ key: 'invitationTtlHours', label: 'Validité des invitations (h)', value: settings.invitationTtlHours, min: 1, max: 168 }]}
            />
          </Card>
          <GuardTile forced={settings.forceBlockBypassPermissions} />
        </div>
      </div>
    </div>
  );
}

interface NumberField {
  key: InstanceKey;
  label: string;
  value: number;
  min: number;
  max: number;
}

function NumbersTile({ icon, title, fields, note }: { icon: 'lock'; title: string; fields: NumberField[]; note: string }) {
  return (
    <Card as="section" aria-label={title} className="gap-2">
      <TileHeader icon={icon} title={title} />
      <NumbersForm fields={fields} />
      <p className="m-0 font-sans text-app-12 text-muted">{note}</p>
    </Card>
  );
}

function NumbersForm({ fields }: { fields: NumberField[] }) {
  const { refresh } = useAdmin();
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((field) => [field.key, String(field.value)])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = fields.filter((field) => values[field.key] !== String(field.value));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const patch: Record<string, number> = {};
    for (const field of changed) {
      const value = Number(values[field.key]);
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        return setError(`${field.label} : entre ${field.min} et ${field.max}.`);
      }
      patch[field.key] = value;
    }
    setBusy(true);
    setError(null);
    const result = await updateInstanceAction(patch);
    setBusy(false);
    if (!result.ok) return setError(result.error.detail ? `${result.error.message} ${result.error.detail}` : result.error.message);
    toast({ message: "Réglages de l'instance enregistrés" });
    refresh();
  }

  return (
    <form id={formId} onSubmit={submit} className="flex flex-col gap-3" noValidate>
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          <Input
            type="number"
            inputMode="numeric"
            min={field.min}
            max={field.max}
            value={values[field.key] ?? ''}
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            shellClassName="max-w-40"
          />
        </Field>
      ))}
      {error ? (
        <p role="alert" className="m-0 font-sans text-app-12 text-danger">
          {error}
        </p>
      ) : null}
      {changed.length > 0 ? (
        <Button variant="accent" type="submit" loading={busy} loadingLabel="Enregistrement…" className="self-start">
          Enregistrer
        </Button>
      ) : null}
    </form>
  );
}

function GuardTile({ forced }: { forced: boolean }) {
  const { refresh } = useAdmin();
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const result = await updateInstanceAction({ forceBlockBypassPermissions: next });
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    toast({ message: next ? 'Mode sans autorisation bloqué pour tous les comptes' : 'Blocage imposé levé' });
    refresh();
  }

  return (
    <Card as="section" aria-label="Garde-fous" className="gap-2">
      <TileHeader icon="shield" title="Garde-fous" />
      <SettingsRows>
        <SettingsRow
          titleId={labelId}
          title="Bloquer le mode sans autorisation pour tous les comptes"
          caption="Chaque espace peut déjà le bloquer pour lui-même ; ce réglage l'impose à tous."
          control={<Switch checked={forced} disabled={busy} onCheckedChange={(next) => void toggle(next)} aria-labelledby={labelId} />}
        />
      </SettingsRows>
      {error ? (
        <p role="alert" className="m-0 font-sans text-app-12 text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
