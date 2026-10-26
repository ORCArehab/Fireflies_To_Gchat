/**
 * Safe local preview: fetches (or loads) a meeting, evaluates the eligibility
 * rules and prints the exact Chat message. Never sends anything.
 *
 *   npm run preview -- --fixture test/fixtures/transcript-full.json
 *   npm run preview -- --meeting <fireflies meeting id>     (needs FIREFLIES_API_KEY)
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FirefliesClient, assertSummaryReady, type FirefliesTranscript } from '../fireflies/client.js';
import { evaluateEligibility, meetingRulesSchema } from '../recap/eligibility.js';
import { formatRecap } from '../recap/format.js';

async function main() {
  const { values } = parseArgs({ options: { meeting: { type: 'string' }, fixture: { type: 'string' } } });
  let transcript: FirefliesTranscript;
  if (values.fixture) {
    transcript = JSON.parse(readFileSync(values.fixture, 'utf8')) as FirefliesTranscript;
  } else if (values.meeting) {
    const key = process.env.FIREFLIES_API_KEY;
    if (!key) throw new Error('FIREFLIES_API_KEY is required with --meeting');
    transcript = await new FirefliesClient(key).getTranscript(values.meeting);
  } else {
    throw new Error('usage: preview --meeting <id> | --fixture <file>');
  }

  try {
    assertSummaryReady(transcript);
  } catch (err) {
    process.stdout.write(`Summary not ready: ${(err as Error).message}\n`);
  }
  const rules = meetingRulesSchema.parse(JSON.parse(process.env.MEETING_RULES ?? '[]'));
  const eligibility = evaluateEligibility(rules, {
    title: transcript.title,
    organizerEmail: transcript.organizer_email,
    calendarId: transcript.calendar_id,
  });
  const recap = formatRecap(transcript);
  process.stdout.write(
    `Eligibility: ${eligibility.eligible ? `ELIGIBLE (rule "${eligibility.rule}")` : `NOT ELIGIBLE (${eligibility.reason})`}\n` +
      `Size: ${recap.bytes} bytes${recap.truncated ? ' (truncated)' : ''}\n` +
      `${'-'.repeat(72)}\n${recap.text}\n${'-'.repeat(72)}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
