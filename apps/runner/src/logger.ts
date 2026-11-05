import pino, { type Logger } from 'pino';

/**
 * Runner logger. Credentials never reach the logs: authorization headers, tokens, git extra
 * headers and terminal input are redacted (terminal output and login terminals are never logged).
 */
export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'runner' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        '*.token',
        '*.hookToken',
        '*.extraHeader',
        '*.password',
        '*.secret',
        'body.data',
        'body.extraHeader',
        'body.env',
      ],
      censor: '[masqué]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } } : {}),
  });
}
