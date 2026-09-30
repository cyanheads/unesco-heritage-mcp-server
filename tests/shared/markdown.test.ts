/**
 * @fileoverview Tests for the markdown helpers that keep upstream text inside
 * its slot: inline flattening, table-cell escaping, and line-by-line quoting.
 * @module tests/shared/markdown.test
 */

import { describe, expect, it } from 'vitest';
import { cell, inline, quote, quoted } from '@/mcp-server/shared/markdown.js';

/** Line-break characters beyond CR/LF, built from code points so no source line contains them literally. */
const NEL = String.fromCodePoint(0x85);
const LINE_SEP = String.fromCodePoint(0x2028);
const PARA_SEP = String.fromCodePoint(0x2029);
const BREAKS = ['\r', '\n', NEL, LINE_SEP, PARA_SEP];

const hasBreak = (text: string) => BREAKS.some((b) => text.includes(b));

describe('inline', () => {
  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['CR', 'a\rb'],
    ['NEL', `a${NEL}b`],
    ['line separator', `a${LINE_SEP}b`],
    ['paragraph separator', `a${PARA_SEP}b`],
    ['mixed run', `a\r\n\n\r${LINE_SEP}b`],
  ])('flattens %s to one space', (_label, text) => {
    expect(inline(text)).toBe('a b');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(inline('  a \t  b \n\n c  ')).toBe('a b c');
  });

  it('leaves a clean value unchanged and an empty value empty', () => {
    expect(inline('Alderfen Old Town')).toBe('Alderfen Old Town');
    expect(inline('')).toBe('');
    expect(inline(' \n ')).toBe('');
  });

  it('never leaves a line break in its output', () => {
    const out = inline(`x\r\ny\nz\rw${LINE_SEP}v${PARA_SEP}u${NEL}t`);
    expect(out).toBe('x y z w v u t');
    expect(hasBreak(out)).toBe(false);
  });
});

describe('cell', () => {
  it('escapes pipes and flattens line breaks', () => {
    expect(cell('a | b\nc')).toBe('a \\| b c');
  });

  it('escapes a backslash before a pipe so the pipe stays escaped', () => {
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(cell('a\\b')).toBe('a\\\\b');
  });

  it('leaves plain text alone', () => {
    expect(cell('plain text')).toBe('plain text');
  });
});

describe('quote', () => {
  it('prefixes every line and keeps blank lines as a bare marker', () => {
    expect(quote('one\n\ntwo')).toBe('> one\n>\n> two');
  });

  it('splits on CRLF, CR, and Unicode line separators without leaving raw breaks', () => {
    const out = quote(`a\r\nb\rc${LINE_SEP}d${PARA_SEP}e${NEL}f`);
    expect(out).toBe('> a\n> b\n> c\n> d\n> e\n> f');
    expect(out.replaceAll('\n', '')).not.toSatisfy(hasBreak);
  });

  it('treats whitespace-only lines as blank', () => {
    expect(quote('a\n   \nb')).toBe('> a\n>\n> b');
  });

  it('keeps line-leading markdown syntax inside the quote', () => {
    const lines = quote('text\n# Heading\n- item\n```').split('\n');
    expect(lines).toEqual(['> text', '> # Heading', '> - item', '> ```']);
    expect(lines.every((l) => l.startsWith('>'))).toBe(true);
  });

  it('keeps a trailing newline as a trailing blank quote line', () => {
    expect(quote('a\n')).toBe('> a\n>');
  });
});

describe('quoted', () => {
  it('renders a labelled blockquote', () => {
    expect(quoted('Description', 'one\ntwo')).toBe('**Description:**\n> one\n> two');
  });

  it('renders Not available for absent or empty text', () => {
    expect(quoted('Description', undefined)).toBe('**Description:** Not available');
    expect(quoted('Description', '')).toBe('**Description:** Not available');
  });
});
