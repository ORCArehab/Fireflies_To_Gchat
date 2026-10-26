/**
 * Neutralizes meeting-derived text before it is placed into a Google Chat
 * message that uses MARKUP_SYNTAX_CHAT.
 *
 * Google does not document an escape character for Chat markup, so instead of
 * relying on undocumented escaping we replace the markup-significant characters
 * with visually similar code points that Chat does not interpret:
 *   <  >   mentions (<users/...>, <users/all>) and custom links (<url|text>)
 *   * _ ~ `  bold, italic, strikethrough, monospace / code blocks
 * Control and bidi-override characters are stripped and whitespace collapsed.
 * Plain "@name" text is not a mention in API-created messages; mentions require
 * the <users/...> form, which cannot survive this function.
 */
const REPLACEMENTS: Record<string, string> = {
  '<': '‹', // ‹
  '>': '›', // ›
  '*': '∗', // ∗
  _: 'ˍ', // ˍ
  '~': '˜', // ˜
  '`': 'ˋ', // ˋ
};

// C0/C1 controls except \n and \t, plus bidi overrides/isolates and zero-width chars.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

export function sanitizeInline(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(UNSAFE_CHARS, '')
    .replace(/[<>*_~`]/g, (c) => REPLACEMENTS[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only https URLs on an expected host are rendered as links. */
export function safeLinkUrl(url: string | null | undefined, allowedHosts: string[]): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    if (!allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return undefined;
    // `|` and `>` would break the <url|text> link syntax.
    return u.toString().replace(/\|/g, '%7C').replace(/>/g, '%3E').replace(/</g, '%3C');
  } catch {
    return undefined;
  }
}
