import { PermanentError, ReauthorizationRequiredError, RetryableError, parseRetryAfter } from '../processing/errors.js';
import type { FetchFn } from '../fireflies/client.js';
import type { AccessTokenProvider } from './credentials.js';

export interface CreateMessageInput {
  space: string;
  text: string;
  /** Custom message id (`client-...`), unique within the space. */
  messageId: string;
  /** Idempotency key: a repeated request with the same id returns the existing message. */
  requestId: string;
}

export interface CreateMessageResult {
  name: string;
  /** True when Chat reported the message already existed (a previous attempt succeeded). */
  alreadyExisted: boolean;
}

export interface ChatSender {
  createMessage(input: CreateMessageInput): Promise<CreateMessageResult>;
}

const CHAT_API = 'https://chat.googleapis.com/v1';

/**
 * spaces.messages.create with *user* authentication: the message is shown as
 * sent by the connected user, with the Chat app's name attributed beside it.
 * User-authenticated messages may contain text only (no cards).
 */
export class GoogleChatClient implements ChatSender {
  constructor(
    private readonly credentials: AccessTokenProvider,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.credentials.getAccessToken();
      const url = new URL(`${CHAT_API}/${input.space}/messages`);
      url.searchParams.set('messageId', input.messageId);
      url.searchParams.set('requestId', input.requestId);

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ text: input.text, markupSyntax: 'MARKUP_SYNTAX_CHAT' }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Ambiguous: the message may or may not have been created. Safe to retry with the same ids.
        throw new RetryableError('chat_send_uncertain', `Chat request failed without a response: ${(err as Error).name}`);
      }

      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { name?: string };
        return { name: body.name ?? `${input.space}/messages/${input.messageId}`, alreadyExisted: false };
      }

      const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
      const status = err.error?.status ?? '';
      const detail = `HTTP ${res.status}${status ? ` ${status}` : ''}`;

      if (res.status === 401) {
        this.credentials.invalidate();
        if (attempt === 0) continue;
        throw new ReauthorizationRequiredError(`Google Chat rejected the user credentials (${detail}). Re-authorize via /oauth/start.`);
      }
      if (res.status === 409 || status === 'ALREADY_EXISTS') {
        // Our deterministic messageId already exists in the space: an earlier attempt posted it.
        return { name: `${input.space}/messages/${input.messageId}`, alreadyExisted: true };
      }
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError('chat_unavailable', `Google Chat temporarily unavailable (${detail})`, parseRetryAfter(res.headers.get('retry-after')));
      }
      if (res.status === 403) {
        throw new RetryableError(
          'chat_permission_denied',
          `Google Chat denied the request (${detail}). Check that the connected user is a member of GOOGLE_CHAT_SPACE, the chat.messages.create scope was granted, and the Workspace admin allows this app.`,
        );
      }
      if (res.status === 404) {
        throw new RetryableError('chat_space_not_found', `Google Chat space not found or not visible to the connected user (${detail}). Check GOOGLE_CHAT_SPACE.`);
      }
      throw new PermanentError('chat_rejected', `Google Chat rejected the message (${detail})`);
    }
    throw new ReauthorizationRequiredError('Google Chat rejected the user credentials. Re-authorize via /oauth/start.');
  }
}

/** Local mode: prints the formatted message instead of sending it. */
export class DryRunChatSender implements ChatSender {
  constructor(private readonly out: (s: string) => void = (s) => process.stdout.write(s)) {}

  async createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
    const bar = '-'.repeat(72);
    this.out(`\n${bar}\nDRY RUN: would post to ${input.space} (messageId=${input.messageId})\n${bar}\n${input.text}\n${bar}\n\n`);
    return { name: `${input.space}/messages/${input.messageId}`, alreadyExisted: false };
  }
}
