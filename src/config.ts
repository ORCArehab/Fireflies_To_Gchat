import { z } from 'zod';
import { meetingRulesSchema, type MeetingRule } from './recap/eligibility.js';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const rawSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** `production` requires every durable backend; `local` allows in-memory stand-ins. */
  APP_MODE: z.enum(['production', 'local']).default('production'),
  /** When true, the formatted recap is printed to stdout instead of being posted. */
  DRY_RUN: booleanFromEnv,

  PUBLIC_BASE_URL: z.string().url(),

  FIREFLIES_API_KEY: optionalString,
  FIREFLIES_WEBHOOK_SECRET: optionalString,
  FIREFLIES_API_URL: z.string().url().default('https://api.fireflies.ai/graphql'),

  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  GOOGLE_AUTHORIZED_USER_EMAIL: optionalString,
  GOOGLE_CHAT_SPACE: optionalString,
  OAUTH_ADMIN_TOKEN: optionalString,

  GOOGLE_CLOUD_PROJECT: optionalString,
  REFRESH_TOKEN_SECRET_ID: z.string().default('google-chat-refresh-token'),

  STORE_BACKEND: z.enum(['firestore', 'memory']).optional(),
  QUEUE_BACKEND: z.enum(['cloudtasks', 'inline']).optional(),
  TOKEN_STORE_BACKEND: z.enum(['secretmanager', 'memory']).optional(),

  FIRESTORE_DATABASE_ID: z.string().default('(default)'),
  FIRESTORE_COLLECTION_PREFIX: z.string().regex(/^[a-z0-9_]*$/).default('ff_recaps_'),

  TASKS_LOCATION: optionalString,
  TASKS_QUEUE: optionalString,
  TASKS_INVOKER_SERVICE_ACCOUNT: optionalString,
  TASKS_AUDIENCE: optionalString,
  /** Must match the queue's --max-attempts so the last attempt can be reported as a final failure. */
  TASKS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),

  /** JSON array of approved meeting rules. Empty (the default) means nothing is ever posted. */
  MEETING_RULES: z.string().default('[]'),
});

export interface Config {
  port: number;
  logLevel: string;
  appMode: 'production' | 'local';
  dryRun: boolean;
  publicBaseUrl: string;
  fireflies: { apiKey?: string; webhookSecret?: string; apiUrl: string };
  google: {
    clientId?: string;
    clientSecret?: string;
    authorizedUserEmail?: string;
    chatSpace?: string;
    redirectUri: string;
  };
  oauthAdminToken?: string;
  gcpProject?: string;
  refreshTokenSecretId: string;
  storeBackend: 'firestore' | 'memory';
  queueBackend: 'cloudtasks' | 'inline';
  tokenStoreBackend: 'secretmanager' | 'memory';
  firestore: { databaseId: string; collectionPrefix: string };
  tasks: {
    location?: string;
    queue?: string;
    invokerServiceAccount?: string;
    audience: string;
    handlerUrl: string;
    maxAttempts: number;
  };
  meetingRules: MeetingRule[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProd = e.APP_MODE === 'production';
  const base = e.PUBLIC_BASE_URL.replace(/\/+$/, '');

  let meetingRules: MeetingRule[] = [];
  try {
    const rules = meetingRulesSchema.safeParse(JSON.parse(e.MEETING_RULES));
    if (rules.success) meetingRules = rules.data;
    else problems.push(...rules.error.issues.map((i) => `MEETING_RULES[${i.path.join('.')}]: ${i.message}`));
  } catch {
    problems.push('MEETING_RULES: must be valid JSON');
  }

  const storeBackend = e.STORE_BACKEND ?? (isProd ? 'firestore' : 'memory');
  const queueBackend = e.QUEUE_BACKEND ?? (isProd ? 'cloudtasks' : 'inline');
  const tokenStoreBackend = e.TOKEN_STORE_BACKEND ?? (isProd ? 'secretmanager' : 'memory');

  if (isProd) {
    if (!base.startsWith('https://')) problems.push('PUBLIC_BASE_URL: must be https in production');
    if (storeBackend !== 'firestore') problems.push('STORE_BACKEND: must be firestore in production');
    if (queueBackend !== 'cloudtasks') problems.push('QUEUE_BACKEND: must be cloudtasks in production');
    if (tokenStoreBackend !== 'secretmanager') problems.push('TOKEN_STORE_BACKEND: must be secretmanager in production');
    const required: Array<[string, string | undefined]> = [
      ['FIREFLIES_API_KEY', e.FIREFLIES_API_KEY],
      ['FIREFLIES_WEBHOOK_SECRET', e.FIREFLIES_WEBHOOK_SECRET],
      ['GOOGLE_OAUTH_CLIENT_ID', e.GOOGLE_OAUTH_CLIENT_ID],
      ['GOOGLE_OAUTH_CLIENT_SECRET', e.GOOGLE_OAUTH_CLIENT_SECRET],
      ['GOOGLE_AUTHORIZED_USER_EMAIL', e.GOOGLE_AUTHORIZED_USER_EMAIL],
      ['GOOGLE_CHAT_SPACE', e.GOOGLE_CHAT_SPACE],
      ['OAUTH_ADMIN_TOKEN', e.OAUTH_ADMIN_TOKEN],
      ['GOOGLE_CLOUD_PROJECT', e.GOOGLE_CLOUD_PROJECT],
      ['TASKS_LOCATION', e.TASKS_LOCATION],
      ['TASKS_QUEUE', e.TASKS_QUEUE],
      ['TASKS_INVOKER_SERVICE_ACCOUNT', e.TASKS_INVOKER_SERVICE_ACCOUNT],
    ];
    for (const [name, value] of required) if (!value) problems.push(`${name}: required in production`);
  } else {
    if (!e.FIREFLIES_WEBHOOK_SECRET) problems.push('FIREFLIES_WEBHOOK_SECRET: required (use any random value locally)');
  }

  // Report each variable once, even if several backends need it.
  const requireFor = (name: string, value: string | undefined, why: string) => {
    if (!value && !problems.some((p) => p.startsWith(`${name}:`))) problems.push(`${name}: required for ${why}`);
  };
  if (storeBackend === 'firestore') requireFor('GOOGLE_CLOUD_PROJECT', e.GOOGLE_CLOUD_PROJECT, 'Firestore');
  if (tokenStoreBackend === 'secretmanager') requireFor('GOOGLE_CLOUD_PROJECT', e.GOOGLE_CLOUD_PROJECT, 'Secret Manager');
  if (queueBackend === 'cloudtasks') {
    requireFor('GOOGLE_CLOUD_PROJECT', e.GOOGLE_CLOUD_PROJECT, 'Cloud Tasks');
    requireFor('TASKS_LOCATION', e.TASKS_LOCATION, 'Cloud Tasks');
    requireFor('TASKS_QUEUE', e.TASKS_QUEUE, 'Cloud Tasks');
    requireFor('TASKS_INVOKER_SERVICE_ACCOUNT', e.TASKS_INVOKER_SERVICE_ACCOUNT, 'Cloud Tasks');
  }
  if (e.GOOGLE_CHAT_SPACE && !/^spaces\/[A-Za-z0-9_-]+$/.test(e.GOOGLE_CHAT_SPACE)) {
    problems.push('GOOGLE_CHAT_SPACE: must look like spaces/AAAA... (the space resource name, not a URL)');
  }
  if (e.GOOGLE_AUTHORIZED_USER_EMAIL && !z.string().email().safeParse(e.GOOGLE_AUTHORIZED_USER_EMAIL).success) {
    problems.push('GOOGLE_AUTHORIZED_USER_EMAIL: must be an email address');
  }
  if (e.OAUTH_ADMIN_TOKEN && e.OAUTH_ADMIN_TOKEN.length < 32) {
    problems.push('OAUTH_ADMIN_TOKEN: must be at least 32 characters (generate with `openssl rand -base64 48`)');
  }
  if (e.FIREFLIES_WEBHOOK_SECRET && e.FIREFLIES_WEBHOOK_SECRET.length < 16) {
    problems.push('FIREFLIES_WEBHOOK_SECRET: must be at least 16 characters');
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    appMode: e.APP_MODE,
    dryRun: e.DRY_RUN,
    publicBaseUrl: base,
    fireflies: { apiKey: e.FIREFLIES_API_KEY, webhookSecret: e.FIREFLIES_WEBHOOK_SECRET, apiUrl: e.FIREFLIES_API_URL },
    google: {
      clientId: e.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
      authorizedUserEmail: e.GOOGLE_AUTHORIZED_USER_EMAIL?.toLowerCase(),
      chatSpace: e.GOOGLE_CHAT_SPACE,
      redirectUri: `${base}/oauth/callback`,
    },
    oauthAdminToken: e.OAUTH_ADMIN_TOKEN,
    gcpProject: e.GOOGLE_CLOUD_PROJECT,
    refreshTokenSecretId: e.REFRESH_TOKEN_SECRET_ID,
    storeBackend,
    queueBackend,
    tokenStoreBackend,
    firestore: { databaseId: e.FIRESTORE_DATABASE_ID, collectionPrefix: e.FIRESTORE_COLLECTION_PREFIX },
    tasks: {
      location: e.TASKS_LOCATION,
      queue: e.TASKS_QUEUE,
      invokerServiceAccount: e.TASKS_INVOKER_SERVICE_ACCOUNT,
      audience: e.TASKS_AUDIENCE ?? base,
      handlerUrl: `${base}/tasks/process-meeting`,
      maxAttempts: e.TASKS_MAX_ATTEMPTS,
    },
    meetingRules,
  };
}
