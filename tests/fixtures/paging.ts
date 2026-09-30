/**
 * @fileoverview Generated intangible heritage and biosphere reserve rows for
 * pagination, sorting, and sparse-shape tests. Every name and text is invented.
 * @module tests/fixtures/paging
 */

import { ichRow, mabRow } from './rows.js';

const INTANGIBLE_LISTS = [
  'Representative List',
  'Urgent Safeguarding List',
  'Register of Good Safeguarding Practices',
] as const;
const ICH_ACRONYMS = ['RL', 'USL', 'Art18'] as const;

/**
 * `count` elements with refs 2001…: lists cycle through the three lists,
 * countries cycle FR/DE/JP with every fifth shared with BE, years 2009–2018,
 * and the first eight carry a linked site 101. Names are `Loomvale Rite NN`.
 */
export function manyIchRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    const ref = String(2001 + i);
    const list = i % 3;
    const countries = [['FR', 'DE', 'JP'][i % 3] as string, ...(i % 5 === 0 ? ['BE'] : [])];
    return ichRow({
      ich_public_ref: ref,
      title_en: `Loomvale Rite ${String(i + 1).padStart(2, '0')}`,
      title_fr: `Rite de Loomvale ${String(i + 1).padStart(2, '0')}`,
      description_en: `Synthetic practice number ${i + 1}.`,
      type_of_element_en: INTANGIBLE_LISTS[list],
      countries,
      inscription_year: String(2009 + (i % 10)),
      concepts_primary_names: i % 2 === 0 ? ['Weaving'] : ['Chanting'],
      concepts_secondary_names: null,
      http_url_en: `https://ich.unesco.org/en/${ICH_ACRONYMS[list]}/${ref.padStart(5, '0')}`,
      whc_sites:
        i < 8
          ? JSON.stringify([{ ref: '101', name_en: 'Alderfen Old Town', name_fr: null }])
          : null,
    });
  });
}

/**
 * `count` reserves `XXLoom{year}` with distinct ids, names `Loomvale Reserve NN`,
 * countries cycling FR/DE/PE (Peru without a network), years 1990–1999, areas
 * ascending by index, and positions marching north from (48, 2) in 0.1° steps.
 */
export function manyMabRows(count: number): Record<string, unknown>[] {
  const countries = [
    { iso2: 'FR', name: 'France', group: 'Europe and North America' },
    { iso2: 'DE', name: 'Germany', group: 'Europe and North America' },
    { iso2: 'PE', name: 'Peru', group: 'Latin America and the Caribbean' },
  ] as const;
  return Array.from({ length: count }, (_, i) => {
    const c = countries[i % 3] as (typeof countries)[number];
    const year = 1990 + (i % 10);
    return mabRow({
      mab_id: `${c.iso2}Loom${String(i).padStart(2, '0')}${year}`,
      title_en: `Loomvale Reserve ${String(i + 1).padStart(2, '0')}`,
      iso2: c.iso2,
      country_title_en: c.name,
      regional_group: c.group,
      date: `${year}-01-01`,
      area_total: 1000 + i * 10,
      area_total_terrestrial: 1000 + i * 10,
      coordinates: { lon: 2, lat: 48 + i * 0.1 },
      regional_network:
        i % 3 === 2 ? null : 'Europe and North America Biosphere Reserve Network (EuroMAB)',
    });
  });
}
