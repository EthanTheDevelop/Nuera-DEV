'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { PermissionMode } from '@nuera/db/schema';
import {
  CompactButton,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  Switch,
} from '@/components/ui';
import {
  CLI_DEFAULT,
  effortOptions,
  MODEL_OTHER,
  modelOptions,
  permissionModeLong,
  permissionModeOptions,
} from '../lib/copy';
import type { SettingsValues } from '../lib/types';
import { ADMIN_SET_NOTE, AdminSetNote, InlineError } from './parts';
import { useSettings } from './SettingsContext';

type Patch = Partial<Omit<SettingsValues, 'editable' | 'updatedAt'>>;

/**
 * Controls bound to the scoped settings (save on change + toast, inline error and previous value on
 * failure). A setting this account may not change renders disabled with « Réglé par un
 * administrateur. » (its value stays readable).
 */

/** Effective block of the bypass mode: the space's own, or the one imposed on every space. */
export function bypassBlocked(settings: Pick<SettingsValues, 'blockBypassPermissions' | 'forceBlockBypassPermissions'>): boolean {
  return settings.blockBypassPermissions || settings.forceBlockBypassPermissions;
}

export function ModelSelect({ id, className, size }: { id?: string; className?: string; size?: 'md' | 'lg' }) {
  const { settings, data, save, pending, errorFor, canEdit } = useSettings();
  const [customOpen, setCustomOpen] = useState(false);
  const current = settings.defaultModel;
  const errorId = useId();
  const locked = !canEdit('defaultModel');
  return (
    <>
      <Select
        id={id}
        size={size}
        className={className}
        options={modelOptions(current, data.seenModels)}
        value={current ?? CLI_DEFAULT}
        disabled={locked || pending.has('defaultModel')}
        aria-describedby={errorFor('defaultModel') ? errorId : undefined}
        onValueChange={(value) => {
          if (value === MODEL_OTHER) {
            setCustomOpen(true);
            return;
          }
          const next = value === CLI_DEFAULT ? null : value;
          if (next === current) return;
          void save({ defaultModel: next }, next ? `Modèle par défaut : ${next}` : 'Modèle par défaut : défaut du CLI');
        }}
      />
      <InlineError id={errorId}>{errorFor('defaultModel')}</InlineError>
      {locked ? <AdminSetNote /> : null}
      <CustomModelDialog open={customOpen} onOpenChange={setCustomOpen} initial={current ?? ''} />
    </>
  );
}

const MODEL_PATTERN = /^[A-Za-z0-9._:[\]-]{1,80}$/;

function CustomModelDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (open: boolean) => void; initial: string }) {
  const { save } = useSettings();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const model = value.trim();
    if (!MODEL_PATTERN.test(model)) {
      setError('Lettres, chiffres et . _ : - [ ] uniquement (80 caractères au plus).');
      return;
    }
    setBusy(true);
    const ok = await save({ defaultModel: model }, `Modèle par défaut : ${model}`);
    setBusy(false);
    if (ok) onOpenChange(false);
    else setError("Le modèle n'a pas pu être enregistré.");
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="Autre modèle"
        description="Alias ou identifiant tel que le CLI l'accepte avec --model. Les nouvelles sessions le recevront ; une session en cours garde le sien."
        footer={
          <>
            <CompactButton variant="secondaire" type="button" onClick={() => onOpenChange(false)}>
              Annuler
            </CompactButton>
            <CompactButton variant="principal" type="submit" form="nu-custom-model" loading={busy}>
              Enregistrer
            </CompactButton>
          </>
        }
      >
        <form id="nu-custom-model" onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Modèle" error={error}>
            <Input mono autoFocus autoComplete="off" spellCheck={false} value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} placeholder="claude-opus-4-1" />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PermissionModeSelect({ id, className, size }: { id?: string; className?: string; size?: 'md' | 'lg' }) {
  const { settings, save, pending, errorFor, canEdit } = useSettings();
  const errorId = useId();
  const locked = !canEdit('defaultPermissionMode');
  return (
    <>
      <Select
        id={id}
        size={size}
        className={className}
        options={permissionModeOptions(bypassBlocked(settings))}
        value={settings.defaultPermissionMode}
        disabled={locked || pending.has('defaultPermissionMode')}
        aria-describedby={errorFor('defaultPermissionMode') ? errorId : undefined}
        onValueChange={(value) => {
          const mode = value as PermissionMode;
          if (mode === settings.defaultPermissionMode) return;
          void save({ defaultPermissionMode: mode }, `Mode de permission par défaut : ${permissionModeLong(mode).toLowerCase()}`);
        }}
      />
      <InlineError id={errorId}>{errorFor('defaultPermissionMode')}</InlineError>
      {locked ? <AdminSetNote /> : null}
    </>
  );
}

export function EffortSelect({ id, className }: { id?: string; className?: string }) {
  const { settings, save, pending, errorFor, canEdit } = useSettings();
  const locked = !canEdit('defaultEffort');
  return (
    <>
      <Select
        id={id}
        className={className}
        options={effortOptions(settings.defaultEffort)}
        value={settings.defaultEffort ?? CLI_DEFAULT}
        disabled={locked || pending.has('defaultEffort')}
        onValueChange={(value) => {
          const next = value === CLI_DEFAULT ? null : value;
          if (next === settings.defaultEffort) return;
          void save({ defaultEffort: next }, next ? `Effort par défaut : ${next}` : 'Effort par défaut : défaut du CLI');
        }}
      />
      <InlineError>{errorFor('defaultEffort')}</InlineError>
      {locked ? <AdminSetNote /> : null}
    </>
  );
}

/**
 * « Bloquer le mode sans autorisation »: blocking applies at once (and moves a bypass default back to
 * « Demander avant d'agir »); lifting the block is confirmed first (T8, warn).
 */
export function BlockBypassSwitch({ labelledBy, describedBy }: { labelledBy: string; describedBy?: string }) {
  const { settings, save, pending, canEdit } = useSettings();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Imposed on every space by the administrators: on and disabled (the row says who set it).
  return (
    <>
      <Switch
        checked={bypassBlocked(settings)}
        disabled={!canEdit('blockBypassPermissions') || pending.has('blockBypassPermissions')}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onCheckedChange={(checked) => {
          if (checked) {
            const patch: Patch = { blockBypassPermissions: true };
            if (settings.defaultPermissionMode === 'bypassPermissions') patch.defaultPermissionMode = 'manual';
            void save(patch, 'Mode sans autorisation bloqué');
          } else {
            setError(null);
            setConfirming(true);
          }
        }}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="warn"
        icon="shield"
        title="Lever le blocage du mode sans autorisation ?"
        consequences={[
          { kind: 'risk', text: 'Le mode qui contourne toutes les demandes pourra être choisi pour une nouvelle session.' },
          { kind: 'risk', text: 'Une session dans ce mode modifie et exécute sans jamais vous demander.' },
          { kind: 'kept', text: 'Les sessions en cours gardent leur mode actuel.' },
        ]}
        confirmLabel="Lever le blocage"
        error={error}
        onConfirm={async () => {
          const ok = await save({ blockBypassPermissions: false }, 'Blocage du mode sans autorisation levé');
          if (ok) setConfirming(false);
          else setError("Le réglage n'a pas pu être enregistré.");
        }}
      />
    </>
  );
}

export function BooleanSwitch({
  field,
  labelledBy,
  describedBy,
  onMessage,
  offMessage,
}: {
  field: 'remoteControlByDefault' | 'autoResumeAfterLimit';
  labelledBy: string;
  describedBy?: string;
  onMessage: string;
  offMessage: string;
}) {
  const { settings, save, pending, errorFor, canEdit } = useSettings();
  const locked = !canEdit(field);
  return (
    <span className="flex flex-col items-end gap-1">
      <Switch
        checked={settings[field]}
        disabled={locked || pending.has(field)}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onCheckedChange={(checked) => void save({ [field]: checked }, checked ? onMessage : offMessage)}
      />
      <InlineError>{errorFor(field)}</InlineError>
      {locked ? <AdminSetNote /> : null}
    </span>
  );
}

type NumberField =
  | 'permissionWaitSeconds'
  | 'maxConcurrentSessions'
  | 'webSessionIdleHours'
  | 'webSessionMaxDays'
  | 'invitationTtlHours'
  | 'worktreeStaleDays'
  | 'sessionMemoryLimitMb';

/** Number setting with its unit; « Enregistrer » appears once the value changed. */
export function NumberSetting({
  field,
  label,
  hint,
  unit,
  min,
  max,
  nullable,
  successMessage,
}: {
  field: NumberField;
  label: ReactNode;
  hint?: ReactNode;
  unit: string;
  min: number;
  max: number;
  nullable?: boolean;
  successMessage: (value: number | null) => string;
}) {
  const { settings, save, pending, errorFor, canEdit } = useSettings();
  const locked = !canEdit(field);
  const saved = settings[field];
  const [draft, setDraft] = useState(saved === null ? '' : String(saved));
  const [lastSaved, setLastSaved] = useState(saved);
  if (lastSaved !== saved) {
    setLastSaved(saved);
    setDraft(saved === null ? '' : String(saved));
  }
  const [localError, setLocalError] = useState<string | null>(null);
  const trimmed = draft.trim();
  const value = trimmed === '' ? null : Number(trimmed);
  const dirty = (saved === null ? '' : String(saved)) !== trimmed;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (value === null && !nullable) return setLocalError('Valeur requise.');
    if (value !== null && (!Number.isInteger(value) || value < min || value > max)) {
      return setLocalError(`Nombre entier entre ${min} et ${max} attendu.`);
    }
    setLocalError(null);
    await save({ [field]: value } as Patch, successMessage(value));
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-2">
      <Field label={label} hint={locked ? ADMIN_SET_NOTE : hint} error={localError ?? errorFor(field)}>
        <Input
          disabled={locked}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          placeholder={nullable ? 'aucune limite' : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setLocalError(null);
          }}
          trailing={<span className="shrink-0 font-sans text-app-13 text-muted">{unit}</span>}
        />
      </Field>
      {dirty && !locked ? (
        <div className="flex gap-2">
          <CompactButton type="submit" variant="principal" loading={pending.has(field)}>
            Enregistrer
          </CompactButton>
          <CompactButton type="button" variant="discret" onClick={() => setDraft(saved === null ? '' : String(saved))}>
            Annuler
          </CompactButton>
        </div>
      ) : null}
    </form>
  );
}

type TextField = 'serverName' | 'serverLocation' | 'autoResumeInstruction';

export function TextSetting({
  field,
  label,
  hint,
  maxLength,
  nullable,
  placeholder,
  successMessage,
}: {
  field: TextField;
  label: ReactNode;
  hint?: ReactNode;
  maxLength: number;
  nullable?: boolean;
  /** Shown while empty (the value used when none is saved). */
  placeholder?: string;
  successMessage: (value: string | null) => string;
}) {
  const { settings, save, pending, errorFor, canEdit } = useSettings();
  const locked = !canEdit(field);
  const saved = settings[field] ?? '';
  const [draft, setDraft] = useState(saved);
  const [lastSaved, setLastSaved] = useState(saved);
  if (lastSaved !== saved) {
    setLastSaved(saved);
    setDraft(saved);
  }
  const [localError, setLocalError] = useState<string | null>(null);
  const dirty = draft.trim() !== saved;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value && !nullable) return setLocalError('Nom requis.');
    setLocalError(null);
    await save({ [field]: value === '' ? null : value } as Patch, successMessage(value || null));
  }
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-2">
      <Field label={label} hint={locked ? ADMIN_SET_NOTE : hint} error={localError ?? errorFor(field)}>
        <Input disabled={locked} value={draft} maxLength={maxLength} placeholder={placeholder} onChange={(event) => { setDraft(event.target.value); setLocalError(null); }} />
      </Field>
      {dirty && !locked ? (
        <div className="flex gap-2">
          <CompactButton type="submit" variant="principal" loading={pending.has(field)}>
            Enregistrer
          </CompactButton>
          <CompactButton type="button" variant="discret" onClick={() => setDraft(saved)}>
            Annuler
          </CompactButton>
        </div>
      ) : null}
    </form>
  );
}
