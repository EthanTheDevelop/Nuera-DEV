'use client';

/** DEV-ONLY: Git changes composites (D05 panel, W1, W4, W5 rows, S2 pager, S3 branch card). */
import { useState } from 'react';
import { CompactButton } from '@/components/ui';
import { BranchStatusBar } from '../changes/BranchStatusBar';
import { ChangedFileRow } from '../changes/ChangedFileRow';
import { DiffFilePager, DIFF_PHONE_HINT } from '../changes/DiffFilePager';
import { DiffView } from '../changes/DiffView';
import { diffTotals } from '../lib/diff';
import { formatAdditions, formatFileCount, formatLineDelta } from '../lib/format';
import { describeBranchStatus, syncBadge } from '../lib/git';
import { useDemo } from './demo-log';
import { GallerySection, Grid, PhoneFrame, Specimen } from './GalleryLayout';
import { PIPELINE_FILES } from './samples';

function ChangesPanel() {
  const [selected, setSelected] = useState(0);
  const [split, setSplit] = useState(false);
  const totals = diffTotals(PIPELINE_FILES);
  const file = PIPELINE_FILES[selected]!;
  return (
    <div className="flex w-[460px] max-w-full flex-col gap-3 rounded-md border border-border bg-bg p-4">
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 font-sans text-app-14 font-semibold text-text">{`${formatFileCount(totals.files)} modifiés`}</p>
        <span className="font-mono text-app-12 text-success">{formatAdditions(totals.additions)}</span>
        <span className="font-mono text-app-12 text-danger">{formatLineDelta(0, totals.deletions)}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {PIPELINE_FILES.map((f, i) => (
          <ChangedFileRow
            key={f.path}
            status={f.status}
            path={f.path}
            additions={f.additions}
            deletions={f.deletions}
            selected={i === selected}
            onSelect={() => setSelected(i)}
          />
        ))}
      </div>
      <DiffView
        file={file}
        layout={split ? 'split' : 'unified'}
        onBeforeAfter={() => setSplit((v) => !v)}
        beforeAfterActive={split}
        framed
        bodyClassName="max-h-[420px] overflow-y-auto"
      />
    </div>
  );
}

function PhoneDiff() {
  const [index, setIndex] = useState(0);
  const file = PIPELINE_FILES[index]!;
  return (
    <PhoneFrame label="Onglet Diff au téléphone (S2)">
      <div className="flex flex-col gap-3 px-4 py-3">
        <DiffFilePager
          path={file.path}
          index={index + 1}
          total={PIPELINE_FILES.length}
          additions={file.additions}
          deletions={file.deletions}
          onPrevious={() => setIndex((i) => Math.max(0, i - 1))}
          onNext={() => setIndex((i) => Math.min(PIPELINE_FILES.length - 1, i + 1))}
        />
        <DiffView file={file} header="none" />
        <p className="m-0 font-sans text-app-12 leading-4 text-muted">{DIFF_PHONE_HINT}</p>
      </div>
    </PhoneFrame>
  );
}

export function ChangesSection() {
  const demo = useDemo();
  const [included, setIncluded] = useState<ReadonlySet<string>>(() => new Set(PIPELINE_FILES.map((f) => f.path)));
  const actions = (disabled: boolean) => (
    <>
      <CompactButton variant="principal" icon="git-commit" disabled={disabled} onClick={demo('Préparer le commit')}>
        Préparer le commit
      </CompactButton>
      <CompactButton variant="secondaire" icon="git-pull-request" disabled={disabled} onClick={demo('Préparer la pull request')}>
        Préparer la pull request
      </CompactButton>
    </>
  );
  return (
    <GallerySection id="git" title="Workspace · Git et lignes" note="D05 panneau Modifications · W1 · W4 · W5 · S2 · S3.">
      <div className="flex flex-wrap items-start gap-8">
        <Specimen label="ChangedFileRow + DiffView · panneau Modifications (cliquer un fichier, « Avant / après »)" figma="214:1678">
          <ChangesPanel />
        </Specimen>
        <Grid className="w-[460px] max-w-full">
          <Specimen label="ChangedFileRow · M / A / D / R / binaire" figma="203:554">
            <div className="flex flex-col gap-0.5 rounded-md border border-border bg-bg p-1">
              <ChangedFileRow status="M" path="src/modules/crm/PipelineBoard.tsx" additions={142} deletions={18} />
              <ChangedFileRow status="A" path="src/modules/crm/pipeline-totals.ts" additions={38} />
              <ChangedFileRow status="D" path="src/modules/crm/legacy-board.tsx" deletions={64} />
              <ChangedFileRow status="R" path="src/modules/crm/board/Pipeline.tsx" oldPath="src/modules/crm/PipelineBoard.tsx" additions={2} deletions={2} />
              <ChangedFileRow status="M" path="public/logo-crm.png" binary />
            </div>
          </Specimen>
          <Specimen label="ChangedFileRow · avec case « Fichier inclus » (W5)" figma="231:3904">
            <div className="flex flex-col gap-2 rounded-md border border-border bg-bg px-2 py-1">
              {PIPELINE_FILES.slice(0, 3).map((f) => {
                const on = included.has(f.path);
                return (
                  <ChangedFileRow
                    key={f.path}
                    status={f.status}
                    path={f.path}
                    additions={f.additions}
                    deletions={f.deletions}
                    leading={
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`Inclure ${f.path}`}
                        onChange={() =>
                          setIncluded((prev) => {
                            const next = new Set(prev);
                            if (next.has(f.path)) next.delete(f.path);
                            else next.add(f.path);
                            return next;
                          })
                        }
                        className="size-[18px] shrink-0 accent-accent"
                      />
                    }
                  />
                );
              })}
            </div>
          </Specimen>
          <Specimen label="BranchStatusBar · Actions Git (D05)" figma="214:1850">
            <BranchStatusBar
              branch="feature/crm-core"
              status={describeBranchStatus({ ahead: 2, uncommitted: 4, base: 'main' })}
              actions={actions(false)}
              className="rounded-md border"
            />
          </Specimen>
          <Specimen label="BranchStatusBar · rien à committer (W1, groupe à 40 %)" figma="227:3075">
            <BranchStatusBar
              branch="feature/pipeline-export"
              status={describeBranchStatus({ ahead: 0, behind: 0, uncommitted: 0, base: 'main' })}
              actions={actions(true)}
              actionsDisabled
              className="rounded-md border"
            />
          </Specimen>
        </Grid>
      </div>

      <Specimen label="DiffView · côte à côte (W4, en-tête revue, colonnes AVANT / APRÈS)" figma="229:3676">
        <div className="max-w-[1048px] rounded-md bg-bg px-5 py-4">
          <DiffView file={PIPELINE_FILES[0]!} layout="split" header="review" baseLabel="main" headLabel="feature/crm-core" />
          <p className="m-0 pt-4 font-sans text-app-12 text-muted">
            Lecture seule. Pour corriger, demandez-le à Claude depuis la session ou modifiez le fichier dans le terminal.
          </p>
        </div>
      </Specimen>

      <div className="flex flex-wrap items-start gap-8">
        <Specimen label="DiffFilePager + DiffView · téléphone (S2 : précédent / suivant, toucher une ligne coupée)" figma="238:5634">
          <PhoneDiff />
        </Specimen>
        <Specimen label="BranchStatusBar · carte (S3) + badge d'avance" figma="238:5863">
          <PhoneFrame label="Onglet Git au téléphone (S3)">
            <div className="px-4 py-3">
              <BranchStatusBar branch="feature/crm-core" variant="card" badge={syncBadge({ state: 'ahead', ahead: 2 }, 'short')} />
            </div>
          </PhoneFrame>
        </Specimen>
        <Specimen label="DiffView · binaire / sans ligne / trop volumineux / tronqué (runner)">
          <div className="flex w-[460px] max-w-full flex-col gap-3">
            <DiffView file={{ path: 'public/logo-crm.png', additions: 0, deletions: 0, binary: true, hunks: [] }} />
            <DiffView file={{ path: 'scripts/deploy.sh', additions: 0, deletions: 0, hunks: [] }} />
            <DiffView file={{ path: 'package-lock.json', additions: 812, deletions: 640, tooLarge: true, hunks: [] }} />
            <DiffView file={{ ...PIPELINE_FILES[1]!, truncated: true }} />
          </div>
        </Specimen>
      </div>
    </GallerySection>
  );
}
