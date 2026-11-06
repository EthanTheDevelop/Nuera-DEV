'use client';

import { useState } from 'react';
import { CodeBlock, CompactButton } from '@/components/ui';

/**
 * A secret shown ONCE (invitation or recovery link, runner token, restricted DSN): dark code block,
 * « Copier », and the reminder that it will not be shown again.
 */
export function OnceSecret({ label, value, copyLabel = 'Copier' }: { label: string; value: string; copyLabel?: string }) {
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback('Copié.');
    } catch {
      setFeedback('Copie impossible : sélectionnez le texte.');
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <CodeBlock label={label} wrap>
        <span className="select-all">{value}</span>
      </CodeBlock>
      <div className="flex items-center gap-3">
        <CompactButton variant="secondaire" onClick={copy}>
          {copyLabel}
        </CompactButton>
        <span role="status" className="font-sans text-app-12 text-muted">
          {feedback}
        </span>
      </div>
    </div>
  );
}
