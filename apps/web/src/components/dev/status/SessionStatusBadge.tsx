import { Badge } from '@/components/ui';
import { SEP } from '../lib/format';
import { sessionBadgeLabel, sessionStatusMeta, type SessionStatus } from '../lib/session-status';
import { LiveTime, type DateInput } from './LiveTime';

export interface SessionStatusBadgeProps {
  status: SessionStatus;
  /** Live sessions: start of the run → « En cours · 7 min », ticking. */
  since?: DateInput | null;
  /** Ended sessions: total duration → « Terminée · 18 min ». */
  durationMs?: number | null;
  /** Short labels of narrow rows (S4 sheet: « Autorisation »). */
  short?: boolean;
  /** W7: the live link to the server is down → Neutre « Reconnexion… » replaces the real status. */
  reconnecting?: boolean;
  className?: string;
}

/**
 * Session status as a `Badge` (D05/W1–W7 header, W6 switcher, S4 sheet): `Prête`, `En cours · 7 min`,
 * `Autorisation demandée`, `Terminée · 18 min`…
 */
export function SessionStatusBadge({ status, since, durationMs, short, reconnecting, className }: SessionStatusBadgeProps) {
  if (reconnecting) {
    return (
      <Badge tone="neutral" className={className}>
        Reconnexion…
      </Badge>
    );
  }
  const meta = sessionStatusMeta(status);
  if (status === 'running' && since !== undefined && since !== null) {
    return (
      <Badge tone={meta.badge} className={className}>
        {short ? meta.shortLabel : meta.label}
        {SEP}
        <LiveTime value={since} format="elapsed" />
      </Badge>
    );
  }
  return (
    <Badge tone={meta.badge} className={className}>
      {sessionBadgeLabel(status, durationMs, { short })}
    </Badge>
  );
}
