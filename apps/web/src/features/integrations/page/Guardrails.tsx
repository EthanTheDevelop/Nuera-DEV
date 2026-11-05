'use client';

import type { ReactNode } from 'react';
import { LiveTime } from '@/components/dev';
import { Icon, type IconName } from '@/components/icons';
import { SectionLabel } from '@/components/ui';
import type { IntegrationsOverview } from '../types';

interface Guardrail {
  icon: IconName;
  title: string;
  body: string;
  meta?: ReactNode;
  /** Exact rules behind the card (read by screen readers and on hover). */
  rules?: string;
}

/**
 * D07 `GARDE-FOUS` (informational, not interactive): « Production hors de portée », « Un accès, un
 * projet », « Diagnostic automatique », built from `overview.guardrails` (denied tools, isolation,
 * check interval and last run).
 */
export function Guardrails({ guardrails }: { guardrails: IntegrationsOverview['guardrails'] }) {
  const lastRun = guardrails.autoCheck.lastRunAt;
  const cards: Guardrail[] = [
    {
      icon: 'shield',
      title: 'Production hors de portée',
      body: 'Déployer ou redémarrer un service de production ne passe jamais par Claude : ces actions restent dans Coolify, avec votre compte.',
      rules: `Outils refusés à Claude : ${guardrails.productionOutOfReach.deniedCoolifyTools.join(', ')}`,
    },
    {
      icon: 'plug',
      title: 'Un accès, un projet',
      body: "Un serveur MCP n'est visible que des projets où il est activé. Les autres sessions ne le voient pas.",
      rules: guardrails.perProjectIsolation.strictMcpConfig ? 'Configuration MCP propre à chaque session, connecteurs claude.ai désactivés.' : undefined,
    },
    {
      icon: 'refresh',
      title: 'Diagnostic automatique',
      body: `Chaque connexion est vérifiée toutes les ${guardrails.autoCheck.intervalMinutes} minutes. Une expiration s'affiche ici et sur l'Accueil.`,
      meta: lastRun ? <LiveTime value={lastRun} format="relative" prefix="Dernier passage " /> : 'Aucun passage pour le moment',
    },
  ];
  return (
    <section aria-labelledby="garde-fous" className="flex flex-col gap-4 nav:gap-6">
      <SectionLabel as="h2" id="garde-fous">
        Garde-fous
      </SectionLabel>
      <ul className="m-0 grid list-none grid-cols-3 gap-5 p-0">
        {cards.map((card) => (
          <li key={card.title} title={card.rules} className="flex items-start gap-3 rounded-lg border border-border bg-bg p-4">
            <Icon name={card.icon} size={18} className="mt-px shrink-0 text-accent" />
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="m-0 font-sans text-app-14 font-semibold text-text">{card.title}</h3>
              <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{card.body}</p>
              {card.rules ? <span className="sr-only">{card.rules}</span> : null}
              {card.meta ? <p className="m-0 font-mono text-app-11 text-muted">{card.meta}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** M07 `Garde-fou`: the production footnote only. */
export function PhoneGuardrail() {
  return (
    <p className="m-0 flex items-start gap-2 font-sans text-app-12 leading-[17px] text-muted">
      <Icon name="shield" size={16} className="shrink-0 text-muted" />
      <span>Les actions de production Coolify ne passent jamais par Claude : elles restent dans Coolify.</span>
    </p>
  );
}
