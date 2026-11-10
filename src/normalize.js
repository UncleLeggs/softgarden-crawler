const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&uuml;': 'ü', '&ouml;': 'ö', '&auml;': 'ä', '&Uuml;': 'Ü', '&Ouml;': 'Ö',
  '&Auml;': 'Ä', '&szlig;': 'ß', '&eacute;': 'é', '&egrave;': 'è', '&ndash;': '–', '&mdash;': '—' };

export function decodeEntities(s) {
  let out = String(s ?? '');
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanCompanyName(s) {
  let out = decodeEntities(s)
    .replace(/^(Karriere\s*Board|Career\s*board|Karriereboard)\s*\|\s*/i, '')
    .replace(/^(Karriereseite und Stellenangebote|Karriereseite|Career site and job offers)\s*[–—|-]\s*/i, '')
    .replace(/\s*[|–-]\s*(Karriere|Jobs|Stellenangebote|Karriereportal)\s*$/i, '');
  return out.replace(/\s+/g, ' ').trim();
}

// Feeds mix "Deutschland" and "Germany" in the same document; the career-page
// JSON already uses ISO. Normalize everything to ISO-3166-1 alpha-2.
const COUNTRIES = new Map(Object.entries({
  deutschland: 'DE', germany: 'DE', de: 'DE', ger: 'DE',
  osterreich: 'AT', austria: 'AT', at: 'AT', 'österreich': 'AT',
  schweiz: 'CH', switzerland: 'CH', suisse: 'CH', ch: 'CH',
  niederlande: 'NL', netherlands: 'NL', nl: 'NL',
  frankreich: 'FR', france: 'FR', fr: 'FR',
  belgien: 'BE', belgium: 'BE', be: 'BE',
  polen: 'PL', poland: 'PL', pl: 'PL',
  tschechien: 'CZ', czechia: 'CZ', 'czech republic': 'CZ', cz: 'CZ',
  spanien: 'ES', spain: 'ES', es: 'ES',
  italien: 'IT', italy: 'IT', it: 'IT',
  luxemburg: 'LU', luxembourg: 'LU', lu: 'LU',
  danemark: 'DK', denmark: 'DK', dk: 'DK', 'dänemark': 'DK',
  schweden: 'SE', sweden: 'SE', se: 'SE',
  norwegen: 'NO', norway: 'NO', no: 'NO',
  'vereinigtes konigreich': 'GB', 'united kingdom': 'GB', uk: 'GB', gb: 'GB',
  usa: 'US', 'united states': 'US', us: 'US',
  rumanien: 'RO', romania: 'RO', ro: 'RO',
  ungarn: 'HU', hungary: 'HU', hu: 'HU',
  slowakei: 'SK', slovakia: 'SK', sk: 'SK',
  bosnien: 'BA', 'bosnia and herzegovina': 'BA', ba: 'BA',
}));

export function normalizeCountry(v) {
  if (v == null) return null;
  const raw = typeof v === 'object' ? (v.name ?? v['@id'] ?? '') : v;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  if (/^[a-z]{2}$/.test(key)) return COUNTRIES.get(key) ?? key.toUpperCase();
  return COUNTRIES.get(key) ?? null;
}

// Feeds label the same Bundesland in German or English ("Niedersachsen" and
// "Lower Saxony" both appear in home24's feed). Canonicalize to German.
const REGIONS = new Map(Object.entries({
  'lower saxony': 'Niedersachsen', 'saxony': 'Sachsen', 'saxony-anhalt': 'Sachsen-Anhalt',
  'north rhine-westphalia': 'Nordrhein-Westfalen', 'bavaria': 'Bayern',
  'rhineland-palatinate': 'Rheinland-Pfalz', 'hesse': 'Hessen', 'thuringia': 'Thüringen',
  'baden-wurttemberg': 'Baden-Württemberg', 'baden-württemberg': 'Baden-Württemberg',
  'mecklenburg-vorpommern': 'Mecklenburg-Vorpommern', 'western pomerania': 'Mecklenburg-Vorpommern',
  'schleswig-holstein': 'Schleswig-Holstein', 'brandenburg': 'Brandenburg',
  'bremen': 'Bremen', 'hamburg': 'Hamburg', 'berlin': 'Berlin', 'saarland': 'Saarland',
}));

export function normalizeRegion(v) {
  const s = decodeEntities(v ?? '').trim();
  if (!s) return null;
  return REGIONS.get(s.toLowerCase()) ?? s;
}

// Softgarden writes "-" where a postal code is unknown.
export function normalizePostalCode(v) {
  const s = String(v ?? '').trim();
  if (!s || /^[-–—.\s]+$/.test(s)) return null;
  return s;
}

export function toIso(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeEmploymentType(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  const vals = arr.map((x) => String(x).trim()).filter(Boolean)
    .filter((x) => x.toUpperCase() !== 'OTHER');
  return vals.length ? vals.join(', ') : null;
}

export function nullIfBlank(v) {
  const s = typeof v === 'string' ? v.trim() : v;
  return s === '' || s == null ? null : s;
}

export function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
