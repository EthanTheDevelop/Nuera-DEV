import { UAParser } from 'ua-parser-js';

/**
 * Human device label from a User-Agent, as written in Paramètres · Accès ouverts:
 * « Mac · Safari », « iPhone · Safari », « PC Windows · Chrome ».
 * A User-Agent never reveals the exact model of a Mac (« MacBook Pro ») — we never guess it.
 */

export type DeviceKind = 'desktop' | 'phone' | 'tablet' | 'unknown';

export interface DeviceDescription {
  /** « Mac · Safari » — « Appareil inconnu » when nothing can be read. */
  label: string;
  kind: DeviceKind;
  /** « Mac », « iPhone », « PC Windows »… */
  device: string | null;
  /** « Safari », « Chrome »… */
  browser: string | null;
}

const BROWSER_NAMES: Record<string, string> = {
  'Mobile Safari': 'Safari',
  Safari: 'Safari',
  Chrome: 'Chrome',
  'Mobile Chrome': 'Chrome',
  'Chrome WebView': 'Chrome',
  'Chrome Headless': 'Chrome',
  Chromium: 'Chromium',
  Firefox: 'Firefox',
  'Mobile Firefox': 'Firefox',
  Edge: 'Edge',
  Opera: 'Opera',
  'Opera Touch': 'Opera',
  'Samsung Internet': 'Samsung Internet',
  Brave: 'Brave',
  Vivaldi: 'Vivaldi',
  Arc: 'Arc',
  DuckDuckGo: 'DuckDuckGo',
};

function browserName(name: string | undefined): string | null {
  if (!name) return null;
  return BROWSER_NAMES[name] ?? name;
}

export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  if (!userAgent) return { label: 'Appareil inconnu', kind: 'unknown', device: null, browser: null };
  const result = UAParser(userAgent);
  const os = result.os.name ?? '';
  const type = result.device.type;
  const model = result.device.model;
  let device: string | null = null;
  let kind: DeviceKind = 'unknown';

  if (model === 'iPhone' || (os === 'iOS' && type === 'mobile')) {
    device = 'iPhone';
    kind = 'phone';
  } else if (model === 'iPad' || (os === 'iOS' && type === 'tablet')) {
    device = 'iPad';
    kind = 'tablet';
  } else if (os === 'Android') {
    kind = type === 'tablet' ? 'tablet' : 'phone';
    const vendor = result.device.vendor;
    device = model && vendor ? `${vendor} ${model}` : type === 'tablet' ? 'Tablette Android' : 'Android';
  } else if (os === 'macOS' || os === 'Mac OS') {
    device = 'Mac';
    kind = 'desktop';
  } else if (os === 'Windows') {
    device = 'PC Windows';
    kind = 'desktop';
  } else if (os === 'Chrome OS' || os === 'Chromium OS') {
    device = 'Chromebook';
    kind = 'desktop';
  } else if (os === 'Linux' || os === 'Ubuntu' || os === 'Debian' || os === 'Fedora') {
    device = 'PC Linux';
    kind = 'desktop';
  } else if (type === 'mobile') {
    device = 'Téléphone';
    kind = 'phone';
  } else if (type === 'tablet') {
    device = 'Tablette';
    kind = 'tablet';
  }

  const browser = browserName(result.browser.name);
  const parts = [device, browser].filter((part): part is string => Boolean(part));
  return {
    label: parts.length ? parts.join(' · ') : 'Appareil inconnu',
    kind,
    device,
    browser,
  };
}
