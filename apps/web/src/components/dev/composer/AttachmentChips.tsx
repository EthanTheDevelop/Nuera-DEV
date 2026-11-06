'use client';

import { useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { CompactButton, IconButton, Sheet, SheetContent, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_COPY,
  attachmentMeta,
  type ComposerAttachment,
} from './attachments';
import type { AttachmentsController } from './use-attachments';

/**
 * Chips of the files to send with the instruction: thumbnail (local image) or file icon, name,
 * size / « Envoi… » / error, and « Retirer ». Removed before sending = never referenced.
 */
export function AttachmentChips({
  attachments,
  className,
}: {
  attachments: AttachmentsController;
  className?: string;
}) {
  if (attachments.items.length === 0 && !attachments.notice) return null;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {attachments.items.length > 0 ? (
        <ul className="m-0 flex min-w-0 list-none flex-wrap gap-2 p-0" aria-label="Pièces jointes">
          {attachments.items.map((item) => (
            <AttachmentChip
              key={item.id}
              item={item}
              onRemove={() => attachments.remove(item.id)}
            />
          ))}
        </ul>
      ) : null}
      {attachments.notice ? (
        <p
          className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 font-sans text-app-12 text-danger"
          role="status"
        >
          <span className="min-w-0 break-words">Non joint : {attachments.notice}</span>
          <CompactButton
            variant="discret"
            onClick={attachments.dismissNotice}
            className="text-danger"
          >
            Fermer
          </CompactButton>
        </p>
      ) : null}
    </div>
  );
}

function AttachmentChip({ item, onRemove }: { item: ComposerAttachment; onRemove: () => void }) {
  const failed = item.status === 'error';
  return (
    <li
      data-attachment={item.status}
      className={cn(
        'flex h-11 max-w-full min-w-0 items-center gap-2 rounded-md border bg-surface-raised py-1 pr-0.5 pl-1',
        failed ? 'border-danger' : 'border-border',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-bg">
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL of the chosen file, never a remote image
          <img src={item.previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <Icon name="file" size={18} className="text-muted" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[160px] truncate font-sans text-app-12 font-medium text-text">
          {item.name}
        </span>
        <span
          className={cn(
            'flex items-center gap-1 font-mono text-app-11',
            failed ? 'text-danger' : 'text-muted',
          )}
        >
          {item.status === 'uploading' ? <Spinner size={10} /> : null}
          <span className="max-w-[160px] truncate">{attachmentMeta(item)}</span>
        </span>
      </span>
      <IconButton
        icon="x"
        label={ATTACHMENT_COPY.remove(item.name)}
        size="sm"
        iconSize={16}
        iconClassName="text-muted"
        onClick={onRemove}
      />
    </li>
  );
}

export interface AttachButtonProps {
  attachments: AttachmentsController;
  variant: 'desktop' | 'phone';
  /** Why files cannot be joined right now (the button stays, with its reason). */
  disabledReason?: string | null;
  onBlockedTap?: (reason: string) => void;
}

/**
 * « Joindre »: desktop = the file picker (several files, images included); phone = a sheet with
 * « Fichier ou photo de la bibliothèque » and « Prendre une photo » (`capture="environment"`).
 */
export function AttachButton({
  attachments,
  variant,
  disabledReason,
  onBlockedTap,
}: AttachButtonProps) {
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pick = (input: HTMLInputElement | null) => {
    setSheetOpen(false);
    input?.click();
  };
  const onFiles = (input: HTMLInputElement) => {
    if (input.files) attachments.add(Array.from(input.files));
    input.value = '';
  };
  const inputs = (
    <>
      <input
        ref={libraryRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        hidden
        data-attach="library"
        onChange={(e) => onFiles(e.currentTarget)}
      />
      {variant === 'phone' ? (
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-attach="camera"
          onChange={(e) => onFiles(e.currentTarget)}
        />
      ) : null}
    </>
  );
  const blocked = Boolean(disabledReason);
  const label = blocked ? `${ATTACHMENT_COPY.join} · ${disabledReason}` : ATTACHMENT_COPY.join;
  const onClick = () => {
    if (blocked) {
      onBlockedTap?.(disabledReason!);
      return;
    }
    if (variant === 'phone') setSheetOpen(true);
    else pick(libraryRef.current);
  };
  return (
    <>
      {inputs}
      <IconButton
        icon="paperclip"
        label={label}
        size={variant === 'phone' ? 'md' : 'sm'}
        iconSize={variant === 'phone' ? 20 : 18}
        iconClassName="text-muted"
        aria-disabled={blocked || undefined}
        aria-haspopup={variant === 'phone' ? 'dialog' : undefined}
        title={variant === 'desktop' ? label : undefined}
        onClick={onClick}
      />
      {variant === 'phone' ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            title={ATTACHMENT_COPY.join}
            description="Images, PDF, texte et code · 20 Mo et 5 fichiers au maximum"
          >
            <div className="flex flex-col gap-0.5 pb-3">
              <button
                type="button"
                onClick={() => pick(libraryRef.current)}
                className="flex min-h-12 items-center gap-3 rounded-md px-2 text-left font-sans text-app-14 text-text hover:bg-hover active:bg-pressed"
              >
                <Icon name="file" size={20} className="text-muted" />
                {ATTACHMENT_COPY.library}
              </button>
              <button
                type="button"
                onClick={() => pick(cameraRef.current)}
                className="flex min-h-12 items-center gap-3 rounded-md px-2 text-left font-sans text-app-14 text-text hover:bg-hover active:bg-pressed"
              >
                <Icon name="camera" size={20} className="text-muted" />
                {ATTACHMENT_COPY.camera}
              </button>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
