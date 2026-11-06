import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthIcon, type AuthIconName } from './_components/icons';
import { LogoNueraDev } from './_components/logo';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/** Browser chrome matches the near-black page (--near-black). */
export const viewport: Viewport = {
  themeColor: '#141830',
};

/**
 * Copy of the cover « Couverture · Nuera Dev » (241:5880). These pages are public and do not know the
 * visitor's server: « VPS-3 » becomes « votre serveur » (docs/MULTICOMPTE.md §10, recorded deviation).
 */
const JOBS: Array<{ icon: AuthIconName; number: string; title: string; body: string }> = [
  {
    icon: 'projets',
    number: '01',
    title: 'Ouvrir un projet',
    body: 'Un dépôt GitHub cloné sur votre serveur, sa branche, son environnement, son CLAUDE.md.',
  },
  {
    icon: 'terminal',
    number: '02',
    title: 'Travailler avec Claude Code',
    body: 'Une vraie session du CLI, persistante, lisible en conversation ou en terminal brut, pilotable au pouce.',
  },
  {
    icon: 'check',
    number: '03',
    title: 'Vérifier et livrer',
    body: 'Le diff, le commit, la pull request : rien ne part sur GitHub sans confirmation.',
  },
];

/**
 * Auth pages (connexion, configuration, invitation, récupération, déconnexion): no Figma frame exists for them, so they
 * reuse the cover language — near-black page, Nuera Dev logo, mono eyebrow, Outfit display title,
 * accent-on-dark lead — with the white form card of Nuera OS « Connexion de l’équipe ».
 * Phone: logo + title on top, the card full width below (16 px gutter).
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-near-black">
      <div className="mx-auto grid min-h-dvh w-full max-w-wrap grid-cols-1 content-start gap-8 px-4 pt-[max(env(safe-area-inset-top),32px)] pb-[max(env(safe-area-inset-bottom),32px)] sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:content-center lg:gap-16 lg:px-12 lg:py-16">
        <header data-tone="dark" className="flex flex-col gap-5 bg-near-black text-text lg:gap-8 lg:self-center">
          <span className="lg:hidden">
            <LogoNueraDev tone="papier" height={27.6} />
          </span>
          {/* Cover size (×1.4) from the desktop breakpoint up. */}
          <span className="hidden lg:block">
            <LogoNueraDev tone="papier" height={38.65} />
          </span>
          <div className="flex flex-col gap-3 lg:gap-5">
            <p className="font-mono text-app-11 tracking-(--tracking-eyebrow) text-accent-on-dark uppercase sm:text-xs">
              Nuera Studio · Application interne
            </p>
            <p className="hidden text-5xl text-paper lg:block" aria-hidden="true">
              Nuera Dev
            </p>
            <p className="max-w-narrow text-app-14 leading-5 text-accent-on-dark sm:text-lg">
              Retrouver, depuis n&apos;importe quel appareil, les projets de votre serveur et les sessions Claude Code qui y
              travaillent.
            </p>
          </div>
          <ul className="hidden flex-col gap-3 lg:flex">
            {JOBS.map((job) => (
              <li key={job.number} className="flex gap-4 rounded-lg bg-surface-raised-dark px-6 py-5">
                <AuthIcon name={job.icon} size={20} className="mt-0.5 shrink-0 text-accent-on-dark" />
                <div className="flex flex-col gap-1.5">
                  <p className="flex items-baseline gap-2.5">
                    <span className="font-mono text-xs text-accent-on-dark">{job.number}</span>
                    <span className="text-app-16 font-semibold text-paper">{job.title}</span>
                  </p>
                  <p className="text-app-13 leading-4.5 text-accent-on-dark">{job.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </header>
        <main id="contenu" className="w-full lg:self-center">
          {children}
        </main>
      </div>
    </div>
  );
}
