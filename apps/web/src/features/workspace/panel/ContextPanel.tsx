'use client';

import { CompactButton, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import type { WorkspacePanel } from '../lib/contract';
import { PreviewPanel } from '../preview/PreviewPanel';
import { useWorkspace } from '../WorkspaceContext';
import { ChangesPanel, GitActions } from './ChangesPanel';
import { FileExplorer } from './FileExplorer';
import { ProjectPanel } from './ProjectPanel';
import { ShellPanel } from './ShellPanel';
import { TestsPanel } from './TestsPanel';

type OpenPanel = Exclude<WorkspacePanel, 'ferme'>;

/**
 * D05 `Panneau contextuel` (214:1666): `Navigation locale` (`?panneau=`; « Aperçu » added, not in
 * Figma), tab body, `Actions Git`.
 */
export function ContextPanel() {
  const ws = useWorkspace();
  const panel = ws.url.panel === 'ferme' ? 'modifications' : ws.url.panel;
  const count = ws.changedCount ?? 0;

  return (
    <aside aria-label="Panneau contextuel" className="flex h-full w-full min-w-0 flex-col bg-bg">
      <Tabs
        value={panel}
        onValueChange={(next) => ws.url.set({ panneau: next })}
        className="flex min-h-0 flex-1 flex-col"
        activationMode="manual"
      >
        <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <TabsList variant="pill" aria-label="Panneau contextuel">
            <TabsTrigger value="fichiers">Fichiers</TabsTrigger>
            <TabsTrigger value="modifications" {...(count > 0 ? { count } : {})}>
              Modifications
            </TabsTrigger>
            <TabsTrigger value="tests">Tests</TabsTrigger>
            <TabsTrigger value="apercu">Aperçu</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="projet">Projet</TabsTrigger>
          </TabsList>
        </div>
        {(['fichiers', 'modifications', 'tests', 'apercu', 'terminal', 'projet'] as OpenPanel[]).map((value) => (
          <TabsContent key={value} value={value} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            {panel === value ? <PanelBody value={value} /> : null}
          </TabsContent>
        ))}
      </Tabs>
      <GitActions />
    </aside>
  );
}

function PanelBody({ value }: { value: OpenPanel }) {
  switch (value) {
    case 'fichiers':
      return <FileExplorer />;
    case 'modifications':
      return <ChangesPanel />;
    case 'tests':
      return <TestsPanel />;
    case 'apercu':
      return <SidePreview />;
    case 'terminal':
      return <ShellPanel />;
    case 'projet':
      return <ProjectPanel />;
  }
}

/** « Aperçu » in the panel, unless it is already shown as the main view (one frame at a time). */
function SidePreview() {
  const ws = useWorkspace();
  if (ws.url.view !== 'apercu') return <PreviewPanel variant="panel" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-4">
      <EmptyState
        icon="eye"
        title="Aperçu agrandi"
        variant="plain"
        action={
          <CompactButton variant="secondaire" onClick={() => ws.url.set({ vue: null })}>
            Revenir à la conversation
          </CompactButton>
        }
      >
        L&apos;aperçu occupe la vue principale.
      </EmptyState>
    </div>
  );
}
