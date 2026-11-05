import 'server-only';

/**
 * Client information derived from request headers.
 *
 * The web app runs behind Coolify's reverse proxy (Traefik), which overwrites `X-Real-IP` and
 * appends to `X-Forwarded-For`. The header to trust is configurable: TRUSTED_IP_HEADER
 * (default: `x-real-ip`, then the right-most `x-forwarded-for` entry, i.e. the one added by the
 * nearest proxy). Without a proxy in development, the IP is unknown and reported as null.
 *
 * Location is only reported when the proxy/CDN provides a trustworthy city header, named by
 * TRUSTED_CITY_HEADER (e.g. `cf-ipcity` behind Cloudflare). Nuera Dev never guesses a location.
 */

export const DEFAULT_IP_HEADERS = ['x-real-ip', 'x-forwarded-for'] as const;

/** Header names used to read the client IP (shared with Better Auth's `ipAddressHeaders`). */
export function trustedIpHeaders(): string[] {
  const configured = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  return configured ? [configured] : [...DEFAULT_IP_HEADERS];
}

const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  // "[::1]:1234" or "1.2.3.4:5678" → strip port; "::ffff:1.2.3.4" → IPv4
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']') > 0 ? ip.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  return IP_PATTERN.test(ip) ? ip : null;
}

export function getClientIp(headers: Headers): string | null {
  for (const name of trustedIpHeaders()) {
    const raw = headers.get(name);
    if (!raw) continue;
    const candidate = name === 'x-forwarded-for' ? raw.split(',').at(-1) : raw;
    const ip = normaliseIp(candidate);
    if (ip) return ip;
  }
  return null;
}

/**
 * IP as it may be shown to the owner. Better Auth stores `session.ip_address` normalised and
 * masked to /64 for IPv6 (`::1` becomes `0000:…:0000`): an unspecified address is not shown at all,
 * a masked IPv6 is shown as its prefix (« 2a01:cb0:1234:5678::/64 »). Never invents anything.
 */
export function displayableIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ip = value.trim().toLowerCase();
  if (ip === '' || ip === '0.0.0.0' || ip === '::') return null;
  if (!ip.includes(':')) return IP_PATTERN.test(ip) ? ip : null;
  const groups = ip.split(':');
  if (groups.length === 8 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    const short = groups.map((group) => group.replace(/^0+(?=.)/, ''));
    if (short.every((group) => group === '0')) return null;
    if (short.slice(4).every((group) => group === '0')) return `${short.slice(0, 4).join(':')}::/64`;
    return short.join(':');
  }
  return IP_PATTERN.test(ip) ? ip : null;
}

/** City from a trusted header (TRUSTED_CITY_HEADER), decoded; null when not configured or absent. */
export function getClientCity(headers: Headers): string | null {
  const name = process.env.TRUSTED_CITY_HEADER?.trim().toLowerCase();
  if (!name) return null;
  const raw = headers.get(name)?.trim();
  if (!raw) return null;
  let city = raw;
  try {
    city = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  city = city.replace(/[\u0000-\u001f<>]/g, '').trim();
  return city && city.length <= 80 ? city : null;
}

export function getUserAgent(headers: Headers): string | null {
  const ua = headers.get('user-agent')?.trim();
  return ua ? ua.slice(0, 512) : null;
}
