import { describe, expect, it } from 'vitest';
import { CHAT_CREATE_SCOPE, buildAuthorizationUrl, type GoogleOAuth, type TokenExchangeResult, type VerifiedIdentity } from '../src/google/oauth.js';
import { MemoryTokenStore } from '../src/google/tokenStore.js';
import { NONCE_COOKIE } from '../src/routes/oauth.js';
import { makeHarness } from './helpers.js';

const ADMIN = 'admin-token-'.padEnd(48, 'x');
const OWNER = 'me@orcarehab.example';

class FakeOAuth implements GoogleOAuth {
  exchange: TokenExchangeResult = {
    accessToken: 'ya29.access-SENSITIVE',
    refreshToken: '1//refresh-SENSITIVE',
    idToken: 'id-token',
    expiresIn: 3599,
    grantedScopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', CHAT_CREATE_SCOPE],
  };
  identity: VerifiedIdentity = { email: OWNER, emailVerified: true };
  exchangedCodes: string[] = [];
  authorizationUrl(state: string, loginHint?: string) {
    return buildAuthorizationUrl({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://svc.example/oauth/callback' }, state, loginHint);
  }
  async exchangeCode(code: string) {
    this.exchangedCodes.push(code);
    return this.exchange;
  }
  async verifyIdToken() {
    return this.identity;
  }
  async refreshAccessToken(): Promise<{ accessToken: string; expiresIn: number }> {
    throw new Error('unused');
  }
}

function setup(now = () => Date.now()) {
  const oauth = new FakeOAuth();
  const tokenStore = new MemoryTokenStore();
  let connected = 0;
  const h = makeHarness({
    now,
    oauth: { client: oauth, tokenStore, adminToken: ADMIN, authorizedEmail: OWNER, secureCookies: true, onConnected: () => void connected++ },
  });
  return { ...h, oauth, tokenStore, connectedCount: () => connected };
}

async function start(h: ReturnType<typeof setup>, token = ADMIN) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/oauth/start',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ admin_token: token }).toString(),
  });
  const location = res.headers.location as string | undefined;
  const state = location ? new URL(location).searchParams.get('state')! : '';
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0]!;
  return { res, location, state, cookie };
}

const callback = (h: ReturnType<typeof setup>, query: Record<string, string>, cookie?: string) =>
  h.app.inject({ method: 'GET', url: `/oauth/callback?${new URLSearchParams(query)}`, headers: cookie ? { cookie } : {} });

describe('Google OAuth', () => {
  it('builds a consent URL with the narrow Chat scope, offline access, state and login hint', () => {
    const url = new URL(buildAuthorizationUrl({ clientId: 'cid', clientSecret: 's', redirectUri: 'https://svc/oauth/callback' }, 'st', OWNER));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(`openid email ${CHAT_CREATE_SCOPE}`);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('login_hint')).toBe(OWNER);
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('GET /oauth/start shows a form and does not start a flow', async () => {
    const h = setup();
    const res = await h.app.inject({ method: 'GET', url: '/oauth/start' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('method="post"');
    expect(h.store.oauthStates.size).toBe(0);
  });

  it('refuses initiation without the admin token', async () => {
    const h = setup();
    for (const token of ['', 'wrong', ADMIN.slice(0, -1)]) {
      const { res } = await start(h, token);
      expect(res.statusCode).toBe(401);
    }
    expect(h.store.oauthStates.size).toBe(0);
  });

  it('completes the flow and stores the refresh token only for the configured account', async () => {
    const h = setup();
    const s = await start(h);
    expect(s.res.statusCode).toBe(303);
    expect(s.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(String(s.res.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax; Path=\/oauth; Max-Age=600; Secure/);

    const res = await callback(h, { state: s.state, code: 'auth-code' }, s.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(OWNER);
    expect(h.tokenStore.value).toMatchObject({ refreshToken: '1//refresh-SENSITIVE', email: OWNER });
    expect(h.connectedCount()).toBe(1);
    // Tokens are never echoed in responses or logs.
    expect(res.body).not.toContain('SENSITIVE');
    expect(h.lines.join('\n')).not.toMatch(/SENSITIVE|auth-code/);
    expect(h.lines.join('\n')).not.toContain(s.state);
  });

  it('rejects a different Google account and stores nothing', async () => {
    const h = setup();
    h.oauth.identity = { email: 'attacker@example.com', emailVerified: true };
    const s = await start(h);
    const res = await callback(h, { state: s.state, code: 'c' }, s.cookie);
    expect(res.statusCode).toBe(403);
    expect(h.tokenStore.value).toBeUndefined();
  });

  it('rejects unverified emails', async () => {
    const h = setup();
    h.oauth.identity = { email: OWNER, emailVerified: false };
    const s = await start(h);
    expect((await callback(h, { state: s.state, code: 'c' }, s.cookie)).statusCode).toBe(403);
    expect(h.tokenStore.value).toBeUndefined();
  });

  it('validates state: unknown, missing, reused, expired, or from another browser', async () => {
    let now = 1_700_000_000_000;
    const h = setup(() => now);

    expect((await callback(h, { code: 'c' })).statusCode).toBe(400);
    expect((await callback(h, { state: 'x'.repeat(43), code: 'c' })).statusCode).toBe(400);

    const a = await start(h);
    expect((await callback(h, { state: a.state, code: 'c' })).statusCode).toBe(400); // no cookie
    expect((await callback(h, { state: a.state, code: 'c' }, a.cookie)).statusCode).toBe(400); // consumed by the failed attempt

    const b = await start(h);
    expect((await callback(h, { state: b.state, code: 'c' }, `${NONCE_COOKIE}=forged`)).statusCode).toBe(400);

    const c = await start(h);
    now += 11 * 60_000;
    expect((await callback(h, { state: c.state, code: 'c' }, c.cookie)).statusCode).toBe(400);

    const d = await start(h);
    expect((await callback(h, { state: d.state, code: 'c' }, d.cookie)).statusCode).toBe(200);
    expect((await callback(h, { state: d.state, code: 'c' }, d.cookie)).statusCode).toBe(400); // single use

    expect(h.oauth.exchangedCodes).toHaveLength(1);
  });

  it('rejects when the Chat scope was not granted (granular consent)', async () => {
    const h = setup();
    h.oauth.exchange = { ...h.oauth.exchange, grantedScopes: ['openid', 'email'] };
    const s = await start(h);
    const res = await callback(h, { state: s.state, code: 'c' }, s.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Google Chat permission was not granted');
    expect(h.tokenStore.value).toBeUndefined();
  });

  it('explains a missing refresh token', async () => {
    const h = setup();
    h.oauth.exchange = { ...h.oauth.exchange, refreshToken: undefined };
    const s = await start(h);
    const res = await callback(h, { state: s.state, code: 'c' }, s.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('did not return a refresh token');
  });

  it('handles a user who denies consent', async () => {
    const h = setup();
    const s = await start(h);
    const res = await callback(h, { state: s.state, error: 'access_denied' }, s.cookie);
    expect(res.statusCode).toBe(400);
    expect(h.oauth.exchangedCodes).toHaveLength(0);
  });

  it('is disabled when OAuth is not configured', async () => {
    const h = makeHarness();
    expect((await h.app.inject({ method: 'GET', url: '/oauth/start' })).statusCode).toBe(503);
  });
});
