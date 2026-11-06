'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readyPaths, refusedText, selectAttachments, type ComposerAttachment } from './attachments';

export interface UseAttachmentsOptions {
  /** Stores one file on the server; resolves with its path in the worktree. */
  upload: (file: File, signal: AbortSignal) => Promise<{ path: string }>;
  /** Error message of a failed upload (French copy of the route). */
  errorMessage?: (error: unknown) => string;
}

export interface AttachmentsController {
  items: ComposerAttachment[];
  /** Picker / drop / paste: checked against the limits, then uploaded one by one. */
  add: (files: FileList | readonly File[]) => void;
  remove: (id: string) => void;
  /** After a successful send. */
  clear: () => void;
  paths: string[];
  uploading: boolean;
  /** Files refused by the limits (shown under the chips until the next change). */
  notice: string | null;
  dismissNotice: () => void;
}

let seq = 0;

/**
 * Chips of a composer: thumbnails of local images (object URLs, revoked with their chip), upload
 * started as soon as a file is chosen (the instruction then only waits for the ones still on their
 * way), cancellation when a chip is removed.
 */
export function useAttachments({
  upload,
  errorMessage,
}: UseAttachmentsOptions): AttachmentsController {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const itemsRef = useRef(items);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const release = useCallback((attachment: ComposerAttachment) => {
    controllers.current.get(attachment.id)?.abort();
    controllers.current.delete(attachment.id);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }, []);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) release(item);
    },
    [release],
  );

  const add = useCallback(
    (list: FileList | readonly File[]) => {
      const files = Array.from(list as ArrayLike<File>);
      if (files.length === 0) return;
      const selection = selectAttachments(itemsRef.current, files);
      setNotice(refusedText(selection.refused));
      const added: ComposerAttachment[] = selection.accepted.map(({ file, kind }) => ({
        id: `pj-${Date.now().toString(36)}-${(seq += 1)}`,
        name: file.name,
        size: file.size,
        kind,
        status: 'uploading',
        path: null,
        error: null,
        previewUrl:
          kind === 'image' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : null,
      }));
      if (added.length === 0) return;
      itemsRef.current = [...itemsRef.current, ...added];
      setItems(itemsRef.current);
      selection.accepted.forEach(({ file }, i) => {
        const id = added[i]!.id;
        const controller = new AbortController();
        controllers.current.set(id, controller);
        upload(file, controller.signal)
          .then((result) => {
            setItems((current) =>
              current.map((a) => (a.id === id ? { ...a, status: 'ready', path: result.path } : a)),
            );
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            const message = errorMessage ? errorMessage(error) : "Échec de l'envoi";
            setItems((current) =>
              current.map((a) => (a.id === id ? { ...a, status: 'error', error: message } : a)),
            );
          })
          .finally(() => controllers.current.delete(id));
      });
    },
    [errorMessage, upload],
  );

  const remove = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((a) => a.id === id);
      if (target) release(target);
      itemsRef.current = itemsRef.current.filter((a) => a.id !== id);
      setItems(itemsRef.current);
      setNotice(null);
    },
    [release],
  );

  const clear = useCallback(() => {
    for (const item of itemsRef.current) release(item);
    itemsRef.current = [];
    setItems([]);
    setNotice(null);
  }, [release]);

  return {
    items,
    add,
    remove,
    clear,
    paths: readyPaths(items),
    uploading: items.some((a) => a.status === 'uploading'),
    notice,
    dismissNotice: () => setNotice(null),
  };
}
