import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature';

/**
 * Fireflies Webhooks V2: `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>`,
 * keyed with the signing secret configured in Fireflies. Must be computed over the
 * exact bytes received, before any JSON parsing.
 */
export function computeSignature(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifySignature(rawBody: Buffer, header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match?.[1]) return false;
  const received = Buffer.from(match[1].toLowerCase(), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}
