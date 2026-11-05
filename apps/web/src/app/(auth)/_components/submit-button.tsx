'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import { DsButton, type DsButtonProps } from './ui';

/** DS button bound to the enclosing <form>: shows `pendingLabel` while the server action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: Omit<DsButtonProps, 'type' | 'pending'> & { pendingLabel: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <DsButton {...props} type="submit" pending={pending}>
      {pending ? pendingLabel : children}
    </DsButton>
  );
}
