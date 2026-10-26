import { z } from 'zod';
import { PermanentError, RetryableError, parseRetryAfter } from '../processing/errors.js';

export type FetchFn = typeof fetch;

const TRANSCRIPT_QUERY = `query RecapTranscript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    dateString
    organizer_email
    transcript_url
    calendar_id
    meeting_info { summary_status }
    summary {
      overview
      short_summary
      action_items
      extended_sections { title content }
    }
  }
}`;

const transcriptSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  date: z.number().nullable().optional(),
  dateString: z.string().nullable().optional(),
  organizer_email: z.string().nullable().optional(),
  transcript_url: z.string().nullable().optional(),
  calendar_id: z.string().nullable().optional(),
  meeting_info: z.object({ summary_status: z.string().nullable().optional() }).nullable().optional(),
  summary: z
    .object({
      overview: z.string().nullable().optional(),
      short_summary: z.string().nullable().optional(),
      action_items: z.string().nullable().optional(),
      extended_sections: z
        .array(z.object({ title: z.string().nullable().optional(), content: z.string().nullable().optional() }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export type FirefliesTranscript = z.infer<typeof transcriptSchema>;

const responseSchema = z.object({
  data: z.object({ transcript: transcriptSchema.nullable() }).nullable().optional(),
  errors: z
    .array(
      z
        .object({
          message: z.string().optional(),
          code: z.string().optional(),
          extensions: z.object({ code: z.string().optional(), status: z.number().optional() }).passthrough().optional(),
        })
        .passthrough(),
    )
    .optional(),
});

/** Fireflies error codes (docs: miscellaneous/error-codes) that retrying cannot fix. */
const PERMANENT_CODES = new Set([
  'invalid_arguments',
  'forbidden',
  'paid_required',
  'not_in_team',
  'require_elevated_privilege',
  'account_cancelled',
  'args_required',
  'feature_disabled',
]);

export interface TranscriptSource {
  getTranscript(meetingId: string): Promise<FirefliesTranscript>;
}

export class FirefliesClient implements TranscriptSource {
  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = 'https://api.fireflies.ai/graphql',
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async getTranscript(meetingId: string): Promise<FirefliesTranscript> {
    let res: Response;
    try {
      res = await this.fetchFn(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ query: TRANSCRIPT_QUERY, variables: { id: meetingId } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RetryableError('fireflies_network', `Fireflies request failed: ${(err as Error).name}`);
    }

    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    if (res.status === 429) throw new RetryableError('fireflies_rate_limited', 'Fireflies rate limit', retryAfter);
    if (res.status >= 500 || res.status === 408) {
      throw new RetryableError('fireflies_unavailable', `Fireflies HTTP ${res.status}`, retryAfter);
    }
    if (res.status === 401) throw new PermanentError('fireflies_unauthorized', 'Fireflies API key rejected (401)');

    let body: z.infer<typeof responseSchema>;
    try {
      body = responseSchema.parse(await res.json());
    } catch {
      if (!res.ok) throw new PermanentError('fireflies_http_error', `Fireflies HTTP ${res.status}`);
      throw new RetryableError('fireflies_bad_response', 'Fireflies returned an unexpected response shape');
    }

    const firstError = body.errors?.[0];
    if (firstError) {
      const code = firstError.extensions?.code ?? firstError.code ?? 'unknown';
      if (code === 'too_many_requests') throw new RetryableError('fireflies_rate_limited', 'Fireflies rate limit', retryAfter);
      if (code === 'object_not_found') {
        // The webhook can race API visibility; Cloud Tasks retries bound this.
        throw new RetryableError('fireflies_not_found', 'Fireflies transcript not found yet');
      }
      if (PERMANENT_CODES.has(code)) throw new PermanentError(`fireflies_${code}`, `Fireflies error: ${code}`);
      throw new RetryableError(`fireflies_${code}`, `Fireflies error: ${code}`);
    }
    if (!res.ok) throw new PermanentError('fireflies_http_error', `Fireflies HTTP ${res.status}`);

    const transcript = body.data?.transcript;
    if (!transcript) throw new RetryableError('fireflies_not_found', 'Fireflies transcript not found yet');
    return transcript;
  }
}

/** Throws when the summary is not usable yet (retry) or will never be (permanent). */
export function assertSummaryReady(t: FirefliesTranscript): void {
  const status = t.meeting_info?.summary_status ?? null;
  if (status === 'failed' || status === 'skipped') {
    throw new PermanentError(`summary_${status}`, `Fireflies summary_status is ${status}`);
  }
  if (status === 'processing') throw new RetryableError('summary_processing', 'Fireflies summary still processing');
  const s = t.summary;
  const hasContent = Boolean(s && (s.overview?.trim() || s.short_summary?.trim() || s.action_items?.trim()));
  if (!hasContent) throw new RetryableError('summary_unavailable', 'Fireflies summary not available yet');
}
