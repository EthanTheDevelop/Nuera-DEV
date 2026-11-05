import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@nuera/shared/runner';
import { DiffView } from './changes/DiffView';
import { Composer } from './composer/Composer';
import { persistenceText } from './composer/SessionPersistenceLine';
import { draftAfterSend } from './composer/use-composer';
import { ClaudeMarkdown } from './conversation/ClaudeMarkdown';
import { CommandOutput } from './conversation/CommandOutput';
import { InstructionMessage } from './conversation/InstructionMessage';
import { PermissionRequestCard } from './conversation/PermissionRequestCard';
import { sessionSummaryMeta } from './conversation/SessionSummaryCard';
import { ToolLine } from './conversation/ToolLine';
import { parseUnifiedDiff } from './lib/diff';
import { toChangeStatus } from './lib/git';
import { defaultPermissionOptions } from './lib/permission';
import { EnvVarRow, SECRET_MASK } from './lists/EnvVarRow';
import { GitActivityRow } from './lists/GitActivityRow';
import { HistoryRow } from './lists/HistoryRow';
import { SessionCard } from './lists/SessionCard';
import { SessionSwitcherHeader } from './lists/SessionSwitcher';
import { formatLiveTime, LiveTime } from './status/LiveTime';

const html = (node: ReactElement) => renderToStaticMarkup(node);

/** Visible text of rendered markup (tags removed, entities decoded). */
const text = (node: ReactElement) =>
  html(node)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const noop = () => undefined;
const MODE = "demander avant d'agir";
const OPTIONS = defaultPermissionOptions('npm run test');
const TITLE = 'Claude demande à exécuter une commande';

describe('ClaudeMarkdown', () => {
  it('never renders raw HTML nor javascript: links', () => {
    const out = html(
      <ClaudeMarkdown>{'Texte <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com)'}</ClaudeMarkdown>,
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toMatch(/href="javascript:/);
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('follows only absolute web and mail links (relative targets are app routes, not repo files)', () => {
    const out = html(
      <ClaudeMarkdown>{'[PipelineBoard.tsx](src/modules/crm/PipelineBoard.tsx) [api](/api/x) [mail](mailto:a@b.fr)'}</ClaudeMarkdown>,
    );
    expect(out).not.toContain('href="src/');
    expect(out).not.toContain('href="/api');
    expect(out).toContain('PipelineBoard.tsx');
    expect(out).toContain('title="src/modules/crm/PipelineBoard.tsx"');
    expect(out).toContain('href="mailto:a@b.fr"');
  });

  it('renders fenced code in the dark code block and inline code in mono', () => {
    const out = html(<ClaudeMarkdown>{'Voir `pipeline-totals.ts`\n\n```ts\nconst a = 1;\n```'}</ClaudeMarkdown>);
    expect(out).toContain('data-tone="dark"');
    expect(out).toContain('const a = 1;');
    expect(out).toMatch(/<code class="[^"]*font-mono[^"]*">pipeline-totals.ts<\/code>/);
  });
});

describe('PermissionRequestCard', () => {
  it('keeps the CLI order and the Figma copy (203:405)', () => {
    const t = text(
      <PermissionRequestCard status="pending" title={TITLE} target="npm run test -- crm" options={OPTIONS} modeLabel={MODE} onDecide={noop} />,
    );
    expect(t.indexOf('Autoriser')).toBeLessThan(t.indexOf('Toujours pour npm run test'));
    expect(t.indexOf('Toujours pour npm run test')).toBeLessThan(t.indexOf('Refuser'));
    expect(t).toContain('$ npm run test -- crm');
    expect(t).toContain('En attente');
    expect(t).toContain("Mode : demander avant d'agir · la réponse est transmise au CLI");
  });

  it('disables the choices when nothing can transmit the answer', () => {
    const out = html(<PermissionRequestCard status="pending" title={TITLE} target="x" options={OPTIONS} modeLabel={MODE} />);
    expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });

  it('collapses once decided (203:413, 203:422)', () => {
    const allowed = html(
      <PermissionRequestCard status="allowed" title={TITLE} target="npm run test -- crm" toolName="Bash" options={OPTIONS} modeLabel={MODE} />,
    );
    expect(allowed).not.toContain('<button');
    expect(allowed).toContain('Commande autorisée une fois · npm run test -- crm');
    const denied = text(<PermissionRequestCard status="denied" title={TITLE} options={OPTIONS} modeLabel={MODE} />);
    expect(denied).toContain('Commande refusée · Claude a été prévenu');
  });

  it('phone variant: no badge, short note (222:2731)', () => {
    const t = text(
      <PermissionRequestCard status="pending" variant="phone" title={TITLE} target="x" options={OPTIONS} modeLabel={MODE} onDecide={noop} />,
    );
    expect(t).not.toContain('En attente');
    expect(t).toContain("Mode : demander avant d'agir");
    expect(t).not.toContain('la réponse est transmise au CLI');
  });

  it('expired: offers the terminal only when it can be opened', () => {
    const without = text(<PermissionRequestCard status="expired" title={TITLE} options={OPTIONS} modeLabel={MODE} />);
    expect(without).not.toContain('Répondre dans le terminal');
    const withHandler = text(
      <PermissionRequestCard status="expired" title={TITLE} options={OPTIONS} modeLabel={MODE} onAnswerInTerminal={noop} />,
    );
    expect(withHandler).toContain('Répondre dans le terminal');
  });

  it('expired while offline (W7): the terminal waits too, with the reason', () => {
    const reason = 'Connexion au serveur perdue : la réponse sera possible dès la reconnexion.';
    const out = html(
      <PermissionRequestCard
        status="expired"
        title={TITLE}
        options={OPTIONS}
        modeLabel={MODE}
        onAnswerInTerminal={noop}
        disabledReason={reason}
      />,
    );
    expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(1);
    expect(out).toContain('Connexion au serveur perdue');
  });
});

describe('Composer', () => {
  it('suspends input while a permission is pending (203:496)', () => {
    const out = html(<Composer state="waiting_permission" modeLabel={MODE} onSubmit={noop} />);
    expect(out).toContain('readOnly=""');
    expect(out).toContain("placeholder=\"Répondez d&#x27;abord à la demande d&#x27;autorisation ci-dessus…\"");
  });

  it('shows Interrompre only when it can interrupt, and no paperclip without attachments', () => {
    const silent = text(<Composer state="running" modeLabel={MODE} onSubmit={noop} />);
    expect(silent).not.toContain('Interrompre · Échap');
    const live = text(<Composer state="running" modeLabel={MODE} onSubmit={noop} onInterrupt={noop} />);
    expect(live).toContain('Interrompre · Échap');
    expect(html(<Composer state="ready" modeLabel={MODE} onSubmit={noop} />)).not.toContain('Joindre un fichier');
  });

  it('names the hints with their visible text (WCAG 2.5.3)', () => {
    const out = html(<Composer state="ready" modeLabel={MODE} onSubmit={noop} />);
    expect(out).toContain('aria-label="/ commandes : ');
    expect(out).toContain('aria-label="@ fichiers : ');
  });

  it('keeps what was typed while an instruction was in flight', () => {
    expect(draftAfterSend('Lance les tests', 'Lance les tests')).toBe('');
    expect(draftAfterSend('Lance les tests', 'Lance les tests\npuis résume')).toBe('puis résume');
    expect(draftAfterSend('Lance les tests', 'Lance les test')).toBe('Lance les test');
  });

  it('writes the reconnection line (W7) and a long outage in minutes', () => {
    expect(persistenceText({ kind: 'reconnecting', lastSignalSeconds: 12, permissionPending: true })).toEqual({
      tone: 'warn',
      text: "Dernier signe du serveur il y a 12 s · la demande d'autorisation attend toujours.",
    });
    expect(persistenceText({ kind: 'reconnecting', lastSignalSeconds: 190 }).text).toBe(
      'Dernier signe du serveur il y a 3 min.',
    );
  });
});

describe('session summary (W3)', () => {
  it('writes the meta line from git and the permission log, nothing unknown', () => {
    expect(sessionSummaryMeta({ files: 4, additions: 152, deletions: 12, allowedCommands: 2, commits: 0 })).toBe(
      '4 fichiers · +152 −12 · 2 commandes autorisées · aucun commit encore',
    );
    expect(sessionSummaryMeta({ files: 1, additions: 3, deletions: 0 })).toBe('1 fichier · +3');
  });
});

describe('dates', () => {
  const now = new Date('2026-11-04T12:00:00+01:00'); // mercredi 4 novembre 2026
  it('formats the D02 activity column (« lun. 2 nov. » within the week)', () => {
    expect(formatLiveTime(new Date('2026-11-04T11:57:00+01:00'), 'activity', now)).toBe('il y a 3 min');
    expect(formatLiveTime(new Date('2026-11-03T18:00:00+01:00'), 'activity', now)).toBe('hier');
    expect(formatLiveTime(new Date('2026-11-02T21:05:00+01:00'), 'activity', now)).toBe('lun. 2 nov.');
    expect(formatLiveTime(new Date('2026-10-28T09:40:00+01:00'), 'activity', now)).toBe('28 oct.');
  });

  it('never throws on a malformed date', () => {
    expect(formatLiveTime('pas une date', 'relative', now)).toBe('');
    expect(() => html(<LiveTime value="pas une date" format="datetime" now={now} />)).not.toThrow();
    expect(text(<InstructionMessage text="Bonjour" at="pas une date" />)).toContain('Vous');
  });
});

describe('ToolLine', () => {
  it('is static without detail and expandable with one', () => {
    const plain = html(<ToolLine tool="Read" target="CLAUDE.md" status="done" meta="212 lignes" />);
    expect(plain).not.toContain('<button');
    expect(plain).not.toContain('data-icon="chevron"');
    const expandable = html(
      <ToolLine tool="Bash" target="npm test" status="error" meta="code 1">
        <p>sortie</p>
      </ToolLine>,
    );
    expect(expandable).toContain('aria-expanded="false"');
    expect(text(<ToolLine tool="Edit" status="running" />)).toContain('en cours');
  });

  it('draws no empty meta cell', () => {
    expect(html(<ToolLine tool="Edit" target="x.ts" status="done" meta="" />)).not.toContain('text-app-11');
  });
});

describe('CommandOutput', () => {
  it('drops escape sequences and prints a failing exit code', () => {
    const out = html(<CommandOutput command="npm test" output={'\u001b[31m✗ échec\u001b[39m\n'} exitCode={1} />);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('✗ échec');
    expect(out).toContain('code 1');
  });
});

describe('DiffView', () => {
  const [file] = parseUnifiedDiff(
    ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@ f()', ' a', '-b', '+c', '@@ -9 +9 @@', '-y', '+z', ''].join('\n'),
  );
  it('renders the D05 header and signs', () => {
    const t = text(<DiffView file={file!} onBeforeAfter={noop} />);
    expect(t).toContain('x.ts');
    expect(t).toContain('2 blocs');
    expect(t).toContain('Avant / après');
    expect(t).toContain('@@ -1,2 +1,2 @@ f()');
    expect(t).toContain('−');
  });
  it('says when there is nothing to show line by line', () => {
    expect(text(<DiffView file={{ path: 'logo.png', additions: 0, deletions: 0, binary: true, hunks: [] }} />)).toContain(
      'Fichier binaire',
    );
  });

  it('draws the runner diff as is, and never calls a too large file unchanged', () => {
    const runnerDiff: FileDiff = {
      path: 'src/x.ts',
      oldPath: null,
      status: '?',
      binary: false,
      truncated: true,
      tooLarge: false,
      insertions: 1,
      deletions: 0,
      baseLabel: 'HEAD',
      headLabel: 'copie de travail',
      hunks: [
        {
          header: '@@ -0,0 +1 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          context: '',
          lines: [{ type: 'add', oldNumber: null, newNumber: 1, text: 'export {};', noNewline: true }],
        },
      ],
    };
    const diffFile = { ...runnerDiff, additions: runnerDiff.insertions, status: toChangeStatus(runnerDiff.status) };
    const truncated = text(<DiffView file={diffFile} />);
    expect(truncated).toContain('export {};');
    expect(truncated).toContain('Diff tronqué');
    const tooLarge = text(
      <DiffView file={{ ...diffFile, truncated: false, tooLarge: true, hunks: [], additions: 812, deletions: 640 }} onBeforeAfter={noop} />,
    );
    expect(tooLarge).toContain('trop volumineux');
    expect(tooLarge).not.toContain('Aucune ligne modifiée');
    // Header: the counts instead of « 0 bloc », no « Avant / après » with nothing to compare.
    expect(tooLarge).toContain('+812 −640');
    expect(tooLarge).not.toContain('0 bloc');
    expect(tooLarge).not.toContain('Avant / après');
  });
});

describe('cards and rows', () => {
  it('SessionCard draws its action only when it can act', () => {
    const base = { status: 'waiting_permission' as const, title: 'Tests e2e du devis', projectName: 'Nuera OS' };
    expect(html(<SessionCard {...base} action={{}} />)).not.toContain('<button');
    expect(text(<SessionCard {...base} action={{ onClick: noop }} />)).toContain('Répondre');
  });

  it('HistoryRow maps a resumable interruption (D06)', () => {
    const t = text(
      <HistoryRow title="Correctif" projectName="Kiné" status="interrupted" resumable startedAt={Date.now()} durationMs={72 * 60_000} action={{ onClick: noop }} />,
    );
    expect(t).toContain('Interrompue · reprise possible');
    expect(t).toContain('Reprendre');
    expect(t).toContain('1 h 12');
  });

  it('EnvVarRow never prints a masked secret', () => {
    const out = html(<EnvVarRow name="DATABASE_URL" secret value="postgres://secret" onEdit={noop} />);
    expect(out).not.toContain('postgres://secret');
    expect(out).toContain(SECRET_MASK);
  });

  it('GitActivityRow prints a PR number as an identifier', () => {
    const t = text(
      <GitActivityRow kind="pull_request" number={1234} message="Galerie" projectName="Atelier Lune" at={Date.now()} />,
    );
    expect(t).toContain('#1234');
  });

  it('SessionSwitcherHeader counts live sessions (W6)', () => {
    expect(text(<SessionSwitcherHeader projectName="Nuera OS" active={1} max={4} />)).toContain('Nuera OS · 1 session active');
    expect(text(<SessionSwitcherHeader projectName="Nuera OS" active={2} max={4} />)).toContain(
      'Nuera OS · 2 sessions actives2 / 4',
    );
  });
});
