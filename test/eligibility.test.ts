import { describe, expect, it } from 'vitest';
import { evaluateEligibility, meetingRulesSchema } from '../src/recap/eligibility.js';

const meta = { title: 'Weekly Clinic Ops Sync', organizerEmail: 'Ops-Lead@OrcaRehab.example', calendarId: 'series-1' };

describe('meeting eligibility', () => {
  it('sends nothing when no rules are configured (default)', () => {
    expect(evaluateEligibility([], meta)).toEqual({ eligible: false, reason: 'no_rules_configured' });
  });

  it('requires every criterion in a rule (AND) and any rule (OR)', () => {
    const rules = meetingRulesSchema.parse([
      { name: 'ops', organizerEmails: ['ops-lead@orcarehab.example'], titleContains: ['ops sync'] },
      { name: 'series', calendarIds: ['series-9'] },
    ]);
    expect(evaluateEligibility(rules, meta)).toEqual({ eligible: true, rule: 'ops' });
    expect(evaluateEligibility(rules, { ...meta, title: 'Patient intake review' })).toEqual({ eligible: false, reason: 'no_rule_matched' });
    expect(evaluateEligibility(rules, { ...meta, organizerEmail: 'someone@else.example' }).eligible).toBe(false);
    expect(evaluateEligibility(rules, { title: 'x', organizerEmail: 'x@y.z', calendarId: 'series-9' })).toEqual({ eligible: true, rule: 'series' });
  });

  it('supports organizer domains and title exclusions', () => {
    const rules = meetingRulesSchema.parse([{ name: 'domain', organizerDomains: ['@orcarehab.example'], titleExcludes: ['1:1', 'patient'] }]);
    expect(evaluateEligibility(rules, meta).eligible).toBe(true);
    expect(evaluateEligibility(rules, { ...meta, title: 'Patient case review' }).eligible).toBe(false);
    expect(evaluateEligibility(rules, { ...meta, organizerEmail: 'a@evil-orcarehab.example' }).eligible).toBe(false);
  });

  it('does not match when metadata is missing', () => {
    const rules = meetingRulesSchema.parse([{ name: 'ops', organizerEmails: ['ops-lead@orcarehab.example'] }]);
    expect(evaluateEligibility(rules, { title: 'Ops', organizerEmail: null }).eligible).toBe(false);
  });

  it('rejects rules without a positive criterion, unknown keys, or empty lists', () => {
    expect(meetingRulesSchema.safeParse([{ name: 'all' }]).success).toBe(false);
    expect(meetingRulesSchema.safeParse([{ name: 'x', titleExcludes: ['a'] }]).success).toBe(false);
    expect(meetingRulesSchema.safeParse([{ name: 'x', organizerEmails: [] }]).success).toBe(false);
    expect(meetingRulesSchema.safeParse([{ name: 'x', titleContains: ['a'], everything: true }]).success).toBe(false);
  });
});
