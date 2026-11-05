'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Banner, CompactButton, toast } from '@/components/ui';
import { githubNotice, isGithubOutcome } from '../model';

function clearParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete('github');
  url.searchParams.delete('compte');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export interface GithubNoticeProps {
  /** Install route (GitHub App registered), or null. */
  installUrl: string | null;
  /** « Vérifier la connexion » for `installation_failed`. */
  onCheck: () => void;
}

/**
 * Result of a GitHub return route (`/integrations?github=<code>&compte=<login>`, docs/INTEGRATIONS.md
 * §2.2): success → T3 toast, shown once (the params are removed from the URL); anything else → a
 * banner at the top of the page that stays until dismissed, with the action that makes sense.
 */
export function GithubNotice({ installUrl, onCheck }: GithubNoticeProps) {
  const params = useSearchParams();
  const outcome = params.get('github');
  const account = params.get('compte');
  const notice = isGithubOutcome(outcome) ? githubNotice(outcome, account) : null;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!notice || notice.kind !== 'toast') return;
    const key = `${outcome}:${account ?? ''}`;
    if (shown.current === key) return;
    shown.current = key;
    toast({ message: notice.message, icon: 'github' });
    clearParams();
  }, [notice, outcome, account]);

  if (!notice || notice.kind !== 'banner') return null;
  const dismiss = () => clearParams();
  const action =
    notice.action === 'install' && installUrl ? (
      <CompactButton variant="secondaire" icon="external" onClick={() => window.location.assign(installUrl)}>
        Installer sur GitHub
      </CompactButton>
    ) : notice.action === 'check' ? (
      <CompactButton
        variant="secondaire"
        icon="refresh"
        onClick={() => {
          dismiss();
          onCheck();
        }}
      >
        Vérifier la connexion
      </CompactButton>
    ) : notice.action === 'connect' && installUrl ? (
      <CompactButton variant="secondaire" onClick={() => window.location.assign(installUrl)}>
        Recommencer
      </CompactButton>
    ) : notice.action === 'connect' ? (
      <CompactButton variant="secondaire" href="#github-title" onClick={dismiss}>
        Recommencer
      </CompactButton>
    ) : null;
  return (
    <Banner
      tone={notice.tone}
      icon="github"
      title={notice.title}
      action={
        <>
          {action}
          <CompactButton variant="discret" onClick={dismiss}>
            Fermer
          </CompactButton>
        </>
      }
    >
      {notice.body}
    </Banner>
  );
}
