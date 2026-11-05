import { formatTime } from '@nuera/shared/format';
import { cn } from '@/lib/cn';
import { joinParts } from '../lib/format';
import type { DateInput } from '../status/LiveTime';

export interface InstructionMessageProps {
  /** Instruction exactly as sent to the CLI (line breaks kept). */
  text: string;
  /** Submission time → « Vous · 10:42 ». */
  at: DateInput;
  /** Author label (« Vous »). */
  author?: string;
  /**
   * Sent while Claude was working: the CLI reads it at the end of the current step
   * (« En cours, l'envoi passe en file »). Shown as « · en file » until delivered.
   */
  queued?: boolean;
  /** `desktop` = 520 px bubble (Figma); `phone` = right-aligned, at most 85 % of the column (S1 note). */
  variant?: 'desktop' | 'phone';
  className?: string;
}

/**
 * `Dev · Message · Instruction` (203:318) — « Instruction envoyée à la session Claude Code. Même bulle
 * que les messages sortants de Nuera OS. » Accent bubble, radius lg, Outfit 14 / 20, mono meta.
 */
export function InstructionMessage({ text, at, author = 'Vous', queued, variant = 'desktop', className }: InstructionMessageProps) {
  const date = new Date(at);
  const valid = !Number.isNaN(date.getTime());
  return (
    <div className={cn('flex w-full justify-end', className)}>
      <div
        className={cn(
          'flex min-w-0 flex-col gap-1 rounded-lg bg-accent px-4 py-3',
          variant === 'desktop' ? 'w-full max-w-[520px]' : 'max-w-[85%]',
          queued && 'opacity-80',
        )}
      >
        <p className="m-0 font-sans text-app-14 leading-5 font-normal break-words whitespace-pre-wrap text-on-accent">{text}</p>
        <p className="m-0 font-mono text-app-11 text-on-accent/55">
          <time dateTime={valid ? date.toISOString() : undefined}>
            {joinParts(author, valid ? formatTime(date) : null, queued ? 'en file' : null)}
          </time>
        </p>
      </div>
    </div>
  );
}
