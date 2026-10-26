import type { FastifyInstance, FastifyReply } from 'fastify';
import { CHAT_CREATE_SCOPE, type GoogleOAuth } from '../google/oauth.js';
import type { RefreshTokenStore } from '../google/tokenStore.js';
import { randomToken, safeEqual, sha256Hex } from '../ids.js';
import type { StateStore } from '../store/types.js';

export const NONCE_COOKIE = 'ff_oauth_nonce';
const STATE_TTL_MS = 10 * 60_000;

export interface OAuthRouteDeps {
  oauth: GoogleOAuth;
  store: StateStore;
  tokenStore: RefreshTokenStore;
  adminToken: string;
  authorizedEmail: string;
  secureCookies: boolean;
  onConnected: () => void;
  now: () => number;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem}input{width:100%;box-sizing:border-box}</style></head>` +
        `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * Connects the single posting account.
 * - Initiation requires OAUTH_ADMIN_TOKEN, submitted in a POST body (never a URL).
 * - `state` is random, single-use, expires in 10 minutes, and is bound to the
 *   initiating browser through an HttpOnly cookie nonce.
 * - The callback verifies the Google ID token and stores the refresh token only
 *   if the identity equals GOOGLE_AUTHORIZED_USER_EMAIL and the Chat scope was granted.
 */
export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  app.get('/oauth/start', async (_req, reply) =>
    page(
      reply,
      200,
      'Connect Google Chat posting account',
      `<p>Recaps will be posted as <strong>${escapeHtml(deps.authorizedEmail)}</strong>. Only that account can be connected.</p>` +
        `<form method="post" action="/oauth/start"><label for="t">Admin token</label><br>` +
        `<input id="t" name="admin_token" type="password" autocomplete="off" required><br><br><button type="submit">Continue to Google</button></form>`,
    ),
  );

  app.post('/oauth/start', async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const submitted = new URLSearchParams(raw).get('admin_token') ?? '';
    if (!submitted || !safeEqual(submitted, deps.adminToken)) {
      req.log.warn({ event: 'oauth.start_denied' }, 'OAuth initiation with invalid admin token');
      return page(reply, 401, 'Not authorized', '<p>The admin token is incorrect.</p>');
    }
    const now = deps.now();
    const state = randomToken(32);
    const nonce = randomToken(32);
    await deps.store.saveOAuthState(sha256Hex(state), { nonceHash: sha256Hex(nonce), createdAt: now, expiresAt: now + STATE_TTL_MS });
    const cookie = [`${NONCE_COOKIE}=${nonce}`, 'HttpOnly', 'SameSite=Lax', 'Path=/oauth', `Max-Age=${STATE_TTL_MS / 1000}`];
    if (deps.secureCookies) cookie.push('Secure');
    req.log.info({ event: 'oauth.started' }, 'redirecting to Google consent');
    return reply
      .header('Set-Cookie', cookie.join('; '))
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .redirect(deps.oauth.authorizationUrl(state, deps.authorizedEmail), 303);
  });

  app.get('/oauth/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    reply.header('Set-Cookie', `${NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0${deps.secureCookies ? '; Secure' : ''}`);
    const fail = (status: number, reason: string, message: string) => {
      req.log.warn({ event: 'oauth.callback_rejected', reason }, 'OAuth callback rejected');
      return page(reply, status, 'Authorization not completed', `<p>${escapeHtml(message)}</p><p><a href="/oauth/start">Start again</a></p>`);
    };

    if (typeof q.state !== 'string' || q.state.length < 16 || q.state.length > 128) return fail(400, 'missing_state', 'Missing or malformed state.');
    // Consume first so a state can never be replayed, even after an error below.
    const record = await deps.store.consumeOAuthState(sha256Hex(q.state));
    if (!record) return fail(400, 'unknown_state', 'This authorization link is invalid or was already used.');
    if (record.expiresAt <= deps.now()) return fail(400, 'expired_state', 'This authorization attempt expired.');
    const nonce = readCookie(req.headers.cookie, NONCE_COOKIE);
    if (!nonce || !safeEqual(sha256Hex(nonce), record.nonceHash)) {
      return fail(400, 'browser_mismatch', 'Authorization must be completed in the same browser that started it.');
    }
    if (q.error) return fail(400, 'provider_error', `Google returned: ${q.error.slice(0, 64)}`);
    if (typeof q.code !== 'string' || !q.code) return fail(400, 'missing_code', 'Missing authorization code.');

    let tokens;
    try {
      tokens = await deps.oauth.exchangeCode(q.code);
    } catch (err) {
      req.log.error({ event: 'oauth.exchange_failed', err }, 'authorization code exchange failed');
      return page(reply, 502, 'Authorization failed', '<p>Could not exchange the authorization code with Google. Try again.</p>');
    }
    if (!tokens.idToken) return fail(400, 'no_id_token', 'Google did not return an identity token.');

    let identity;
    try {
      identity = await deps.oauth.verifyIdToken(tokens.idToken);
    } catch {
      return fail(400, 'invalid_id_token', 'Could not verify the Google identity.');
    }
    if (!identity.emailVerified || identity.email !== deps.authorizedEmail) {
      return fail(403, 'unexpected_account', `Only ${deps.authorizedEmail} may be connected. Nothing was stored.`);
    }
    if (!tokens.grantedScopes.includes(CHAT_CREATE_SCOPE)) {
      return fail(400, 'scope_not_granted', 'The Google Chat permission was not granted. Start again and allow "send messages in Google Chat".');
    }
    if (!tokens.refreshToken) {
      return fail(400, 'no_refresh_token', 'Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and start again.');
    }

    try {
      await deps.tokenStore.put({ refreshToken: tokens.refreshToken, email: identity.email, scopes: tokens.grantedScopes, connectedAt: new Date(deps.now()).toISOString() });
    } catch (err) {
      req.log.error({ event: 'oauth.store_failed', err }, 'failed to store refresh token');
      return page(reply, 500, 'Authorization failed', '<p>The token could not be stored. Check Secret Manager permissions and try again.</p>');
    }
    deps.onConnected();
    req.log.info({ event: 'oauth.connected', account: identity.email }, 'Google account connected');
    return page(reply, 200, 'Connected', `<p>Recaps will be posted to Google Chat as <strong>${escapeHtml(identity.email)}</strong>. You can close this window.</p>`);
  });
}

export function registerOAuthDisabledRoutes(app: FastifyInstance): void {
  const disabled = async (_req: unknown, reply: FastifyReply) =>
    page(reply, 503, 'OAuth not configured', '<p>Set the Google OAuth client, authorized email, and admin token to enable this.</p>');
  app.get('/oauth/start', disabled);
  app.post('/oauth/start', disabled);
  app.get('/oauth/callback', disabled);
}
