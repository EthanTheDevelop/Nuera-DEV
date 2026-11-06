import type { MetadataRoute } from 'next';
import { ICON_COLORS } from '@/server/push/app-icon';

/**
 * Web app manifest (PWA: installable app + Web Push on the phone, Figma V4 / S5).
 * Colours from the tokens: page background `--paper` (theme-color = status bar, mobile spec),
 * splash background `--paper`.
 */

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Nuera Dev',
    short_name: 'Nuera Dev',
    description: "Retrouver, depuis n'importe quel appareil, les projets de votre serveur et les sessions Claude Code qui y travaillent.",
    lang: 'fr',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: ICON_COLORS.paper,
    theme_color: ICON_COLORS.paper,
    categories: ['developer', 'productivity'],
    icons: [
      { src: '/icon/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon/maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
