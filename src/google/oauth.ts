import { OAuth2Client } from 'google-auth-library';
import { ReauthorizationRequiredError, RetryableError } from '../processing/errors.js';
import type { FetchFn } from '../fireflies/client.js';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const CHAT_CREATE_SCOPE = 'https://www.googleapis.com/auth/chat.messages.create';
/**
 * `chat.messages.create` is the narrowest Chat scope that can post. `openid email`
 * are added only so the callback can verify *which* account authorized; the
 * service never reads anything else from the account.
 */
export const REQUESTED_SCOPES = ['openid', 'email', CHAT_CREATE_SCOPE];

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthorizationUrl(cfg: OAuthClientConfig, state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: REQUESTED_SCOPES.join(' '),
    access_type: 'offline', // refresh token for background posting
    prompt: 'consent', // guarantees a refresh token is returned on re-authorization
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenExchangeResult {
  refreshToken?: string;
  idToken?: string;
  accessToken: string;
  expiresIn: number;
  grantedScopes: string[];
}

export interface VerifiedIdentity {
  email: string;
  emailVerified: boolean;
}

export interface GoogleOAuth {
  authorizationUrl(state: string, loginHint?: string): string;
  exchangeCode(code: string): Promise<TokenExchangeResult>;
  verifyIdToken(idToken: string): Promise<VerifiedIdentity>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
}

export class GoogleOAuthClient implements GoogleOAuth {
  private readonly verifier: OAuth2Client;

  constructor(
    private readonly cfg: OAuthClientConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.verifier = new OAuth2Client({ clientId: cfg.clientId });
  }

  authorizationUrl(state: string, loginHint?: string): string {
    return buildAuthorizationUrl(this.cfg, state, loginHint);
  }

  async exchangeCode(code: string): Promise<TokenExchangeResult> {
    const body = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
    });
    if (body.error) throw new Error(`token exchange failed: ${body.error}`);
    if (typeof body.access_token !== 'string') throw new Error('token exchange returned no access token');
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
      expiresIn: Number(body.expires_in ?? 3600),
      grantedScopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
    };
  }

  async verifyIdToken(idToken: string): Promise<VerifiedIdentity> {
    const ticket = await this.verifier.verifyIdToken({ idToken, audience: this.cfg.clientId });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new Error('ID token has no email claim');
    return { email: payload.email.toLowerCase(), emailVerified: payload.email_verified === true };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    let body: Record<string, unknown>;
    let status: number;
    try {
      ({ body, status } = await this.tokenRequestWithStatus({ grant_type: 'refresh_token', refresh_token: refreshToken }));
    } catch (err) {
      throw new RetryableError('google_token_network', `Google token endpoint unreachable: ${(err as Error).name}`);
    }
    if (body.error === 'invalid_grant') {
      throw new ReauthorizationRequiredError(
        'Google refresh token was rejected (invalid_grant): it was revoked, expired, or superseded. Re-authorize via /oauth/start.',
      );
    }
    if (body.error === 'admin_policy_enforced') {
      throw new ReauthorizationRequiredError('A Google Workspace admin policy blocks this OAuth client (admin_policy_enforced).');
    }
    if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      throw new RetryableError('google_oauth_client_invalid', `Google rejected the OAuth client (${body.error}); check GOOGLE_OAUTH_CLIENT_ID/SECRET.`);
    }
    if (status >= 400 || typeof body.access_token !== 'string') {
      throw new RetryableError('google_token_error', `Google token refresh failed (HTTP ${status}${body.error ? `, ${String(body.error)}` : ''})`);
    }
    return { accessToken: body.access_token, expiresIn: Number(body.expires_in ?? 3600) };
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    return (await this.tokenRequestWithStatus(params)).body;
  }

  private async tokenRequestWithStatus(params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }
}
