import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from '../src/fireflies/signature.js';

const secret = 'test-webhook-secret-0123456789';
const body = Buffer.from('{"event":"meeting.summarized","timestamp":1710876789456,"meeting_id":"ASxwZxCstx"}');

describe('Fireflies webhook signature', () => {
  it('matches the documented format: sha256=<hex HMAC-SHA256 of raw body>', () => {
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(computeSignature(body, secret)).toBe(expected);
    expect(verifySignature(body, expected, secret)).toBe(true);
  });

  it('accepts uppercase hex', () => {
    const sig = `sha256=${computeSignature(body, secret).slice('sha256='.length).toUpperCase()}`;
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it('rejects a wrong secret, tampered body, missing header, or malformed header', () => {
    const sig = computeSignature(body, secret);
    expect(verifySignature(body, computeSignature(body, 'other-secret-0123456789'), secret)).toBe(false);
    expect(verifySignature(Buffer.from(body.toString().replace('ASx', 'BSx')), sig, secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, ['a', 'b'], secret)).toBe(false);
    expect(verifySignature(body, sig.replace('sha256=', ''), secret)).toBe(false);
    expect(verifySignature(body, 'sha1=abcdef', secret)).toBe(false);
    expect(verifySignature(body, `${sig}00`, secret)).toBe(false);
  });

  it('is computed over raw bytes, so re-serialized JSON does not verify', () => {
    const spaced = Buffer.from('{ "event": "meeting.summarized", "timestamp": 1710876789456, "meeting_id": "ASxwZxCstx" }');
    const sigForSpaced = computeSignature(spaced, secret);
    expect(verifySignature(spaced, sigForSpaced, secret)).toBe(true);
    expect(verifySignature(Buffer.from(JSON.stringify(JSON.parse(spaced.toString()))), sigForSpaced, secret)).toBe(false);
  });

  it('handles multi-byte UTF-8 bodies byte-exactly', () => {
    const utf8 = Buffer.from('{"note":"café ☕"}', 'utf8');
    expect(verifySignature(utf8, computeSignature(utf8, secret), secret)).toBe(true);
  });
});
