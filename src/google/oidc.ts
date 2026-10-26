import { OAuth2Client } from 'google-auth-library';

export interface TaskRequestVerifier {
  /** Throws if the request was not sent by Cloud Tasks as the configured service account. */
  verify(authorizationHeader: string | undefined): Promise<void>;
}

export class TaskAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskAuthError';
  }
}

/**
 * The service is deployed with public ingress (Fireflies must reach the webhook),
 * so the task endpoint verifies the Google-signed OIDC token that Cloud Tasks
 * attaches: signature, issuer, expiry, audience, and the service account email.
 */
export class GoogleOidcTaskVerifier implements TaskRequestVerifier {
  private readonly client = new OAuth2Client();

  constructor(
    private readonly audience: string,
    private readonly serviceAccountEmail: string,
  ) {}

  async verify(authorizationHeader: string | undefined): Promise<void> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
    if (!match?.[1]) throw new TaskAuthError('missing bearer token');
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({ idToken: match[1], audience: this.audience });
      payload = ticket.getPayload();
    } catch {
      throw new TaskAuthError('invalid OIDC token');
    }
    if (!payload?.email || payload.email_verified !== true || payload.email.toLowerCase() !== this.serviceAccountEmail.toLowerCase()) {
      throw new TaskAuthError('unexpected token identity');
    }
  }
}

/** Local mode with the inline queue: the task endpoint is disabled entirely. */
export class RejectAllTaskVerifier implements TaskRequestVerifier {
  async verify(): Promise<void> {
    throw new TaskAuthError('task endpoint disabled in local mode');
  }
}
