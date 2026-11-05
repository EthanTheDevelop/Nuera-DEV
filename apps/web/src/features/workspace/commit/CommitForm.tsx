'use client';

import { ChangedFileRow, formatLineDelta, toChangeStatus } from '@/components/dev';
import { Icon } from '@/components/icons';
import { ErrorPanel, Field, Input, LinkButton, Switch, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useId } from 'react';
import type { CommitFlow } from './useCommitFlow';

/** W5 `Case` (18 × 18, accent when checked), 44 px hit area. */
function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'nu-hit inline-flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors duration-(--dur-fast)',
        checked ? 'border-accent bg-accent text-on-accent' : 'border-border bg-bg',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      {checked ? <Icon name="check" size={12} /> : null}
    </button>
  );
}

function OptionRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  border,
  variant,
}: {
  title: string;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  border?: boolean;
  variant: 'dialog' | 'phone';
}) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-3', variant === 'dialog' ? 'px-4 py-3' : 'min-h-12 px-3', border && 'border-b border-border')}>
      <label htmlFor={id} className={cn('flex min-w-0 flex-1 flex-col gap-0.5', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
        <span className={cn('font-sans text-app-14 text-text', variant === 'dialog' && 'font-medium')}>{title}</span>
        {description ? <span className="font-sans text-app-12 text-muted">{description}</span> : null}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/**
 * Body of W5 `Modale · Préparer le commit` (231:3904) and of the S3 Git tab: included files, commit
 * message + description, push / pull request switches, pull request title.
 */
export function CommitForm({ flow, variant }: { flow: CommitFlow; variant: 'dialog' | 'phone' }) {
  const { draft, setDraft, files, included, totals } = flow;
  const busy = flow.step !== null;
  const phone = variant === 'phone';
  const messageId = useId();

  return (
    <div className={cn('flex flex-col', phone ? 'gap-3.5' : 'gap-[18px]')}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <p className={cn('m-0 min-w-0 flex-1 font-sans text-text', phone ? 'text-app-14 font-semibold' : 'text-app-13 font-medium')}>
            {phone
              ? `${included.length} ${included.length >= 2 ? 'fichiers' : 'fichier'} à committer`
              : `Fichiers inclus · ${included.length} sur ${files.length}`}
          </p>
          <span className="font-mono text-app-12 text-muted">{formatLineDelta(totals.insertions, totals.deletions)}</span>
          {files.length > 1 ? (
            <LinkButton size={13} onClick={flow.toggleAll} disabled={busy}>
              {included.length === files.length ? 'Tout retirer' : 'Tout inclure'}
            </LinkButton>
          ) : null}
        </div>
        {files.length > 0 ? (
          <ul className={cn('m-0 flex list-none flex-col rounded-md border border-border p-0', phone ? 'px-1 py-0.5' : 'px-2 py-1')}>
            {files.map((file) => {
              const checked = !draft.excluded.includes(file.path);
              return (
                <li key={file.path}>
                  <ChangedFileRow
                    status={toChangeStatus(file.status)}
                    path={file.path}
                    oldPath={file.oldPath}
                    additions={file.insertions}
                    deletions={file.deletions}
                    binary={file.binary}
                    leading={<Checkbox checked={checked} onChange={() => flow.toggleFile(file.path)} label={`Inclure ${file.path}`} disabled={busy} />}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 rounded-md border border-border px-3 py-2.5 font-sans text-app-13 text-muted">
            Aucun fichier modifié : seuls les commits déjà faits sur {flow.branch ?? 'cette branche'} partiront.
          </p>
        )}
      </div>

      {files.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Field label="Message de commit" id={messageId}>
            {phone ? (
              <Textarea
                mono
                rows={2}
                value={draft.message}
                onChange={(e) => setDraft({ message: e.target.value.replace(/\n/g, ' ') })}
                placeholder="Résumé du changement, en une ligne"
                maxLength={500}
                disabled={busy || included.length === 0}
              />
            ) : (
              <Input
                mono
                value={draft.message}
                onChange={(e) => setDraft({ message: e.target.value })}
                placeholder="Résumé du changement, en une ligne"
                maxLength={500}
                autoFocus
                disabled={busy || included.length === 0}
                className="text-app-14"
              />
            )}
          </Field>
          {phone ? null : (
            <Textarea
              mono
              rows={3}
              aria-label="Description du commit"
              value={draft.body}
              onChange={(e) => setDraft({ body: e.target.value })}
              placeholder="Description (facultative) : ce qui change et pourquoi"
              disabled={busy || included.length === 0}
              className="text-app-12"
            />
          )}
        </div>
      ) : null}

      <div className="flex flex-col rounded-md border border-border">
        <OptionRow
          variant={variant}
          border
          title={phone ? 'Pousser sur origin' : `Pousser sur origin/${flow.branch ?? ''}`}
          description={flow.pushBlockedReason ?? (phone ? undefined : "Le push part après le commit, avec l'accès GitHub de l'application.")}
          checked={draft.push}
          onChange={(value) => setDraft({ push: value })}
          disabled={busy || Boolean(flow.pushBlockedReason)}
        />
        <OptionRow
          variant={variant}
          title={phone ? 'Ouvrir une pull request' : `Ouvrir une pull request vers ${flow.base}`}
          description={
            flow.openPullRequest ? (
              <>
                {`Pull request #${flow.openPullRequest.number} déjà ouverte : le push la met à jour. `}
                <a href={flow.openPullRequest.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                  Voir sur GitHub
                </a>
              </>
            ) : phone ? undefined : (
              'Titre et description repris du commit, modifiables sur GitHub.'
            )
          }
          checked={flow.openPr}
          onChange={(value) => setDraft({ openPr: value })}
          disabled={busy || !draft.push || Boolean(flow.openPullRequest)}
        />
      </div>

      {flow.openPr && !phone ? (
        <Field label="Titre de la pull request">
          <Input
            value={flow.prTitle}
            onChange={(e) => setDraft({ prTitle: e.target.value, prTitleEdited: true })}
            placeholder="Titre de la pull request"
            maxLength={256}
            disabled={busy}
          />
        </Field>
      ) : null}

      {flow.error ? (
        <ErrorPanel
          title={flow.error.title}
          excerpt={flow.error.message}
          untouched={flow.error.untouched}
          raw={flow.error.raw ?? null}
          onRetry={() => void flow.submit()}
          retrying={busy}
        />
      ) : null}
    </div>
  );
}
