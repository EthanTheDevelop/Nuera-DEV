'use client';

import { Icon } from '@/components/icons';
import { Banner, CompactButton } from '@/components/ui';
import { diagnosticIcon, phoneAlertTitle } from '../model';
import type { DiagnosticBanner, IntegrationsOverview } from '../types';

type ActionItem = DiagnosticBanner['actions'][number];

function ActionButton({ action, size }: { action: ActionItem; size: 'md' | 'lg' }) {
  if (!action.href) return null;
  const external = action.kind === 'external' && /^https?:/i.test(action.href);
  const internalApi = action.href.startsWith('/api/');
  const variant = action.kind === 'journal' ? 'discret' : 'secondaire';
  const icon = action.kind === 'external' ? 'external' : action.kind === 'reconnect' && action.label === 'Reconnecter' ? 'refresh' : undefined;
  const block = size === 'lg';
  if (internalApi) {
    // GitHub redirects (« Réautoriser sur GitHub ») need a full navigation.
    const href = action.href;
    return (
      <CompactButton variant={variant} size={size} block={block} icon={icon} onClick={() => window.location.assign(href)}>
        {action.label}
      </CompactButton>
    );
  }
  if (action.href.startsWith('/integrations?')) {
    // Same page (« Voir le journal » of GitHub / Coolify): only the search params change.
    const href = action.href;
    return (
      <CompactButton variant={variant} size={size} block={block} icon={icon} onClick={() => window.history.pushState(null, '', href)}>
        {action.label}
      </CompactButton>
    );
  }
  return (
    <CompactButton variant={variant} size={size} block={block} icon={icon} href={action.href} external={external}>
      {action.label}
    </CompactButton>
  );
}

/**
 * D07 `Diagnostic Coolify` (216:2247) and T7 banners: one per failing service, below the MCP grid —
 * « <Service> ne répond plus depuis 09:12 » + what keeps working, « Voir le journal », « Reconnecter ».
 */
export function DiagnosticBanners({ diagnostics, overview }: { diagnostics: DiagnosticBanner[]; overview: IntegrationsOverview }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {diagnostics.map((banner) => (
        <Banner
          key={banner.target}
          tone={banner.tone}
          dense="relaxed"
          icon={diagnosticIcon(banner, overview)}
          title={banner.title}
          action={
            banner.actions.length ? (
              <>
                {banner.actions.map((action) => (
                  <ActionButton key={`${action.kind}-${action.label}`} action={action} size="md" />
                ))}
              </>
            ) : undefined
          }
        >
          {banner.body}
        </Banner>
      ))}
    </div>
  );
}

/**
 * M07 `Alerte Coolify`: danger-pale card above the MCP list (no border, no shadow, radius 20, p 16):
 * « Coolify : autorisation expirée » + impact + full-width « Reconnecter ».
 */
export function PhoneAlerts({ diagnostics, overview }: { diagnostics: DiagnosticBanner[]; overview: IntegrationsOverview }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {diagnostics.map((banner) => {
        const primary = banner.actions.find((action) => action.kind !== 'journal' && action.href) ?? banner.actions.find((action) => action.href);
        return (
          <section
            key={banner.target}
            role="alert"
            aria-label={phoneAlertTitle(banner, overview)}
            className={banner.tone === 'warn' ? 'flex flex-col gap-2.5 rounded-lg bg-warn-pale p-4' : 'flex flex-col gap-2.5 rounded-lg bg-danger-pale p-4'}
          >
            <div className="flex items-start gap-2">
              <Icon name={diagnosticIcon(banner, overview)} size={18} className={banner.tone === 'warn' ? 'mt-px text-warn' : 'mt-px text-danger'} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="m-0 font-sans text-app-15 font-semibold text-text">{phoneAlertTitle(banner, overview)}</p>
                <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{banner.body}</p>
              </div>
            </div>
            {primary ? <ActionButton action={primary} size="lg" /> : null}
          </section>
        );
      })}
    </div>
  );
}
