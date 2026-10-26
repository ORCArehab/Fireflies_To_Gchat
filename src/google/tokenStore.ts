import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export interface StoredRefreshToken {
  refreshToken: string;
  email: string;
  scopes: string[];
  connectedAt: string;
}

export interface RefreshTokenStore {
  get(): Promise<StoredRefreshToken | undefined>;
  put(value: StoredRefreshToken): Promise<void>;
}

const GRPC_NOT_FOUND = 5;

/**
 * Stores the refresh token as a new version of one Secret Manager secret and
 * disables all older versions, so a replaced account's token stops working
 * for this service. The secret itself must be created ahead of time (see README).
 */
export class SecretManagerTokenStore implements RefreshTokenStore {
  private readonly client: SecretManagerServiceClient;
  private readonly secretName: string;

  constructor(project: string, secretId: string, client?: SecretManagerServiceClient) {
    this.client = client ?? new SecretManagerServiceClient();
    this.secretName = `projects/${project}/secrets/${secretId}`;
  }

  async get(): Promise<StoredRefreshToken | undefined> {
    try {
      const [version] = await this.client.accessSecretVersion({ name: `${this.secretName}/versions/latest` });
      const data = version.payload?.data;
      if (!data) return undefined;
      const parsed = JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as StoredRefreshToken;
      return parsed.refreshToken ? parsed : undefined;
    } catch (err) {
      // No enabled versions yet => no account connected.
      const code = (err as { code?: number }).code;
      if (code === GRPC_NOT_FOUND || code === 9 /* FAILED_PRECONDITION: latest is disabled */) return undefined;
      throw err;
    }
  }

  async put(value: StoredRefreshToken): Promise<void> {
    const [added] = await this.client.addSecretVersion({
      parent: this.secretName,
      payload: { data: Buffer.from(JSON.stringify(value), 'utf8') },
    });
    const [versions] = await this.client.listSecretVersions({ parent: this.secretName, filter: 'state:ENABLED' });
    for (const v of versions) {
      if (v.name && v.name !== added.name) await this.client.disableSecretVersion({ name: v.name });
    }
  }
}

/** Local mode only: lost on restart. */
export class MemoryTokenStore implements RefreshTokenStore {
  value?: StoredRefreshToken;
  async get() {
    return this.value;
  }
  async put(value: StoredRefreshToken) {
    this.value = value;
  }
}
