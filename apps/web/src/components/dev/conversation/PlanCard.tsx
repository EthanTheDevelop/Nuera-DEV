import { Icon, type IconName } from '@/components/icons';
import { cn } from '@/lib/cn';
import { formatRatio } from '../lib/format';

/** Todo item as exposed by the CLI (`TodoWrite`): `completed` / `in_progress` / `pending`. */
export interface PlanStep {
  content: string;
  status: 'completed' | 'in_progress' | 'pending';
}

const STEP: Record<PlanStep['status'], { icon: IconName; iconClass: string; textClass: string; sr: string }> = {
  completed: { icon: 'check', iconClass: 'text-success', textClass: 'text-muted line-through', sr: 'terminée' },
  in_progress: { icon: 'clock', iconClass: 'text-en-cours', textClass: 'font-medium text-text', sr: 'en cours' },
  pending: { icon: 'minus', iconClass: 'text-muted', textClass: 'text-text', sr: 'à faire' },
};

export interface PlanCardProps {
  steps: readonly PlanStep[];
  /** Card title (« Plan de travail »). */
  title?: string;
  className?: string;
}

/**
 * `Dev · Plan de travail` (203:455) — « Liste de tâches tenue par Claude Code pendant la session, telle
 * que le CLI l'expose. Rien n'est estimé par Nuera Dev. » Counter = completed / total.
 */
export function PlanCard({ steps, title = 'Plan de travail', className }: PlanCardProps) {
  const done = steps.filter((s) => s.status === 'completed').length;
  return (
    <section
      aria-label={title}
      className={cn('flex w-full min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-bg p-4', className)}
    >
      <div className="flex items-center gap-2">
        <Icon name="list-checks" size={16} className="text-accent" />
        <h3 className="m-0 min-w-0 flex-1 truncate font-sans text-app-14 font-semibold text-text">{title}</h3>
        <span className="shrink-0 font-mono text-app-12 text-muted">
          <span className="sr-only">Étapes terminées : </span>
          {formatRatio(done, steps.length)}
        </span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {steps.map((step, index) => {
          const spec = STEP[step.status];
          return (
            <li key={`${index}-${step.content}`} className="flex items-start gap-2.5">
              <Icon name={spec.icon} size={16} className={spec.iconClass} />
              <span className={cn('min-w-0 flex-1 font-sans text-app-13 leading-4 break-words', spec.textClass)}>
                <span className="sr-only">{`Étape ${spec.sr} : `}</span>
                {step.content}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
