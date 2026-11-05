import { ImageResponse } from 'next/og';
import { AppIcon } from '@/server/push/app-icon';

/** apple-touch-icon (home screen on iOS): full-bleed, iOS applies its own rounded mask. */

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={180} shape="full" pillRatio={0.8} />, size);
}
