import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

const severityByLevel: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Structured JSON logs that Cloud Logging understands (`severity`, `message`).
 *
 * Policy: log identifiers and processing status only. Never log transcript
 * content, summaries, formatted recaps, OAuth codes/state, or credentials.
 * The redact list is a safety net, not a licence to log sensitive objects.
 */
export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    messageKey: 'message',
    base: { service: 'fireflies-chat-recaps' },
    formatters: {
      level: (label) => ({ severity: severityByLevel[label] ?? 'DEFAULT', level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-hub-signature"]',
        '*.access_token',
        '*.refresh_token',
        '*.id_token',
        '*.code',
        '*.state',
        '*.summary',
        '*.text',
      ],
      censor: '[redacted]',
    },
    serializers: {
      // Only the path: OAuth callback query strings contain the code and state.
      req: (req: { method?: string; url?: string; id?: string }) => ({
        method: req.method,
        path: req.url?.split('?')[0],
        id: req.id,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      // Allow-list: some client errors carry request config (headers, bodies) as properties.
      err: (err: Error & { code?: unknown }) => ({
        type: err?.name,
        message: err?.message,
        code: typeof err?.code === 'string' || typeof err?.code === 'number' ? err.code : undefined,
        stack: err?.stack,
      }),
    },
  };
}

export function createLogger(level = 'info'): Logger {
  return pino(loggerOptions(level));
}

/** Fields that make an ERROR entry visible to Cloud Error Reporting. */
export const errorReportingFields = {
  '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
} as const;
