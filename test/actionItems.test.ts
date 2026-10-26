import { describe, expect, it } from 'vitest';
import { extractDecisions, parseActionItems } from '../src/recap/actionItems.js';

describe('action item parsing', () => {
  it('assigns owners only from explicit headings and deadlines only from explicit labels', () => {
    const items = parseActionItems(
      '**Alex Rivera**\nPublish the form (04:12)\nConfirm coverage, Due: Oct 31 (10:45)\n\n**Sam Lee**\n- Call the vendor by Friday\n',
    );
    expect(items).toEqual([
      { task: 'Publish the form', owner: 'Alex Rivera' },
      { task: 'Confirm coverage', owner: 'Alex Rivera', due: 'Oct 31' },
      { task: 'Call the vendor by Friday', owner: 'Sam Lee' },
    ]);
  });

  it('keeps unstructured lines verbatim without inventing owners or deadlines', () => {
    expect(parseActionItems('Review the budget\nFollow up next week')).toEqual([
      { task: 'Review the budget' },
      { task: 'Follow up next week' },
    ]);
  });

  it('treats "Unassigned" headings as no owner and supports inline owner labels', () => {
    expect(parseActionItems('**Unassigned**\nOrder supplies (Owner: Jordan; Due: 11/02)')).toEqual([
      { task: 'Order supplies', owner: 'Jordan', due: '11/02' },
    ]);
    expect(parseActionItems('**Unassigned**\nOrder supplies')).toEqual([{ task: 'Order supplies' }]);
  });

  it('does not treat "overdue" as a deadline label', () => {
    expect(parseActionItems('Chase overdue invoices')).toEqual([{ task: 'Chase overdue invoices' }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseActionItems('')).toEqual([]);
    expect(parseActionItems(null)).toEqual([]);
  });
});

describe('decision extraction', () => {
  it('uses only an explicit decisions section', () => {
    expect(extractDecisions([{ title: 'Key Decisions', content: '- A\n- B' }])).toEqual(['A', 'B']);
    expect(extractDecisions([{ title: 'Risks', content: '- A' }])).toEqual([]);
    expect(extractDecisions(null)).toEqual([]);
  });
});
