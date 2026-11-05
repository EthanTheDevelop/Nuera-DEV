import { formatDuration } from '@nuera/shared/format';
import { StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { DotTone } from '../lib/tones';

export type PersistenceContext =
  | { kind: 'new' }
  | { kind: 'live'; host: string }
  | { kind: 'ended' }
  | { kind: 'reconnecting'; lastSignalSeconds: number; permissionPending?: boolean };

export interface PersistenceText {
  tone: DotTone;
  text: string;
}

/**
 * Copy of the persistence line under the composer (D05, W1, W3, W7 — states-workspace.md §4):
 * - new → « La session démarre au premier envoi et continuera sans ce navigateur. »
 * - live → « Session vivante sur VPS-3 : fermer cet onglet ou changer d'appareil ne l'arrête pas. »
 * - ended → « Conversation enregistrée par Claude Code : reprenable plus tard depuis Sessions. »
 * - reconnecting → « Dernier signe du serveur il y a 12 s · la demande d'autorisation attend toujours. »
 */
export function persistenceText(context: PersistenceContext): PersistenceText {
  switch (context.kind) {
    case 'new':
      return { tone: 'success', text: 'La session démarre au premier envoi et continuera sans ce navigateur.' };
    case 'live':
      return {
        tone: 'success',
        text: `Session vivante sur ${context.host} : fermer cet onglet ou changer d'appareil ne l'arrête pas.`,
      };
    case 'ended':
      return { tone: 'neutral', text: 'Conversation enregistrée par Claude Code : reprenable plus tard depuis Sessions.' };
    case 'reconnecting': {
      // « il y a 12 s », then « il y a 3 min », « il y a 1 h 05 » for a long outage.
      const base = `Dernier signe du serveur il y a ${formatDuration(Math.max(0, context.lastSignalSeconds) * 1000)}`;
      return {
        tone: 'warn',
        text: context.permissionPending ? `${base} · la demande d'autorisation attend toujours.` : `${base}.`,
      };
    }
  }
}

export interface SessionPersistenceLineProps {
  tone: DotTone;
  text: string;
  /** Keyboard hint on the right (« Échap · interrompre »); null hides it. */
  hint?: string | null;
  className?: string;
}

/** `Persistance` line (D05 `214:1661`): status dot · sentence · keyboard hint. */
export function SessionPersistenceLine({ tone, text, hint = 'Échap · interrompre', className }: SessionPersistenceLineProps) {
  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', className)}>
      <StatusDot tone={tone} />
      <p className="m-0 min-w-0 flex-1 font-sans text-app-12 text-muted">{text}</p>
      {hint ? <p className="m-0 shrink-0 font-mono text-app-11 whitespace-nowrap text-muted">{hint}</p> : null}
    </div>
  );
}
