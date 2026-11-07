'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildPaletteItems,
  useAttachments,
  type ComposerTools,
  type PaletteSource,
} from '@/components/dev';
import { toast } from '@/components/ui';
import {
  fetchComposerPalette,
  fetchTree,
  setEffortRequest,
  setModelRequest,
  setPermissionModeRequest,
  uploadAttachmentRequest,
  WorkspaceApiError,
} from '../api';
import {
  COMPOSER_EFFORT_OPTIONS,
  COMPOSER_MODE_HINTS,
  COMPOSER_MODE_LABELS,
  COMPOSER_MODE_SHORT,
  SWITCHABLE_MODES,
  composerModelOptions,
  effortChipLabel,
  type ComposerPaletteData,
  type SwitchablePermissionMode,
} from '../lib/composer';
import { isLiveStatus } from '../lib/contract';
import { toActionError, useWorkspace, type ActionError } from '../WorkspaceContext';

const NEXT_LAUNCH_NOTE = "S'applique au prochain démarrage de Claude Code dans cette session.";
const PENDING_MODEL_MS = 10_000;

/** What the model chip shows: the model of the CLI's status line, else the `--model` of the next launch. */
export function modelChipLabel(input: {
  reported: { id: string | null; displayName: string | null } | null;
  launch: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
}): string {
  if (input.reported && (input.reported.displayName || input.reported.id))
    return (input.reported.displayName || input.reported.id)!;
  if (!input.launch) return 'Modèle par défaut';
  return `${input.options.find((o) => o.value === input.launch)?.label ?? input.launch} · au démarrage`;
}

/**
 * Tools of the Workspace composer: « Joindre » (files stored in the session's worktree and sent as
 * `@<chemin>`), the model chip (`/model`) and the mode chip (Maj+Tab) — both show what the CLI
 * reports —, the « / » palette (curated commands, skills, MCP of the project, `@` files).
 */
export function useWorkspaceComposerTools(variant: 'desktop' | 'phone'): {
  tools: ComposerTools;
  error: ActionError | null;
  clearError: () => void;
} {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  const sessionId = ws.data.session.id;
  const worktreeId = ws.data.worktree?.present ? ws.data.worktree.id : null;
  const [error, setError] = useState<ActionError | null>(null);

  // --- Palette data (skills, MCP, models), read once per page -----------------------------------
  const [palette, setPalette] = useState<{
    data: ComposerPaletteData | null;
    loading: boolean;
    failed: string | null;
  }>({ data: null, loading: true, failed: null });
  useEffect(() => {
    const controller = new AbortController();
    fetchComposerPalette(sessionId, controller.signal)
      .then((data) => setPalette({ data, loading: false, failed: null }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setPalette({
            data: null,
            loading: false,
            failed:
              e instanceof WorkspaceApiError ? e.message : 'Skills et outils MCP indisponibles.',
          });
      });
    return () => controller.abort();
  }, [sessionId]);

  const loadFiles = useCallback(
    async (dir: string, signal: AbortSignal) => (await fetchTree(worktreeId!, dir, signal)).entries,
    [worktreeId],
  );
  const source = useMemo<PaletteSource>(
    () => ({
      items: buildPaletteItems({
        skills: palette.data?.skills ?? null,
        mcp: palette.data?.mcp ?? [],
      }),
      ...(worktreeId ? { loadFiles } : {}),
      loading: palette.loading,
      notice: palette.failed ?? palette.data?.skillsError ?? null,
    }),
    [loadFiles, palette, worktreeId],
  );

  // --- Pieces jointes ------------------------------------------------------------------------------
  const upload = useCallback(
    (file: File, signal: AbortSignal) => uploadAttachmentRequest(sessionId, file, signal),
    [sessionId],
  );
  const attachments = useAttachments({
    upload,
    errorMessage: (e) => (e instanceof WorkspaceApiError ? e.message : "Échec de l'envoi"),
  });

  // --- Why a chip waits ----------------------------------------------------------------------------
  const live = Boolean(session.live) && isLiveStatus(session.status);
  const blocked =
    ws.serverDisabledReason ??
    (ws.composer.state === 'unavailable'
      ? (ws.composer.reason ?? 'Session indisponible.')
      : null) ??
    (session.status === 'waiting_permission'
      ? "Répondez d'abord à la demande d'autorisation."
      : null);

  // --- Model chip ----------------------------------------------------------------------------------
  const models = palette.data?.models ?? composerModelOptions([]);
  const reported = session.cliStatus?.model ?? null;
  const [pendingModel, setPendingModel] = useState<{
    value: string;
    from: string | null;
    until: number;
  } | null>(null);
  const reportedId = reported?.id ?? null;
  useEffect(() => {
    if (!pendingModel) return;
    if (reportedId !== pendingModel.from) {
      const done = setTimeout(() => setPendingModel(null), 0);
      return () => clearTimeout(done);
    }
    const timer = setTimeout(
      () => setPendingModel(null),
      Math.max(0, pendingModel.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pendingModel, reportedId]);
  const [sendingModel, setSendingModel] = useState(false);
  const selectModel = useCallback(
    async (value: string) => {
      setSendingModel(true);
      setError(null);
      try {
        const result = await setModelRequest(sessionId, value);
        ws.ctl.dispatch({ type: 'session', patch: { model: result.session.model } });
        const label = models.find((m) => m.value === value)?.label ?? value;
        if (result.applied === 'live') {
          setPendingModel({ value, from: reportedId, until: Date.now() + PENDING_MODEL_MS });
          toast({
            message: `/model ${value} tapé dans le CLI : la barre d'état confirmera le modèle.`,
          });
        } else toast({ message: `Modèle « ${label} » au prochain démarrage de Claude Code.` });
      } catch (e) {
        setError(toActionError(e, "Le modèle n'a pas changé"));
      } finally {
        setSendingModel(false);
      }
    },
    [models, reportedId, sessionId, ws.ctl],
  );
  const modelBusy =
    live && session.status === 'running' ? "Disponible à la fin de l'étape en cours." : null;

  // --- Effort chip ---------------------------------------------------------------------------------
  const reportedEffort = session.cliStatus?.effort ?? null;
  const [sendingEffort, setSendingEffort] = useState(false);
  const selectEffort = useCallback(
    async (value: string) => {
      setSendingEffort(true);
      setError(null);
      try {
        const result = await setEffortRequest(sessionId, value);
        ws.ctl.dispatch({
          type: 'session',
          patch: {
            effort: result.session.effort,
            ...(result.applied === 'live' && session.cliStatus
              ? { cliStatus: { ...session.cliStatus, effort: result.session.cliStatus?.effort ?? null } }
              : {}),
          },
        });
        const label = COMPOSER_EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
        toast({
          message:
            result.applied === 'live'
              ? `/effort ${value} confirmé par le CLI.`
              : `Effort « ${label} » au prochain démarrage de Claude Code.`,
        });
      } catch (e) {
        setError(toActionError(e, "L'effort n'a pas changé"));
      } finally {
        setSendingEffort(false);
      }
    },
    [session.cliStatus, sessionId, ws.ctl],
  );

  // --- Mode chip -----------------------------------------------------------------------------------
  const [sendingMode, setSendingMode] = useState(false);
  const selectMode = useCallback(
    async (value: string) => {
      setSendingMode(true);
      setError(null);
      try {
        const result = await setPermissionModeRequest(sessionId, value as SwitchablePermissionMode);
        ws.ctl.dispatch({
          type: 'session',
          patch: { permissionMode: result.mode as typeof session.permissionMode },
        });
        const label = COMPOSER_MODE_LABELS[result.mode as typeof session.permissionMode];
        toast({
          message:
            result.applied === 'live'
              ? `Mode « ${label} » affiché par le CLI.`
              : `Mode « ${label} » au prochain démarrage de Claude Code.`,
        });
      } catch (e) {
        setError(toActionError(e, "Le mode n'a pas changé"));
        // The CLI may have stopped on another mode: its status event tells which.
      } finally {
        setSendingMode(false);
      }
    },
    [sessionId, ws.ctl],
  );

  const tools: ComposerTools = {
    attachments,
    attachDisabledReason: worktreeId
      ? null
      : 'Le worktree de cette session a été supprimé : rien ne peut être joint.',
    model: {
      title: 'Modèle de la session',
      label: modelChipLabel({ reported, launch: session.model, options: models }),
      options: models,
      value: models.find((m) => m.value === reportedId)?.value ?? session.model,
      onSelect: (value) => void selectModel(value),
      pending: sendingModel || Boolean(pendingModel),
      disabledReason: blocked ?? modelBusy,
      note: live ? 'Tapé dans le CLI (/model), une fois Claude au repos.' : NEXT_LAUNCH_NOTE,
    },
    effort: {
      title: "Niveau d'effort",
      label: effortChipLabel({ reported: live ? reportedEffort : null, launch: session.effort, live }),
      options: COMPOSER_EFFORT_OPTIONS,
      value: (live ? reportedEffort : null) ?? session.effort ?? 'auto',
      onSelect: (value) => void selectEffort(value),
      pending: sendingEffort,
      disabledReason: blocked ?? modelBusy,
      note: live ? 'Tapé dans le CLI (/effort), une fois Claude au repos.' : NEXT_LAUNCH_NOTE,
    },
    mode: {
      title: 'Mode de permission',
      label:
        variant === 'phone'
          ? COMPOSER_MODE_SHORT[session.permissionMode]
          : COMPOSER_MODE_LABELS[session.permissionMode],
      options: SWITCHABLE_MODES.map((mode) => ({
        value: mode,
        label: COMPOSER_MODE_LABELS[mode],
        description: COMPOSER_MODE_HINTS[mode],
      })),
      value: session.permissionMode,
      onSelect: (value) => void selectMode(value),
      pending: sendingMode,
      disabledReason: blocked,
      note: live
        ? "Maj+Tab envoyé au CLI jusqu'à ce que son écran affiche le mode."
        : NEXT_LAUNCH_NOTE,
    },
    palette: source,
  };
  return { tools, error, clearError: () => setError(null) };
}
