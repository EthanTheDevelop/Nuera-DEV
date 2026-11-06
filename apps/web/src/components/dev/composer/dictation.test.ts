import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DICTATION_COPY,
  DictationController,
  detectDictation,
  dictationErrorCode,
  dictationLanguages,
  insertDictated,
  unavailableReason,
  type DictationSnapshot,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from './dictation';
import { isDictationShortcut } from './use-dictation';

/** TEST-ONLY fake of the browser's SpeechRecognition: the test plays the recognition events. */
class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  started = false;
  stopped = false;
  aborted = false;
  private results: { transcript: string; isFinal: boolean }[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  /** Replaces the pending (non-final) result, or appends a final one. */
  hear(transcript: string, isFinal: boolean) {
    const last = this.results.at(-1);
    const index = last && !last.isFinal ? this.results.length - 1 : this.results.length;
    this.results[index] = { transcript, isFinal };
    const event: SpeechRecognitionEventLike = {
      resultIndex: index,
      results: this.results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })),
    };
    this.onresult?.(event);
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  end() {
    this.onend?.();
  }
}

function field(initial = '', selection: { start: number; end: number } | null = null) {
  const state = { value: initial, selection, caret: -1 };
  return {
    state,
    target: {
      read: () => ({ value: state.value, selection: state.selection }),
      write: (value: string, caret: number) => {
        state.value = value;
        state.caret = caret;
      },
    },
  };
}

function setup(initial = '', selection: { start: number; end: number } | null = null, languages = ['fr-FR']) {
  const f = field(initial, selection);
  const changes: DictationSnapshot[] = [];
  const ctl = new DictationController({
    create: () => new FakeRecognition(),
    target: f.target,
    languages,
    onChange: (s) => changes.push(s),
    silenceMs: 5_000,
  });
  const rec = () => FakeRecognition.instances.at(-1)!;
  return { f, ctl, rec, changes };
}

beforeEach(() => {
  FakeRecognition.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dictation availability', () => {
  it('needs the API and a secure context', () => {
    expect(detectDictation({})).toBe('unsupported');
    expect(detectDictation({ SpeechRecognition: 'pas une fonction' })).toBe('unsupported');
    expect(detectDictation({ webkitSpeechRecognition: FakeRecognition, isSecureContext: true })).toBe('supported');
    expect(detectDictation({ SpeechRecognition: FakeRecognition, isSecureContext: false })).toBe('insecure');
    expect(unavailableReason('unsupported')).toBe(DICTATION_COPY.unsupported);
    expect(unavailableReason('insecure')).toContain('HTTPS');
    expect(unavailableReason('supported')).toBeNull();
    expect(unavailableReason('pending')).toBeNull();
  });

  it('speaks French first, then the browser language', () => {
    expect(dictationLanguages('en-US')).toEqual(['fr-FR', 'en-US']);
    expect(dictationLanguages('fr-fr')).toEqual(['fr-FR']);
    expect(dictationLanguages(undefined)).toEqual(['fr-FR']);
  });

  it('maps the recognition errors, ignoring our own abort', () => {
    expect(dictationErrorCode('aborted')).toBeNull();
    expect(dictationErrorCode('not-allowed')).toBe('not-allowed');
    expect(dictationErrorCode('service-not-allowed')).toBe('not-allowed');
    expect(dictationErrorCode('audio-capture')).toBe('audio-capture');
    expect(dictationErrorCode('network')).toBe('network');
    expect(dictationErrorCode('bad-grammar')).toBe('other');
  });

  it('recognises Ctrl/⌘ + Maj + Espace only', () => {
    const key = { key: ' ', code: 'Space', shiftKey: true, ctrlKey: true, metaKey: false, altKey: false };
    expect(isDictationShortcut(key)).toBe(true);
    expect(isDictationShortcut({ ...key, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isDictationShortcut({ ...key, shiftKey: false })).toBe(false);
    expect(isDictationShortcut({ ...key, ctrlKey: false })).toBe(false);
    expect(isDictationShortcut({ ...key, altKey: true })).toBe(false);
  });
});

describe('insertDictated', () => {
  it('appends with a space and capitalises a new text or sentence', () => {
    expect(insertDictated('', 0, 0, ' lance les tests ')).toEqual({ value: 'Lance les tests', caret: 15 });
    expect(insertDictated('Lance les tests', 15, 15, 'puis résume')).toEqual({ value: 'Lance les tests puis résume', caret: 27 });
    expect(insertDictated('Lance les tests.', 16, 16, 'ensuite résume')!.value).toBe('Lance les tests. Ensuite résume');
    expect(insertDictated('Ligne 1\n', 8, 8, 'deuxième')!.value).toBe('Ligne 1\nDeuxième');
    expect(insertDictated('Bonjour', 7, 7, ', merci')!.value).toBe('Bonjour, merci');
    expect(insertDictated('abc', 3, 3, '   ')).toBeNull();
  });

  it('inserts at the caret and replaces a selection, spacing both sides', () => {
    expect(insertDictated('Corrige le test', 7, 7, 'vite')).toEqual({ value: 'Corrige vite le test', caret: 12 });
    expect(insertDictated('Corrige ce test', 8, 10, 'le premier')).toEqual({ value: 'Corrige le premier test', caret: 18 });
    expect(insertDictated('Corrigele test', 7, 7, 'vite')!.value).toBe('Corrige vite le test');
  });
});

describe('DictationController', () => {
  it('starts a continuous French recognition with interim results', () => {
    const { ctl, rec } = setup();
    ctl.start();
    expect(rec()).toMatchObject({ lang: 'fr-FR', continuous: true, interimResults: true, started: true });
    expect(ctl.state.status).toBe('listening');
  });

  it('reports interim words without writing them, then writes each final segment', () => {
    const { ctl, rec, f } = setup('Regarde');
    ctl.start();
    rec().hear('le fichier', false);
    expect(ctl.state.interim).toBe('le fichier');
    expect(f.state.value).toBe('Regarde');
    rec().hear('le fichier README', true);
    expect(f.state.value).toBe('Regarde le fichier README');
    expect(ctl.state.interim).toBe('');
    rec().hear('puis', false);
    rec().hear('puis lance les tests', true);
    expect(f.state.value).toBe('Regarde le fichier README puis lance les tests');
    // A later event replaying the same results never writes them twice.
    rec().hear('fin', true);
    expect(f.state.value).toBe('Regarde le fichier README puis lance les tests fin');
  });

  it('inserts at the caret captured when it starts, and follows the owner edits', () => {
    const { ctl, rec, f } = setup('Corrige le test', { start: 7, end: 7 });
    ctl.start();
    rec().hear('vite', true);
    expect(f.state.value).toBe('Corrige vite le test');
    rec().hear('et bien', true);
    expect(f.state.value).toBe('Corrige vite et bien le test');
    // The owner typed at the end meanwhile, caret there.
    f.state.value = 'Corrige vite et bien le test unitaire';
    f.state.selection = { start: f.state.value.length, end: f.state.value.length };
    rec().hear('maintenant', true);
    expect(f.state.value).toBe('Corrige vite et bien le test unitaire maintenant');
  });

  it('never sends: it only writes the field', () => {
    const { ctl, rec, f } = setup();
    ctl.start();
    rec().hear('envoie', true);
    expect(f.state.value).toBe('Envoie');
  });

  it('stop() lets the last words arrive, then ends', () => {
    const { ctl, rec, f } = setup();
    ctl.start();
    rec().hear('dernière', false);
    ctl.stop();
    expect(rec().stopped).toBe(true);
    expect(ctl.state.status).toBe('stopping');
    rec().hear('dernière phrase', true);
    rec().end();
    expect(f.state.value).toBe('Dernière phrase');
    expect(ctl.state).toEqual({ status: 'idle', interim: '', error: null });
  });

  it('cancel() aborts at once and drops the unsettled words', () => {
    const { ctl, rec, f } = setup('Texte');
    ctl.start();
    rec().hear('pas fini', false);
    ctl.cancel();
    expect(rec().aborted).toBe(true);
    expect(ctl.state.status).toBe('idle');
    rec().hear('pas fini du tout', true); // late event of the aborted recognition: ignored
    expect(f.state.value).toBe('Texte');
  });

  it('stops after the silence timeout, re-armed by each result', () => {
    const { ctl, rec } = setup();
    ctl.start();
    vi.advanceTimersByTime(4_000);
    rec().hear('encore', false);
    vi.advanceTimersByTime(4_000);
    expect(rec().stopped).toBe(false);
    vi.advanceTimersByTime(1_100);
    expect(rec().stopped).toBe(true);
  });

  it('closes a stop the browser never confirms', () => {
    const { ctl } = setup();
    ctl.start();
    ctl.stop();
    vi.advanceTimersByTime(2_100);
    expect(ctl.state.status).toBe('idle');
  });

  it('toggle() starts, then stops', () => {
    const { ctl, rec } = setup();
    ctl.toggle();
    expect(ctl.state.status).toBe('listening');
    ctl.toggle();
    expect(rec().stopped).toBe(true);
  });

  it('keeps a sober error after a refusal, and can start again', () => {
    const { ctl, rec } = setup();
    ctl.start();
    rec().fail('not-allowed');
    rec().end();
    expect(ctl.state).toEqual({ status: 'idle', interim: '', error: 'not-allowed' });
    ctl.start();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(ctl.state).toEqual({ status: 'listening', interim: '', error: null });
  });

  it('falls back to the browser language when French is not supported', () => {
    const { ctl, rec } = setup('', null, ['fr-FR', 'en-GB']);
    ctl.start();
    rec().fail('language-not-supported');
    rec().end();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(rec().lang).toBe('en-GB');
    expect(ctl.state.status).toBe('listening');
    rec().fail('language-not-supported');
    rec().end();
    expect(ctl.state).toMatchObject({ status: 'idle', error: 'language' });
  });

  it('reports a start that throws (already started elsewhere)', () => {
    const f = field();
    const ctl = new DictationController({
      create: () => {
        const rec = new FakeRecognition();
        rec.start = () => {
          throw new Error('InvalidStateError');
        };
        return rec;
      },
      target: f.target,
      languages: ['fr-FR'],
      onChange: () => undefined,
    });
    ctl.start();
    expect(ctl.state).toEqual({ status: 'idle', interim: '', error: 'other' });
  });
});
