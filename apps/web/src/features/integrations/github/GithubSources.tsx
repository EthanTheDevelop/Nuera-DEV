'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CompactButton, ConfirmDialog, Dialog, DialogContent, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { integrationsApi, toApiError } from '../api';
import { sourceInUseSentence } from '../model';
import type { GithubOverview, GithubSourceStatus } from '../types';
import { ConnectGithubForm } from './ConnectGithubForm';
import { GithubSection } from './GithubSection';

export interface GithubSourcesProps {
  github: GithubOverview;
  onChanged: () => void;
  variant: 'desktop' | 'phone';
}

/**
 * GitHub sources of the space (MULTICOMPTE §7): the D07 featured tile (M07 card) unchanged when the
 * space has one source — or none (connect form) —, one tile per source when it has several, each
 * with its own « Vérifier la connexion », repositories, journal and « Déconnecter ». Under the tiles:
 * « Ajouter une source GitHub » (the manifest form: personal account or organisation, private unless
 * public), and « Déconnecter » of the single source. `?source=<id>` scrolls to that source.
 */
export function GithubSources({ github, onChanged, variant }: GithubSourcesProps) {
  const params = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [disconnecting, setDisconnecting] = useState<GithubSourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sources = github.sources ?? [];
  const several = sources.length > 1;
  const single = sources.length === 1 ? sources[0]! : null;
  const phone = variant === 'phone';
  const focus = params.get('source');

  useEffect(() => {
    if (!focus || !several) return;
    const element = document.getElementById(`github-source-${focus}${phone ? '-phone' : ''}`);
    if (element && element.offsetParent !== null) element.scrollIntoView({ block: 'center' });
  }, [focus, several, phone]);

  const disconnect = async () => {
    if (!disconnecting) return;
    setError(null);
    try {
      await integrationsApi.disconnectGithubSource(disconnecting.id);
      setDisconnecting(null);
      toast({ message: several ? `Source GitHub « ${disconnecting.label} » déconnectée` : 'GitHub déconnecté', icon: 'github' });
      onChanged();
    } catch (cause) {
      const apiError = toApiError(cause);
      setError([apiError.message, apiError.detail].filter(Boolean).join(' '));
      throw apiError;
    }
  };

  const blocked = disconnecting ? sourceInUseSentence(disconnecting.projects) : null;

  return (
    <div className={cn('flex flex-col', phone ? 'gap-3' : 'gap-4')}>
      {several ? (
        sources.map((source) => (
          <GithubSection
            key={source.id}
            github={source}
            sourceId={source.id}
            several
            onChanged={onChanged}
            variant={variant}
            onDisconnect={() => {
              setError(null);
              setDisconnecting(source);
            }}
          />
        ))
      ) : (
        <GithubSection github={github} sourceId={single?.id ?? null} onChanged={onChanged} variant={variant} />
      )}

      {sources.length > 0 ? (
        <div className={cn('flex flex-wrap items-center gap-2', phone && 'flex-col items-stretch')}>
          {github.canAddSource ? (
            <CompactButton variant="secondaire" icon="plus" size={phone ? 'lg' : 'md'} block={phone} onClick={() => setAdding(true)}>
              Ajouter une source GitHub
            </CompactButton>
          ) : (
            <p className="m-0 font-sans text-app-12 text-muted">{`${github.maxSources} sources GitHub au plus par espace : déconnectez-en une pour en ajouter une autre.`}</p>
          )}
          {single ? (
            <CompactButton
              variant="discret"
              size={phone ? 'lg' : 'md'}
              block={phone}
              onClick={() => {
                setError(null);
                setDisconnecting(single);
              }}
            >
              Déconnecter la source
            </CompactButton>
          ) : null}
        </div>
      ) : null}

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding ? (
          <DialogContent
            title="Ajouter une source GitHub"
            description="Une nouvelle application GitHub de Nuera Dev, créée sur GitHub en un clic puis installée sur les comptes et les dépôts de votre choix. Aucun jeton n'est saisi à la main."
          >
            <ConnectGithubForm variant={phone ? 'phone' : 'dialog'} />
          </DialogContent>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        tone="danger"
        icon="github"
        title={disconnecting ? (several ? `Déconnecter la source GitHub « ${disconnecting.label} » ?` : 'Déconnecter GitHub ?') : ''}
        consequences={[
          { kind: 'risk', text: "Les identifiants de l'application sont supprimés de Nuera Dev : plus de clonage, de push ni de pull request par cette source." },
          { kind: 'kept', text: "L'application reste sur GitHub : vous pouvez la supprimer depuis GitHub." },
          { kind: 'kept', text: 'Les dépôts et le travail local des projets ne sont pas touchés.' },
        ]}
        confirmLabel="Déconnecter"
        confirmTone="danger"
        onConfirm={disconnect}
        error={error ?? undefined}
        confirmDisabled={blocked ? `${blocked} Archivez ces projets avant de déconnecter la source.` : undefined}
      />
    </div>
  );
}
