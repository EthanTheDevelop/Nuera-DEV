import { formatTime } from '@nuera/shared/format';
import { Pastille } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { DateInput } from '../status/LiveTime';
import { ClaudeMarkdown } from './ClaudeMarkdown';

export interface ClaudeMessageProps {
  /** Text written by Claude Code (Markdown, rendered safely — never raw HTML). */
  markdown: string;
  /** Time of the message (« 10:51 »); omitted when unknown. */
  at?: DateInput | null;
  /** Author label (« Claude Code »). */
  author?: string;
  className?: string;
}

/**
 * `Dev · Message · Claude` (203:329) — « Texte produit par Claude Code dans la session. Rendu lisible
 * de la sortie du CLI ; la vue Terminal montre le flux brut. » 28 px terminal pastille + header + body.
 */
export function ClaudeMessage({ markdown, at, author = 'Claude Code', className }: ClaudeMessageProps) {
  const date = at === undefined || at === null ? null : new Date(at);
  const valid = date !== null && !Number.isNaN(date.getTime());
  return (
    <div className={cn('flex w-full min-w-0 items-start gap-3', className)}>
      <Pastille icon="terminal" size={28} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 flex items-center gap-2">
          <span className="font-sans text-app-13 font-semibold text-text">{author}</span>
          {valid ? (
            <time dateTime={date.toISOString()} className="font-mono text-app-11 text-muted">
              {formatTime(date)}
            </time>
          ) : null}
        </p>
        <ClaudeMarkdown>{markdown}</ClaudeMarkdown>
      </div>
    </div>
  );
}
