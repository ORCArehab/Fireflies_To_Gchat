import type { Config } from './config.js';
import { FirefliesClient, type TranscriptSource } from './fireflies/client.js';
import { DryRunChatSender, GoogleChatClient, type ChatSender } from './google/chatClient.js';
import { UserCredentials } from './google/credentials.js';
import { GoogleOAuthClient } from './google/oauth.js';
import { GoogleOidcTaskVerifier, RejectAllTaskVerifier, type TaskRequestVerifier } from './google/oidc.js';
import { MemoryTokenStore, SecretManagerTokenStore, type RefreshTokenStore } from './google/tokenStore.js';
import type { Logger } from './logger.js';
import { PermanentError } from './processing/errors.js';
import { MeetingProcessor } from './processing/processor.js';
import { CloudTasksQueue } from './queue/cloudTasks.js';
import { InlineQueue } from './queue/inline.js';
import type { TaskQueue } from './queue/types.js';
import { FirestoreStateStore } from './store/firestore.js';
import { MemoryStateStore } from './store/memory.js';
import type { StateStore } from './store/types.js';
import type { AppDeps } from './app.js';

const DRY_RUN_SPACE = 'spaces/DRY-RUN';

/** Wires real implementations from validated configuration. */
export function createServices(config: Config, logger: Logger) {
  const store: StateStore =
    config.storeBackend === 'firestore'
      ? new FirestoreStateStore({ projectId: config.gcpProject!, databaseId: config.firestore.databaseId, collectionPrefix: config.firestore.collectionPrefix })
      : new MemoryStateStore();

  const tokenStore: RefreshTokenStore =
    config.tokenStoreBackend === 'secretmanager' ? new SecretManagerTokenStore(config.gcpProject!, config.refreshTokenSecretId) : new MemoryTokenStore();

  const { clientId, clientSecret, authorizedUserEmail, redirectUri } = config.google;
  const oauthClient = clientId && clientSecret ? new GoogleOAuthClient({ clientId, clientSecret, redirectUri }) : undefined;
  const credentials = oauthClient ? new UserCredentials(oauthClient, tokenStore, authorizedUserEmail) : undefined;

  let chat: ChatSender;
  if (config.dryRun) chat = new DryRunChatSender();
  else if (credentials) chat = new GoogleChatClient(credentials);
  else
    chat = {
      createMessage: async () => {
        throw new PermanentError('chat_not_configured', 'Google OAuth is not configured and DRY_RUN is off');
      },
    };

  const fireflies: TranscriptSource = config.fireflies.apiKey
    ? new FirefliesClient(config.fireflies.apiKey, config.fireflies.apiUrl)
    : {
        getTranscript: async () => {
          throw new PermanentError('fireflies_not_configured', 'FIREFLIES_API_KEY is not set');
        },
      };

  const chatSpace = config.google.chatSpace ?? (config.dryRun ? DRY_RUN_SPACE : undefined);
  if (!chatSpace) throw new Error('GOOGLE_CHAT_SPACE is required unless DRY_RUN=true');

  const processor = new MeetingProcessor({
    store,
    fireflies,
    chat,
    rules: config.meetingRules,
    chatSpace,
    logger,
    maxAttempts: config.queueBackend === 'inline' ? 3 : config.tasks.maxAttempts,
  });

  let queue: TaskQueue;
  let taskVerifier: TaskRequestVerifier;
  if (config.queueBackend === 'cloudtasks') {
    queue = new CloudTasksQueue({
      project: config.gcpProject!,
      location: config.tasks.location!,
      queue: config.tasks.queue!,
      handlerUrl: config.tasks.handlerUrl,
      invokerServiceAccount: config.tasks.invokerServiceAccount!,
      audience: config.tasks.audience,
    });
    taskVerifier = new GoogleOidcTaskVerifier(config.tasks.audience, config.tasks.invokerServiceAccount!);
  } else {
    const inline = new InlineQueue(logger);
    inline.handler = async (task, attempt) => {
      const outcome = await processor.process(task.meetingId, { retryCount: attempt, taskName: 'inline' });
      return { retry: outcome.result === 'retry' };
    };
    queue = inline;
    taskVerifier = new RejectAllTaskVerifier();
  }

  const oauth: AppDeps['oauth'] =
    oauthClient && credentials && config.oauthAdminToken && authorizedUserEmail
      ? {
          client: oauthClient,
          tokenStore,
          adminToken: config.oauthAdminToken,
          authorizedEmail: authorizedUserEmail,
          secureCookies: config.publicBaseUrl.startsWith('https://'),
          onConnected: () => credentials.reset(),
        }
      : undefined;

  return { store, queue, processor, taskVerifier, oauth, fireflies, chatSpace };
}
