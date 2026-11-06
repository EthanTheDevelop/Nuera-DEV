'use client';

import { useId, useState } from 'react';
import { countdownLabel, effectiveAutoResume, isUsageLimited, scheduledResumeAt, usageLimitDetail } from '@/components/dev';
import { Banner, CompactButton, Switch, toast } from '@/components/ui';
import { resumeAfterLimitRequest, SessionApiError, setAutoResumeRequest } from '@/features/sessions';
import { useNow } from '@/hooks/useNow';
import { useWorkspace } from '../WorkspaceContext';

/**
 * « Reprise automatique après la limite d'utilisation » of the open session: its effective value
 * (the session's choice, else the space's), the switch of the banner and of the « … » menu / phone
 * sheet, and « Reprendre maintenant ». The runner keeps the schedule; its `session.status` events
 * bring the new `limit` back.
 */
export function useAutoResume() {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  const [saving, setSaving] = useState(false);
  const [resuming, setResuming] = useState(false);
  const enabled = effectiveAutoResume(session.autoResume.override, session.autoResume.spaceDefault);
  const limited = isUsageLimited(session.limit);

  const fail = (title: string, error: unknown) =>
    ws.setActionError({
      title,
      message: (error as Error).message,
      ...(error instanceof SessionApiError && error.untouched ? { untouched: error.untouched } : {}),
      ...(error instanceof SessionApiError && error.raw ? { raw: error.raw } : {}),
    });

  const setEnabled = async (next: boolean) => {
    setSaving(true);
    // Back to the space default when it says the same: the session follows later changes of it.
    const override = next === session.autoResume.spaceDefault ? null : next;
    try {
      const result = await setAutoResumeRequest(session.id, override);
      ws.ctl.dispatch({ type: 'session', patch: { autoResume: { ...session.autoResume, override }, limit: result.session.limit } });
      toast({ message: next ? 'Reprise automatique activée pour cette session.' : 'Reprise automatique désactivée pour cette session.' });
    } catch (error) {
      fail("La reprise automatique n'a pas pu être modifiée", error);
    } finally {
      setSaving(false);
    }
  };

  const resumeNow = async () => {
    setResuming(true);
    try {
      const result = await resumeAfterLimitRequest(session.id);
      ws.ctl.dispatch({ type: 'session', patch: { limit: result.session.limit } });
      toast({ message: "Instruction de reprise envoyée : si la limite est encore là, le CLI l'indiquera." });
    } catch (error) {
      fail("La session n'a pas pu reprendre", error);
    } finally {
      setResuming(false);
    }
  };

  return { enabled, limited, saving, resuming, setEnabled, resumeNow, disabled: ws.reconnecting || saving };
}

/**
 * Workspace banner while the subscription usage limit stops the session (no Figma frame: `Dev ·
 * Bandeau` Alerte): the reset time the CLI announced, the scheduled resumption with a live
 * countdown and its attempt count, the session's switch and « Reprendre maintenant ».
 */
export function UsageLimitBanner({ className }: { className?: string }) {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  const auto = useAutoResume();
  const switchLabel = useId();
  const next = scheduledResumeAt(session.limit);
  // Ticks every second only while a resumption is scheduled (the countdown).
  const now = useNow(next ? 1_000 : 60_000, ws.initialNow);
  if (!isUsageLimited(session.limit)) return null;
  const countdown = next ? countdownLabel(next, now) : null;

  return (
    <Banner
      tone="warn"
      icon="clock"
      title="Limite d'utilisation atteinte"
      className={className}
      action={
        <>
          <span className="inline-flex items-center gap-2">
            <span id={switchLabel} className="font-sans text-app-13 text-text">
              Reprise automatique
            </span>
            <Switch checked={auto.enabled} disabled={auto.disabled} aria-labelledby={switchLabel} onCheckedChange={(checked) => void auto.setEnabled(checked)} />
          </span>
          <CompactButton variant="secondaire" icon="play" loading={auto.resuming} disabled={ws.reconnecting} onClick={() => void auto.resumeNow()}>
            Reprendre maintenant
          </CompactButton>
        </>
      }
    >
      <span data-testid="limite-detail">{usageLimitDetail(session.limit, now)}</span>
      {countdown ? <span className="font-mono text-app-12" data-testid="limite-compte-a-rebours">{` · ${countdown}`}</span> : null}
    </Banner>
  );
}
