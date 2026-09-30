/**
 * @fileoverview Markdown helpers for rendering upstream-authored text in
 * `format()` and enrichment trailers: inline flattening, table-cell escaping,
 * and line-by-line blockquoting.
 * @module mcp-server/shared/markdown
 */

const LINE_BREAKS = /[\r\n\x85\p{Zl}\p{Zp}]+/gu;
const LINE_SPLIT = /\r\n|[\r\n\x85\p{Zl}\p{Zp}]/u;

/** Flattens line breaks to spaces and collapses whitespace, for headings, list items, and trailer lines. */
export function inline(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(/\s+/g, ' ').trim();
}

/** An inline value safe inside a markdown table cell: flattened, `\` escaped before `|`. */
export function cell(text: string): string {
  return inline(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Quotes free text line by line (`> `), keeping blank lines as a bare `>`. */
export function quote(text: string): string {
  return text
    .split(LINE_SPLIT)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** A labelled blockquote, or `**Label:** Not available` when the text is absent. */
export function quoted(label: string, text: string | undefined): string {
  return text ? `**${label}:**\n${quote(text)}` : `**${label}:** Not available`;
}
