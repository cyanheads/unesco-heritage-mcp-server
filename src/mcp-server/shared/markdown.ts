/**
 * @fileoverview Markdown helpers for rendering upstream-authored text in
 * `format()` and enrichment trailers: inline flattening, table-cell escaping,
 * line-by-line blockquoting, and bare URLs. Every helper also renders link,
 * image, and HTML syntax as text; the text helpers drop control and
 * bidi-override characters.
 * @module mcp-server/shared/markdown
 */

/** Line breaks, with VT and FF, which Unicode line breaking treats as mandatory breaks. */
const LINE_BREAKS = /[\n\v\f\r\x85\p{Zl}\p{Zp}]+/gu;
const LINE_SPLIT = /\r\n|[\n\v\f\r\x85\p{Zl}\p{Zp}]/u;
/**
 * Control characters other than tab (the line breaks are handled first), plus
 * bidi embeddings, overrides, and isolates (U+202A–U+202E, U+2066–U+2069).
 */
const INVISIBLE = /(?!\t)[\p{Cc}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
/** A backslash run, or a character that opens a link or image (`[`, `]`) or HTML (`<`, `>`). */
const SYNTAX = /\\+|[[\]<>]/g;
const SYNTAX_CHARS = new Set(['[', ']', '<', '>']);

/**
 * Backslash-escapes `[`, `]`, `<`, and `>`, and doubles a backslash run that
 * directly precedes one so it cannot cancel the escape. Parentheses, `!`, and
 * backticks stay as written: without a bracket they form no link or image.
 */
function escapeSyntax(text: string): string {
  return text.replace(SYNTAX, (match: string, offset: number) => {
    if (!match.startsWith('\\')) return `\\${match}`;
    return SYNTAX_CHARS.has(text.charAt(offset + match.length)) ? match.repeat(2) : match;
  });
}

/** Line breaks to spaces, invisible characters dropped, whitespace collapsed, trimmed. */
function flatten(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** Flattens line breaks to spaces and collapses whitespace, for headings, list items, and trailer lines. */
export function inline(text: string): string {
  return escapeSyntax(flatten(text));
}

/** An inline value safe inside a markdown table cell: flattened, with `\`, `|`, brackets, and angle brackets escaped. */
export function cell(text: string): string {
  return flatten(text).replace(/[\\|[\]<>]/g, '\\$&');
}

/** Quotes free text line by line (`> `), keeping blank lines (after invisible characters are dropped) as a bare `>`. */
export function quote(text: string): string {
  return text
    .split(LINE_SPLIT)
    .map((line) => line.replace(INVISIBLE, ''))
    .map((line) => (line.trim() === '' ? '>' : `> ${escapeSyntax(line)}`))
    .join('\n');
}

/** The scheme and authority of an http(s) URL; brackets there can only be an IPv6 host literal. */
const AUTHORITY = /^https?:\/\/[^/?#]*/i;

/**
 * An http(s) URL for printing bare: `[` and `]` after the authority become
 * `%5B` and `%5D`, so no link, image, or reference syntax can form around it,
 * and the URL still names the same resource. Everything else stays as written.
 */
export function bareUrl(href: string): string {
  const authority = AUTHORITY.exec(href)?.[0] ?? '';
  return authority + href.slice(authority.length).replaceAll('[', '%5B').replaceAll(']', '%5D');
}

/** A labelled blockquote, or `**Label:** Not available` when the text is absent. */
export function quoted(label: string, text: string | undefined): string {
  return text ? `**${label}:**\n${quote(text)}` : `**${label}:** Not available`;
}
