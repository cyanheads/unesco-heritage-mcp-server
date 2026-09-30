/**
 * @fileoverview Tests for the export-row schemas, the edge parsers (text
 * cleanup, criteria and the criterion (vi) inference, the components parser and
 * its rejection count, the year parsers, the `whc_sites` parser), and the
 * row → domain mappers, against synthetic fixture rows.
 * @module tests/services/unesco-datahub/rows.test
 */

import { describe, expect, it } from 'vitest';
import {
  cleanText,
  DatasetMetaSchema,
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
  toHeritageSite,
  toIntangibleElement,
  WHC_FIELDS,
  WhcRowSchema,
  yearsIn,
} from '@/services/unesco-datahub/rows.js';
import { componentsList, ichRow, mabRow, WHC_ROWS, whcRow } from '../../fixtures/rows.js';

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
    expect(cleanText('a&nbsp;b &#0; &#1114112; &#xD800;x')).toContain('&nbsp;');
    expect(cleanText('&#0;')).toBe('&#0;');
    expect(cleanText('&#1114112;')).toBe('&#1114112;');
  });

  it('does not double-decode', () => {
    expect(cleanText('&amp;lt;')).toBe('&lt;');
  });

  it('trims the result and preserves inner newlines', () => {
    expect(cleanText('  a\nb  ')).toBe('a\nb');
    expect(cleanText('   ')).toBe('');
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
