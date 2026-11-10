import { config } from '../config.js';
import { requestText } from '../http.js';
import { PLATFORM } from '../tenants.js';
import { htmlToText, normalizeCountry, normalizeRegion, normalizePostalCode,
  normalizeEmploymentType, toIso, nullIfBlank, numOrNull, decodeEntities } from '../normalize.js';

/**
 * Where job descriptions actually live.
 *
 * The widget API (pcw-api.softgarden.de/widgets/job-list/job-ads) is a LISTING
 * endpoint: its records carry title, location, category, careerLevel, workTime,
 * coords and dates, but no description field at all. There is no widget detail
 * endpoint either -- /widgets/job-ad, /widgets/job-detail/job-ad and friends all
 * 404. So per-job detail comes from the job page itself:
 *
 *   career-next / career-embedded -> __NEXT_DATA__ props...context.job
 *       The richest source available: description, remoteStatusKey
 *       (FULLY_REMOTE), careerLevel, workExperience, employmentType, ISO
 *       country code, applyOnlineLink and a per-job versionId.
 *   board -> JSON-LD <script type="application/ld+json"> JobPosting
 *       description, datePosted, validThrough, baseSalary and a full
 *       PostalAddress.
 *
 * versionId matters: the feeds have no per-job dateModified, so versionId is
 * the only exact change signal on the career-page stack.
 */

function nextDataJob(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1])?.props?.pageProps?.data?.context?.job ?? null; }
  catch { return null; }
}

function jsonLdJobPosting(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    const candidates = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] ?? [])];
    for (const c of candidates) {
      const t = c?.['@type'];
      if (t && (Array.isArray(t) ? t : [t]).some((x) => /JobPosting/i.test(x))) return c;
    }
  }
  return null;
}

const firstAddress = (loc) => {
  const l = Array.isArray(loc) ? loc[0] : loc;
  return l?.address ?? l ?? null;
};

function salaryText(baseSalary) {
  if (!baseSalary) return null;
  const v = baseSalary.value ?? baseSalary;
  const parts = [v?.minValue ?? v?.value, v?.maxValue].filter((x) => x != null && x !== '');
  if (!parts.length) return null;
  const cur = baseSalary.currency ?? v?.currency ?? '';
  const unit = v?.unitText ? ` / ${v.unitText}` : '';
  return `${[...new Set(parts)].join('-')} ${cur}${unit}`.trim();
}

/** Fetch and parse one job page into the unified shape. */
export async function fetchJobDetail(tenant, listing) {
  const url = absoluteJobUrl(tenant, listing);
  const { text: html } = await requestText(url, {
    ua: config.browserUA, timeoutMs: 45_000, label: `detail ${listing.jobId}`,
    headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
  });

  if (tenant.platform === PLATFORM.BOARD) {
    const ld = jsonLdJobPosting(html);
    if (!ld) return { url, detailOk: false, note: 'no JSON-LD JobPosting' };
    const a = firstAddress(ld.jobLocation) ?? {};
    return {
      url, detailOk: true,
      title: nullIfBlank(decodeEntities(ld.title)) ?? listing.title ?? null,
      descriptionHtml: nullIfBlank(ld.description),
      descriptionText: ld.description ? htmlToText(ld.description) : null,
      datePosted: toIso(ld.datePosted),
      validThrough: toIso(ld.validThrough),
      employmentType: normalizeEmploymentType(ld.employmentType),
      careerLevel: null, workExperience: null, workTime: null,
      remoteStatus: null, remoteStatusKey: null,
      salary: salaryText(ld.baseSalary),
      city: nullIfBlank(decodeEntities(a.addressLocality)),
      region: normalizeRegion(a.addressRegion),
      country: normalizeCountry(a.addressCountry),
      postalCode: normalizePostalCode(a.postalCode),
      streetAddress: nullIfBlank(decodeEntities(a.streetAddress)),
      companyName: nullIfBlank(decodeEntities(ld.hiringOrganization?.name)),
      versionId: null,
      applyUrl: null,
      note: null,
    };
  }

  const j = nextDataJob(html);
  if (!j) return { url, detailOk: false, note: 'no context.job in page' };
  return {
    url, detailOk: true,
    title: nullIfBlank(decodeEntities(j.title)) ?? listing.title ?? null,
    descriptionHtml: nullIfBlank(j.description),
    descriptionText: j.description ? htmlToText(j.description) : null,
    datePosted: toIso(j.date),
    validThrough: null, // career-page stack does not expose it
    employmentType: nullIfBlank(j.employmentType),
    careerLevel: nullIfBlank(j.careerLevel),
    workExperience: nullIfBlank(j.workExperience),
    workTime: nullIfBlank(j.workTime),
    remoteStatus: nullIfBlank(j.remoteStatus),
    remoteStatusKey: nullIfBlank(j.remoteStatusKey),
    salary: nullIfBlank(j.salary) ? `${j.salary}${j.paymentPeriod ? ` / ${j.paymentPeriod}` : ''}` : null,
    city: nullIfBlank(decodeEntities(j.city)),
    region: normalizeRegion(j.state ?? j.geoLocationRegion),
    country: normalizeCountry(j.country),
    postalCode: null,
    streetAddress: nullIfBlank(decodeEntities(j.geoLocationName)),
    companyName: nullIfBlank(decodeEntities(j.company)),
    versionId: numOrNull(j.versionId),
    applyUrl: nullIfBlank(j.applyOnlineLink),
    note: null,
  };
}

export function absoluteJobUrl(tenant, listing) {
  if (listing.url?.startsWith('http')) return listing.url;
  const path = listing.url ?? '';
  return `https://${tenant.host}${path.startsWith('/') ? '' : '/'}${path}`;
}
