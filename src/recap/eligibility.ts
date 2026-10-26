import { z } from 'zod';

const nonEmptyList = z.array(z.string().trim().min(1)).min(1);

/**
 * One approved rule. Every criterion present in a rule must match (AND);
 * a meeting is eligible when any rule matches (OR). A rule needs at least one
 * criterion, so a rule can never accidentally approve every meeting.
 */
export const meetingRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    organizerEmails: nonEmptyList.optional(),
    organizerDomains: nonEmptyList.optional(),
    titleContains: nonEmptyList.optional(),
    titleExcludes: nonEmptyList.optional(),
    calendarIds: nonEmptyList.optional(),
  })
  .strict()
  .refine(
    (r) => Boolean(r.organizerEmails || r.organizerDomains || r.titleContains || r.calendarIds),
    'rule must set at least one of organizerEmails, organizerDomains, titleContains, calendarIds',
  );

export const meetingRulesSchema = z.array(meetingRuleSchema).max(50);
export type MeetingRule = z.infer<typeof meetingRuleSchema>;

/** Metadata as returned by the Fireflies API (verified source), never from the webhook body. */
export interface MeetingMetadata {
  title?: string | null;
  organizerEmail?: string | null;
  calendarId?: string | null;
}

export type EligibilityResult = { eligible: true; rule: string } | { eligible: false; reason: string };

const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim();

function ruleMatches(rule: MeetingRule, meta: MeetingMetadata): boolean {
  const title = norm(meta.title ?? '');
  const organizer = norm(meta.organizerEmail ?? '');
  const organizerDomain = organizer.includes('@') ? organizer.slice(organizer.lastIndexOf('@') + 1) : '';

  if (rule.organizerEmails && !(organizer && rule.organizerEmails.some((e) => norm(e) === organizer))) return false;
  if (rule.organizerDomains && !(organizerDomain && rule.organizerDomains.some((d) => norm(d).replace(/^@/, '') === organizerDomain))) {
    return false;
  }
  if (rule.titleContains && !(title && rule.titleContains.some((t) => title.includes(norm(t))))) return false;
  if (rule.titleExcludes && rule.titleExcludes.some((t) => title.includes(norm(t)))) return false;
  if (rule.calendarIds && !(meta.calendarId && rule.calendarIds.includes(meta.calendarId))) return false;
  return true;
}

export function evaluateEligibility(rules: MeetingRule[], meta: MeetingMetadata): EligibilityResult {
  if (rules.length === 0) return { eligible: false, reason: 'no_rules_configured' };
  const match = rules.find((r) => ruleMatches(r, meta));
  return match ? { eligible: true, rule: match.name } : { eligible: false, reason: 'no_rule_matched' };
}
