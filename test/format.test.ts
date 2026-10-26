import { describe, expect, it } from 'vitest';
import type { FirefliesTranscript } from '../src/fireflies/client.js';
import { safeLinkUrl, sanitizeInline } from '../src/recap/escape.js';
import { CHAT_MAX_MESSAGE_BYTES, formatMeetingDate, formatRecap, truncateBytes } from '../src/recap/format.js';
import { fixture } from './helpers.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('recap formatting', () => {
  it('formats a full recap with all sections', () => {
    const { text, truncated } = formatRecap(fixture('transcript-full.json'));
    expect(truncated).toBe(false);
    expect(text).toMatchInlineSnapshot(`
      "🤖 *Automated Fireflies meeting recap*
      *Weekly Clinic Ops Sync*
      Mon, Oct 27, 2025, 10:00 AM PDT

      *Overview*
      The team reviewed scheduling coverage for next week, agreed to roll out the updated intake form, and assigned follow-ups on equipment maintenance.

      *Key decisions*
      • Adopt the updated intake form starting Monday
      • Keep Saturday clinic hours unchanged

      *Action items*
      • Publish the updated intake form to the front desk (Owner: Alex Rivera)
      • Confirm Saturday coverage with the PT team (Owner: Alex Rivera; Due: Oct 31)
      • Schedule the treadmill maintenance visit (Owner: Sam Lee)
      • Share the meeting notes with absent staff (Owner: Sam Lee)

      <https://app.fireflies.ai/view/Weekly-Clinic-Ops-Sync::SYNTH01ABC|View the full meeting in Fireflies>
      _Automated Fireflies recap. AI-generated; verify details in Fireflies before acting._"
    `);
  });

  it('omits sections with no source data', () => {
    const { text } = formatRecap(fixture('transcript-minimal.json'));
    expect(text).toContain('*Overview*\nBrief status check');
    expect(text).not.toContain('Key decisions');
    expect(text).not.toContain('Action items');
    expect(text).toContain('View the full meeting in Fireflies');
  });

  it('uses America/Los_Angeles including DST changes', () => {
    expect(formatMeetingDate(Date.UTC(2026, 0, 15, 18, 30))).toBe('Thu, Jan 15, 2026, 10:30 AM PST');
    expect(formatMeetingDate(Date.UTC(2026, 6, 15, 18, 30))).toBe('Wed, Jul 15, 2026, 11:30 AM PDT');
    expect(formatMeetingDate(null, '2026-07-15T18:30:00.000Z')).toBe('Wed, Jul 15, 2026, 11:30 AM PDT');
    expect(formatMeetingDate(null, null)).toBeUndefined();
  });

  it('neutralizes mentions, links and formatting in meeting-derived content', () => {
    const t: FirefliesTranscript = {
      ...fixture('transcript-full.json'),
      title: '*URGENT* <users/all> _review_ ~x~ `code`',
      summary: {
        short_summary: 'Ping <users/123456> and see <https://evil.example|click here>\n> quoted',
        action_items: '**<users/all>**\nDo the thing',
        extended_sections: null,
      },
    };
    const { text } = formatRecap(t);
    const body = text.split('\n').slice(1, -2).join('\n'); // exclude fixed template header/footer
    expect(body).not.toMatch(/<users\//);
    expect(body).not.toContain('<https://evil');
    expect(body).not.toMatch(/\*URGENT\*/);
    expect(text).toContain('*∗URGENT∗ ‹users/all› ˍreviewˍ ˜x˜ ˋcodeˋ*');
    expect(text).toContain('(Owner: ‹users/all›)');
    expect(text).not.toContain('\n> quoted');
  });

  it('only links https Fireflies URLs', () => {
    expect(safeLinkUrl('https://app.fireflies.ai/view/x', ['fireflies.ai'])).toBe('https://app.fireflies.ai/view/x');
    expect(safeLinkUrl('http://app.fireflies.ai/view/x', ['fireflies.ai'])).toBeUndefined();
    expect(safeLinkUrl('https://fireflies.ai.evil.example/x', ['fireflies.ai'])).toBeUndefined();
    expect(safeLinkUrl('javascript:alert(1)', ['fireflies.ai'])).toBeUndefined();
    const { text } = formatRecap({ ...fixture('transcript-full.json'), transcript_url: 'https://evil.example/x' });
    expect(text).toContain('Fireflies meeting link unavailable.');
  });

  it('strips control and bidi characters', () => {
    expect(sanitizeInline('a‮b\u0007c​d')).toBe('abcd');
  });

  it('stays within the Chat size limit and always keeps the link and label', () => {
    const t = fixture('transcript-full.json');
    const many = Array.from({ length: 2000 }, (_, i) => `Follow up on item number ${i} with the vendor ✅`).join('\n');
    const { text, truncated, counts } = formatRecap({ ...t, summary: { ...t.summary, short_summary: 'é'.repeat(5000), action_items: many } });
    expect(truncated).toBe(true);
    expect(bytes(text)).toBeLessThanOrEqual(30_000);
    expect(bytes(text)).toBeLessThan(CHAT_MAX_MESSAGE_BYTES);
    expect(counts.actionItems).toBe(2000);
    expect(counts.actionItemsShown).toBeGreaterThan(0);
    expect(counts.actionItemsShown).toBeLessThan(2000);
    expect(text).toMatch(new RegExp(`…and ${2000 - counts.actionItemsShown} more action items in Fireflies`));
    expect(text).toContain('View the full meeting in Fireflies>');
    expect(text.endsWith('verify details in Fireflies before acting._')).toBe(true);
  });

  it('keeps the footer even with a tiny budget', () => {
    const { text } = formatRecap(fixture('transcript-full.json'), 400);
    expect(bytes(text)).toBeLessThanOrEqual(400);
    expect(text).toContain('View the full meeting in Fireflies>');
  });

  it('truncates on code point boundaries', () => {
    const out = truncateBytes('😀'.repeat(100), 21);
    expect(bytes(out)).toBeLessThanOrEqual(21);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('�');
  });
});
