import { describe, expect, it, vi } from 'vitest';
import { FirefliesClient, assertSummaryReady } from '../src/fireflies/client.js';
import { GoogleChatClient } from '../src/google/chatClient.js';
import { UserCredentials, type AccessTokenProvider } from '../src/google/credentials.js';
import { GoogleOAuthClient, TOKEN_ENDPOINT } from '../src/google/oauth.js';
import { MemoryTokenStore } from '../src/google/tokenStore.js';
import { PermanentError, ReauthorizationRequiredError, RetryableError } from '../src/processing/errors.js';
import { fixture } from './helpers.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('Fireflies client', () => {
  it('sends a GraphQL transcript query with a bearer key', async () => {
    const fetchFn = vi.fn(async () => json(200, { data: { transcript: fixture('transcript-full.json') } }));
    const t = await new FirefliesClient('ff-key', 'https://api.fireflies.ai/graphql', fetchFn as unknown as typeof fetch).getTranscript('SYNTH01ABC');
    expect(t.id).toBe('SYNTH01ABC');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fireflies.ai/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ff-key');
    const body = JSON.parse(String(init.body));
    expect(body.variables).toEqual({ id: 'SYNTH01ABC' });
    expect(body.query).toContain('transcript(id: $id)');
    expect(body.query).toContain('summary_status');
  });

  it.each([
    ['HTTP 429 with Retry-After', () => json(429, {}, { 'retry-after': '30' }), RetryableError, 'fireflies_rate_limited'],
    ['GraphQL too_many_requests', () => json(200, { errors: [{ code: 'too_many_requests', extensions: { code: 'too_many_requests', status: 429 } }] }), RetryableError, 'fireflies_rate_limited'],
    ['HTTP 503', () => json(503, {}), RetryableError, 'fireflies_unavailable'],
    ['object_not_found', () => json(200, { errors: [{ extensions: { code: 'object_not_found' } }] }), RetryableError, 'fireflies_not_found'],
    ['null transcript', () => json(200, { data: { transcript: null } }), RetryableError, 'fireflies_not_found'],
    ['forbidden', () => json(200, { errors: [{ extensions: { code: 'forbidden', status: 403 } }] }), PermanentError, 'fireflies_forbidden'],
    ['HTTP 401', () => json(401, {}), PermanentError, 'fireflies_unauthorized'],
  ])('classifies %s', async (_name, response, type, code) => {
    const client = new FirefliesClient('k', 'https://api.fireflies.ai/graphql', (async () => response()) as unknown as typeof fetch);
    const err = await client.getTranscript('X').catch((e) => e);
    expect(err).toBeInstanceOf(type);
    expect(err.code).toBe(code);
    if (code === 'fireflies_rate_limited' && _name.startsWith('HTTP')) expect(err.retryAfterSeconds).toBe(30);
  });

  it('classifies network failures as retryable', async () => {
    const client = new FirefliesClient('k', undefined, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(client.getTranscript('X')).rejects.toMatchObject({ code: 'fireflies_network' });
  });

  it('summary readiness follows meeting_info.summary_status', () => {
    expect(() => assertSummaryReady(fixture('transcript-full.json'))).not.toThrow();
    expect(() => assertSummaryReady(fixture('transcript-processing.json'))).toThrow(RetryableError);
    const t = fixture('transcript-full.json');
    expect(() => assertSummaryReady({ ...t, meeting_info: { summary_status: 'failed' } })).toThrow(PermanentError);
    expect(() => assertSummaryReady({ ...t, meeting_info: { summary_status: 'skipped' } })).toThrow(PermanentError);
    expect(() => assertSummaryReady({ ...t, meeting_info: null, summary: { overview: '', action_items: null } })).toThrow(RetryableError);
  });
});

describe('Google Chat client', () => {
  const creds = (): AccessTokenProvider & { invalidated: number } => {
    let n = 0;
    return {
      invalidated: 0,
      async getAccessToken() {
        return `token-${++n}`;
      },
      invalidate() {
        this.invalidated++;
      },
    };
  };
  const input = { space: 'spaces/AAAA', text: 'hello', messageId: 'client-ff-abc', requestId: 'req-1' };

  it('posts text with messageId, requestId and Chat markup syntax as the user', async () => {
    const fetchFn = vi.fn(async () => json(200, { name: 'spaces/AAAA/messages/xyz' }));
    const result = await new GoogleChatClient(creds(), fetchFn as unknown as typeof fetch).createMessage(input);
    expect(result).toEqual({ name: 'spaces/AAAA/messages/xyz', alreadyExisted: false });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://chat.googleapis.com/v1/spaces/AAAA/messages');
    expect(url.searchParams.get('messageId')).toBe('client-ff-abc');
    expect(url.searchParams.get('requestId')).toBe('req-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello', markupSyntax: 'MARKUP_SYNTAX_CHAT' });
  });

  it('refreshes once on 401, then asks for re-authorization', async () => {
    const c = creds();
    const fetchFn = vi.fn(async () => json(401, { error: { status: 'UNAUTHENTICATED' } }));
    await expect(new GoogleChatClient(c, fetchFn as unknown as typeof fetch).createMessage(input)).rejects.toBeInstanceOf(ReauthorizationRequiredError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(c.invalidated).toBe(2);
  });

  it('treats an existing custom message id as already sent', async () => {
    const fetchFn = vi.fn(async () => json(409, { error: { status: 'ALREADY_EXISTS' } }));
    const result = await new GoogleChatClient(creds(), fetchFn as unknown as typeof fetch).createMessage(input);
    expect(result).toEqual({ name: 'spaces/AAAA/messages/client-ff-abc', alreadyExisted: true });
  });

  it.each([
    [429, RetryableError, 'chat_unavailable'],
    [500, RetryableError, 'chat_unavailable'],
    [403, RetryableError, 'chat_permission_denied'],
    [404, RetryableError, 'chat_space_not_found'],
    [400, PermanentError, 'chat_rejected'],
  ])('classifies HTTP %i', async (status, type, code) => {
    const fetchFn = async () => json(status, { error: { status: 'X' } });
    const err = await new GoogleChatClient(creds(), fetchFn as unknown as typeof fetch).createMessage(input).catch((e) => e);
    expect(err).toBeInstanceOf(type);
    expect(err.code).toBe(code);
  });

  it('treats a timeout as an uncertain send (retryable with the same ids)', async () => {
    const fetchFn = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await expect(new GoogleChatClient(creds(), fetchFn as unknown as typeof fetch).createMessage(input)).rejects.toMatchObject({ code: 'chat_send_uncertain' });
  });
});

describe('Google user credentials', () => {
  const oauthWith = (fetchFn: typeof fetch) => new GoogleOAuthClient({ clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://svc/oauth/callback' }, fetchFn);
  const stored = (refreshToken = 'rt-1', email = 'me@orcarehab.example') => ({ refreshToken, email, scopes: [], connectedAt: '2026-01-01T00:00:00Z' });

  it('refreshes and caches access tokens', async () => {
    const fetchFn = vi.fn(async () => json(200, { access_token: 'at-1', expires_in: 3599 }));
    const store = new MemoryTokenStore();
    await store.put(stored());
    const creds = new UserCredentials(oauthWith(fetchFn as unknown as typeof fetch), store, 'me@orcarehab.example');
    expect(await creds.getAccessToken()).toBe('at-1');
    expect(await creds.getAccessToken()).toBe('at-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    const params = new URLSearchParams(String(init.body));
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-1');
  });

  it('turns invalid_grant (revoked or expired) into a re-authorization error', async () => {
    const fetchFn = vi.fn(async () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const store = new MemoryTokenStore();
    await store.put(stored());
    const creds = new UserCredentials(oauthWith(fetchFn as unknown as typeof fetch), store, 'me@orcarehab.example');
    const err = await creds.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(ReauthorizationRequiredError);
    expect(err.message).toContain('/oauth/start');
    expect(err.message).not.toContain('rt-1');
  });

  it('picks up a token re-authorized on another instance before failing', async () => {
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const rt = new URLSearchParams(String(init?.body)).get('refresh_token');
      return rt === 'rt-new' ? json(200, { access_token: 'at-new', expires_in: 3599 }) : json(400, { error: 'invalid_grant' });
    });
    const store = new MemoryTokenStore();
    await store.put(stored('rt-old'));
    const creds = new UserCredentials(oauthWith(fetchFn as unknown as typeof fetch), store, 'me@orcarehab.example');
    await expect(creds.getAccessToken()).rejects.toBeInstanceOf(ReauthorizationRequiredError);
    await store.put(stored('rt-new'));
    expect(await creds.getAccessToken()).toBe('at-new');
  });

  it('requires a connected account that matches the configured email', async () => {
    const store = new MemoryTokenStore();
    const creds = new UserCredentials(oauthWith((async () => json(200, {})) as unknown as typeof fetch), store, 'me@orcarehab.example');
    await expect(creds.getAccessToken()).rejects.toThrow(/No Google account is connected/);
    await store.put(stored('rt', 'other@orcarehab.example'));
    creds.reset();
    await expect(creds.getAccessToken()).rejects.toThrow(/different account/);
  });

  it('classifies token endpoint outages as retryable', async () => {
    const store = new MemoryTokenStore();
    await store.put(stored());
    const creds = new UserCredentials(oauthWith((async () => json(503, {})) as unknown as typeof fetch), store, undefined);
    await expect(creds.getAccessToken()).rejects.toMatchObject({ code: 'google_token_error' });
  });
});
