/**
 * Errors are classified by what the task runner should do next:
 * - RetryableError: return non-2xx so Cloud Tasks retries with backoff.
 * - PermanentError: record a final failure; retrying cannot help.
 */
export class RetryableError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class PermanentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** The connected Google account must be re-authorized via /oauth/start. */
export class ReauthorizationRequiredError extends RetryableError {
  constructor(message: string) {
    super('google_reauthorization_required', message);
    this.name = 'ReauthorizationRequiredError';
  }
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}
