import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'doc-router' },
    redact: { paths: ['*.text', '*.content', 'text', 'content'], censor: '[redacted]' },
  });
}
