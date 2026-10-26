import { ReauthorizationRequiredError } from '../processing/errors.js';
import type { GoogleOAuth } from './oauth.js';
import type { RefreshTokenStore, StoredRefreshToken } from './tokenStore.js';

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  /** Drop the cached access token (e.g. after a 401 from Chat). */
  invalidate(): void;
}

const REFRESH_TOKEN_CACHE_MS = 5 * 60_000;
const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * Mints short-lived access tokens for the connected user from the refresh token
 * in the token store. Caches are per-instance optimizations only; the source of
 * truth is the token store, so scaling to zero loses nothing.
 */
export class UserCredentials implements AccessTokenProvider {
  private refreshCache?: { value: StoredRefreshToken; loadedAt: number };
  private accessCache?: { token: string; expiresAt: number };

  constructor(
    private readonly oauth: GoogleOAuth,
    private readonly store: RefreshTokenStore,
    private readonly expectedEmail: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {
    this.accessCache = undefined;
  }

  /** Called after a successful (re)authorization on this instance. */
  reset(): void {
    this.accessCache = undefined;
    this.refreshCache = undefined;
  }

  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.accessCache && this.accessCache.expiresAt - ACCESS_TOKEN_SKEW_MS > now) return this.accessCache.token;

    let stored = await this.loadRefreshToken(false);
    try {
      return await this.mint(stored);
    } catch (err) {
      if (!(err instanceof ReauthorizationRequiredError)) throw err;
      // Another instance may have stored a newer token after re-authorization.
      const fresh = await this.loadRefreshToken(true);
      if (fresh.refreshToken === stored.refreshToken) throw err;
      stored = fresh;
      return this.mint(stored);
    }
  }

  private async mint(stored: StoredRefreshToken): Promise<string> {
    const { accessToken, expiresIn } = await this.oauth.refreshAccessToken(stored.refreshToken);
    this.accessCache = { token: accessToken, expiresAt: this.now() + expiresIn * 1000 };
    return accessToken;
  }

  private async loadRefreshToken(force: boolean): Promise<StoredRefreshToken> {
    const now = this.now();
    if (!force && this.refreshCache && now - this.refreshCache.loadedAt < REFRESH_TOKEN_CACHE_MS) return this.refreshCache.value;
    const value = await this.store.get();
    if (!value) {
      throw new ReauthorizationRequiredError('No Google account is connected. Authorize the posting account via /oauth/start.');
    }
    if (this.expectedEmail && value.email.toLowerCase() !== this.expectedEmail) {
      throw new ReauthorizationRequiredError(
        'The stored Google authorization belongs to a different account than GOOGLE_AUTHORIZED_USER_EMAIL. Re-authorize via /oauth/start.',
      );
    }
    this.refreshCache = { value, loadedAt: now };
    return value;
  }
}
