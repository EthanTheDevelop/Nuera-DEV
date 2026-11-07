import { describe, expect, it } from 'vitest';
import {
  AUTODEBUG_OUTPUT_MAX,
  AUTODEBUG_STALL_MS,
  AUTODEBUG_TAIL_LINES,
  buildAutodebugInstruction,
  devServerFailure,
  outputShowsErrors,
  outputTail,
  redactForClaude,
} from './preview-autodebug';

const START = '2026-11-07T10:00:00.000Z';
const at = (ms: number) => Date.parse(START) + ms;

describe('« Aperçu » — a dev server that does not start, handed to Claude', () => {
  it('knows when a dev server does not start: ended in error, or no port after a minute with errors', () => {
    expect(devServerFailure({ status: 'failed', port: null, startedAt: START, exitCode: 1 }, '')).toBe('exit');
    expect(devServerFailure({ status: 'stopped', port: null, startedAt: START }, 'Error: boom')).toBeNull();
    expect(devServerFailure({ status: 'succeeded', port: null, startedAt: START }, 'Error: boom')).toBeNull();
    const stuck = { status: 'running', port: null, startedAt: START };
    expect(devServerFailure(stuck, 'Error: Cannot find module', at(AUTODEBUG_STALL_MS - 1))).toBeNull();
    expect(devServerFailure(stuck, 'Error: Cannot find module', at(AUTODEBUG_STALL_MS))).toBe('stalled');
    // Slow but healthy: no error in the output, or a port already there.
    expect(devServerFailure(stuck, 'compiling…', at(5 * AUTODEBUG_STALL_MS))).toBeNull();
    expect(devServerFailure({ ...stuck, port: 3001 }, 'Error', at(5 * AUTODEBUG_STALL_MS))).toBeNull();
    expect(outputShowsErrors('\u001b[31mERR!\u001b[0m code ELIFECYCLE')).toBe(true);
    expect(outputShowsErrors('    at Object.<anonymous> (/srv/app/server.js:12:5)')).toBe(true);
    expect(outputShowsErrors('ready in 320 ms')).toBe(false);
  });

  it('keeps the last 80 lines, as a terminal shows them', () => {
    const output = Array.from({ length: 200 }, (_, i) => `\u001b[2mligne ${i}\u001b[0m`).join('\r\n') + '\r\n\r\n';
    const tail = outputTail(output).split('\n');
    expect(tail).toHaveLength(AUTODEBUG_TAIL_LINES);
    expect(tail[0]).toBe('ligne 120');
    expect(tail.at(-1)).toBe('ligne 199');
  });

  it('never gives Claude a secret: project variables and known token shapes are masked', () => {
    const text = redactForClaude(
      'DATABASE_URL=postgres://app:motdepasse-tres-secret@db:5432/app\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\nANTHROPIC=sk-ant-api03-abcdefghijklmnop\nAuthorization: Bearer abc.def.ghi',
      ['motdepasse-tres-secret', 'court'],
    );
    expect(text).not.toContain('motdepasse-tres-secret');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).toContain('[masqué]');
  });

  it('builds the instruction: server, command, redacted output in a fence it cannot close, the request', () => {
    const text = buildAutodebugInstruction({
      name: 'client',
      command: 'pnpm --filter client dev',
      output: "> next dev\n```\nError: Cannot find module 'tailwind'\n  token=ghp_abcdefghijklmnopqrstuvwxyz0123\n",
      failure: 'exit',
      exitCode: 1,
    });
    expect(text.startsWith("Le serveur de développement « client » (`pnpm --filter client dev`) ne démarre pas : il s'est arrêté avec le code 1. Voici la fin de sa sortie :")).toBe(true);
    expect(text).toContain("````\n> next dev\n```\nError: Cannot find module 'tailwind'");
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(text.endsWith("Trouve la cause et corrige-la si c'est dans le code ou la configuration du projet, puis dis-moi comment relancer.")).toBe(true);
    // French copy of NUERA DEV: straight apostrophes only.
    expect(text).not.toContain('’');
    expect(buildAutodebugInstruction({ name: 'admin', command: 'npm run dev', output: '', failure: 'stalled' })).toContain(
      "ne démarre pas : aucun port n'apparaît dans sa sortie, qui montre des erreurs",
    );
  });

  it('caps the output it gives (the end kept)', () => {
    const long = Array.from({ length: 80 }, (_, i) => `${i} ${'x'.repeat(300)}`).join('\n');
    const text = buildAutodebugInstruction({ name: 'dev', command: 'npm run dev', output: long, failure: 'exit', exitCode: 1 });
    const body = text.split('```\n')[1]!.split('\n```')[0]!;
    expect(body.length).toBeLessThanOrEqual(AUTODEBUG_OUTPUT_MAX + 2);
    expect(body.startsWith('…\n')).toBe(true);
    expect(body).toContain(`79 ${'x'.repeat(300)}`);
    expect(body).not.toContain(`\n0 ${'x'}`);
  });
});
