'use client';

import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { CompactButton, IconButton, SectionLabel, Sheet, SheetContent, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ATTACHMENT_COPY } from './attachments';
import { useAttachPickers } from './AttachmentChips';
import { PaletteSearchPanel } from './CommandPalette';
import { ComposerChoiceList } from './ComposerChip';
import type { ComposerToolChip, ComposerTools } from './ComposerToolbar';
import { PALETTE_COPY, type PaletteItem } from './palette';

export const PHONE_OPTIONS_COPY = {
  button: "Options de l'instruction",
  title: "Options de l'instruction",
  back: 'Options',
  attach: 'Joindre',
  session: 'Session',
  insert: 'Insérer',
  paletteHint: "/ commandes et skills · @ fichiers · rien n'est envoyé",
} as const;

type ChipKey = 'model' | 'effort' | 'mode';
type View = 'root' | ChipKey | 'palette';

const CHIP_ICONS: Record<ChipKey, IconName> = { model: 'cpu', effort: 'sparkle', mode: 'shield' };
/** Short row names (the chip's own `title` stays the accessible name and the sub-view title). */
const CHIP_NAMES: Record<ChipKey, string> = { model: 'Modèle', effort: 'Effort', mode: 'Mode' };

export interface PhoneComposerOptionsProps {
  tools: ComposerTools;
  /** Why nothing can be added to the field right now (input suspended): Joindre and « / » show it. */
  blockedReason: string | null;
  /** Inserts a palette item into the field (never sends). */
  onInsert: (item: PaletteItem) => void;
  /** Called before opening (the field's caret is kept for an insertion). */
  onOpen?: () => void;
}

/**
 * Phone composer: one 44 px « Options » button left of the field instead of a row of chips over it (the
 * field kept its width at 360 px). Its sheet gathers « Joindre » (library, camera), the session's model,
 * effort and permission mode with their current values, and the « / » palette; each choice opens in the
 * same sheet. A part the session cannot use now stays listed, disabled, with its reason written.
 */
export function PhoneComposerOptions({ tools, blockedReason, onInsert, onOpen }: PhoneComposerOptionsProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('root');
  const pickers = useAttachPickers(tools.attachments, true);
  const chips = (['model', 'effort', 'mode'] as const).filter((key) => tools[key]);
  const pending = chips.some((key) => tools[key]?.pending);
  const attachReason = blockedReason ?? tools.attachDisabledReason ?? null;

  const openWith = (next: boolean) => {
    if (next) {
      onOpen?.();
      setView('root');
    }
    setOpen(next);
  };
  const close = () => setOpen(false);

  const chip = view === 'model' || view === 'effort' || view === 'mode' ? tools[view] : undefined;
  const title = view === 'palette' ? PALETTE_COPY.title : chip ? chip.title : PHONE_OPTIONS_COPY.title;

  let body: ReactNode;
  if (view === 'palette' && tools.palette) {
    body = (
      <>
        <BackRow onBack={() => setView('root')} />
        <PaletteSearchPanel source={tools.palette} onInsert={onInsert} onDone={close} variant="phone" />
      </>
    );
  } else if (chip) {
    body = (
      <>
        <BackRow onBack={() => setView('root')} />
        {chip.note ? <p className="m-0 px-2 pb-2 font-sans text-app-13 text-muted">{chip.note}</p> : null}
        <ComposerChoiceList
          title={chip.title}
          options={chip.options}
          value={chip.value}
          onChoose={(choice) => {
            close();
            if (choice !== chip.value) chip.onSelect(choice);
          }}
        />
      </>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4 pb-3">
        {tools.attachments ? (
          <section className="flex flex-col gap-0.5" aria-label={PHONE_OPTIONS_COPY.attach}>
            <SectionLabel className="px-2 pb-1">{PHONE_OPTIONS_COPY.attach}</SectionLabel>
            <OptionRow
              icon="file"
              label={ATTACHMENT_COPY.library}
              disabledReason={attachReason}
              onClick={() => {
                close();
                pickers.openLibrary();
              }}
            />
            <OptionRow
              icon="camera"
              label={ATTACHMENT_COPY.camera}
              disabledReason={attachReason}
              onClick={() => {
                close();
                pickers.openCamera();
              }}
            />
          </section>
        ) : null}
        {chips.length > 0 ? (
          <section className="flex flex-col gap-0.5" aria-label={PHONE_OPTIONS_COPY.session}>
            <SectionLabel className="px-2 pb-1">{PHONE_OPTIONS_COPY.session}</SectionLabel>
            {chips.map((key) => (
              <ChipRow key={key} name={CHIP_NAMES[key]} icon={CHIP_ICONS[key]} chip={tools[key]!} onOpen={() => setView(key)} />
            ))}
          </section>
        ) : null}
        {tools.palette ? (
          <section className="flex flex-col gap-0.5" aria-label={PHONE_OPTIONS_COPY.insert}>
            <SectionLabel className="px-2 pb-1">{PHONE_OPTIONS_COPY.insert}</SectionLabel>
            <OptionRow
              glyph="/"
              label={PALETTE_COPY.button}
              hint={PHONE_OPTIONS_COPY.paletteHint}
              disabledReason={blockedReason}
              chevron
              onClick={() => setView('palette')}
            />
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {pickers.inputs}
      <Sheet open={open} onOpenChange={openWith}>
        <IconButton
          icon="reglages"
          label={PHONE_OPTIONS_COPY.button}
          size="md"
          iconSize={20}
          iconClassName={pending ? 'text-accent' : 'text-muted'}
          aria-haspopup="dialog"
          aria-busy={pending || undefined}
          data-composer-options
          onClick={() => openWith(true)}
          className="shrink-0"
        />
        <SheetContent title={title}>{body}</SheetContent>
      </Sheet>
    </>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <CompactButton variant="discret" size="lg" icon="arrow-left" onClick={onBack} className="-ml-2 mb-1 self-start">
      {PHONE_OPTIONS_COPY.back}
    </CompactButton>
  );
}

const rowClasses =
  'flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-hover active:bg-pressed aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent';

function OptionRow({
  icon,
  glyph,
  label,
  hint,
  value,
  disabledReason,
  pending,
  chevron,
  ariaLabel,
  onClick,
}: {
  icon?: IconName;
  /** Text glyph instead of an icon (« / »). */
  glyph?: string;
  label: string;
  hint?: string;
  /** Current value, on the right. */
  value?: string;
  disabledReason?: string | null;
  pending?: boolean;
  chevron?: boolean;
  ariaLabel?: string;
  onClick: () => void;
}) {
  const blocked = Boolean(disabledReason) || Boolean(pending);
  const reason = disabledReason ?? (pending ? 'Changement en cours…' : null);
  return (
    <button
      type="button"
      aria-label={ariaLabel ? (reason ? `${ariaLabel} · ${reason}` : ariaLabel) : undefined}
      aria-disabled={blocked || undefined}
      aria-busy={pending || undefined}
      onClick={blocked ? undefined : onClick}
      className={rowClasses}
    >
      <span className={cn('flex size-6 shrink-0 items-center justify-center text-muted', blocked && 'opacity-40')}>
        {pending ? <Spinner size={18} /> : glyph ? <span className="font-mono text-app-18">{glyph}</span> : icon ? <Icon name={icon} size={20} /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate font-sans text-app-15 text-text', blocked && 'text-muted')}>{label}</span>
        {reason ? <span className="font-sans text-app-12 text-muted">{reason}</span> : hint ? <span className="font-sans text-app-12 text-muted">{hint}</span> : null}
      </span>
      {value ? <span className={cn('max-w-[45%] shrink-0 truncate font-sans text-app-13 text-muted', blocked && 'opacity-60')}>{value}</span> : null}
      {chevron && !blocked ? <Icon name="chevron" size={16} className="shrink-0 text-muted" /> : null}
    </button>
  );
}

/** Model / effort / mode: what the session has now, on the right; its choices in the same sheet. */
function ChipRow({ name, icon, chip, onOpen }: { name: string; icon: IconName; chip: ComposerToolChip; onOpen: () => void }) {
  return (
    <OptionRow
      icon={icon}
      label={name}
      value={chip.label}
      ariaLabel={`${chip.title} : ${chip.label}`}
      disabledReason={chip.disabledReason}
      pending={chip.pending}
      chevron
      onClick={onOpen}
    />
  );
}
