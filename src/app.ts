import Fastify, { type FastifyInstance } from 'fastify';
import type { GoogleOAuth } from './google/oauth.js';
import type { TaskRequestVerifier } from './google/oidc.js';
import type { RefreshTokenStore } from './google/tokenStore.js';
import { loggerOptions, type Logger } from './logger.js';
import type { MeetingProcessor } from './processing/processor.js';
import type { TaskQueue } from './queue/types.js';
import { registerOAuthDisabledRoutes, registerOAuthRoutes } from './routes/oauth.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import type { StateStore } from './store/types.js';

export interface AppDeps {
  logLevel: string;
  /** Overrides logLevel-based logger creation (tests). */
  logger?: Logger;
  webhookSecret: string;
  store: StateStore;
  queue: TaskQueue;
  processor: MeetingProcessor;
  taskVerifier: TaskRequestVerifier;
  oauth?: {
    client: GoogleOAuth;
    tokenStore: RefreshTokenStore;
    adminToken: string;
    authorizedEmail: string;
    secureCookies: boolean;
    onConnected: () => void;
  };
  now?: () => number;
}

const BODY_LIMIT_BYTES = 64 * 1024;

export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: loggerOptions(deps.logLevel) }),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: true,
  }) as unknown as FastifyInstance;

  // Keep the exact bytes: the webhook signature is computed over the raw body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  registerWebhookRoutes(app, { webhookSecret: deps.webhookSecret, store: deps.store, queue: deps.queue, now });
  registerTaskRoutes(app, { verifier: deps.taskVerifier, processor: deps.processor });
  if (deps.oauth) {
    registerOAuthRoutes(app, {
      oauth: deps.oauth.client,
      store: deps.store,
      tokenStore: deps.oauth.tokenStore,
      adminToken: deps.oauth.adminToken,
      authorizedEmail: deps.oauth.authorizedEmail,
      secureCookies: deps.oauth.secureCookies,
      onConnected: deps.oauth.onConnected,
      now,
    });
  } else {
    registerOAuthDisabledRoutes(app);
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ event: 'http.error', err }, 'unhandled error');
    else req.log.warn({ event: 'http.client_error', statusCode: status, code: (err as { code?: string }).code }, 'request rejected');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request' });
  });

  return app;
}
