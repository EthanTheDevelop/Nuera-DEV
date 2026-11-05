'use client';

import { useMediaQuery, NAV_QUERY } from '@/hooks/useMediaQuery';
import { DesktopWorkspace } from './DesktopWorkspace';
import type { WorkspaceData } from './lib/contract';
import { PhoneWorkspace } from './PhoneWorkspace';
import { WorkspaceProvider } from './WorkspaceContext';

export interface WorkspaceViewProps {
  data: WorkspaceData;
  /** Server guess of the layout (user agent), so a phone does not paint the desktop first. */
  initialDesktop: boolean;
}

/**
 * Workspace Claude Code (`/workspace/[sessionId]`): D05 + W1–W7 at desktop widths (≥ 900 px),
 * M05 + S1–S4 on the phone. One live state (session stream, thread, changes) feeds both.
 */
export function WorkspaceView({ data, initialDesktop }: WorkspaceViewProps) {
  const desktop = useMediaQuery(NAV_QUERY, initialDesktop);
  return <WorkspaceProvider data={data}>{desktop ? <DesktopWorkspace /> : <PhoneWorkspace />}</WorkspaceProvider>;
}
