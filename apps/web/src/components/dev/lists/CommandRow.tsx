import { Badge, CompactButton, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { COMMAND_KIND_LABEL, commandRunBadge, type CommandKind, type CommandRunSummary } from '../lib/commands';

export interface CommandRowProps {
  kind: CommandKind;
  /** Row label override (custom commands); defaults to `Installation`, `Lancement`, `Build`, `Tests`. */
  label?: string;
  /** Command configured for the project (`npm ci`); null → « Non configurée ». */
  command: string | null;
  /** Last real run (badge); nothing is estimated. */
  lastRun?: CommandRunSummary | null;
  /** Starts the command in the active worktree (output goes to the Workspace terminal). */
  onRun?: () => void;
  /** Stops the running command (dev server). */
  onStop?: () => void;
  /** Run / stop request in flight. */
  pending?: boolean;
  /** Why the command cannot be launched now (no worktree, runner unavailable…), shown under the row. */
  disabledReason?: string | null;
  /** Reference time for the relative badge (tests, galleries). */
  now?: Date | string | number;
  /** `desktop` = D04 row (label · command box · badge · Lancer/Arrêter) · `phone` = M04 row (44 px icon button). */
  variant?: 'desktop' | 'phone';
  className?: string;
}

/** D04 `Tuile · Environnement de développement` / M04 `Environnement` command row. */
export function CommandRow({
  kind,
  label,
  command,
  lastRun,
  onRun,
  onStop,
  pending,
  disabledReason,
  now,
  variant = 'desktop',
  className,
}: CommandRowProps) {
  const name = label ?? COMMAND_KIND_LABEL[kind];
  const running = lastRun?.status === 'running';
  const phone = variant === 'phone';
  const badge = commandRunBadge(kind, lastRun, now, phone ? 'short' : 'long');
  const blocked = Boolean(disabledReason) || !command;
  const handler = running ? onStop : onRun;
  const actionLabel = running ? `Arrêter ${name}` : `Lancer ${name}`;

  const action = handler ? (
    phone ? (
      <IconButton
        icon={running ? 'stop' : 'play'}
        label={actionLabel}
        variant="tinted"
        loading={pending}
        disabled={blocked && !running}
        onClick={handler}
      />
    ) : running ? (
      <CompactButton variant="discret" loading={pending} onClick={handler} aria-label={actionLabel}>
        Arrêter
      </CompactButton>
    ) : (
      <CompactButton
        variant="discret"
        icon="play"
        loading={pending}
        disabled={blocked}
        onClick={handler}
        aria-label={actionLabel}
      >
        Lancer
      </CompactButton>
    )
  ) : null;

  const commandText = command ?? 'Non configurée';

  return (
    <div className={cn('flex min-w-0 flex-col gap-1 border-b border-border py-2.5 last:border-b-0', className)}>
      {phone ? (
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="m-0 truncate font-sans text-app-14 font-medium text-text">{name}</p>
            <p className={cn('m-0 truncate font-mono text-app-12', command ? 'text-muted' : 'text-muted italic')}>{commandText}</p>
          </div>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {action}
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <p className="m-0 w-[110px] shrink-0 truncate font-sans text-app-14 font-medium text-text">{name}</p>
          <code
            className={cn(
              'min-w-0 flex-1 truncate rounded-sm border border-border bg-surface-raised px-2.5 py-1.5 font-mono text-app-12',
              command ? 'text-text' : 'text-muted',
            )}
            title={command ?? undefined}
          >
            {commandText}
          </code>
          {/* In a narrow tile the badge truncates (full text in the tooltip) instead of pushing the action out. */}
          <Badge tone={badge.tone} title={badge.label} className="min-w-0 shrink">
            {badge.label}
          </Badge>
          {action}
        </div>
      )}
      {disabledReason ? (
        <p className={cn('m-0 font-sans text-app-12 text-muted', !phone && 'pl-[122px]')}>{disabledReason}</p>
      ) : null}
    </div>
  );
}
