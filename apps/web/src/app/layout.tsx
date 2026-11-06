import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Outfit } from 'next/font/google';
import { Toaster } from '@/components/ui/Toast';
import { getThemePreference } from '@/server/shell/theme';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-outfit',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Nuera Dev', template: '%s · Nuera Dev' },
  description: "Retrouver, depuis n'importe quel appareil, les projets de votre serveur et les sessions Claude Code qui y travaillent.",
  applicationName: 'Nuera Dev',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Nuera Dev', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

/** Page background per theme for the browser / PWA status bar (values of --paper and --ink, tokens.css). */
const PAGE_BG = { light: '#ffffff', dark: '#233353' } as const;

export async function generateViewport(): Promise<Viewport> {
  const theme = await getThemePreference();
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    // S1: the composer stays pinned right above the phone keyboard.
    interactiveWidget: 'resizes-content',
    // Status bar colours follow the page background (Dev · Barre d'état « Ses couleurs suivent le rôle text »),
    // in the theme the signed-in account chose in Paramètres (no white bar over a dark page).
    themeColor:
      theme === 'system'
        ? [
            { media: '(prefers-color-scheme: dark)', color: PAGE_BG.dark },
            { media: '(prefers-color-scheme: light)', color: PAGE_BG.light },
          ]
        : PAGE_BG[theme],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = await getThemePreference();
  return (
    <html lang="fr" data-theme={theme} className={`${outfit.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body>
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
