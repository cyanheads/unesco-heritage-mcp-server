---
name: unesco-heritage-guide
description: Gates and chains for the unesco_* tools over UNESCO's World Heritage List, intangible heritage lists, biosphere reserves, and Global Geoparks. Covers whether a landmark is World Heritage, what an empty result proves, coordinates for near searches, nearest-designation chains, keyword match tiers, inferred criterion (vi), intangible heritage linked to a site, and partial answers while a dataset cannot load. Use for any question about UNESCO-listed places or traditions.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Four UNESCO Data Hub datasets, keyless, served from a daily snapshot: inscribed World Heritage properties, Intangible Cultural Heritage elements, biosphere reserves, and UNESCO Global Geoparks. Nothing else UNESCO runs is here, including the Tentative Lists, Creative Cities, and Memory of the World.

Properties removed from the World Heritage List are absent, and the List of World Heritage in Danger is the current one only: each listed site carries the year of its current entry, with no earlier listings, no removals, and no threat factors. The data cannot answer "was X ever inscribed" or "was X ever in danger", and `in_danger: false` never means a site was never listed. "Currently" means as of the `data_as_of` date in `sources`, which can trail UNESCO's own reprocessing by a day.

The server does not geocode. `near` takes coordinates.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| `id_no` (digits; a `whc.unesco.org/en/list/{id}` URL also works) | unesco_search_sites; an element's `world_heritage_sites` | unesco_get_site; unesco_search_intangible_heritage `world_heritage_site` |
| Component `ref` (`208-001`, `1496rev-002`) | unesco_get_site `components`; a search row's `nearest_component` or `matched_components` | No tool takes it. It names a part of the site whose `id_no` you hold |
| `ich_ref` (an `ich.unesco.org` element page URL also works) | unesco_search_intangible_heritage | unesco_get_intangible_heritage_element |
| `mab_id` | unesco_search_biosphere_reserves | unesco_get_biosphere_reserve. A transboundary reserve has one per participating country |
| `ugg_id` (`EUFR10`) | unesco_search_geoparks | unesco_get_geopark |
| Country code | unesco_list_reference topic `countries` with the country's name as `filter`, or an ISO alpha-2 or alpha-3 code you already know | every `country` input |

## Gates

**A keyword miss does not mean a place isn't World Heritage.** Many landmarks are component parts of a serial site, and many more stand inside an area site whose record never names them.
unesco_search_sites matches component names as a tier of their own. When a query word matches a component name and none of the site's own names, the row lists the components matching such words in `matched_components` (at most 10, with `matched_components_total` counting all of them): every `matched_in: component` row carries them, and a `description` or `justification` row can too. A word the site's names already match lists no component.
Finlandia Hall, for one, is component 1752-006 of Aalto Works (id_no 1752).
Answer such a match as part of its site ("component {ref} of {site}, id_no {id_no}"), never as a site of its own. When a landmark matches nothing, search the town or area that contains it, or run `near` on the landmark's own coordinates with a small `radius_km`, then confirm in unesco_get_site's description and components before answering. `near` measures to recorded points (a site's representative point and one per component), never to a boundary, so a building inside a large site can lie outside a small radius of every point.

**`matched_in` says whether the record is the thing asked about.** A `name` or `component` hit identifies the record.
A `description` or `justification` hit (the statement of Outstanding Universal Value) only means the words appear in UNESCO's prose, so a site that merely mentions them ranks there. Confirm such a hit with the get tool before naming it as the answer. `sort: relevance` orders `name`, then `component`, then `description`, then `justification`.

**Keywords are literal word prefixes, all required.** Each query word must be the start of a word in the searched fields, so use the shortest form: `temple` finds "temples", but `temples` misses "temple". Every added word can only narrow the match, so drop filler words and narrow with `country`, `region`, or the other filters instead. Site names also match in French, Spanish, Russian, Arabic, and Chinese; element names in English and French.

**`near` needs coordinates you bring or a record supplies.** Get a place's coordinates from a geocoder or from a UNESCO record. A serial site has no `latitude`/`longitude` of its own, so take a component's point from unesco_get_site or from a row's `nearest_component`. Every biosphere reserve and geopark has one point. Intangible heritage elements have no coordinates and never match `near`; reach them by country, keyword, or a linked site.

**"Nearest" is `near` with `limit: 1`, widened until it hits.** Nothing outside `radius_km` (default 100, at most 5000) comes back, so an empty result only means nothing lies within that radius: widen it and call again. With `near` alone the sort defaults to distance; with a `query` as well, the default is relevance, so set `sort: distance`. A site's `distance_km` runs to its nearest recorded point, and `nearest_component` is set when that point is a component; name the component in the answer, since a serial site's nearest part can be far from the rest of it.

**Check every designation before saying a place has no UNESCO status.** World Heritage, biosphere reserves, and geoparks are separate lists, and one place can hold all three. A miss in one says nothing about the others: run all three searches with the same keyword or the same `near`, and unesco_search_intangible_heritage when the question is about a practice, craft, festival, or food.

**Criterion (vi) is a floor.** UNESCO's criteria fields never record (vi); the server adds it where a site's statement of Outstanding Universal Value names it. A site whose statement is missing or never names (vi) comes back without it, so present a (vi) list or count as the sites whose statement names it, and never state that a site lacks (vi) on this data alone. `criteria` requires every criterion listed, so "(iii) or (vi)" takes one search per criterion.

**Linked intangible heritage is UNESCO's own sparse cross-reference.** unesco_search_intangible_heritage with `world_heritage_site` lists the elements whose record names that site. Links attach to a whole site's `id_no`, never to a component, and most elements carry none. The `id_no` is not checked against the World Heritage List, so a mistyped one returns zero rather than an error; take it from unesco_search_sites. An empty result means UNESCO links no element to that site, not that no tradition relates to it: search intangible heritage by the site's country and a keyword for related traditions.

**A partial reference answer is not a zero.** While a dataset cannot load, unesco_list_reference topics `countries`, `regions`, and `datasets` still answer from the datasets that did.
In those answers an absent count means that dataset is unavailable, never zero, and `notice` names each unavailable dataset.
A `datasets` row with `available: false` carries the failure's `retryable` instead of a record count and data date.
Never report a country as having no sites, elements, reserves, or geoparks from a partial answer. Every search and get tool needs only its own dataset, so the rest of the server keeps answering while one is down.

## Workflows

**Counts and breakdowns.** A search with `limit: 1` returns `totalCount` and `facets` over the whole match, so a count, or a breakdown by any facet the tool reports, takes one call and no paging. Facets list only the top 10 countries; unesco_list_reference topic `countries` gives every country's count in each dataset. A record shared by several countries counts once for each of them in facets and country counts, so those can add up to more than the total. A transboundary biosphere reserve is a separate row and `mab_id` per country, while a transboundary site, a multinational element, and a transnational geopark are each one record listing every country.

**Everything UNESCO around a place.** Get coordinates (see the `near` gate), run unesco_search_sites, unesco_search_biosphere_reserves, and unesco_search_geoparks with the same `near`, then reach intangible heritage through the country, or through `world_heritage_site` for each site found.
