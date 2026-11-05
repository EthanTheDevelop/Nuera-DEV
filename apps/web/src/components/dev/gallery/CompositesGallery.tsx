'use client';

/**
 * DEV-ONLY gallery of the Nuera Dev composites (/kit/composites). Sample props are labelled and live
 * only here; every button reports its action in the demo log. Not exported from ../index.ts.
 */
import { useState } from 'react';
import { LinkButton } from '@/components/ui';
import { ChangesSection } from './ChangesSection';
import { ConversationSection } from './ConversationSection';
import { DemoLogProvider } from './demo-log';
import { ListsSection } from './ListsSection';

const TOC = [
  { id: 'fil', label: 'Fil de session' },
  { id: 'decisions', label: 'Décisions et saisie' },
  { id: 'git', label: 'Git et lignes' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'listes', label: 'Projets' },
  { id: 'integrations', label: 'Intégrations' },
];

export function CompositesGallery({ now: serverNow }: { now: number }) {
  // Reference time chosen on the server and reused by the client: sample dates hydrate identically.
  const [now] = useState(serverNow);
  return (
    <DemoLogProvider>
      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-12 px-4 py-7 nav:px-8">
        <header className="flex flex-col gap-3">
          <p className="m-0 font-mono text-app-11 tracking-label text-muted uppercase">Kit · section 04 · Créés pour Nuera Dev</p>
          <h1 className="m-0 font-sans text-app-28 font-semibold text-text">Composants Nuera Dev</h1>
          <p className="m-0 max-w-[760px] font-sans text-app-14 text-muted">
            Chaque composite dans chacun de ses états, avec des données d&apos;exemple étiquetées (page de développement). Les
            boutons signalent l&apos;action que la page réelle transmet au serveur.
          </p>
          <nav aria-label="Sections de la galerie" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <LinkButton href="/kit" icon="arrow-left">
              Primitives du kit
            </LinkButton>
            {TOC.map((item) => (
              <a key={item.id} href={`#${item.id}`} className="font-sans text-app-13 font-medium text-accent hover:underline">
                {item.label}
              </a>
            ))}
          </nav>
        </header>
        <ConversationSection now={now} />
        <ChangesSection />
        <ListsSection now={now} />
      </main>
    </DemoLogProvider>
  );
}
