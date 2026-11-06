/**
 * Pieces jointes of a composer (pure, tested): what may be added, chip texts, and the `@<chemin>`
 * references appended to the instruction — the official CLI reads the files itself (images
 * included) from these paths of the worktree.
 */
import { formatBytes } from '@nuera/shared/format';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  attachmentKindOf,
  type AttachmentKind,
} from '@nuera/shared/attachments';

export {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  type AttachmentKind,
} from '@nuera/shared/attachments';

export type AttachmentStatus = 'uploading' | 'ready' | 'error';

export interface ComposerAttachment {
  /** Local id (chip key). */
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** Path in the worktree once stored (`.nuera/pieces-jointes/…`). */
  path: string | null;
  error: string | null;
  /** Object URL of a local image (thumbnail), revoked with the chip. */
  previewUrl: string | null;
}

export const ATTACHMENT_COPY = {
  join: 'Joindre',
  library: 'Fichier ou photo de la bibliothèque',
  camera: 'Prendre une photo',
  remove: (name: string) => `Retirer ${name}`,
  uploading: 'Envoi…',
  refusedType: 'type refusé (images, PDF, texte et code seulement)',
  tooLarge: 'plus de 20 Mo',
  empty: 'fichier vide',
  tooMany: `${ATTACHMENT_MAX_PER_MESSAGE} fichiers au maximum par message`,
  waitUpload: "Attendez la fin de l'envoi des pièces jointes.",
  afterCreate: 'Les pièces jointes se joignent une fois la session créée, depuis son compositeur.',
} as const;

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export interface AttachmentSelection<T extends FileLike> {
  accepted: Array<{ file: T; kind: AttachmentKind }>;
  refused: Array<{ name: string; reason: string }>;
}

/** Files of a picker or a drop, checked against the limits (the runner checks the bytes again). */
export function selectAttachments<T extends FileLike>(
  existing: readonly ComposerAttachment[],
  files: readonly T[],
): AttachmentSelection<T> {
  const result: AttachmentSelection<T> = { accepted: [], refused: [] };
  let count = existing.filter((a) => a.status !== 'error').length;
  for (const file of files) {
    const kind = attachmentKindOf(file.name);
    if (!kind) result.refused.push({ name: file.name, reason: ATTACHMENT_COPY.refusedType });
    else if (file.size <= 0)
      result.refused.push({ name: file.name, reason: ATTACHMENT_COPY.empty });
    else if (file.size > ATTACHMENT_MAX_BYTES)
      result.refused.push({ name: file.name, reason: ATTACHMENT_COPY.tooLarge });
    else if (count >= ATTACHMENT_MAX_PER_MESSAGE)
      result.refused.push({ name: file.name, reason: ATTACHMENT_COPY.tooMany });
    else {
      result.accepted.push({ file, kind });
      count += 1;
    }
  }
  return result;
}

/** « photo.png : plus de 20 Mo · notes.zip : type refusé (…) ». */
export function refusedText(
  refused: ReadonlyArray<{ name: string; reason: string }>,
): string | null {
  if (refused.length === 0) return null;
  return refused.map((r) => `${r.name} : ${r.reason}`).join(' · ');
}

/** Chip meta: « 2,4 Mo », « Envoi… », or the error. */
export function attachmentMeta(
  attachment: Pick<ComposerAttachment, 'size' | 'status' | 'error'>,
): string {
  if (attachment.status === 'uploading') return ATTACHMENT_COPY.uploading;
  if (attachment.status === 'error') return attachment.error ?? "Échec de l'envoi";
  return formatBytes(attachment.size);
}

/** The instruction as sent: the text, then one `@<chemin>` per stored file (blank line between). */
export function withAttachmentReferences(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (paths.length === 0) return body;
  const refs = paths.map((p) => `@${p}`).join(' ');
  return body ? `${body}\n\n${refs}` : refs;
}

/** Stored paths, in the order of the chips. */
export function readyPaths(attachments: readonly ComposerAttachment[]): string[] {
  return attachments.filter((a) => a.status === 'ready' && a.path).map((a) => a.path!);
}
