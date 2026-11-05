import { CodeBlock } from '@/components/ui';
import { cn } from '@/lib/cn';
import { terminalText } from '../lib/ansi';

export interface CommandOutputProps {
  /** Command line, printed as `$ npm run test -- crm`. */
  command?: string | null;
  /** Raw output captured from the process (escape sequences are dropped, text never reworded). */
  output: string;
  /** Exit code; a non-zero code is printed after the output (`code 1`). */
  exitCode?: number | null;
  /** The runner kept only the end of a long output. */
  truncated?: boolean;
  /** Height after which the block scrolls (px). Default 320. */
  maxHeight?: number;
  /** Accessible name (« Sortie de npm run test -- crm »). */
  label?: string;
  className?: string;
}

/**
 * `Dev · Sortie de commande` (203:373) — « Sortie brute d'une commande, sur le mode Dark de la
 * collection Color (l'équivalent de .on-dark). Texte exact du terminal, jamais reformulé. »
 */
export function CommandOutput({
  command,
  output,
  exitCode,
  truncated,
  maxHeight = 320,
  label,
  className,
}: CommandOutputProps) {
  const text = terminalText(output).replace(/\n+$/, '');
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-1.5', className)}>
      <div className="min-w-0 overflow-y-auto rounded-md" style={{ maxHeight }}>
        <CodeBlock
          command={command ?? undefined}
          label={label ?? (command ? `Sortie de ${command}` : 'Sortie de la commande')}
          className="[font-variant-ligatures:none]"
        >
          {text !== '' || failed ? (
            <>
              {text}
              {failed ? <span className="block pt-2 text-danger-on-dark">{`code ${exitCode}`}</span> : null}
            </>
          ) : undefined}
        </CodeBlock>
      </div>
      {truncated ? (
        <p className="m-0 font-sans text-app-12 text-muted">
          Sortie tronquée : seule la fin est affichée, le flux complet reste dans le terminal.
        </p>
      ) : null}
    </div>
  );
}
