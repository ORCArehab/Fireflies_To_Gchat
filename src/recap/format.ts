import type { FirefliesTranscript } from '../fireflies/client.js';
import { extractDecisions, parseActionItems, type ActionItem } from './actionItems.js';
import { safeLinkUrl, sanitizeInline } from './escape.js';

/** Google Chat: "The maximum message size, including text and cards, is 32,000 bytes." */
export const CHAT_MAX_MESSAGE_BYTES = 32_000;
/** Headroom below the hard limit for any server-side accounting differences. */
export const DEFAULT_BUDGET_BYTES = 30_000;

const TIME_ZONE = 'America/Los_Angeles';
const OVERVIEW_MAX_BYTES = 1_500;
const FIREFLIES_HOSTS = ['fireflies.ai'];

export interface FormattedRecap {
  text: string;
  bytes: number;
  truncated: boolean;
  counts: { decisions: number; actionItems: number; decisionsShown: number; actionItemsShown: number };
}

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** Truncate to a byte budget on a word boundary without splitting a code point. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const ellipsis = '…';
  const budget = maxBytes - byteLength(ellipsis);
  if (budget <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > out.length * 0.6) out = out.slice(0, lastSpace);
  return `${out.trimEnd()}${ellipsis}`;
}

export function formatMeetingDate(epochMs: number | null | undefined, iso?: string | null): string | undefined {
  const ms = typeof epochMs === 'number' && Number.isFinite(epochMs) ? epochMs : iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return undefined;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function formatActionItem(item: ActionItem): string {
  const parts = [sanitizeInline(item.task)];
  const meta: string[] = [];
  if (item.owner) meta.push(`Owner: ${sanitizeInline(item.owner)}`);
  if (item.due) meta.push(`Due: ${sanitizeInline(item.due)}`);
  if (meta.length > 0) parts.push(`(${meta.join('; ')})`);
  return `• ${parts.join(' ')}`;
}

/**
 * Builds the Chat message text (MARKUP_SYNTAX_CHAT). All meeting-derived content
 * passes through sanitizeInline; only the fixed template uses Chat markup.
 * Sections without source data are omitted. The footer with the Fireflies link
 * and the automation label is reserved first so truncation never drops it.
 */
export function formatRecap(t: FirefliesTranscript, budgetBytes = DEFAULT_BUDGET_BYTES): FormattedRecap {
  const title = truncateBytes(sanitizeInline(t.title) || 'Untitled meeting', 300);
  const date = formatMeetingDate(t.date, t.dateString);
  const overviewSource = t.summary?.short_summary?.trim() || t.summary?.overview?.trim() || '';
  const overview = truncateBytes(sanitizeInline(overviewSource), OVERVIEW_MAX_BYTES);
  const decisions = extractDecisions(t.summary?.extended_sections).map((d) => `• ${sanitizeInline(d)}`).filter((d) => d.length > 2);
  const actionItems = parseActionItems(t.summary?.action_items).map(formatActionItem).filter((a) => a.length > 2);

  const link = safeLinkUrl(t.transcript_url, FIREFLIES_HOSTS);
  const footerLines = [
    link ? `<${link}|View the full meeting in Fireflies>` : 'Fireflies meeting link unavailable.',
    '_Automated Fireflies recap. AI-generated; verify details in Fireflies before acting._',
  ];
  const header = ['🤖 *Automated Fireflies meeting recap*', `*${title}*`, ...(date ? [date] : [])].join('\n');
  const footer = footerLines.join('\n');

  const blocks: string[] = [header];
  let truncated = false;
  const remaining = () => budgetBytes - byteLength([...blocks, footer].join('\n\n')) - 2;

  if (overview) blocks.push(`*Overview*\n${overview}`);
  if (overview !== sanitizeInline(overviewSource)) truncated = true;

  const addList = (heading: string, lines: string[], noun: string): number => {
    if (lines.length === 0) return 0;
    const shown: string[] = [];
    const moreNote = (n: number) => `…and ${n} more ${noun} in Fireflies`;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const pending = lines.length - i - 1;
      const candidate = [...shown, line, ...(pending > 0 ? [moreNote(pending)] : [])];
      const block = `*${heading}*\n${candidate.join('\n')}`;
      if (byteLength(block) + 2 > remaining()) break;
      shown.push(line);
    }
    if (shown.length === 0) {
      const note = `*${heading}*\n${moreNote(lines.length)}`;
      if (byteLength(note) + 2 <= remaining()) blocks.push(note);
      truncated = true;
      return 0;
    }
    const shownCount = shown.length;
    if (shownCount < lines.length) {
      shown.push(moreNote(lines.length - shownCount));
      truncated = true;
    }
    blocks.push(`*${heading}*\n${shown.join('\n')}`);
    return shownCount;
  };

  const decisionsShown = addList('Key decisions', decisions, decisions.length === 1 ? 'decision' : 'decisions');
  const actionItemsShown = addList('Action items', actionItems, 'action items');

  let text = [...blocks, footer].join('\n\n');
  if (byteLength(text) > budgetBytes) {
    // Only reachable with an extremely small budget: keep the footer at all costs.
    text = `${truncateBytes(header, Math.max(0, budgetBytes - byteLength(footer) - 2))}\n\n${footer}`;
    truncated = true;
  }
  return {
    text,
    bytes: byteLength(text),
    truncated,
    counts: {
      decisions: decisions.length,
      actionItems: actionItems.length,
      decisionsShown,
      actionItemsShown,
    },
  };
}
