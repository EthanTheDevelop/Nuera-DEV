'use client';

import { useEffect, useId, useState } from 'react';
import { isValidBranchName } from '@nuera/shared/paths';
import { Button, Dialog, DialogContent, ErrorPanel, Field, Input, Select, Switch, toast } from '@/components/ui';
import { failureOf, projectsApi } from './api';
import type { Failure } from './FailureBanner';
import { useServerName } from './hooks';

export interface NewBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string; defaultBranch: string };
  /** Start points offered (local branches); default: the default branch only. */
  branches?: readonly string[];
  onCreated?: (branch: string) => void;
  /** Server holding the project (default: the server of the space). */
  serverName?: string | null;
}

/**
 * « Nouvelle branche… » (D02 row menu, D04 tile — not drawn): name, start point, optional switch
 * of the primary clone. Same visual language as the add-project dialog.
 */
export function NewBranchDialog({ open, onOpenChange, project, branches, onCreated, serverName: known }: NewBranchDialogProps) {
  const nameId = useId();
  const serverName = useServerName(known);
  const [name, setName] = useState('');
  const [from, setFrom] = useState(project.defaultBranch);
  const [checkout, setCheckout] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react/set-state-in-effect -- form reset on each opening
    setName('');
    setFrom(project.defaultBranch);
    setCheckout(false);
    setFailure(null);
  }, [open, project.defaultBranch]);

  const trimmed = name.trim();
  const invalid = trimmed !== '' && !isValidBranchName(trimmed);
  const options = Array.from(new Set([project.defaultBranch, ...(branches ?? [])])).map((value) => ({ value, label: value }));

  const submit = async () => {
    if (!trimmed || invalid) return;
    setPending(true);
    setFailure(null);
    try {
      await projectsApi.createBranch(project.id, { name: trimmed, from, checkout });
      toast({ message: checkout ? `Branche ${trimmed} créée et ouverte` : `Branche ${trimmed} créée depuis ${from}` });
      onOpenChange(false);
      onCreated?.(trimmed);
    } catch (error) {
      setFailure(failureOf(error, "La branche n'a pas pu être créée."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        size="sm"
        title="Nouvelle branche"
        description={`Dans ${project.name}, sur ${serverName}. Rien n'est poussé sur GitHub.`}
        dismissible={!pending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Annuler
            </Button>
            <Button variant="accent" onClick={submit} loading={pending} disabled={!trimmed || invalid}>
              Créer la branche
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            id={nameId}
            label="Nom de la branche"
            hint="Par exemple feature/export-csv ou fix/tarifs-mobile."
            error={invalid ? "Nom de branche invalide : pas d'espace, ni « .. », ni caractère spécial Git." : undefined}
          >
            <Input mono leadingIcon="git-branch" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Créée depuis">
            <Select options={options} value={from} onValueChange={setFrom} icon="git-branch" aria-label="Branche de départ" />
          </Field>
          <label className="flex items-center gap-3 rounded-md border border-border px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-sans text-app-14 font-medium text-text">Passer sur cette branche</span>
              <span className="font-sans text-app-12 text-muted">Le clone principal du projet bascule sur la nouvelle branche.</span>
            </span>
            <Switch checked={checkout} onCheckedChange={setCheckout} aria-label="Passer sur cette branche" />
          </label>
          {failure ? <ErrorPanel title={failure.message} excerpt={failure.detail} untouched={failure.untouched} raw={failure.raw ?? null} /> : null}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
