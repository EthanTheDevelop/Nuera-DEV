import { shortSha } from '@nuera/shared/format';
import { Icon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { SEP } from '../lib/format';
import { LiveTime, type DateInput } from '../status/LiveTime';

export interface GitActivityRowProps {
  kind: 'commit' | 'pull_request';
  /** Commit SHA (shown on 7 characters). */
  sha?: string | null;
  /** Pull request number (« #42 »). */
  number?: number | null;
  message: string;
  projectName: string;
  branch?: string | null;
  /** Author label; « Claude Code » renders « par Claude Code ». PR rows usually omit it. */
  author?: string | null;
  at: DateInput;
  /** Commit / pull request page on GitHub (opens in a new tab). */
  href?: string | null;
  /** `desktop` = D01 row (ref column + two lines) · `phone` = M01/S5 row (ref inside the meta). */
  variant?: 'desktop' | 'phone';
  className?: string;
}

/** D01 `Tuile · Dernières modifications` / M01 `Dernières modifications` row. */
export function GitActivityRow({
  kind,
  sha,
  number,
  message,
  projectName,
  branch,
  author,
  at,
  href,
  variant = 'desktop',
  className,
}: GitActivityRowProps) {
  // A PR number is an identifier, not a quantity: « #1234 », never « #1 234 ».
  const ref = kind === 'pull_request' ? (typeof number === 'number' ? `#${number}` : '') : shortSha(sha);
  const icon = kind === 'pull_request' ? 'git-pull-request' : 'git-commit';
  const phone = variant === 'phone';
  const external = href ? { href, target: '_blank', rel: 'noopener noreferrer' } : null;
  const messageClass = 'block truncate font-sans text-app-14 text-text';
  const messageNode = external ? (
    <a {...external} className={cn(messageClass, "hover:underline after:absolute after:inset-0 after:content-['']")}>
      {message}
    </a>
  ) : (
    <span className={messageClass}>{message}</span>
  );

  if (phone) {
    return (
      <div className={cn('relative flex min-w-0 items-center gap-2.5 border-b border-border py-3 last:border-b-0', className)}>
        <Icon name={icon} size={16} className="text-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {messageNode}
          <span className="truncate font-mono text-app-11 text-muted">
            {[ref, projectName].filter(Boolean).join(SEP)}
            {SEP}
            <LiveTime value={at} format="relative" />
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('relative flex min-w-0 items-center gap-3 border-b border-border py-2.5', className)}>
      <Icon name={icon} size={16} className="text-muted" />
      <span className="w-[72px] shrink-0 truncate font-mono text-app-12 font-medium text-accent">{ref}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {messageNode}
        <span className="truncate font-sans text-app-12 text-muted">
          {[projectName, branch, author ? `par ${author}` : null].filter(Boolean).join(SEP)}
          {SEP}
          <LiveTime value={at} format="relative" />
        </span>
      </div>
    </div>
  );
}
