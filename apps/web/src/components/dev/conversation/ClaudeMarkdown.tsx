import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '@/components/ui';
import { cn } from '@/lib/cn';

/** Concatenated text of a hast node (fenced code blocks are rendered from their raw text). */
function textOf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: unknown; children?: unknown[] };
  if (n.type === 'text' && typeof n.value === 'string') return n.value;
  return Array.isArray(n.children) ? n.children.map(textOf).join('') : '';
}

const HEADING = 'm-0 font-sans text-app-15 font-semibold text-text';

/**
 * Only absolute web and mail links are followed. Relative targets (`src/x.ts`, `/api/…`, `#…`) would
 * open routes of this app, not files of the repository: they stay plain text (target in the tooltip).
 */
const FOLLOWED_LINK = /^(https?:\/\/|mailto:)/i;

/**
 * Element mapping. Raw HTML from the CLI output is never interpreted: react-markdown escapes it
 * (no rehype-raw), images are not loaded (alt text only), links open in a new tab without referrer.
 */
const components: Components = {
  p: ({ node: _node, className, ...props }) => <p className={cn('m-0', className)} {...props} />,
  h1: ({ node: _node, ...props }) => <p className={HEADING} {...props} />,
  h2: ({ node: _node, ...props }) => <p className={HEADING} {...props} />,
  h3: ({ node: _node, ...props }) => <p className={HEADING} {...props} />,
  h4: ({ node: _node, ...props }) => <p className={cn(HEADING, 'text-app-14')} {...props} />,
  h5: ({ node: _node, ...props }) => <p className={cn(HEADING, 'text-app-14')} {...props} />,
  h6: ({ node: _node, ...props }) => <p className={cn(HEADING, 'text-app-14')} {...props} />,
  a: ({ node: _node, href, children, ...props }) =>
    href && FOLLOWED_LINK.test(href) ? (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline underline-offset-2 hover:text-accent-hover"
      >
        {children}
      </a>
    ) : (
      <span title={href || undefined}>{children}</span>
    ),
  ul: ({ node: _node, className, ...props }) => <ul className={cn('m-0 list-disc space-y-1 pl-5', className)} {...props} />,
  ol: ({ node: _node, className, ...props }) => <ol className={cn('m-0 list-decimal space-y-1 pl-5', className)} {...props} />,
  li: ({ node: _node, className, ...props }) => <li className={cn('pl-0.5', className)} {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="m-0 border-l-2 border-border pl-3 text-muted" {...props} />,
  hr: () => <hr className="my-1 border-0 border-t border-border" />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
  code: ({ node: _node, className, ...props }) => (
    <code className={cn('rounded-[4px] bg-hover px-1 py-px font-mono text-[0.9em] break-words', className)} {...props} />
  ),
  pre: ({ node }) => <CodeBlock className="my-0.5">{textOf(node).replace(/\n$/, '')}</CodeBlock>,
  table: ({ node: _node, ...props }) => (
    <div className="max-w-full overflow-x-auto">
      <table className="border-collapse text-app-13" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border border-border px-2 py-1 text-left font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-border px-2 py-1 align-top" {...props} />,
  img: ({ alt }) => <span className="text-muted">{alt ? `[${alt}]` : '[image]'}</span>,
  input: ({ node: _node, ...props }) => <input {...props} disabled className="mr-1.5 align-middle accent-accent" />,
};

export interface ClaudeMarkdownProps {
  children: string;
  className?: string;
}

/** Safe Markdown (GFM) for text written by Claude Code: Outfit 14 / 20, code in JetBrains Mono. */
export function ClaudeMarkdown({ children, className }: ClaudeMarkdownProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 font-sans text-app-14 leading-5 text-text break-words', className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml={false}>
        {children}
      </Markdown>
    </div>
  );
}
