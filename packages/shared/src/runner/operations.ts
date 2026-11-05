import { z } from 'zod';
import { IsoDateSchema, OperationKindSchema, OperationStatusSchema, UuidSchema } from './common';

export const OperationStepSchema = z.object({
  key: z.string(),
  /** French label shown in the UI (« Cloner le dépôt »). */
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  /** Formatted meta (« 84 Mo · 12 s », « en cours · 31 s », « en attente »). */
  detail: z.string().optional(),
  startedAt: IsoDateSchema.optional(),
  finishedAt: IsoDateSchema.optional(),
  /** Step progress 0–100 when measurable. */
  progress: z.number().optional(),
  bytes: z.number().optional(),
});
export type OperationStepDto = z.infer<typeof OperationStepSchema>;

export const OperationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  untouched: z.string().optional(),
  raw: z.string().optional(),
  reason: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const OperationDtoSchema = z.object({
  id: UuidSchema,
  kind: OperationKindSchema,
  status: OperationStatusSchema,
  projectId: UuidSchema.nullable(),
  worktreeId: UuidSchema.nullable(),
  sessionId: UuidSchema.nullable(),
  title: z.string().nullable(),
  /** Overall progress 0–100 (null when not measurable). */
  progress: z.number().int().nullable(),
  steps: z.array(OperationStepSchema),
  error: OperationErrorSchema.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
});
export type OperationDto = z.infer<typeof OperationDtoSchema>;

export const OperationSnapshotSchema = OperationDtoSchema.extend({
  /** Journal (finalised lines, last ~64 KiB). */
  log: z.string(),
  /** Line being updated in place (git progress, spinner), not yet final. */
  liveLine: z.string().nullable(),
});
export type OperationSnapshot = z.infer<typeof OperationSnapshotSchema>;
