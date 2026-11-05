import { Icon } from '@/components/icons';
import { Card, SlotMeter } from '@/components/ui';
import type { SessionCapacity } from '../lib/contract';
import { capacityFullReason } from '../lib/form';
import { capacityShort, capacityTitle, memoryCaption, memoryFreeShort, type MemoryMetrics } from '../lib/view';

/**
 * D06 `Capacité` (215:1877): tile 68 tall, pastille cpu 36, « 2 sessions actives sur 4 autorisées » /
 * « Limite réglable dans Paramètres · Serveur », slot gauge + « Mémoire libre : 10,9 Go sur 16 ·
 * processeur 23 % ». M06: card p 16, « 2 sessions sur 4 » + « 10,9 Go libres », slots h 8.
 */
export function CapacityTile({ capacity, metrics }: { capacity: SessionCapacity; metrics: MemoryMetrics | null }) {
  const title = capacityTitle(capacity.active, capacity.max);
  const caption = memoryCaption(metrics);
  const freeShort = memoryFreeShort(metrics);
  // Phone: the disabled « + » has no tooltip, the reason is written under the gauge.
  const fullReason = capacity.active >= capacity.max ? capacityFullReason(capacity.active, capacity.max) : null;
  return (
    <>
      <Card variant="tile" as="section" aria-label="Capacité" padding="none" className="hidden items-center gap-6 px-5 py-4 nav:flex nav:flex-row">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-accent-pale text-accent">
          <Icon name="cpu" size={18} />
        </span>
        <div className="flex w-[300px] shrink-0 flex-col gap-0.5">
          <p className="m-0 font-sans text-app-15 font-semibold text-text" aria-live="polite">
            {title}
          </p>
          <p className="m-0 font-sans text-app-12 text-muted">Limite réglable dans Paramètres · Serveur</p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <SlotMeter used={capacity.active} total={capacity.max} label={title} />
          {caption ? <p className="m-0 truncate font-mono text-app-11 text-muted">{caption}</p> : null}
        </div>
      </Card>
      <Card variant="card" as="section" aria-label="Capacité" className="flex flex-col gap-2 nav:hidden">
        <div className="flex items-center gap-2">
          <Icon name="cpu" size={16} className="text-accent" />
          <p className="m-0 min-w-0 flex-1 font-sans text-app-15 font-semibold text-text">{capacityShort(capacity.active, capacity.max)}</p>
          {freeShort ? <span className="shrink-0 font-mono text-app-11 text-muted">{freeShort}</span> : null}
        </div>
        <SlotMeter used={capacity.active} total={capacity.max} label={title} className="h-2 [&>span]:rounded-[4px]" />
        {fullReason ? <p className="m-0 font-sans text-app-12 leading-4 text-muted">{fullReason}</p> : null}
      </Card>
    </>
  );
}
