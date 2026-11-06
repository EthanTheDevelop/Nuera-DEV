'use client';

import { useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/components/icons';
import { claudeLoginTerminal, useTerminalLauncher } from '@/components/terminal';
import { Card, CompactButton, TileHeader } from '@/components/ui';
import { cn } from '@/lib/cn';
import { firstSteps, firstStepsVisible, type FirstStep } from './lib';
import type { HomeOnboarding } from './types';
import type { HomeLive } from './useHomeLive';

/**
 * « Premiers pas » (no Figma: built from the tile primitives): Connecter Claude Code · Connecter
 * GitHub · Ajouter un premier projet. Every state comes from the data (CLI status of the server,
 * GitHub sources of the space, projects of the space): a step is never ticked nor offered on a
 * guess. Hidden once the three are done (the Figma Accueil of a set-up account is unchanged), and
 * while an unknown state is the only thing left.
 */
export function FirstStepsCard({ live, onboarding }: { live: HomeLive; onboarding: HomeOnboarding }) {
  const router = useRouter();
  const terminal = useTerminalLauncher();
  const steps = firstSteps({
    server: live.server ? { name: live.server.name, availability: live.availability } : null,
    claudeState: live.claudeState,
    onboarding,
  });
  if (!firstStepsVisible(steps, onboarding)) return null;
  const done = steps.filter((step) => step.state === 'done').length;
  return (
    <Card variant="tile" as="section" aria-labelledby="accueil-premiers-pas" className="gap-3">
      <TileHeader
        icon="sparkle"
        title={<span id="accueil-premiers-pas">Premiers pas</span>}
        action={<span className="font-sans text-app-12 text-muted">{`${done} sur ${steps.length}`}</span>}
      />
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((step, index) => (
          <li key={step.id} className="flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0 nav:flex-row nav:items-center nav:gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <StepMarker state={step.state} index={index} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className={cn('m-0 font-sans text-app-14 font-medium', step.state === 'done' ? 'text-muted' : 'text-text')}>{step.title}</p>
                <p className="m-0 font-sans text-app-12 leading-[17px] text-muted">{step.text}</p>
              </div>
            </div>
            {step.state === 'todo' && step.action ? (
              <div className="flex shrink-0 pl-9 nav:pl-0">
                {step.action.kind === 'link' ? (
                  <CompactButton variant="secondaire" icon={step.action.icon as IconName} href={step.action.href}>
                    {step.action.label}
                  </CompactButton>
                ) : (
                  <CompactButton
                    variant="secondaire"
                    icon={step.action.icon as IconName}
                    onClick={() => terminal.open(claudeLoginTerminal({ serverName: live.server?.name, onExit: () => router.refresh() }))}
                  >
                    {step.action.label}
                  </CompactButton>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {terminal.dialog}
    </Card>
  );
}

function StepMarker({ state, index }: { state: FirstStep['state']; index: number }) {
  if (state === 'done') {
    return (
      <span aria-label="Terminé" role="img" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-success-pale text-success">
        <Icon name="check" size={14} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-app-12',
        state === 'todo' ? 'text-text' : 'text-muted',
      )}
    >
      {index + 1}
    </span>
  );
}
