'use client';

import { useState } from 'react';
import { Icon, type IconName } from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  Spinner,
  Tooltip,
  TooltipProvider,
} from '@/components/ui';
import { cn } from '@/lib/cn';

export interface ComposerChoice {
  value: string;
  label: string;
  description?: string;
}

export interface ComposerChipProps {
  icon: IconName;
  /** Visible text: what the CLI reports (« Fake Opus », « Plan »). */
  label: string;
  /** Accessible name and title of the menu / sheet (« Modèle de la session »). */
  title: string;
  options: readonly ComposerChoice[];
  /** Current value (check mark), null when unknown. */
  value: string | null;
  onSelect: (value: string) => void;
  /** A change is on its way to the CLI. */
  pending?: boolean;
  /** Why the chip cannot be used right now (shown as tooltip and, on a tap, under the field). */
  disabledReason?: string | null;
  /** Line under the options (« S'applique au prochain démarrage de Claude Code. »). */
  note?: string | null;
  onBlockedTap?: (reason: string) => void;
  variant: 'desktop' | 'phone';
  className?: string;
}

const chipClasses =
  'nu-hit inline-flex h-8 min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 font-sans text-app-12 text-muted ' +
  'transition-colors duration-(--dur-fast) hover:bg-hover hover:text-text aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-bg aria-disabled:hover:text-muted ' +
  'data-[state=open]:border-accent data-[state=open]:text-text';

/**
 * Chip of the composer toolbar (model, permission mode): a menu on desktop, a sheet on a phone.
 * Shows only what the session really has; disabled with its reason otherwise (never a dead button).
 */
export function ComposerChip({
  icon,
  label,
  title,
  options,
  value,
  onSelect,
  pending,
  disabledReason,
  note,
  onBlockedTap,
  variant,
  className,
}: ComposerChipProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const blocked = Boolean(disabledReason) || Boolean(pending);
  const content = (
    <>
      {pending ? <Spinner size={14} /> : <Icon name={icon} size={14} />}
      <span className="min-w-0 truncate">{label}</span>
      <Icon name="chevron-down" size={12} className="shrink-0" />
    </>
  );
  const ariaLabel = `${title} : ${label}`;

  if (blocked) {
    const reason = disabledReason ?? 'Changement en cours…';
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip content={reason}>
          <button
            type="button"
            aria-label={`${ariaLabel} · ${reason}`}
            aria-disabled
            aria-busy={pending || undefined}
            onClick={() => (disabledReason ? onBlockedTap?.(disabledReason) : undefined)}
            className={cn(chipClasses, className)}
          >
            {content}
          </button>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (variant === 'phone') {
    return (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          onClick={() => setSheetOpen(true)}
          className={cn(chipClasses, 'h-9', className)}
        >
          {content}
        </button>
        <SheetContent title={title} description={note ?? undefined}>
          <ComposerChoiceList
            title={title}
            options={options}
            value={value}
            onChoose={(choice) => {
              setSheetOpen(false);
              if (choice !== value) onSelect(choice);
            }}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={ariaLabel} className={cn(chipClasses, className)}>
          {content}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" width={300}>
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {options.map((option) => {
          const current = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => (current ? undefined : onSelect(option.value))}
              aside={current ? <Icon name="check" size={16} className="text-accent" /> : null}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                {option.description ? (
                  <span className="truncate text-app-12 text-muted">{option.description}</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          );
        })}
        {note ? (
          <p className="m-0 px-2.5 pt-1.5 pb-1 font-sans text-app-12 text-muted">{note}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phone list of a chip's choices (44 px+ rows, check mark on the current one), in a sheet. */
export function ComposerChoiceList({
  title,
  options,
  value,
  onChoose,
}: {
  title: string;
  options: readonly ComposerChoice[];
  value: string | null;
  onChoose: (value: string) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pb-3" aria-label={title}>
      {options.map((option) => {
        const current = option.value === value;
        return (
          <li key={option.value}>
            <button
              type="button"
              aria-current={current || undefined}
              onClick={() => onChoose(option.value)}
              className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-hover active:bg-pressed"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-sans text-app-14 text-text">{option.label}</span>
                {option.description ? <span className="font-sans text-app-12 text-muted">{option.description}</span> : null}
              </span>
              {current ? <Icon name="check" size={18} className="shrink-0 text-accent" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
