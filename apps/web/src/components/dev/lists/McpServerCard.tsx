import Link from 'next/link';
import type { IconName } from '@/components/icons';
import { Badge, Card, Pastille } from '@/components/ui';
import { cn } from '@/lib/cn';
import { mcpStatusBadge, projectCountLabel, type McpStatus } from '../lib/integrations';
import { RowActionButton, type RowAction } from './row-action';

export interface McpServerCardProps {
  name: string;
  icon: IconName;
  description?: string | null;
  status: McpStatus;
  /** Projects where the server is enabled (`3 projets`, `aucun projet`). */
  projectCount: number;
  /**
   * The card's action: Secondaire « Configurer » / « Activer », Principal « Reconnecter » (`refresh`)
   * when the authorisation expired. Without `href`/`onClick` nothing is drawn.
   */
  action?: RowAction | null;
  className?: string;
}

/**
 * D07 `Grille MCP` card (216:2166…): pastille 32 · name · description · status + project count · one
 * compact button. Expired / failing servers get the 1 px danger border (`MCP · Coolify`).
 */
export function McpServerCard({ name, icon, description, status, projectCount, action, className }: McpServerCardProps) {
  const badge = mcpStatusBadge(status, 'long');
  const failing = status === 'expired' || status === 'error';
  return (
    <Card
      variant="tile"
      as="article"
      aria-label={name}
      className={cn('gap-3', failing && 'border border-danger', className)}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Pastille icon={icon} size={32} iconSize={20} />
        <h3 className="m-0 min-w-0 flex-1 truncate font-sans text-app-16 font-semibold text-text">{name}</h3>
      </div>
      {description ? <p className="m-0 font-sans text-app-13 leading-[18px] text-muted">{description}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <Badge tone="neutral">{projectCountLabel(projectCount)}</Badge>
      </div>
      {action ? (
        <div className="flex">
          <RowActionButton action={action} />
        </div>
      ) : null}
    </Card>
  );
}

export interface AddMcpServerCardProps {
  href?: string;
  onClick?: () => void;
  label?: string;
  className?: string;
}

/** D07 `Ajouter un MCP` dashed tile (216:2242), 160 px wide in the grid. */
export function AddMcpServerCard({ href, onClick, label = 'Ajouter un serveur MCP', className }: AddMcpServerCardProps) {
  const classes = cn(
    'flex min-h-[160px] w-full min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-5 text-center',
    'transition-colors duration-(--dur-fast) hover:bg-hover',
    className,
  );
  const content = (
    <>
      <Pastille icon="plus" size={32} shape="circle" className="size-9" />
      <span className="font-sans text-app-13 font-medium text-accent">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  if (!onClick) return null;
  return (
    <button type="button" onClick={onClick} className={classes}>
      {content}
    </button>
  );
}
