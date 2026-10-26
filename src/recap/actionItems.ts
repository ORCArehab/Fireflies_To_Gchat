export interface ActionItem {
  task: string;
  owner?: string;
  due?: string;
}

/**
 * Fireflies documents `summary.action_items` only as a String. In practice it is
 * newline-separated items, optionally grouped under bold owner headings such as
 * `**Jane Doe**`. This parser is deliberately conservative:
 * - an owner is set only from an explicit bold heading or an explicit
 *   "Owner:" / "Assignee:" label on the item;
 * - a deadline is set only from an explicit "Due:" / "Deadline:" label;
 * - nothing is inferred from free text ("by Friday" stays in the task text).
 * Lines that do not match these shapes are kept verbatim as unowned items.
 */
const OWNER_HEADING = /^\*\*\s*(.+?)\s*\*\*\s*:?$/;
const BULLET_PREFIX = /^(?:[-*•▪●]|\d{1,3}[.)])\s+/;
const TRAILING_TIMESTAMP = /\s*\(\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)\s*$/;
const DUE_LABEL = /[\s([,;–—-]*\b(?:due(?:\s+date)?|deadline)\s*[:–—-]\s*([^)\];]+?)\s*[)\]]?\s*$/i;
const OWNER_LABEL = /[\s([,;–—-]*\b(?:owner|assignee|assigned\s+to)\s*[:–—-]\s*([^)\];,]+?)\s*[)\]]?\s*$/i;
const UNASSIGNED = new Set(['unassigned', 'no owner', 'none', 'n/a', 'general', 'everyone']);

function stripLabel(text: string, label: RegExp): { text: string; value?: string } {
  const m = label.exec(text);
  if (!m?.[1]) return { text };
  const value = m[1].trim();
  return value ? { text: text.slice(0, m.index).trim(), value } : { text };
}

export function parseActionItems(raw: string | null | undefined): ActionItem[] {
  if (!raw?.trim()) return [];
  const items: ActionItem[] = [];
  let currentOwner: string | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = OWNER_HEADING.exec(line);
    if (heading?.[1]) {
      const owner = heading[1].trim();
      currentOwner = UNASSIGNED.has(owner.toLowerCase()) ? undefined : owner;
      continue;
    }

    let text = line.replace(BULLET_PREFIX, '').replace(TRAILING_TIMESTAMP, '').trim();
    // Labels may appear in either order at the end of the line.
    let due: string | undefined;
    let owner: string | undefined;
    for (let i = 0; i < 2; i++) {
      const d = stripLabel(text, DUE_LABEL);
      if (d.value && !due) ({ text, value: due } = d);
      const o = stripLabel(text, OWNER_LABEL);
      if (o.value && !owner) ({ text, value: owner } = o);
    }
    text = text.replace(TRAILING_TIMESTAMP, '').trim();
    if (!text) continue;
    const resolvedOwner = owner && !UNASSIGNED.has(owner.toLowerCase()) ? owner : currentOwner;
    items.push({ task: text, ...(resolvedOwner ? { owner: resolvedOwner } : {}), ...(due ? { due } : {}) });
  }
  return items;
}

/** Decisions only come from an explicit Fireflies summary section titled e.g. "Key decisions". */
export function extractDecisions(
  sections: Array<{ title?: string | null; content?: string | null }> | null | undefined,
): string[] {
  const section = sections?.find((s) => /\bdecisions?\b/i.test(s.title ?? ''));
  if (!section?.content?.trim()) return [];
  return section.content
    .split(/\r?\n/)
    .map((l) => l.trim().replace(BULLET_PREFIX, '').replace(TRAILING_TIMESTAMP, '').trim())
    .filter((l) => l.length > 0 && !OWNER_HEADING.test(l));
}
