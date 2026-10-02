/**
 * @fileoverview Tests for the export-row schemas and their text length bounds,
 * the edge parsers (text cleanup, criteria and the criterion (vi) inference, the
 * components parser with its rejection count and linear-time split, the year
 * parsers, the `whc_sites` parser), and the row → domain mappers, against
 * synthetic fixture rows.
 * @module tests/services/unesco-datahub/rows.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cleanText,
  DatasetMetaSchema,
  EG_FIELDS,
  EgRowSchema,
  ICH_FIELDS,
  IchRowSchema,
  justificationNamesVi,
  MAB_FIELDS,
  MabRowSchema,
  parseComponentsList,
  parseCriteriaTxt,
  parseFusedYears,
  parseWhcSites,
  toBiosphereReserve,
  toGeopark,
  toHeritageSite,
  toIntangibleElement,
  WHC_FIELDS,
  WhcRowSchema,
  yearsIn,
} from '@/services/unesco-datahub/rows.js';
import {
  componentsList,
  EG_ROWS,
  egRow,
  ichRow,
  mabRow,
  WHC_ROWS,
  whcRow,
} from '../../fixtures/rows.js';

const whcById = (id: string) => {
  const row = WHC_ROWS.find((r) => r.id_no === id);
  if (!row) throw new Error(`fixture ${id} missing`);
  return WhcRowSchema.parse(row);
};

describe('field allowlists', () => {
  it.each([
    ['whc001', WHC_FIELDS, WhcRowSchema],
    ['ich001', ICH_FIELDS, IchRowSchema],
    ['mab001', MAB_FIELDS, MabRowSchema],
  ] as const)('%s select list equals the strict row schema keys', (_id, fields, schema) => {
    expect([...fields].sort()).toEqual(Object.keys(schema.shape).sort());
  });

  it('matches the keys of the synthetic row builders', () => {
    expect(Object.keys(whcRow()).sort()).toEqual([...WHC_FIELDS].sort());
    expect(Object.keys(ichRow()).sort()).toEqual([...ICH_FIELDS].sort());
    expect(Object.keys(mabRow()).sort()).toEqual([...MAB_FIELDS].sort());
  });

  it('eg0001 select list equals the strict row schema keys and the row builder', () => {
    expect([...EG_FIELDS].sort()).toEqual(Object.keys(EgRowSchema.shape).sort());
    expect(Object.keys(egRow()).sort()).toEqual([...EG_FIELDS].sort());
  });
});

describe('cleanText', () => {
  it.each([
    ['a <em>b</em> c', 'a b c'],
    ['<I>Italic</I> and <U>under</U>', 'Italic and under'],
    ['x<sup>2</sup> <small>s</small> <b>b</b> <strong>st</strong>', 'x2 s b st'],
    ['<EM >spaced</EM >', 'spaced'],
  ])('strips the closed inline tag list: %j', (input, expected) => {
    expect(cleanText(input)).toBe(expected);
  });

  it.each([
    ['one<br />two', 'one two'],
    ['one<br>two', 'one two'],
    ['one<BR/>two', 'one two'],
  ])('turns a line-break tag into a space: %j', (input, expected) => {
    expect(cleanText(input)).toBe(expected);
  });

  it('leaves other angle-bracket text alone', () => {
    expect(cleanText('a <span>b</span> and 1 < 2 > 0')).toBe('a <span>b</span> and 1 < 2 > 0');
  });

  it('decodes numeric and the five named XML entities', () => {
    expect(cleanText('&#39;x&#39; &#x41; &amp; &lt;&gt; &quot;q&quot; &apos;')).toBe(
      `'x' A & <> "q" '`,
    );
  });

  it('keeps unknown and invalid entities as written', () => {
    expect(cleanText('a&hellip;b &#0; &#1114112; &#xD800;x')).toContain('&hellip;');
    expect(cleanText('&#0;')).toBe('&#0;');
    expect(cleanText('&#1114112;')).toBe('&#1114112;');
  });

  it('does not double-decode', () => {
    expect(cleanText('&amp;lt;')).toBe('&lt;');
    expect(cleanText('&amp;lt;li&amp;gt;item&amp;lt;/li&amp;gt;')).toBe(
      '&lt;li&gt;item&lt;/li&gt;',
    );
  });

  it('trims the result and preserves inner newlines', () => {
    expect(cleanText('  a\nb  ')).toBe('a\nb');
    expect(cleanText('   ')).toBe('');
  });

  it('keeps inner whitespace runs and blank lines as written', () => {
    expect(cleanText('First.\n\nSecond.  Third.\t\tEnd.')).toBe(
      'First.\n\nSecond.  Third.\t\tEnd.',
    );
  });

  it('decodes an encoded angle bracket in prose to a literal one, stripping nothing around it', () => {
    expect(cleanText('depths &lt; 5 km and &gt;2,200 m')).toBe('depths < 5 km and >2,200 m');
    expect(cleanText('forest (<1,300 masl), <em>scrub</em> (>2,200 masl)')).toBe(
      'forest (<1,300 masl), scrub (>2,200 masl)',
    );
  });

  it('decodes an encoded inline tag to literal text rather than stripping it', () => {
    expect(cleanText('&lt;em&gt;Old&lt;/em&gt; Town')).toBe('<em>Old</em> Town');
  });

  it('decodes &#160; and &#xA0; to a no-break space', () => {
    expect(cleanText('a&#160;b&#xA0;c')).toBe('a\u00a0b\u00a0c');
  });

  it('decodes &nbsp; to the same no-break space, in any case', () => {
    expect(cleanText('Lake&nbsp;Salagou and&NBSP;more')).toBe('Lake\u00a0Salagou and\u00a0more');
  });

  it('turns an entity-encoded <ul>/<li> list into one line per item', () => {
    expect(
      cleanText(
        '&lt;ul&gt; &lt;li&gt;Explore the mines.&lt;/li&gt; &lt;li&gt;Follow the trail.&lt;/li&gt; &lt;/ul&gt;',
      ),
    ).toBe('Explore the mines.\nFollow the trail.');
  });

  it('turns a raw list the same way, any case, and keeps the text around it on its own lines', () => {
    expect(cleanText('Highlights:<ul><li>Caves</li>\n<LI >Cliffs</LI ></ul>More text.')).toBe(
      'Highlights:\nCaves\nCliffs\nMore text.',
    );
    expect(cleanText('&LT;UL&GT;&LT;LI&GT;One&LT;/LI&GT;&LT;/UL&GT;')).toBe('One');
  });

  it('cleans inline tags and entities inside list items', () => {
    expect(
      cleanText(
        '&lt;ul&gt;&lt;li&gt;The &quot;<em>red</em>&quot; earth&#39;s&nbsp;quarry &amp; caves &lt; 5 km&lt;/li&gt;&lt;/ul&gt;',
      ),
    ).toBe('The "red" earth\'s\u00a0quarry & caves < 5 km');
  });

  it('leaves list-like text that is not a whole tag alone', () => {
    expect(cleanText('a <list> b <lime> c <u l> d &lt;ul e')).toBe(
      'a <list> b <lime> c <u l> d <ul e',
    );
  });

  describe('runs in linear time on adversarial list markup', () => {
    const fill = (unit: string, length: number) =>
      unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    /** Fastest of seven 10-call batches after a warm-up, in ms per call. */
    const msPerCall = (input: string) => {
      for (let i = 0; i < 3; i += 1) cleanText(input);
      let best = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < 7; sample += 1) {
        const started = performance.now();
        for (let i = 0; i < 10; i += 1) cleanText(input);
        best = Math.min(best, (performance.now() - started) / 10);
      }
      return best;
    };

    it.each<[string, (length: number) => string]>([
      ['a repeated raw opener with no closer', (n) => fill('<li', n)],
      ['a repeated encoded opener with no closer', (n) => fill('&lt;li', n)],
      ['one opener before a whitespace run with no closer', (n) => `<li${' '.repeat(n - 3)}`],
      ['nested raw openers', (n) => fill('<ul><li>', n)],
      ['nested encoded openers', (n) => fill('&lt;ul&gt;&lt;li&gt;', n)],
      ['tags, whitespace, and broken openers', (n) => fill('<li>  <li  ', n)],
      ['a whitespace run with no tag', (n) => `${' '.repeat(n - 1)}x`],
    ])('%s: 80k characters cost under 64× what 5k cost', (_label, build) => {
      const small = msPerCall(build(5_000));
      const large = msPerCall(build(80_000));
      expect(large / small).toBeLessThan(64);
      expect(large).toBeLessThan(25);
    });
  });
});

describe('parseCriteriaTxt', () => {
  it('parses concatenated numerals', () => {
    expect(parseCriteriaTxt('(ii)(iii)(iv)')).toEqual(['ii', 'iii', 'iv']);
    expect(parseCriteriaTxt('(x)')).toEqual(['x']);
  });

  it('returns [] for null and empty', () => {
    expect(parseCriteriaTxt(null)).toEqual([]);
    expect(parseCriteriaTxt('')).toEqual([]);
  });
});

describe('justificationNamesVi', () => {
  it.each([
    'Criterion (vi): synthetic association.',
    'criterion(vi) applies',
    'CRITERION (VI)',
    'Criteria (vi) is named',
    'Preamble.\n\nCriterion (vi): text',
  ])('detects the criterion (vi) heading form: %j', (text) => {
    expect(justificationNamesVi(text)).toBe(true);
  });

  it.each([
    'Criterion (vii): natural beauty.',
    'Criterion (v): settlement.',
    'Criteria (i), (iii), (vi) apply.',
    'The vi criterion',
    '',
  ])('does not match %j', (text) => {
    expect(justificationNamesVi(text)).toBe(false);
  });

  it('is false when there is no statement', () => {
    expect(justificationNamesVi(undefined)).toBe(false);
  });
});

describe('parseComponentsList', () => {
  it('returns nothing for null, empty, and blank lists', () => {
    for (const value of [null, '', '   ']) {
      expect(parseComponentsList(value)).toEqual({ components: [], parts: 0, unparsed: 0 });
    }
  });

  it('parses a well-formed list in upstream order', () => {
    const result = parseComponentsList(
      componentsList([
        { name: 'Alpha', ref: 'r1', latitude: 10, longitude: 20 },
        { name: 'Beta', ref: 'r2', latitude: -33.5, longitude: -70.25 },
      ]),
    );
    expect(result).toEqual({
      components: [
        { name: 'Alpha', ref: 'r1', latitude: 10, longitude: 20 },
        { name: 'Beta', ref: 'r2', latitude: -33.5, longitude: -70.25 },
      ],
      parts: 2,
      unparsed: 0,
    });
  });

  it('keeps commas, `, ref: `, and coordinate keys inside a name (split at the last key sequence)', () => {
    const result = parseComponentsList(
      '{name: North Gate, Upper Ward, ref: a-1, latitude: 1.5, longitude: 2.5}, ' +
        '{name: Odd, ref: name, latitude: 1, longitude: 2 gate, ref: a-2, latitude: 3, longitude: 4}',
    );
    expect(result.unparsed).toBe(0);
    expect(result.components.map((c) => c.name)).toEqual([
      'North Gate, Upper Ward',
      'Odd, ref: name, latitude: 1, longitude: 2 gate',
    ]);
    expect(result.components.map((c) => c.ref)).toEqual(['a-1', 'a-2']);
  });

  it('accepts a comma inside a ref', () => {
    const result = parseComponentsList('{name: N, ref: 12,3, latitude: 1, longitude: 2}');
    expect(result.components).toEqual([{ name: 'N', ref: '12,3', latitude: 1, longitude: 2 }]);
  });

  it('omits the name of a nameless component and trims a trailing-space ref', () => {
    const result = parseComponentsList(
      '{name: , ref: n-1, latitude: 1, longitude: 2}, {name: Spaced, ref: n-2 , latitude: 3, longitude: 4}',
    );
    expect(result.components[0]).toEqual({ ref: 'n-1', latitude: 1, longitude: 2 });
    expect(result.components[0]).not.toHaveProperty('name');
    expect(result.components[1]?.ref).toBe('n-2');
    expect(result.unparsed).toBe(0);
  });

  it('strips inline tags from component names', () => {
    const result = parseComponentsList(
      '{name: Span <em>One</em>, ref: t-1, latitude: 1, longitude: 2}',
    );
    expect(result.components[0]?.name).toBe('Span One');
  });

  it('accepts the coordinate range limits', () => {
    const result = parseComponentsList(
      '{name: A, ref: r, latitude: 90, longitude: 180}, {name: B, ref: s, latitude: -90, longitude: -180}',
    );
    expect(result.components).toHaveLength(2);
    expect(result.unparsed).toBe(0);
  });

  it.each([
    ['latitude above 90', '{name: A, ref: r, latitude: 95, longitude: 10}'],
    ['latitude below -90', '{name: A, ref: r, latitude: -90.5, longitude: 10}'],
    ['longitude above 180', '{name: A, ref: r, latitude: 10, longitude: 181}'],
    ['an empty ref', '{name: A, ref: , latitude: 10, longitude: 10}'],
    ['a whitespace ref', '{name: A, ref:   , latitude: 10, longitude: 10}'],
    ['a garbage entry', '{not a component at all}'],
    ['a non-numeric latitude', '{name: A, ref: r, latitude: north, longitude: 10}'],
    ['a missing longitude', '{name: A, ref: r, latitude: 10}'],
  ])('skips and counts an entry with %s', (_label, entry) => {
    const result = parseComponentsList(entry);
    expect(result).toEqual({ components: [], parts: 1, unparsed: 1 });
  });

  it('keeps the good entries around a rejected one', () => {
    const result = parseComponentsList(
      '{name: Good1, ref: a, latitude: 1, longitude: 2}, {name: Bad, ref: b, latitude: 99, longitude: 2}, {name: Good2, ref: c, latitude: 3, longitude: 4}',
    );
    expect(result.components.map((c) => c.ref)).toEqual(['a', 'c']);
    expect(result.parts).toBe(3);
    expect(result.unparsed).toBe(1);
  });

  it('counts a name containing the literal delimiter as two rejected parts', () => {
    const result = parseComponentsList(
      '{name: Split }, { Name, ref: r, latitude: 1, longitude: 2}',
    );
    expect(result.components).toEqual([]);
    expect(result.parts).toBe(2);
    expect(result.unparsed).toBe(2);
  });

  it('parses the fixture site with awkward entries: 4 of 5 parsed, 1 rejected', () => {
    const row = WHC_ROWS.find((r) => r.id_no === '108');
    const result = parseComponentsList(row?.components_list as string);
    expect(result.parts).toBe(5);
    expect(result.components).toHaveLength(4);
    expect(result.unparsed).toBe(1);
  });

  it.each([
    ['many `, ref: ` sequences and no coordinates', `name: ${', ref: '.repeat(30_000)}x`],
    [
      'many `, ref: , latitude: 1` runs and no longitude',
      `name: ${', ref: , latitude: 1'.repeat(10_000)}x`,
    ],
    [
      'many coordinate tails and a non-numeric end',
      `name: a${', ref: r, latitude: 1, longitude: 2'.repeat(5_000)}x`,
    ],
  ])('reads a 200 KB part with %s in linear time and counts it unparsed', (_label, part) => {
    const started = performance.now();
    const result = parseComponentsList(`{${part}}`);
    const elapsedMs = performance.now() - started;
    expect(result).toEqual({ components: [], parts: 1, unparsed: 1 });
    expect(elapsedMs).toBeLessThan(50);
  });

  it('splits each entry exactly as an anchored name/ref/latitude/longitude pattern would', () => {
    /** The entry grammar: greedy name, lazy ref, anchored numeric tail, so the last key sequence wins. */
    const ENTRY =
      /^name: (.*), ref: (.*?), latitude: (-?\d+(?:\.\d+)?), longitude: (-?\d+(?:\.\d+)?)$/s;
    const expected = (part: string) => {
      const match = ENTRY.exec(part);
      const ref = match?.[2]?.trim();
      const latitude = Number(match?.[3]);
      const longitude = Number(match?.[4]);
      if (!match || !ref || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return { components: [], parts: 1, unparsed: 1 };
      }
      const name = cleanText(match[1] ?? '');
      return {
        components: [{ ref, latitude, longitude, ...(name ? { name } : {}) }],
        parts: 1,
        unparsed: 0,
      };
    };
    const token = fc.constantFrom(
      'name: ',
      ', ref: ',
      ', latitude: ',
      ', longitude: ',
      'Gate',
      'r-1',
      ' ',
      ',',
      ':',
      '-',
      '.',
      '1',
      '45',
      '2.5',
      '-90',
      '181',
      '\n',
      '<em>',
      'é',
    );
    const part = fc
      .tuple(fc.boolean(), fc.array(token, { maxLength: 14 }))
      .map(([lead, tokens]) => `${lead ? 'name: ' : ''}${tokens.join('')}`);
    fc.assert(
      fc.property(part, (p) => {
        expect(parseComponentsList(`{${p}}`)).toEqual(expected(p));
      }),
      { numRuns: 5_000 },
    );
  });
});

describe('yearsIn', () => {
  it('reads every four-digit group', () => {
    expect(yearsIn('1988, 2005,2012')).toEqual([1988, 2005, 2012]);
    expect(yearsIn('2010; 2020, March 2025')).toEqual([2010, 2020, 2025]);
  });

  it('returns [] for null, empty, and yearless text', () => {
    expect(yearsIn(null)).toEqual([]);
    expect(yearsIn('')).toEqual([]);
    expect(yearsIn('none')).toEqual([]);
  });
});

describe('parseFusedYears', () => {
  it('reads nothing for null', () => {
    expect(parseFusedYears(null)).toEqual([]);
  });

  it('reads a single year written as a whole-number double', () => {
    expect(parseFusedYears(2010)).toEqual([2010]);
    expect(parseFusedYears(2010.0)).toEqual([2010]);
  });

  it('splits two fused years', () => {
    expect(parseFusedYears(2004.2016)).toEqual([2004, 2016]);
  });

  it('pads a fraction that JSON serialization shortened (trailing-zero second year)', () => {
    expect(parseFusedYears(2004.201)).toEqual([2004, 2010]);
  });

  it.each([1969, 2101, 2004.1969, 2004.2101, 2004.19])(
    'rejects %d as outside 1970–2100',
    (value) => {
      expect(() => parseFusedYears(value)).toThrow(/1970–2100/);
    },
  );
});

describe('parseWhcSites', () => {
  it('returns [] for null', () => {
    expect(parseWhcSites(null)).toEqual([]);
  });

  it('maps ref to id_no as a string and cleans names', () => {
    const links = parseWhcSites(
      JSON.stringify([
        { ref: 101, name_en: 'A <em>B</em>', name_fr: 'AB', url: 'https://x.test/1' },
        { ref: ' 102 ', name_en: 'C', name_fr: null, url: null },
        { ref: '103', name_en: 'D' },
      ]),
    );
    expect(links).toEqual([
      { id_no: '101', name: 'A B' },
      { id_no: '102', name: 'C' },
      { id_no: '103', name: 'D' },
    ]);
  });

  it('rejects unknown keys, non-arrays, and malformed JSON', () => {
    expect(() => parseWhcSites(JSON.stringify([{ ref: 1, name_en: 'A', extra: true }]))).toThrow();
    expect(() => parseWhcSites(JSON.stringify({ ref: 1 }))).toThrow();
    expect(() => parseWhcSites('not json')).toThrow(SyntaxError);
    expect(() => parseWhcSites(JSON.stringify([{ ref: 1 }]))).toThrow();
  });
});

describe('row schemas', () => {
  it('accept complete synthetic rows', () => {
    expect(() => WhcRowSchema.parse(whcRow())).not.toThrow();
    expect(() => IchRowSchema.parse(ichRow())).not.toThrow();
    expect(() => MabRowSchema.parse(mabRow())).not.toThrow();
  });

  it.each([
    ['whc001', WhcRowSchema, whcRow()],
    ['ich001', IchRowSchema, ichRow()],
    ['mab001', MabRowSchema, mabRow()],
  ] as const)('%s rejects an extra key (a `select` the upstream ignored)', (_id, schema, row) => {
    expect(schema.safeParse({ ...row, uuid: 'x' }).success).toBe(false);
  });

  it.each([
    ['whc001', WhcRowSchema, whcRow(), 'name_en'],
    ['ich001', IchRowSchema, ichRow(), 'title_en'],
    ['mab001', MabRowSchema, mabRow(), 'title_en'],
  ] as const)('%s rejects a missing key', (_id, schema, row, key) => {
    const { [key]: _omitted, ...rest } = row as Record<string, unknown>;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ['id_no 0', { id_no: '0' }],
    ['id_no with a leading zero', { id_no: '012' }],
    ['id_no non-numeric', { id_no: 'abc' }],
    ['unknown category', { category: 'Hybrid' }],
    ['unknown region', { region: 'Atlantis' }],
    ['criteria_txt with an invalid numeral', { criteria_txt: '(xi)' }],
    ['criteria_txt without parentheses', { criteria_txt: 'ii' }],
    ['criteria_txt with a separator', { criteria_txt: '(ii), (iii)' }],
    ['transboundary not True/False', { transboundary: 'yes' }],
    ['a two-digit year', { date_inscribed: '88' }],
    ['danger_list without the Y prefix', { danger_list: '2015' }],
    ['danger_list with a short year', { danger_list: 'Y 15' }],
    ['no States Parties', { states_names: [] }],
    ['coordinates with an extra key', { coordinates: { lon: 1, lat: 2, alt: 3 } }],
    ['string coordinates', { coordinates: { lon: '1', lat: '2' } }],
    ['negative components_count', { components_count: -1 }],
    ['fractional components_count', { components_count: 1.5 }],
  ])('whc001 rejects %s', (_label, override) => {
    expect(WhcRowSchema.safeParse(whcRow(override)).success).toBe(false);
  });

  it('whc001 accepts recorded (vi) and null-valued optional columns', () => {
    expect(WhcRowSchema.safeParse(whcRow({ criteria_txt: '(vi)' })).success).toBe(true);
    expect(
      WhcRowSchema.safeParse(
        whcRow({
          criteria_txt: null,
          coordinates: null,
          area_hectares: null,
          components_list: null,
          danger_list: null,
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['ref with a leading zero', { ich_public_ref: '01' }],
    ['ref of six digits', { ich_public_ref: '123456' }],
    ['unknown list', { type_of_element_en: 'Other List' }],
    ['lowercase country', { countries: ['fr'] }],
    ['no countries', { countries: [] }],
    ['a non-array countries value', { countries: 'FR' }],
    ['null image URL', { main_image_url: null }],
    ['null description', { description_en: null }],
  ])('ich001 rejects %s', (_label, override) => {
    expect(IchRowSchema.safeParse(ichRow(override)).success).toBe(false);
  });

  it.each([
    ['an empty mab_id', { mab_id: '' }],
    ['a 21-character mab_id', { mab_id: 'A'.repeat(21) }],
    ['a lowercase iso2', { iso2: 'fr' }],
    ['a date without a day', { date: '1998' }],
    ['an unknown network', { regional_network: 'Mars Network' }],
    ['null coordinates', { coordinates: null }],
    ['a string population', { population_total: '10' }],
    ['a null area', { area_total: null }],
  ])('mab001 rejects %s', (_label, override) => {
    expect(MabRowSchema.safeParse(mabRow(override)).success).toBe(false);
  });

  it('mab001 accepts a 20-character mab_id and a null network', () => {
    expect(MabRowSchema.safeParse(mabRow({ mab_id: 'A'.repeat(20) })).success).toBe(true);
    expect(MabRowSchema.safeParse(mabRow({ regional_network: null })).success).toBe(true);
  });

  it('eg0001 accepts the synthetic builder row and every fixture row', () => {
    expect(EgRowSchema.safeParse(egRow()).success).toBe(true);
    for (const row of EG_ROWS)
      expect(EgRowSchema.safeParse(row).success, String(row.ugg_id)).toBe(true);
  });

  it.each(['uuid', 'density', 'quote', 'main_image_url'])(
    'eg0001 rejects the unselected field %s (a `select` the upstream ignored)',
    (key) => {
      expect(EgRowSchema.safeParse({ ...egRow(), [key]: null }).success).toBe(false);
    },
  );

  it.each(['ugg_id', 'title_en', 'area_unit', 'population', 'website'])(
    'eg0001 rejects a row missing %s',
    (key) => {
      const { [key]: _omitted, ...rest } = egRow();
      expect(EgRowSchema.safeParse(rest).success).toBe(false);
    },
  );

  it.each([
    ['an area_unit other than ha', { area_unit: 'km2' }],
    ['an uppercase HA area_unit', { area_unit: 'HA' }],
    ['a null area_unit', { area_unit: null }],
    ['a lowercase ugg_id', { ugg_id: 'eufr10' }],
    ['a ugg_id with a separator', { ugg_id: 'EU-FR10' }],
    ['an empty ugg_id', { ugg_id: '' }],
    ['a 21-character ugg_id', { ugg_id: 'A'.repeat(21) }],
    ['a lowercase country code', { countries: ['fr'] }],
    ['a semicolon-joined countries entry', { countries: ['AT;SI'] }],
    ['a countries entry with a one-letter code', { countries: ['A,SI'] }],
    ['a countries entry ending in a comma', { countries: ['AT,'] }],
    ['no countries', { countries: [] }],
    ['a non-array countries value', { countries: 'FR' }],
    ['transnational not True/False', { transnational: 'yes' }],
    ['a date without month and day', { date: '2015' }],
    ['null coordinates', { coordinates: null }],
    ['a null url', { url: null }],
    ['a null description', { description: null }],
    ['a null introduction', { introduction_en: null }],
    ['a null sustaining-communities text', { sustaining_local_communities_description: null }],
    ['a string population', { population: '10' }],
    ['a null area', { area_total: null }],
  ])('eg0001 rejects %s', (_label, override) => {
    expect(EgRowSchema.safeParse(egRow(override)).success).toBe(false);
  });

  it.each([
    ['a null population and website (the sparse row)', { population: null, website: null }],
    ['a zero population', { population: 0 }],
    ['a two-digit country number', { ugg_id: 'ASCN51' }],
    ['a transnational id', { ugg_id: 'EUA301' }],
    ['a 20-character ugg_id', { ugg_id: 'A'.repeat(20) }],
    ['a joined countries entry', { countries: ['AT,SI'] }],
    ['a joined entry with a space after the comma', { countries: ['HU, SK'] }],
    ['two separate countries entries', { countries: ['BE', 'NL'] }],
  ])('eg0001 accepts %s', (_label, override) => {
    expect(EgRowSchema.safeParse(egRow(override)).success).toBe(true);
  });
});

describe('text length bounds', () => {
  const NAME = 2_000;
  const TEXT = 65_536;
  const COMPONENTS = 262_144;
  const URL_LENGTH = 2_048;
  const url = (length: number) => `https://example.test/${'a'.repeat(length - 21)}`;
  const text = (length: number) => 'a'.repeat(length);
  type Case = [string, number, (length: number) => unknown];
  const scalar = (fields: string[], max: number, build = text): Case[] =>
    fields.map((field) => [field, max, build]);
  const listOf = (fields: string[], max: number): Case[] =>
    fields.map((field) => [`${field}[]`, max, (length: number) => [text(length)]]);

  const WHC_CASES: Case[] = [
    ...scalar(
      [
        'name_en',
        'name_fr',
        'name_es',
        'name_ru',
        'name_ar',
        'name_zh',
        'main_image_copyright',
        'main_image_author',
      ],
      NAME,
    ),
    ...scalar(['secondary_dates'], NAME),
    ...scalar(['iso_codes'], NAME, (length) => `FR,${' '.repeat(length - 5)}DE`),
    ...listOf(['states_names'], NAME),
    ...scalar(['short_description_en', 'justification_en'], TEXT),
    ...scalar(['components_list'], COMPONENTS),
    ...scalar(['main_image_url'], URL_LENGTH, url),
  ];
  const ICH_CASES: Case[] = [
    ...scalar(
      [
        'title_en',
        'title_fr',
        'main_image_caption_en',
        'main_image_copyright',
        'main_image_author',
      ],
      NAME,
    ),
    ...listOf(['concepts_primary_names', 'concepts_secondary_names'], NAME),
    ...scalar(['description_en', 'whc_sites'], TEXT),
    ...scalar(['http_url_en', 'main_image_url'], URL_LENGTH, url),
  ];
  const MAB_CASES: Case[] = [
    ...scalar(['title_en', 'country_title_en', 'periodic_review', 'regional_group'], NAME),
    ...scalar(
      ['introduction_en', 'ecological_characteristics_en', 'socio_economic_characteristics_en'],
      TEXT,
    ),
    ...scalar(['website', 'url'], URL_LENGTH, url),
  ];
  const field = (name: string) => name.replace('[]', '');

  it.each(WHC_CASES)('whc001 %s holds at most %d characters', (name, max, build) => {
    expect(WhcRowSchema.safeParse(whcRow({ [field(name)]: build(max) })).success).toBe(true);
    const over = WhcRowSchema.safeParse(whcRow({ [field(name)]: build(max + 1) }));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path[0]).toBe(field(name));
  });

  it.each(ICH_CASES)('ich001 %s holds at most %d characters', (name, max, build) => {
    expect(IchRowSchema.safeParse(ichRow({ [field(name)]: build(max) })).success).toBe(true);
    const over = IchRowSchema.safeParse(ichRow({ [field(name)]: build(max + 1) }));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path[0]).toBe(field(name));
  });

  it.each(MAB_CASES)('mab001 %s holds at most %d characters', (name, max, build) => {
    expect(MabRowSchema.safeParse(mabRow({ [field(name)]: build(max) })).success).toBe(true);
    const over = MabRowSchema.safeParse(mabRow({ [field(name)]: build(max + 1) }));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path[0]).toBe(field(name));
  });

  const EG_CASES: Case[] = [
    ...scalar(['title_en'], NAME),
    ['countries[]', NAME, (length: number) => [`AT,${' '.repeat(length - 5)}SI`]],
    ...scalar(['introduction_en', 'description', 'sustaining_local_communities_description'], TEXT),
    ...scalar(['website', 'url'], URL_LENGTH, url),
  ];

  it.each(EG_CASES)('eg0001 %s holds at most %d characters', (name, max, build) => {
    expect(EgRowSchema.safeParse(egRow({ [field(name)]: build(max) })).success).toBe(true);
    const over = EgRowSchema.safeParse(egRow({ [field(name)]: build(max + 1) }));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path[0]).toBe(field(name));
  });
});

describe('DatasetMetaSchema', () => {
  const meta = {
    metas: { default: { data_processed: 'x', records_count: 3, license: 'CC BY-SA 4.0' } },
  };

  it('reads the three fields and ignores the rest of the document', () => {
    const parsed = DatasetMetaSchema.parse({ ...meta, dataset_id: 'whc001', fields: [] });
    expect(parsed.metas.default).toEqual(meta.metas.default);
  });

  it.each([
    ['a missing default block', { metas: {} }],
    ['a string count', { metas: { default: { ...meta.metas.default, records_count: '3' } } }],
    ['a negative count', { metas: { default: { ...meta.metas.default, records_count: -1 } } }],
    ['a missing license', { metas: { default: { data_processed: 'x', records_count: 3 } } }],
    [
      'a data_processed over 100 characters',
      { metas: { default: { ...meta.metas.default, data_processed: 'x'.repeat(101) } } },
    ],
    [
      'a license over 100 characters',
      { metas: { default: { ...meta.metas.default, license: 'x'.repeat(101) } } },
    ],
  ])('rejects %s', (_label, doc) => {
    expect(DatasetMetaSchema.safeParse(doc).success).toBe(false);
  });
});

describe('toHeritageSite', () => {
  it('maps a full row: aligned codes, secondary years after the first, sorted criteria', () => {
    const { site, componentParts } = toHeritageSite(whcById('101'));
    expect(site).toMatchObject({
      id_no: '101',
      name: 'Alderfen Old Town',
      category: 'Cultural',
      states: ['France'],
      country_codes: ['FR'],
      region: 'Europe and North America',
      transboundary: false,
      inscribed_year: 1988,
      secondary_years: [2005, 2012],
      criteria: ['ii', 'iv'],
      criteria_inferred: [],
      in_danger: false,
      area_hectares: 120.5,
      latitude: 48,
      longitude: 2,
      components_total: 3,
      components_unparsed: 0,
      names: { fr: "Vieille Ville d'Alderfen", es: 'Casco Antiguo de Alderfen', zh: '奥德芬古城' },
      image: {
        url: 'https://whc.unesco.org/document/101',
        copyright: 'Synthetic Photo Agency',
        author: 'A. Tester',
      },
    });
    expect(site.components).toHaveLength(3);
    expect(componentParts).toBe(3);
    expect(site.names).not.toHaveProperty('ru');
    expect(site).not.toHaveProperty('danger_listed_year');
  });

  it('maps a transboundary Danger-list site with aligned multi-state codes', () => {
    const { site } = toHeritageSite(whcById('102'));
    expect(site.states).toEqual(['Germany', 'Poland']);
    expect(site.country_codes).toEqual(['DE', 'PL']);
    expect(site.transboundary).toBe(true);
    expect(site.in_danger).toBe(true);
    expect(site.danger_listed_year).toBe(2015);
    expect(site.category).toBe('Natural');
    expect(site.secondary_years).toEqual([2007]);
  });

  it('infers (vi) for a site with null criteria and marks it', () => {
    const { site } = toHeritageSite(whcById('103'));
    expect(site.criteria).toEqual(['vi']);
    expect(site.criteria_inferred).toEqual(['vi']);
    expect(site).not.toHaveProperty('latitude');
    expect(site).not.toHaveProperty('longitude');
    expect(site).not.toHaveProperty('area_hectares');
  });

  it('adds inferred (vi) to recorded criteria in numeral order', () => {
    const { site } = toHeritageSite(whcById('104'));
    expect(site.criteria).toEqual(['i', 'iii', 'vi']);
    expect(site.criteria_inferred).toEqual(['vi']);
  });

  it('does not mark (vi) inferred when it is already recorded', () => {
    const row = WhcRowSchema.parse(
      whcRow({ criteria_txt: '(iv)(vi)', justification_en: 'Criterion (vi): text.' }),
    );
    const { site } = toHeritageSite(row);
    expect(site.criteria).toEqual(['iv', 'vi']);
    expect(site.criteria_inferred).toEqual([]);
  });

  it('gives a site with no criteria and no statement an empty criteria list', () => {
    const row = WhcRowSchema.parse(whcRow({ criteria_txt: null, justification_en: null }));
    const { site } = toHeritageSite(row);
    expect(site.criteria).toEqual([]);
    expect(site.criteria_inferred).toEqual([]);
  });

  it('keeps an absent description/statement/image absent rather than inventing values', () => {
    const { site } = toHeritageSite(whcById('105'));
    expect(site).not.toHaveProperty('description');
    expect(site).not.toHaveProperty('justification');
    expect(site).not.toHaveProperty('image');
    expect(site.components).toEqual([]);
    expect(site.components_total).toBe(0);
    expect(site.names).toEqual({ fr: 'Site Épars de Hollowmere' });
  });

  it('treats an empty-after-cleaning description as absent', () => {
    const row = WhcRowSchema.parse(
      whcRow({ short_description_en: '  <em></em> ', main_image_copyright: '' }),
    );
    const { site } = toHeritageSite(row);
    expect(site).not.toHaveProperty('description');
    expect(site.image).toEqual({ url: 'https://whc.unesco.org/document/900', author: 'A. Tester' });
  });

  it('gives the code-less State-Party site an empty country_codes list', () => {
    const { site } = toHeritageSite(whcById('106'));
    expect(site.country_codes).toEqual([]);
    expect(site.states).toEqual(['Synthetic Party Name']);
    expect(site.category).toBe('Mixed');
  });

  it('strips tags and decodes entities in names, descriptions, and component names', () => {
    const { site } = toHeritageSite(whcById('107'));
    expect(site.name).toBe('Lantern Bridge Quarter');
    expect(site.names.fr).toBe('Quartier du Pont Lanterne');
    expect(site.description).toBe("Text with a 'quoted' word & more.\nSecond line here.");
    expect(site.components[0]?.name).toBe('Span One');
    expect(site.image?.copyright).toBe('Synthetic\nAgency');
  });

  it('counts unparsed components and reports the part count', () => {
    const { site, componentParts } = toHeritageSite(whcById('108'));
    expect(site.components).toHaveLength(4);
    expect(site.components_unparsed).toBe(1);
    expect(site.components_total).toBe(5);
    expect(componentParts).toBe(5);
    expect(site.components.find((c) => c.ref === '108-003')).not.toHaveProperty('name');
    expect(site.components.find((c) => c.ref === '108-004')).toBeDefined();
  });

  it('reports a part count that differs from components_count without changing the total', () => {
    const row = WhcRowSchema.parse(whcRow({ components_count: 9 }));
    const { site, componentParts } = toHeritageSite(row);
    expect(site.components_total).toBe(9);
    expect(componentParts).toBe(1);
  });

  it('reads secondary_years as empty when only the inscription year is listed', () => {
    const { site } = toHeritageSite(whcById('103'));
    expect(site.secondary_years).toEqual([]);
  });
});

describe('toIntangibleElement', () => {
  it('maps a multinational element with two site links and cleans link names', () => {
    const element = toIntangibleElement(
      IchRowSchema.parse(
        ichRow({
          ich_public_ref: '1001',
          countries: ['FR', 'BE'],
          concepts_primary_names: [' Textile <b>craft</b> '],
          concepts_secondary_names: ['', 'Ritual'],
          whc_sites: JSON.stringify([
            { ref: '101', name_en: 'A <em>B</em>' },
            { ref: 102, name_en: 'C' },
          ]),
        }),
      ),
    );
    expect(element).toMatchObject({
      ich_ref: '1001',
      country_codes: ['FR', 'BE'],
      countries: ['France', 'Belgium'],
      multinational: true,
      concepts: ['Textile craft'],
      concepts_secondary: ['Ritual'],
      world_heritage_sites: [
        { id_no: '101', name: 'A B' },
        { id_no: '102', name: 'C' },
      ],
      list: 'Representative List',
    });
  });

  it('maps a single-country element with null concept arrays and no links', () => {
    const element = toIntangibleElement(
      IchRowSchema.parse(
        ichRow({ concepts_primary_names: null, concepts_secondary_names: null, whc_sites: null }),
      ),
    );
    expect(element.multinational).toBe(false);
    expect(element.concepts).toEqual([]);
    expect(element.concepts_secondary).toEqual([]);
    expect(element.world_heritage_sites).toEqual([]);
  });

  it('keeps line breaks inside an element description and omits absent image credits', () => {
    const element = toIntangibleElement(
      IchRowSchema.parse(
        ichRow({
          description_en: 'One.\n\nTwo.',
          main_image_caption_en: null,
          main_image_copyright: null,
          main_image_author: null,
        }),
      ),
    );
    expect(element.description).toBe('One.\n\nTwo.');
    expect(element.image).toEqual({ url: 'https://ich.unesco.org/img/photo/thumb/9000.jpg' });
  });
});

describe('toBiosphereReserve', () => {
  it('maps a full reserve: designation year, zones, fused years, review years, website', () => {
    const reserve = toBiosphereReserve(
      MabRowSchema.parse(
        mabRow({
          date: '1998-01-01',
          extension: 2004.2016,
          renaming: 2010.0,
          periodic_review: '2010; 2020, March 2025',
          website: 'https://reserve.example.test/x',
        }),
      ),
    );
    expect(reserve).toMatchObject({
      designation_year: 1998,
      extension_years: [2004, 2016],
      renaming_years: [2010],
      periodic_review_years: [2010, 2020, 2025],
      website: 'https://reserve.example.test/x',
      latitude: 48.5,
      longitude: 2.5,
      transboundary: false,
      sids: false,
      area_hectares: {
        total: 5000,
        terrestrial: { total: 5000, core: 1000, buffer: 2000, transition: 2000 },
      },
      population: { total: 1000, core: 0, buffer: 400, transition: 600 },
    });
  });

  it('deduplicates a repeated regional_group entry', () => {
    const reserve = toBiosphereReserve(
      MabRowSchema.parse(mabRow({ regional_group: 'Africa,Africa' })),
    );
    expect(reserve.regions).toEqual(['Africa']);
  });

  it('keeps a reserve spanning two regions in both', () => {
    const reserve = toBiosphereReserve(
      MabRowSchema.parse(mabRow({ regional_group: 'Africa,Arab States' })),
    );
    expect(reserve.regions).toEqual(['Africa', 'Arab States']);
  });

  it('fails the mapping on an unknown region name', () => {
    expect(() =>
      toBiosphereReserve(MabRowSchema.parse(mabRow({ regional_group: 'Atlantis' }))),
    ).toThrow(/unknown regional_group/);
  });

  it('keeps only http(s) websites', () => {
    const site = (website: string | null) =>
      toBiosphereReserve(MabRowSchema.parse(mabRow({ website })));
    expect(site('http://a.example.test/')).toHaveProperty('website', 'http://a.example.test/');
    expect(site('ftp://a.example.test/')).not.toHaveProperty('website');
    expect(site('not a url')).not.toHaveProperty('website');
    expect(site('   ')).not.toHaveProperty('website');
    expect(site(null)).not.toHaveProperty('website');
  });

  it('serializes websites and page URLs as the parser does, which drops line breaks', () => {
    const reserve = toBiosphereReserve(
      MabRowSchema.parse(
        mabRow({ website: 'http://a.example.test', url: 'https://x.test/a\r\n# b' }),
      ),
    );
    expect(reserve.website).toBe('http://a.example.test/');
    expect(reserve.url).toBe('https://x.test/a#%20b');
  });

  it('fails the row when the required page URL is not an http(s) URL', () => {
    expect(() => toBiosphereReserve(MabRowSchema.parse(mabRow({ url: 'not a url' })))).toThrow(
      'url is not an http(s) URL.',
    );
  });
});

describe('URL slots in site and element rows', () => {
  it('serializes a site image URL and drops an image whose URL does not parse', () => {
    const site = (url: string) =>
      toHeritageSite(WhcRowSchema.parse(whcRow({ main_image_url: url }))).site;
    expect(site('https://x.test/doc\n# b').image?.url).toBe('https://x.test/doc#%20b');
    expect(site('not a url')).not.toHaveProperty('image');
  });

  it('serializes element page and image URLs, drops an unparseable image, and fails a bad page URL', () => {
    const element = (row: Parameters<typeof ichRow>[0]) =>
      toIntangibleElement(IchRowSchema.parse(ichRow(row)));
    const e = element({
      http_url_en: 'https://x.test/RL/0\n# a',
      main_image_url: 'https://x.test/img\r\n## b',
    });
    expect(e.url).toBe('https://x.test/RL/0#%20a');
    expect(e.image?.url).toBe('https://x.test/img##%20b');
    expect(element({ main_image_url: 'javascript:alert(1)' })).not.toHaveProperty('image');
    expect(() => element({ http_url_en: 'ftp://x.test/' })).toThrow(
      'http_url_en is not an http(s) URL.',
    );
  });
});

describe('code and link shapes', () => {
  it.each(['F R', 'fr', 'FR;DE', 'FR,\n# X'])('rejects iso_codes %j', (iso_codes) => {
    expect(WhcRowSchema.safeParse(whcRow({ iso_codes })).success).toBe(false);
  });

  it.each(['FR', 'DE, PL', 'DE,PL'])('accepts iso_codes %j', (iso_codes) => {
    expect(WhcRowSchema.safeParse(whcRow({ iso_codes })).success).toBe(true);
  });

  it.each(['101\n# X', 'abc', '0', 0, 1.5])('rejects the whc_sites ref %j', (ref) => {
    expect(() => parseWhcSites(JSON.stringify([{ ref, name_en: 'A' }]))).toThrow();
  });
});

describe('toBiosphereReserve — ids, narratives, and year lists', () => {
  it('NFC-normalizes a decomposed non-ASCII mab_id', () => {
    const decomposed = 'PEÑandu2001';
    const reserve = toBiosphereReserve(MabRowSchema.parse(mabRow({ mab_id: decomposed })));
    expect(reserve.mab_id).toBe('PEÑandu2001');
  });

  it('decodes entities and drops null narrative fields', () => {
    const reserve = toBiosphereReserve(
      MabRowSchema.parse(
        mabRow({
          ecological_characteristics_en: 'Marsh &#39;core&#39;.',
          socio_economic_characteristics_en: null,
          regional_network: null,
        }),
      ),
    );
    expect(reserve.ecological_characteristics).toBe("Marsh 'core'.");
    expect(reserve).not.toHaveProperty('socio_economic_characteristics');
    expect(reserve).not.toHaveProperty('regional_network');
  });

  it('reads no extension, renaming, or review years when the columns are null', () => {
    const reserve = toBiosphereReserve(MabRowSchema.parse(mabRow()));
    expect(reserve.extension_years).toEqual([]);
    expect(reserve.renaming_years).toEqual([]);
    expect(reserve.periodic_review_years).toEqual([]);
  });

  it('fails the mapping on an out-of-range fused year', () => {
    expect(() => toBiosphereReserve(MabRowSchema.parse(mabRow({ extension: 1850 })))).toThrow();
  });
});

describe('toGeopark', () => {
  const geopark = (overrides: Record<string, unknown> = {}) =>
    toGeopark(EgRowSchema.parse(egRow(overrides)));
  const fixture = (ugg_id: string) => {
    const row = EG_ROWS.find((r) => r.ugg_id === ugg_id);
    if (!row) throw new Error(`fixture ${ugg_id} missing`);
    return toGeopark(EgRowSchema.parse(row));
  };

  it('maps a full row, decoding every entity and trimming a trailing &nbsp;', () => {
    expect(fixture('EUFR90')).toEqual({
      ugg_id: 'EUFR90',
      name: 'Alderfen Cliffs UNESCO Global Geopark',
      country_codes: ['FR'],
      countries: ['France'],
      transnational: false,
      designation_year: 2015,
      area_hectares: 120_000,
      population: 52_000,
      latitude: 49.9,
      longitude: 1.5,
      introduction: `The "Alderfen" cliffs record 300 million years of the coast's history.`,
      description: 'Chalk cliffs and fossil beds.\u00a0Synthetic sea stacks rise offshore.',
      sustaining_local_communities:
        'Fishing & farming villages share the coast.\u00a0Synthetic markets sell local stone.',
      website: 'https://geopark.example.test/alderfen',
      url: 'https://www.unesco.org/en/iggp/alderfen-cliffs-unesco-global-geopark',
    });
  });

  it('splits the joined countries entry of a transnational geopark, with display names', () => {
    expect(fixture('EUA190')).toMatchObject({
      country_codes: ['DE', 'PL'],
      countries: ['Germany', 'Poland'],
      transnational: true,
    });
    expect(geopark({ countries: ['HU, SK'] }).country_codes).toEqual(['HU', 'SK']);
    expect(geopark({ countries: ['BE', 'NL'] }).country_codes).toEqual(['BE', 'NL']);
  });

  it('reads transnational from UNESCO\'s "True"/"False" text, not from the code count', () => {
    expect(geopark({ transnational: 'True' }).transnational).toBe(true);
    expect(geopark({ countries: ['AT,SI'], transnational: 'False' }).transnational).toBe(false);
  });

  it('keeps a null population absent and passes a zero population through', () => {
    expect(fixture('ASJP91')).not.toHaveProperty('population');
    expect(fixture('EUA190').population).toBe(0);
  });

  it('maps the sparse row without inventing a population or website', () => {
    const sparse = fixture('ASJP91');
    expect(sparse).not.toHaveProperty('population');
    expect(sparse).not.toHaveProperty('website');
    expect(sparse).toMatchObject({
      ugg_id: 'ASJP91',
      designation_year: 2015,
      area_hectares: 30_000,
    });
  });

  it('turns an entity-encoded list introduction into one line per item', () => {
    expect(fixture('EUIT92').introduction).toBe(
      'Explore the red earth mines.\nFollow the plateau trail.',
    );
  });

  it('reads the designation year from the date and keeps the area as recorded', () => {
    expect(geopark({ date: '2026-01-01', area_total: 27_000_000 })).toMatchObject({
      designation_year: 2026,
      area_hectares: 27_000_000,
    });
  });

  it('keeps only http(s) websites, serialized as the parser does', () => {
    expect(geopark({ website: 'http://a.example.test' }).website).toBe('http://a.example.test/');
    expect(geopark({ website: 'ftp://a.example.test/' })).not.toHaveProperty('website');
    expect(geopark({ website: 'not a url' })).not.toHaveProperty('website');
    expect(geopark({ website: '   ' })).not.toHaveProperty('website');
  });

  it('serializes the page URL and fails the row when it is not an http(s) URL', () => {
    expect(geopark({ url: 'https://x.test/iggp/a\r\n# b' }).url).toBe('https://x.test/iggp/a#%20b');
    expect(() => geopark({ url: 'not a url' })).toThrow('url is not an http(s) URL.');
  });
});
