'use client';

import { useId } from 'react';
import type { IconName } from '@/components/icons';
import { Pastille, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { joinParts } from '../lib/format';

export interface McpToolRowProps {
  /** Server name (`Figma`, `GitHub`, `Coolify`). */
  name: string;
  icon: IconName;
  /** Scope for this project (« maquettes Nuera OS · lecture »). */
  description?: string | null;
  /** Enabled for this project (`project_mcp_servers`). */
  enabled: boolean;
  onToggle?: (next: boolean) => void;
  /** Toggle request in flight. */
  pending?: boolean;
  /**
   * Degraded server (« à reconnecter »): appended to the description, the whole line in `warn`;
   * the switch stays off and disabled — reconnection happens in Intégrations.
   */
  warning?: string | null;
  /** `desktop` = D04 row with the service pastille · `phone` = M04 row without icon. */
  variant?: 'desktop' | 'phone';
  className?: string;
}

/** D04 `Tuile · Outils MCP du projet` / M04 `Outils MCP` row: pastille · name / scope · `Dev · Interrupteur`. */
export function McpToolRow({
  name,
  icon,
  description,
  enabled,
  onToggle,
  pending,
  warning,
  variant = 'desktop',
  className,
}: McpToolRowProps) {
  const labelId = useId();
  const descriptionId = useId();
  const line = joinParts(description, warning);
  return (
    <div className={cn('flex min-w-0 items-center gap-3 border-b border-border py-2.5 last:border-b-0', className)}>
      {variant === 'desktop' ? <Pastille icon={icon} size={28} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p id={labelId} className="m-0 truncate font-sans text-app-14 font-medium text-text">
          {name}
        </p>
        {line ? (
          <p id={descriptionId} className={cn('m-0 truncate font-sans text-app-12', warning ? 'text-warn' : 'text-muted')}>
            {line}
          </p>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={!onToggle || pending || Boolean(warning && !enabled)}
        aria-labelledby={labelId}
        aria-describedby={line ? descriptionId : undefined}
      />
    </div>
  );
}
