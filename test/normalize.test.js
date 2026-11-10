import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCountry, normalizeRegion, normalizePostalCode, cleanCompanyName,
  htmlToText, normalizeEmploymentType, toIso, decodeEntities } from '../src/normalize.js';

test('country names collapse to ISO codes', () => {
  // home24's feed mixes these two in one document.
  assert.equal(normalizeCountry('Deutschland'), 'DE');
  assert.equal(normalizeCountry('Germany'), 'DE');
  assert.equal(normalizeCountry('DE'), 'DE');
  assert.equal(normalizeCountry({ name: 'Austria' }), 'AT');
  assert.equal(normalizeCountry(''), null);
  assert.equal(normalizeCountry(null), null);
  assert.equal(normalizeCountry('Freedonia'), null);
});

test('regions canonicalize across languages', () => {
  // Both of these appear in the same home24 feed.
  assert.equal(normalizeRegion('Niedersachsen'), 'Niedersachsen');
  assert.equal(normalizeRegion('Lower Saxony'), 'Niedersachsen');
  assert.equal(normalizeRegion('Saxony-Anhalt'), 'Sachsen-Anhalt');
  assert.equal(normalizeRegion('  '), null);
});

test('"-" is not a postal code', () => {
  assert.equal(normalizePostalCode('-'), null);
  assert.equal(normalizePostalCode(' — '), null);
  assert.equal(normalizePostalCode('41468'), '41468');
  assert.equal(normalizePostalCode(null), null);
});

test('company names lose their page-title furniture', () => {
  assert.equal(cleanCompanyName('Karriere Board | K&ouml;nig + Neurath AG'), 'König + Neurath AG');
  assert.equal(cleanCompanyName('Career board | abatec GmbH'), 'abatec GmbH');
  assert.equal(cleanCompanyName('Karriereseite und Stellenangebote – ACHAT Hotel GmbH'), 'ACHAT Hotel GmbH');
  assert.equal(cleanCompanyName('Foo &amp; Bar'), 'Foo & Bar');
});

test('html descriptions become readable text', () => {
  const html = '<p>Erste Zeile</p><ul><li>Punkt&nbsp;A</li><li>Punkt B</li></ul>';
  const text = htmlToText(html);
  assert.match(text, /Erste Zeile/);
  assert.match(text, /Punkt A/);
  assert.doesNotMatch(text, /<[a-z]/i);
});

test('employmentType drops the OTHER placeholder', () => {
  assert.equal(normalizeEmploymentType(['OTHER']), null);
  assert.equal(normalizeEmploymentType(['FULL_TIME']), 'FULL_TIME');
  assert.equal(normalizeEmploymentType('Feste Anstellung'), 'Feste Anstellung');
  assert.equal(normalizeEmploymentType(null), null);
});

test('dates normalize from epoch millis and ISO strings', () => {
  assert.equal(toIso(1790152625995), new Date(1790152625995).toISOString());
  assert.equal(toIso('2026-11-10T12:38:45.506+01:00'), new Date('2026-11-10T12:38:45.506+01:00').toISOString());
  assert.equal(toIso(''), null);
  assert.equal(toIso('not a date'), null);
});

test('numeric entities decode', () => {
  assert.equal(decodeEntities('caf&#233;'), 'café');
});
