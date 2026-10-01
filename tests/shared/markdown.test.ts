/**
 * @fileoverview Tests for the markdown helpers that keep upstream text inside
 * its slot: inline flattening, table-cell escaping, line-by-line quoting, inert
 * link/image/HTML syntax, stripped control and bidi characters, and bare URLs
 * printed without brackets.
 * @module tests/shared/markdown.test
 */

import { describe, expect, it } from 'vitest';
import { bareUrl, cell, inline, quote, quoted } from '@/mcp-server/shared/markdown.js';

/** Line-break characters beyond CR/LF, built from code points so no source line contains them literally. */
const NEL = String.fromCodePoint(0x85);
const LINE_SEP = String.fromCodePoint(0x2028);
const PARA_SEP = String.fromCodePoint(0x2029);
const BREAKS = ['\r', '\n', NEL, LINE_SEP, PARA_SEP];

const hasBreak = (text: string) => BREAKS.some((b) => text.includes(b));

const char = (codePoint: number) => String.fromCodePoint(codePoint);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Control characters other than tab and the line breaks (LF, VT, FF, CR, NEL): C0, DEL, and C1. */
const CONTROLS_STRIPPED = [
  ...range(0x00, 0x08),
  ...range(0x0e, 0x1f),
  ...range(0x7f, 0x84),
  ...range(0x86, 0x9f),
];
/** Bidi embeddings, overrides, and isolates: LRE…RLO and LRI…PDI. */
const BIDI = [...range(0x202a, 0x202e), ...range(0x2066, 0x2069)];

/** True when the text holds a control character other than tab or LF, or a bidi override or isolate. */
const hasControl = (text: string) =>
  [...text].some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    return (control && cp !== 0x09 && cp !== 0x0a) || BIDI.includes(cp);
  });

/** True when some `[`, `]`, `<`, or `>` is not backslash-escaped, i.e. could still open markdown or HTML syntax. */
function hasActiveSyntax(text: string): boolean {
  let escaped = false;
  for (const ch of text) {
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if ('[]<>'.includes(ch)) return true;
  }
  return false;
}

/** Quoted lines without their `> ` prefix. */
const quotedBodies = (text: string) => text.split('\n').map((line) => line.replace(/^> ?/, ''));

/** Link, image, reference, autolink, and HTML forms, plus backslashes placed to cancel an escape. */
const SYNTAX_CASES = [
  '![x](https://example.test/t.gif)',
  'Site [label](https://example.test/a) name',
  '[ref]: https://example.test/ref',
  '<https://example.test/auto>',
  '<img src=x onerror=y>',
  '</a><script>x</script>',
  '\\[x](https://example.test/a)',
  '\\\\[x](https://example.test/a)',
  '\\\\\\<b>bold</b>',
  'trailing backslash \\',
];

describe('inline', () => {
  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['CR', 'a\rb'],
    ['NEL', `a${NEL}b`],
    ['line separator', `a${LINE_SEP}b`],
    ['paragraph separator', `a${PARA_SEP}b`],
    ['vertical tab', 'a\vb'],
    ['form feed', 'a\fb'],
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

  it('escapes brackets and angle brackets so link, image, and HTML syntax stays text', () => {
    expect(inline('Site ![x](https://example.test/t.gif)')).toBe(
      'Site !\\[x\\](https://example.test/t.gif)',
    );
    expect(inline('<img src=x onerror=y>')).toBe('\\<img src=x onerror=y\\>');
    expect(inline('<https://example.test/a>')).toBe('\\<https://example.test/a\\>');
  });

  it('leaves parentheses, exclamation marks, backticks, and other punctuation as written', () => {
    const plain = "Old Town (Core Zone) — `Ward` ! *St. Mary's* #2 & co_op";
    expect(inline(plain)).toBe(plain);
  });

  it('doubles a backslash run before a bracket so it cannot cancel the escape, and leaves other backslashes alone', () => {
    expect(inline('a\\[b](u)')).toBe('a\\\\\\[b\\](u)');
    expect(inline('a\\\\<b')).toBe('a\\\\\\\\\\<b');
    expect(inline('a\\b \\(c\\)')).toBe('a\\b \\(c\\)');
  });

  it.each(SYNTAX_CASES)('leaves no unescaped bracket or angle bracket in %j', (text) => {
    expect(hasActiveSyntax(inline(text))).toBe(false);
  });

  it('strips control characters other than tab and line breaks', () => {
    for (const cp of CONTROLS_STRIPPED) {
      expect(inline(`a${char(cp)}b`), cp.toString(16)).toBe('ab');
    }
    expect(inline('a\tb')).toBe('a b');
  });

  it('strips bidi embeddings, overrides, and isolates', () => {
    for (const cp of BIDI) expect(inline(`a${char(cp)}b`), cp.toString(16)).toBe('ab');
  });

  it('never leaves a control or bidi character in its output', () => {
    const all = [...CONTROLS_STRIPPED, ...BIDI, 0x0b, 0x0c].map(char).join('x');
    expect(hasControl(inline(all))).toBe(false);
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

  it('escapes brackets and angle brackets along with pipes', () => {
    expect(cell('a [b](u) | <c>')).toBe('a \\[b\\](u) \\| \\<c\\>');
    expect(cell('a\\[b')).toBe('a\\\\\\[b');
  });

  it.each(SYNTAX_CASES)('leaves no unescaped bracket or angle bracket in %j', (text) => {
    expect(hasActiveSyntax(cell(text))).toBe(false);
  });

  it('strips control and bidi characters', () => {
    expect(cell(`a${char(0)}b${char(0x202e)}c`)).toBe('abc');
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

  it('escapes brackets and angle brackets on every line', () => {
    expect(quote('see [x](https://example.test/a) and ![i](u)\n<script>x</script>')).toBe(
      '> see \\[x\\](https://example.test/a) and !\\[i\\](u)\n> \\<script\\>x\\</script\\>',
    );
  });

  it('keeps a line-leading > at one quote level', () => {
    expect(quote('> nested\nplain')).toBe('> \\> nested\n> plain');
  });

  it.each(SYNTAX_CASES)('leaves no unescaped bracket or angle bracket in %j', (text) => {
    expect(quotedBodies(quote(`${text}\n${text}`)).some(hasActiveSyntax)).toBe(false);
  });

  it('splits on vertical tab and form feed like other line breaks', () => {
    expect(quote('a\vb\fc')).toBe('> a\n> b\n> c');
  });

  it('strips control characters other than tab, and bidi characters, from each line', () => {
    expect(quote(`a${char(0)}b\n${char(0x202e)}c${char(0x2069)}\nd\te`)).toBe('> ab\n> c\n> d\te');
    for (const cp of [...CONTROLS_STRIPPED, ...BIDI]) {
      expect(quote(`a${char(cp)}b`), cp.toString(16)).toBe('> ab');
    }
  });

  it('treats a line holding only control or bidi characters as blank', () => {
    expect(quote(`a\n${char(0)}${char(0x2066)}\nb`)).toBe('> a\n>\n> b');
  });

  it('never leaves a control or bidi character in its output', () => {
    const all = [...CONTROLS_STRIPPED, ...BIDI, 0x0b, 0x0c].map(char).join('x');
    expect(hasControl(quote(all))).toBe(false);
  });
});

describe('bareUrl', () => {
  it('percent-encodes brackets in the path, query, and fragment so no link or image forms', () => {
    expect(bareUrl('https://example.test/![x](https://example.test/t.gif)')).toBe(
      'https://example.test/!%5Bx%5D(https://example.test/t.gif)',
    );
    expect(bareUrl('https://example.test/p?q=[a](b)#[c]:d')).toBe(
      'https://example.test/p?q=%5Ba%5D(b)#%5Bc%5D:d',
    );
  });

  it('keeps an IPv6 host literal as written', () => {
    expect(bareUrl('https://[2001:db8::1]:8080/a[b]')).toBe('https://[2001:db8::1]:8080/a%5Bb%5D');
  });

  it('leaves a URL without brackets unchanged, parentheses and ! included', () => {
    for (const url of [
      'https://whc.unesco.org/en/list/101/',
      'https://example.test/wiki/Old_Town_(core)!',
      'https://example.test/a%5Bb%5D?x=1',
    ]) {
      expect(bareUrl(url)).toBe(url);
    }
  });

  it('prints the same address: decoding the brackets gives back the input', () => {
    const url = 'https://example.test/![x](u)?q=[1]#[2]';
    expect(bareUrl(url).replaceAll('%5B', '[').replaceAll('%5D', ']')).toBe(url);
  });

  it.each([
    'https://example.test/![x](https://example.test/t.gif)',
    'https://example.test/[ref]: https://example.test/ref',
    'https://example.test/\\[x](https://example.test/a)',
    'https://example.test/#]](x)[[',
    '[x](https://example.test/a)',
  ])('leaves no bracket in %j', (url) => {
    expect(bareUrl(url)).not.toMatch(/[[\]]/);
  });
});

describe('quoted', () => {
  it('renders a labelled blockquote', () => {
    expect(quoted('Description', 'one\ntwo')).toBe('**Description:**\n> one\n> two');
  });

  it('escapes link syntax in the quoted text', () => {
    expect(quoted('Description', '[x](u)')).toBe('**Description:**\n> \\[x\\](u)');
  });

  it('renders Not available for absent or empty text', () => {
    expect(quoted('Description', undefined)).toBe('**Description:** Not available');
    expect(quoted('Description', '')).toBe('**Description:** Not available');
  });
});
