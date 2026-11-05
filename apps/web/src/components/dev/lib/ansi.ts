/**
 * Terminal text as a terminal would show it, without its control sequences: used by
 * `Dev · Sortie de commande` (« Texte exact du terminal, jamais reformulé ») when the output was
 * captured with colours or progress bars. Characters are never changed, only escape sequences
 * are removed and carriage-return overwrites are resolved.
 */

// CSI (ESC [ … final), OSC (ESC ] … BEL / ESC \), other 2-char escapes, and 8-bit CSI (0x9B).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Normalises captured output for display: strips escape sequences, turns CRLF into LF, and keeps
 * only what a line shows after `\r` overwrites (progress bars), like the terminal does.
 */
export function terminalText(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      // Each segment overwrites the start of the line; a shorter segment leaves the tail visible.
      let screen = '';
      for (const seg of segments) screen = seg + screen.slice(seg.length);
      return screen;
    })
    .join('\n');
}
