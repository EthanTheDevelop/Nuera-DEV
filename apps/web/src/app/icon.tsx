import { ImageResponse } from 'next/og';
import { AppIcon } from '@/server/push/app-icon';

/**
 * App icons (favicon + PWA manifest), generated with next/og from the Nuera Dev « DEV » icon
 * (Figma S5, design-system §9.3). Served at /icon/32, /icon/192, /icon/512 and /icon/maskable.
 */

const ICONS = {
  '32': { size: 32, shape: 'rounded', pillRatio: 0.8 },
  '192': { size: 192, shape: 'rounded', pillRatio: 0.8 },
  '512': { size: 512, shape: 'rounded', pillRatio: 0.8 },
  // Maskable: full bleed, pill inside the 80 % safe circle.
  maskable: { size: 512, shape: 'full', pillRatio: 0.6 },
} as const;

type IconId = keyof typeof ICONS;

export function generateImageMetadata() {
  return (Object.keys(ICONS) as IconId[]).map((id) => ({
    id,
    contentType: 'image/png',
    size: { width: ICONS[id].size, height: ICONS[id].size },
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const key = String(await id) as IconId;
  const icon = ICONS[key] ?? ICONS['192'];
  return new ImageResponse(<AppIcon size={icon.size} shape={icon.shape} pillRatio={icon.pillRatio} />, {
    width: icon.size,
    height: icon.size,
  });
}
