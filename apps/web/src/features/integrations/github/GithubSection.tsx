'use client';

import { useState, type ReactNode } from 'react';
import { LiveTime } from '@/components/dev';
import { Badge, Banner, Button, Card, CompactButton, Pastille, SectionLabel, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { integrationsApi, toApiError, type IntegrationsApiError } from '../api';
import { githubTile, type GithubTileModel } from '../model';
import type { GithubStatus } from '../types';
import { ConnectGithubForm } from './ConnectGithubForm';
import { ReposDialog } from './ReposDialog';

export interface GithubSectionProps {
  github: GithubStatus;
  /** Re-reads the page data (deferred while the drawer is open). */
  onChanged: () => void;
  /** `desktop` = D07 featured tile (216:2120) · `phone` = M07 card. */
  variant: 'desktop' | 'phone';
}

/** GitHub navigation for internal API routes (redirects to github.com): a full navigation, never a client one. */
function goTo(href: string, external: boolean) {
  if (external) window.open(href, '_blank', 'noopener,noreferrer');
  else window.location.assign(href);
}

function PrimaryAction({ primary, size }: { primary: NonNullable<GithubTileModel['primary']>; size: 'desktop' | 'phone' }) {
  if (size === 'phone') {
    return primary.external ? (
      <CompactButton variant="secondaire" size="lg" block href={primary.href} external className="flex-1">
        {primary.label}
      </CompactButton>
    ) : (
      <CompactButton variant="secondaire" size="lg" block onClick={() => goTo(primary.href, false)} className="flex-1">
        {primary.label}
      </CompactButton>
    );
  }
  return primary.external ? (
    <Button variant="default" href={primary.href} external>
      {primary.label}
    </Button>
  ) : (
    <Button variant="default" onClick={() => goTo(primary.href, false)}>
      {primary.label}
    </Button>
  );
}

/**
 * GitHub integration: D07 featured tile (header, three detail boxes, « Vérifier la connexion »,
 * « Voir les N dépôts », expiry line) or the condensed M07 card, plus the « Connecter GitHub »
 * manifest form when no GitHub App is registered. Every value comes from `getGithubStatus()`.
 */
export function GithubSection({ github, onChanged, variant }: GithubSectionProps) {
  const model = githubTile(github);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<IntegrationsApiError | { message: string; detail?: string } | null>(null);
  const [reposOpen, setReposOpen] = useState(false);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const result = await integrationsApi.checkGithub();
      if (result.status === 'connected' || result.status === 'expiring') toast({ message: 'Connexion GitHub vérifiée', icon: 'check' });
      else setCheckError({ message: 'La vérification de GitHub a échoué', detail: result.reason ?? undefined });
      onChanged();
    } catch (error) {
      setCheckError(toApiError(error));
    } finally {
      setChecking(false);
    }
  };

  const errorBanner = checkError ? (
    <Banner tone="danger" title={checkError.message}>
      {[checkError.detail, 'Rien n\'a été modifié sur GitHub.'].filter(Boolean).join(' ')}
    </Banner>
  ) : null;

  const repos = model.repoCount !== null && model.repoCount > 0 ? <ReposDialog open={reposOpen} onOpenChange={setReposOpen} /> : null;

  if (variant === 'phone') {
    return (
      <Card variant="card" as="section" aria-labelledby="github-phone-title" className="gap-3 border-[1.5px] border-accent">
        <div className="flex min-w-0 items-center gap-3">
          <Pastille icon="github" size={32} className="size-9 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="github-phone-title" className="m-0 truncate font-sans text-app-16 font-semibold text-text">
              GitHub
            </h2>
            <p className="m-0 truncate font-sans text-app-12 text-muted">{model.phoneSubtitle}</p>
          </div>
          <Badge tone={model.badge.tone}>{model.badge.label}</Badge>
        </div>
        {model.phoneSummary || model.details?.lastCheck.at ? (
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">
            {model.phoneSummary}
            {model.details?.lastCheck.at ? (
              <>
                {model.phoneSummary ? ' · ' : ''}
                <LiveTime value={model.details.lastCheck.at} format="relative" prefix="vérifiée " />
              </>
            ) : null}
          </p>
        ) : (
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{model.description}</p>
        )}
        {model.canCheck || model.primary ? (
          <div className="flex gap-2">
            {model.canCheck ? (
              <CompactButton variant="secondaire" size="lg" icon="refresh" block loading={checking} onClick={check} className="flex-1">
                Vérifier
              </CompactButton>
            ) : null}
            {model.primary ? <PrimaryAction primary={model.primary} size="phone" /> : null}
          </div>
        ) : null}
        {errorBanner}
        {model.connectForm ? <ConnectGithubForm variant="phone" /> : null}
      </Card>
    );
  }

  return (
    <Card variant="tile" padding="xl" as="section" aria-labelledby="github-title" className="gap-4 border-[1.5px] border-accent">
      <div className="flex min-w-0 items-center gap-4">
        <Pastille icon="github" size={48} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="github-title" className="m-0 font-sans text-app-18 font-semibold text-text">
            GitHub · import et synchronisation des dépôts
          </h2>
          <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{model.description}</p>
        </div>
        <Badge tone={model.badge.tone}>{model.badge.label}</Badge>
        {model.primary ? <PrimaryAction primary={model.primary} size="desktop" /> : null}
      </div>
      {model.details ? (
        <div className="grid grid-cols-3 gap-4">
          <DetailBox label="Dépôts accessibles" value={model.details.repos.value} caption={model.details.repos.caption} />
          <DetailBox label="Droits" value={model.details.rights.value} caption={model.details.rights.caption} warn={model.details.rights.warn} />
          <DetailBox
            label="Dernière vérification"
            value={model.details.lastCheck.at ? <LiveTime value={model.details.lastCheck.at} format="relative" /> : 'jamais'}
            caption={model.details.lastCheck.caption}
            warn={model.details.lastCheck.failing}
          />
        </div>
      ) : null}
      {model.canCheck ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CompactButton variant="secondaire" icon="refresh" loading={checking} onClick={check}>
            Vérifier la connexion
          </CompactButton>
          {model.repoCount !== null && model.repoCount > 0 ? (
            <CompactButton variant="discret" onClick={() => setReposOpen(true)}>
              {`Voir les ${model.repoCount} dépôts`}
            </CompactButton>
          ) : null}
          {model.note ? <p className="m-0 min-w-0 flex-1 font-sans text-app-12 text-muted">{model.note}</p> : null}
        </div>
      ) : null}
      {errorBanner}
      {model.connectForm ? <ConnectGithubForm variant="desktop" /> : null}
      {repos}
    </Card>
  );
}

function DetailBox({ label, value, caption, warn }: { label: string; value: ReactNode; caption: string; warn?: boolean }) {
  return (
    <Card variant="inset" padding="none" className="gap-1 px-4 py-3">
      <SectionLabel>{label}</SectionLabel>
      <p className="m-0 truncate font-sans text-app-16 font-semibold text-text">{value}</p>
      <p className={cn('m-0 font-sans text-app-12 text-muted', warn && 'text-danger')}>{caption}</p>
    </Card>
  );
}
