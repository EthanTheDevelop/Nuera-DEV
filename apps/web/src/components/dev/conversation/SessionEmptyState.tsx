import { Icon, type IconName } from '@/components/icons';
import { Pastille } from '@/components/ui';
import { cn } from '@/lib/cn';
import { joinParts } from '../lib/format';

export interface SessionSuggestion {
  icon: IconName;
  /** Instruction text proposed to the owner. */
  label: string;
}

export interface NewSessionDescriptionInput {
  worktreeName: string;
  baseBranch: string;
  /** The repository has a CLAUDE.md that the CLI reads at start. */
  claudeMdRead?: boolean;
}

/** « Worktree pipeline-export créé depuis main · CLAUDE.md lu · aucune instruction envoyée pour l'instant. » */
export function newSessionDescription({ worktreeName, baseBranch, claudeMdRead }: NewSessionDescriptionInput): string {
  return `${joinParts(
    `Worktree ${worktreeName} créé depuis ${baseBranch}`,
    claudeMdRead ? 'CLAUDE.md lu' : null,
    "aucune instruction envoyée pour l'instant",
  )}.`;
}

export interface SessionEmptyStateProps {
  /** Repository short name → « Claude Code est prêt dans nuera-os ». */
  repoName: string;
  /** Context line (see `newSessionDescription`). */
  description?: string | null;
  /** Instructions the owner can pick; each one is put in the composer (W1 Q1: fill, never auto-send). */
  suggestions?: readonly SessionSuggestion[];
  onSuggestion?: (suggestion: SessionSuggestion) => void;
  className?: string;
}

/** W1 `Session vierge`: the worktree exists, the CLI has not received its first instruction yet. */
export function SessionEmptyState({ repoName, description, suggestions = [], onSuggestion, className }: SessionEmptyStateProps) {
  return (
    <div className={cn('mx-auto flex w-full max-w-[560px] flex-col items-center gap-4 text-center', className)}>
      <Pastille icon="terminal" size={56} className="rounded-lg" />
      <h2 className="m-0 font-sans text-app-22 font-semibold text-text">{`Claude Code est prêt dans ${repoName}`}</h2>
      {description ? <p className="m-0 font-sans text-app-14 leading-5 text-muted">{description}</p> : null}
      {suggestions.length > 0 && onSuggestion ? (
        <ul className="m-0 flex w-full list-none flex-col gap-2 p-0 text-left">
          {suggestions.map((s) => (
            <li key={s.label}>
              <button
                type="button"
                onClick={() => onSuggestion(s)}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-md border border-border bg-bg px-3.5 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-hover"
              >
                <Icon name={s.icon} size={16} className="text-accent" />
                <span className="min-w-0 flex-1 font-sans text-app-14 text-text">{s.label}</span>
                <Icon name="chevron" size={14} className="text-muted" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
