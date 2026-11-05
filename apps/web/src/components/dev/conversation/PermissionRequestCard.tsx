'use client';

import { useId } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { Badge, CodeBlock, CompactButton, type CompactButtonVariant } from '@/components/ui';
import { cn } from '@/lib/cn';
import { joinParts } from '../lib/format';
import {
  permissionModeText,
  permissionSummary,
  type PermissionOption,
  type PermissionRequestStatus,
} from '../lib/permission';

const OPTION_STYLE: Record<PermissionOption['kind'], { variant: CompactButtonVariant; icon?: IconName }> = {
  allow: { variant: 'principal', icon: 'check' },
  allow_always: { variant: 'secondaire' },
  deny: { variant: 'discret', icon: 'x' },
};

const RESOLVED_ICON: Partial<Record<PermissionRequestStatus, { icon: IconName; className: string }>> = {
  allowed: { icon: 'check', className: 'text-success' },
  allowed_always: { icon: 'check', className: 'text-success' },
  denied: { icon: 'x', className: 'text-danger' },
  answered_in_terminal: { icon: 'terminal', className: 'text-muted' },
  cancelled: { icon: 'x', className: 'text-muted' },
};

export interface PermissionRequestCardProps {
  status: PermissionRequestStatus;
  /** « Claude demande à exécuter une commande » (see `permissionTitle`). */
  title: string;
  /** Command or target shown in the dark block (`npm run test -- crm`). */
  target?: string | null;
  /** Print the target as a shell command (`$ …`). Default true. */
  isCommand?: boolean;
  /** Tool name, used by the collapsed one-liner (`Commande` vs `Modification`). */
  toolName?: string;
  /** Human explanation from the CLI request (tool description), when it gives one. */
  explanation?: string | null;
  /** The CLI's choices, in its order (max 3). See `defaultPermissionOptions`. */
  options: readonly PermissionOption[];
  /** Label of the CLI permission mode (`demander avant d'agir`, see `permissionModeLabel`). */
  modeLabel: string;
  /** `desktop` = 680/720 card, buttons in a row · `phone` = 358 card, three 44 px buttons stacked. */
  variant?: 'desktop' | 'phone';
  /** Sends the decision; omitted → the buttons stay disabled (`disabledReason` explains why). */
  onDecide?: (option: PermissionOption) => void;
  /** Option being transmitted (spinner on that button, the others disabled). */
  pendingOptionId?: string | null;
  /** Why the card cannot be answered now (W7: connexion perdue). Disables the buttons. */
  disabledReason?: string | null;
  /** Last transmission error (T4: what failed, the request still waits). */
  error?: string | null;
  /** `expired`: the wait is over and the official dialog is in the terminal → opens it. */
  onAnswerInTerminal?: () => void;
  /** Anchor target for deep links (`#demande-<id>`). */
  id?: string;
  className?: string;
}

/**
 * `Dev · Demande d'autorisation` (203:423) and `· téléphone` (222:2731) — « Demande de permission du
 * CLI. Trois choix au plus, dans l'ordre du CLI. Une fois tranchée, la carte se replie en une ligne et
 * l'historique la garde. » The decision is transmitted to the CLI; the mode is never bypassed.
 */
export function PermissionRequestCard(props: PermissionRequestCardProps) {
  const { status } = props;
  if (status === 'pending' || status === 'expired') return <OpenRequest {...props} />;
  return <ResolvedRequest {...props} />;
}

function ResolvedRequest({ status, target, toolName, id, className }: PermissionRequestCardProps) {
  const summary = permissionSummary(status, target, toolName) ?? '';
  const trailing = RESOLVED_ICON[status];
  return (
    <div
      id={id}
      className={cn(
        'flex min-h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md border border-border bg-bg px-3 py-2',
        className,
      )}
    >
      <Icon name="shield" size={16} className="text-muted" />
      <p className="m-0 min-w-0 flex-1 font-mono text-app-12 break-words text-muted">{summary}</p>
      {trailing ? <Icon name={trailing.icon} size={16} className={trailing.className} /> : null}
    </div>
  );
}

function OpenRequest({
  status,
  title,
  target,
  isCommand = true,
  explanation,
  options,
  modeLabel,
  variant = 'desktop',
  onDecide,
  pendingOptionId,
  disabledReason,
  error,
  onAnswerInTerminal,
  id,
  className,
}: PermissionRequestCardProps) {
  const titleId = useId();
  const phone = variant === 'phone';
  const expired = status === 'expired';
  const busy = Boolean(pendingOptionId);
  const blocked = !onDecide || Boolean(disabledReason);
  const note = phone
    ? permissionModeText(modeLabel)
    : joinParts(permissionModeText(modeLabel), 'la réponse est transmise au CLI');

  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={cn(
        'flex w-full min-w-0 flex-col gap-3 rounded-lg border border-warn bg-warn-pale p-4 outline-none',
        className,
      )}
    >
      <div className={cn('flex gap-2.5', phone ? 'items-start' : 'items-center')}>
        <Icon name="shield" size={phone ? 20 : 18} className="text-warn" />
        <h3
          id={titleId}
          className={cn(
            'm-0 min-w-0 flex-1 font-sans font-semibold text-text',
            phone ? 'text-app-15 leading-5' : 'text-app-14',
          )}
        >
          {title}
        </h3>
        {!phone ? <Badge tone="warn">{expired ? 'Dans le terminal' : 'En attente'}</Badge> : null}
      </div>

      {/* No ligatures: the owner approves exactly what is printed (`--` stays two hyphens). */}
      {target ? (
        isCommand ? (
          <CodeBlock size="sm" command={target} wrap={phone} label="Commande demandée" className="[font-variant-ligatures:none]" />
        ) : (
          <CodeBlock size="sm" wrap={phone} label="Cible de la demande" className="[font-variant-ligatures:none]">
            {target}
          </CodeBlock>
        )
      ) : null}

      {explanation ? <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{explanation}</p> : null}

      {expired ? (
        <>
          <p className="m-0 font-sans text-app-13 leading-[18px] text-text">
            Le délai de réponse est écoulé : le CLI attend maintenant votre réponse dans son terminal.
          </p>
          {onAnswerInTerminal ? (
            <div className={cn('flex', phone && 'flex-col')}>
              {/* The terminal goes through the server too: offline (W7) it waits like the choices. */}
              <CompactButton
                variant="principal"
                icon="terminal"
                size={phone ? 'lg' : 'md'}
                block={phone}
                disabled={Boolean(disabledReason)}
                onClick={onAnswerInTerminal}
              >
                Répondre dans le terminal
              </CompactButton>
            </div>
          ) : null}
        </>
      ) : (
        <div className={cn('flex gap-2', phone ? 'flex-col' : 'flex-wrap items-center')}>
          {options.map((option) => {
            const style = OPTION_STYLE[option.kind];
            const loading = pendingOptionId === option.id;
            return (
              <CompactButton
                key={option.id}
                variant={style.variant}
                icon={style.icon}
                size={phone ? 'lg' : 'md'}
                block={phone}
                loading={loading}
                disabled={blocked || (busy && !loading)}
                onClick={onDecide ? () => onDecide(option) : undefined}
              >
                {option.label}
              </CompactButton>
            );
          })}
        </div>
      )}

      {disabledReason ? <p className="m-0 font-sans text-app-12 leading-4 text-muted">{disabledReason}</p> : null}
      {error ? (
        <p role="alert" className="m-0 font-sans text-app-12 leading-4 text-danger">
          {error}
        </p>
      ) : null}

      <p className="m-0 font-mono text-app-11 text-warn">{note}</p>
    </section>
  );
}
