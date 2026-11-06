/**
 * Dictation of an instruction with the browser's own speech recognition (Web Speech API:
 * `SpeechRecognition` / `webkitSpeechRecognition` — Safari macOS / iOS, Chrome, Edge; absent in
 * Firefox). No server, no audio kept by Nuera Dev: the browser (Apple or Google) does the work.
 *
 * Pure module (no React): availability, text insertion at the caret, and the controller that turns
 * recognition events into field edits. `use-dictation.ts` binds it to a textarea.
 */

/** The few members of `SpeechRecognitionResultList` we read (the DOM lib types are not shipped everywhere). */
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; length: number; [index: number]: { transcript: string } }>;
}

export interface SpeechRecognitionErrorLike {
  error: string;
  message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechWindow {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  isSecureContext?: boolean;
}

/** `pending` until the page is mounted (SSR and first hydration render). */
export type DictationAvailability = 'pending' | 'supported' | 'unsupported' | 'insecure';

export function speechRecognitionOf(win: SpeechWindow): SpeechRecognitionConstructor | null {
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as SpeechRecognitionConstructor) : null;
}

export function detectDictation(win: SpeechWindow): Exclude<DictationAvailability, 'pending'> {
  if (!speechRecognitionOf(win)) return 'unsupported';
  // Browsers refuse the microphone outside HTTPS / localhost.
  if (win.isSecureContext === false) return 'insecure';
  return 'supported';
}

/** French first, then the browser's language (de-duplicated, case-insensitive). */
export function dictationLanguages(browserLanguage: string | null | undefined): string[] {
  const list = ['fr-FR'];
  const extra = browserLanguage?.trim();
  if (extra && extra.toLowerCase() !== 'fr-fr') list.push(extra);
  return list;
}

export type DictationErrorCode = 'not-allowed' | 'audio-capture' | 'network' | 'no-speech' | 'language' | 'other';

export function dictationErrorCode(error: string): DictationErrorCode | null {
  switch (error) {
    case 'aborted':
      return null; // our own abort (send, unmount)
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'audio-capture':
      return 'audio-capture';
    case 'network':
      return 'network';
    case 'no-speech':
      return 'no-speech';
    case 'language-not-supported':
      return 'language';
    default:
      return 'other';
  }
}

export const DICTATION_COPY = {
  start: "Dicter l'instruction",
  stop: 'Arrêter la dictée',
  listening: "À l'écoute…",
  retry: 'Réessayer',
  understood: 'Compris',
  pending: 'Vérification de la dictée…',
  unsupported:
    "La dictée n'est pas disponible dans ce navigateur : utilisez la dictée du clavier de votre téléphone ou Chrome / Safari.",
  insecure:
    'La dictée demande une connexion sécurisée (HTTPS) : utilisez la dictée du clavier de votre téléphone.',
  privacy:
    "La reconnaissance vocale est assurée par votre navigateur (Apple ou Google) : l'audio ne passe pas par Nuera Dev.",
  errors: {
    'not-allowed': 'Micro refusé : autorisez le micro pour ce site dans les réglages du navigateur, puis réessayez.',
    'audio-capture': 'Aucun micro détecté : branchez ou activez un micro, puis réessayez.',
    network: 'La reconnaissance vocale du navigateur ne répond pas (réseau) : réessayez dans un instant.',
    'no-speech': 'Aucune parole détectée : rapprochez-vous du micro et réessayez.',
    language: "Le français n'est pas pris en charge par la reconnaissance vocale de ce navigateur.",
    other: "La dictée s'est interrompue : réessayez.",
  } satisfies Record<DictationErrorCode, string>,
} as const;

export function unavailableReason(availability: DictationAvailability): string | null {
  if (availability === 'unsupported') return DICTATION_COPY.unsupported;
  if (availability === 'insecure') return DICTATION_COPY.insecure;
  return null;
}

/**
 * Inserts a dictated segment in place of `[start, end)`: a space where the words would touch,
 * a capital letter at the start of the text or of a sentence. Returns null for an empty segment.
 */
export function insertDictated(
  value: string,
  start: number,
  end: number,
  segment: string,
): { value: string; caret: number } | null {
  let text = segment.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  if (/(?:[.!?…]|\n)\s*$/.test(before) || before.trim() === '') {
    text = text.charAt(0).toLocaleUpperCase('fr-FR') + text.slice(1);
  }
  const lead = before === '' || /\s$/.test(before) || /^[,.…)]/.test(text) ? '' : ' ';
  const trail = after === '' || /^\s/.test(after) ? '' : ' ';
  const head = before + lead + text;
  return { value: head + trail + after, caret: head.length };
}

/** The field the controller writes into. */
export interface DictationTarget {
  /** Current text and, when the field has the focus, its selection (null otherwise: append). */
  read(): { value: string; selection: { start: number; end: number } | null };
  write(value: string, caret: number): void;
}

export type DictationStatus = 'idle' | 'listening' | 'stopping';

export interface DictationSnapshot {
  status: DictationStatus;
  /** Words heard but not settled yet (never in the field: shown beside it). */
  interim: string;
  error: DictationErrorCode | null;
}

export const IDLE_DICTATION: DictationSnapshot = { status: 'idle', interim: '', error: null };

export interface DictationControllerOptions {
  create: () => SpeechRecognitionLike;
  target: DictationTarget;
  languages: string[];
  onChange: (snapshot: DictationSnapshot) => void;
  /** Stops after this long without any result. Default 8 s. */
  silenceMs?: number;
  /** A stop that the browser never confirms is closed after this delay. Default 2 s. */
  stopGraceMs?: number;
}

/**
 * One dictation at a time: continuous recognition with interim results. Final results are written
 * into the field at the caret (or where the previous segment ended); interim ones are only
 * reported. Never sends anything.
 */
export class DictationController {
  private rec: SpeechRecognitionLike | null = null;
  private snapshot: DictationSnapshot = IDLE_DICTATION;
  private languageIndex = 0;
  private restartWithNextLanguage = false;
  private nextFinal = 0;
  private range: { start: number; end: number } | null = null;
  private lastWritten: string | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DictationControllerOptions) {}

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  get active(): boolean {
    return this.snapshot.status !== 'idle';
  }

  start(): void {
    if (this.rec) return;
    this.languageIndex = 0;
    const current = this.options.target.read();
    this.range = current.selection ?? { start: current.value.length, end: current.value.length };
    this.lastWritten = current.value;
    this.launch();
  }

  /** Stops listening; what was already said still lands in the field. */
  stop(): void {
    const rec = this.rec;
    if (!rec || this.snapshot.status === 'stopping') return;
    this.clearSilence();
    this.update({ status: 'stopping' });
    try {
      rec.stop();
    } catch {
      this.finish();
      return;
    }
    this.stopTimer = setTimeout(() => this.cancel(), this.options.stopGraceMs ?? 2_000);
  }

  /** Stops at once and drops the words not settled yet (sending, leaving the page). */
  cancel(): void {
    const rec = this.rec;
    if (!rec) return;
    this.detach(rec);
    try {
      rec.abort();
    } catch {
      // already ended
    }
    this.finish();
  }

  toggle(): void {
    if (this.snapshot.status === 'listening') this.stop();
    else if (this.snapshot.status === 'idle') this.start();
  }

  clearError(): void {
    if (this.snapshot.error) this.update({ error: null });
  }

  dispose(): void {
    this.cancel();
  }

  private launch(): void {
    let rec: SpeechRecognitionLike;
    try {
      rec = this.options.create();
      rec.lang = this.options.languages[this.languageIndex] ?? 'fr-FR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
    } catch {
      this.update({ ...IDLE_DICTATION, error: 'other' });
      return;
    }
    this.rec = rec;
    this.nextFinal = 0;
    rec.onresult = (event) => {
      if (this.rec === rec) this.onResult(event);
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- one handler per recognition, cleared by detach()
    rec.onerror = (event) => {
      if (this.rec === rec) this.onError(event);
    };
    rec.onend = () => {
      if (this.rec === rec) this.onEnd();
    };
    try {
      rec.start();
    } catch {
      this.detach(rec);
      this.rec = null;
      this.update({ ...IDLE_DICTATION, error: 'other' });
      return;
    }
    this.update({ status: 'listening', interim: '', error: null });
    this.armSilence();
  }

  private onResult(event: SpeechRecognitionEventLike): void {
    let interim = '';
    const { results } = event;
    for (let i = Math.min(event.resultIndex, this.nextFinal); i < results.length; i += 1) {
      const result = results[i];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        if (i >= this.nextFinal) {
          this.commit(transcript);
          this.nextFinal = i + 1;
        }
      } else {
        interim += transcript;
      }
    }
    this.update({ interim: interim.replace(/\s+/g, ' ').trim() });
    if (this.snapshot.status === 'listening') this.armSilence();
  }

  private commit(segment: string): void {
    const { target } = this.options;
    const current = target.read();
    // The owner edited the field meanwhile: continue from where they are now.
    if (current.value !== this.lastWritten || !this.range) {
      this.range = current.selection ?? { start: current.value.length, end: current.value.length };
    }
    const next = insertDictated(current.value, this.range.start, this.range.end, segment);
    if (!next) return;
    this.range = { start: next.caret, end: next.caret };
    this.lastWritten = next.value;
    target.write(next.value, next.caret);
  }

  private onError(event: SpeechRecognitionErrorLike): void {
    const code = dictationErrorCode(event.error);
    if (code === 'language' && this.languageIndex + 1 < this.options.languages.length) {
      this.restartWithNextLanguage = true;
      return;
    }
    if (code) this.update({ error: code });
  }

  private onEnd(): void {
    if (this.restartWithNextLanguage) {
      this.restartWithNextLanguage = false;
      this.languageIndex += 1;
      const rec = this.rec;
      if (rec) this.detach(rec);
      this.rec = null;
      this.launch();
      return;
    }
    this.finish();
  }

  private finish(): void {
    if (this.rec) this.detach(this.rec);
    this.rec = null;
    this.restartWithNextLanguage = false;
    this.clearSilence();
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.update({ status: 'idle', interim: '' });
  }

  private detach(rec: SpeechRecognitionLike): void {
    rec.onresult = null;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- one handler per recognition, cleared by detach()
    rec.onerror = null;
    rec.onend = null;
  }

  private armSilence(): void {
    this.clearSilence();
    this.silenceTimer = setTimeout(() => this.stop(), this.options.silenceMs ?? 8_000);
  }

  private clearSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private update(patch: Partial<DictationSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.status === this.snapshot.status && next.interim === this.snapshot.interim && next.error === this.snapshot.error) return;
    this.snapshot = next;
    this.options.onChange(next);
  }
}
