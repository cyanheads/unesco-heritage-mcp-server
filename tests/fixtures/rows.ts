/**
 * @fileoverview Synthetic export-row builders and the default fixture datasets
 * for the three UNESCO Data Hub datasets. Every name and text is invented;
 * shapes follow the API Reference in docs/design.md.
 * @module tests/fixtures/rows
 */

/** One component part as UNESCO's pseudo-JSON `components_list` writes it. */
export interface ComponentSpec {
  latitude: number | string;
  longitude: number | string;
  name: string;
  ref: string;
}

/** Builds the pseudo-JSON `components_list` string from component specs. */
export function componentsList(components: readonly ComponentSpec[]): string {
  return `{${components
    .map(
      (c) => `name: ${c.name}, ref: ${c.ref}, latitude: ${c.latitude}, longitude: ${c.longitude}`,
    )
    .join('}, {')}}`;
}

/** A complete `whc001` export row with every allowlisted key; override what a test needs. */
export function whcRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id_no: '900',
    name_en: 'Placeholder Site',
    name_fr: 'Site Fictif',
    name_es: null,
    name_ru: null,
    name_ar: null,
    name_zh: null,
    short_description_en: 'A synthetic site used as test data.',
    justification_en: 'Criterion (iv): a synthetic ensemble.',
    category: 'Cultural',
    criteria_txt: '(iv)',
    states_names: ['France'],
    iso_codes: 'FR',
    region: 'Europe and North America',
    transboundary: 'False',
    date_inscribed: '1990',
    secondary_dates: '1990',
    danger: 'False',
    danger_list: null,
    area_hectares: 10,
    coordinates: { lon: 2, lat: 48 },
    components_count: 1,
    components_list: componentsList([
      { name: 'Main Part', ref: '900-001', latitude: 48, longitude: 2 },
    ]),
    main_image_url: 'https://whc.unesco.org/document/900',
    main_image_copyright: 'Synthetic Photo Agency',
    main_image_author: 'A. Tester',
    ...overrides,
  };
}

/** A complete `ich001` export row. */
export function ichRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ich_public_ref: '9000',
    inscription_year: '2012',
    title_en: 'Placeholder Element',
    title_fr: 'Element Fictif',
    description_en: 'A synthetic practice used as test data.',
    type_of_element_en: 'Representative List',
    countries: ['FR'],
    http_url_en: 'https://ich.unesco.org/en/RL/09000',
    concepts_primary_names: ['Craft'],
    concepts_secondary_names: ['Community'],
    whc_sites: null,
    main_image_url: 'https://ich.unesco.org/img/photo/thumb/9000.jpg',
    main_image_caption_en: 'A synthetic caption.',
    main_image_copyright: 'Synthetic Photo Agency',
    main_image_author: 'A. Tester',
    ...overrides,
  };
}

/** A complete `mab001` export row. */
export function mabRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mab_id: 'FRTest1990',
    title_en: 'Placeholder Reserve',
    iso2: 'FR',
    country_title_en: 'France',
    date: '1990-01-01',
    introduction_en: 'A synthetic reserve used as test data.',
    ecological_characteristics_en: 'Synthetic wetlands.',
    socio_economic_characteristics_en: 'Synthetic villages.',
    population_total: 1000,
    population_core: 0,
    population_buffer: 400,
    population_transition: 600,
    area_total: 5000,
    area_total_terrestrial: 5000,
    area_core_terrestrial: 1000,
    area_buffer_terrestrial: 2000,
    area_transition_terrestrial: 2000,
    area_total_marine: 0,
    area_core_marine: 0,
    area_buffer_marine: 0,
    area_transition_marine: 0,
    extension: null,
    renaming: null,
    periodic_review: null,
    regional_network: 'Europe and North America Biosphere Reserve Network (EuroMAB)',
    coordinates: { lon: 2.5, lat: 48.5 },
    tbr: 'False',
    website: null,
    url: 'https://www.unesco.org/en/mab/placeholder',
    regional_group: 'Europe and North America',
    sids: 'False',
    ...overrides,
  };
}

const MANY_PARTS = Array.from({ length: 25 }, (_, i) => ({
  name: `Part ${String(i + 1).padStart(2, '0')}`,
  ref: `109-${String(i + 1).padStart(3, '0')}`,
  latitude: 40 + i * 0.01,
  longitude: 10,
}));

/** Filler sites 201–230: Cultural, Europe, France, staggered years and positions. */
const FILLER_SITES = Array.from({ length: 30 }, (_, i) => {
  const n = 201 + i;
  return whcRow({
    id_no: String(n),
    name_en: `Gridwick Ward ${n}`,
    name_fr: `Quartier Gridwick ${n}`,
    short_description_en: `Synthetic ward ${n}.`,
    justification_en: null,
    date_inscribed: String(1980 + (i % 20)),
    secondary_dates: String(1980 + (i % 20)),
    area_hectares: 100 - i,
    coordinates: { lon: 2, lat: 48 + (i + 1) * 0.01 },
    components_count: 0,
    components_list: null,
    main_image_url: null,
    main_image_copyright: null,
    main_image_author: null,
  });
});

/** The default `whc001` fixture rows. */
export const WHC_ROWS: Record<string, unknown>[] = [
  whcRow({
    id_no: '101',
    name_en: 'Alderfen Old Town',
    name_fr: "Vieille Ville d'Alderfen",
    name_es: 'Casco Antiguo de Alderfen',
    name_zh: '奥德芬古城',
    short_description_en: 'A synthetic walled town used as test data.',
    justification_en:
      'Criterion (ii): synthetic exchange of ideas.\n\nCriterion (iv): synthetic ensemble.',
    criteria_txt: '(ii)(iv)',
    date_inscribed: '1988',
    secondary_dates: '1988, 2005,2012',
    area_hectares: 120.5,
    coordinates: { lon: 2, lat: 48 },
    components_count: 3,
    components_list: componentsList([
      { name: 'North Gate, Upper Ward', ref: '101-001', latitude: 48.01, longitude: 2.01 },
      { name: 'Market Hall', ref: '101-002', latitude: 48.02, longitude: 2.02 },
      { name: 'Old Mill', ref: '101-003', latitude: 48.03, longitude: 2.03 },
    ]),
    main_image_url: 'https://whc.unesco.org/document/101',
  }),
  whcRow({
    id_no: '102',
    name_en: 'Brindle Frontier Forest',
    name_fr: 'Forêt Frontalière de Brindle',
    short_description_en: 'A synthetic forest shared by two states.',
    justification_en: 'Criterion (ix): synthetic ecological processes.',
    category: 'Natural',
    criteria_txt: '(ix)(x)',
    states_names: ['Germany', 'Poland'],
    iso_codes: 'DE, PL',
    transboundary: 'True',
    date_inscribed: '1992',
    secondary_dates: '1992, 2007',
    danger: 'True',
    danger_list: 'Y 2015',
    area_hectares: 5000,
    coordinates: { lon: 14.5, lat: 52.5 },
    components_count: 2,
    components_list: componentsList([
      { name: 'West Tract', ref: '102-001', latitude: 52.5, longitude: 14.4 },
      { name: 'East Tract', ref: '102-002', latitude: 52.5, longitude: 14.6 },
    ]),
  }),
  whcRow({
    id_no: '103',
    name_en: 'Tarnwick Memorial Grounds',
    name_fr: 'Terrains Commémoratifs de Tarnwick',
    short_description_en: 'Synthetic grounds tied to a synthetic event.',
    justification_en: 'Criterion (vi): synthetic association with events.',
    criteria_txt: null,
    states_names: ['Ethiopia'],
    iso_codes: 'ET',
    region: 'Africa',
    date_inscribed: '2004',
    secondary_dates: '2004',
    area_hectares: null,
    coordinates: null,
    components_count: 1,
    components_list: componentsList([
      { name: 'Central Field', ref: '103-001', latitude: 9, longitude: 38 },
    ]),
  }),
  whcRow({
    id_no: '104',
    name_en: 'Vessel Harbour Precinct',
    name_fr: 'Quartier du Port de Vessel',
    short_description_en: 'A synthetic harbour precinct.',
    justification_en:
      'Criterion (i): synthetic masterpiece.\n\nCriterion (iii): synthetic testimony.\n\nCriterion (vi): synthetic association.',
    criteria_txt: '(i)(iii)',
    states_names: ['Japan'],
    iso_codes: 'JP',
    region: 'Asia and the Pacific',
    date_inscribed: '2001',
    secondary_dates: '2001',
    area_hectares: 40,
    coordinates: { lon: 139.7, lat: 35.7 },
    components_count: 0,
    components_list: null,
  }),
  whcRow({
    id_no: '105',
    name_en: 'Hollowmere Sparse Site',
    name_fr: 'Site Épars de Hollowmere',
    short_description_en: null,
    justification_en: null,
    criteria_txt: '(iii)',
    states_names: ['Peru'],
    iso_codes: 'PE',
    region: 'Latin America and the Caribbean',
    date_inscribed: '1995',
    secondary_dates: '1995',
    area_hectares: null,
    coordinates: null,
    components_count: 0,
    components_list: null,
    main_image_url: null,
    main_image_copyright: null,
    main_image_author: null,
  }),
  whcRow({
    id_no: '106',
    name_en: 'Orchard Commons',
    name_fr: 'Communaux du Verger',
    short_description_en: 'A synthetic mixed site of a code-less party.',
    justification_en: 'Criterion (iii): synthetic testimony.',
    category: 'Mixed',
    criteria_txt: '(iii)(vii)',
    states_names: ['Synthetic Party Name'],
    iso_codes: null,
    region: 'Arab States',
    date_inscribed: '2010',
    secondary_dates: '2010',
    area_hectares: 900,
    coordinates: { lon: 10, lat: 30 },
    components_count: 0,
    components_list: null,
  }),
  whcRow({
    id_no: '107',
    name_en: 'Lantern <em>Bridge</em><br />Quarter',
    name_fr: 'Quartier du <I>Pont</I> Lanterne',
    short_description_en: 'Text with a &#39;quoted&#39; word &amp; more.\nSecond line here.',
    justification_en: null,
    criteria_txt: '(iv)',
    states_names: ['Germany'],
    iso_codes: 'DE',
    date_inscribed: '1999',
    secondary_dates: '1999',
    area_hectares: 3,
    coordinates: { lon: 8.7, lat: 50.1 },
    components_count: 1,
    components_list: componentsList([
      { name: 'Span <em>One</em>', ref: '107-001', latitude: 50.1, longitude: 8.7 },
    ]),
    main_image_copyright: 'Synthetic\nAgency',
  }),
  whcRow({
    id_no: '108',
    name_en: 'Reedhaven Components Test',
    name_fr: 'Test de Composants de Reedhaven',
    short_description_en: 'A synthetic site with awkward component entries.',
    justification_en: null,
    states_names: ['Germany'],
    iso_codes: 'DE',
    date_inscribed: '2003',
    secondary_dates: '2003',
    coordinates: { lon: 9, lat: 51 },
    components_count: 5,
    components_list:
      '{name: Stone Gate, North, ref: 108-001, latitude: 10.5, longitude: 20.5}, ' +
      '{name: Odd, ref: name, latitude: 1, longitude: 2 gate, ref: 108-002, latitude: 11.25, longitude: 21.5}, ' +
      '{name: , ref: 108-003, latitude: 12, longitude: 22}, ' +
      '{name: Spaced Ref, ref: 108-004 , latitude: 13, longitude: 23}, ' +
      '{name: Bad Lat, ref: 108-005, latitude: 95, longitude: 24}',
  }),
  whcRow({
    id_no: '109',
    name_en: 'Manyparts Estate',
    name_fr: 'Domaine Multiparties',
    short_description_en: 'A synthetic estate with many parts.',
    justification_en: null,
    date_inscribed: '2006',
    secondary_dates: '2006',
    coordinates: { lon: 10, lat: 40 },
    components_count: 25,
    components_list: componentsList(MANY_PARTS),
  }),
  ...FILLER_SITES,
];

/** The default `ich001` fixture rows. */
export const ICH_ROWS: Record<string, unknown>[] = [
  ichRow({
    ich_public_ref: '1001',
    title_en: 'Synthetic Weaving Rite',
    title_fr: 'Rite de Tissage Synthétique',
    description_en: 'First paragraph.\n\nSecond paragraph.',
    countries: ['FR', 'BE'],
    concepts_primary_names: ['Textile craft'],
    concepts_secondary_names: ['Community', 'Ritual'],
    whc_sites: JSON.stringify([
      {
        ref: '101',
        name_en: 'Alderfen <em>Old</em> Town',
        name_fr: 'Vieille Ville',
        url: 'https://whc.unesco.org/en/list/101',
      },
      { ref: 102, name_en: 'Brindle Frontier Forest', name_fr: null, url: null },
    ]),
    inscription_year: '2010',
  }),
  ichRow({
    ich_public_ref: '1002',
    title_en: 'Synthetic Song Cycle',
    title_fr: 'Cycle de Chants Synthétique',
    type_of_element_en: 'Urgent Safeguarding List',
    countries: ['ET'],
    inscription_year: '2008',
    concepts_primary_names: null,
    concepts_secondary_names: null,
    http_url_en: 'https://ich.unesco.org/en/USL/01002',
  }),
  ichRow({
    ich_public_ref: '1003',
    title_en: 'Synthetic Craft Register',
    title_fr: 'Registre Artisanal Synthétique',
    type_of_element_en: 'Register of Good Safeguarding Practices',
    countries: ['JP'],
    inscription_year: '2015',
    main_image_caption_en: null,
    main_image_copyright: null,
    main_image_author: null,
    http_url_en: 'https://ich.unesco.org/en/Art18/01003',
  }),
];

/** The default `mab001` fixture rows. */
export const MAB_ROWS: Record<string, unknown>[] = [
  mabRow({
    mab_id: 'FRAlder1998',
    title_en: 'Alderfen Marsh Reserve',
    date: '1998-01-01',
    regional_group: 'Europe and North America,Europe and North America',
    ecological_characteristics_en: 'Marsh &#39;core&#39; habitat.',
    extension: 2004.2016,
    renaming: 2010.0,
    periodic_review: '2010; 2020, March 2025',
    website: 'https://reserve.example.test/alderfen',
  }),
  mabRow({
    mab_id: 'DEBrin1993',
    title_en: 'Brindle Cross-border Reserve',
    iso2: 'DE',
    country_title_en: 'Germany',
    date: '1993-01-01',
    tbr: 'True',
    coordinates: { lon: 14.4, lat: 52.5 },
    website: 'ftp://bad.example.test/',
  }),
  mabRow({
    mab_id: 'PLBrin1993',
    title_en: 'Brindle Cross-border Reserve',
    iso2: 'PL',
    country_title_en: 'Poland',
    date: '1993-01-01',
    tbr: 'True',
    coordinates: { lon: 14.6, lat: 52.5 },
  }),
  mabRow({
    mab_id: 'PEÑandu2001',
    title_en: 'Ñandu Highland Reserve',
    iso2: 'PE',
    country_title_en: 'Peru',
    date: '2001-01-01',
    regional_network: null,
    regional_group: 'Latin America and the Caribbean',
    ecological_characteristics_en: null,
    socio_economic_characteristics_en: null,
    coordinates: { lon: -75, lat: -10 },
  }),
];
