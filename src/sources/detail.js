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
function fromBoardLd(url, ld, listing) {
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
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    sourceHash: nullIfBlank(typeof ld.identifier === 'string' ? ld.identifier : ld.identifier?.value),
    published: null, imported: null, jobBoardType: null,
    totalApplications: null, projectNumber: null, additionalLocations: null,
    raw: { source: 'board', payload: ld },
    note: null,
  };
}

function fromCareerJob(url, j, listing) {
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
    // context.job carries 47 keys. These are the ones worth querying as
    // columns; `raw` keeps the remainder so recovering a field we did not think
    // to map never means re-crawling 30k pages.
    sourceCreatedAt: toIso(j.createdAt),
    sourceUpdatedAt: toIso(j.updatedAt),
    sourceHash: nullIfBlank(j.hash),
    published: typeof j.published === 'boolean' ? j.published : null,
    imported: typeof j.imported === 'boolean' ? j.imported : null,
    jobBoardType: nullIfBlank(j.jobBoardType),
    totalApplications: numOrNull(j.totalApplications),
    projectNumber: numOrNull(j.sgJobAdProjectNumber),
    additionalLocations: Array.isArray(j.additionalLocations) && j.additionalLocations.length
      ? j.additionalLocations : null,
    raw: { source: 'career', payload: j },
    note: null,
  };
}

function parseDetail(platform, url, html, listing) {
  if (platform === PLATFORM.BOARD) {
    const ld = jsonLdJobPosting(html);
    return ld ? fromBoardLd(url, ld, listing) : { url, detailOk: false, note: 'no JSON-LD JobPosting' };
  }
  const j = nextDataJob(html);
  return j ? fromCareerJob(url, j, listing) : { url, detailOk: false, note: 'no context.job in page' };
}

/**
 * `detailHost`, when given, is the board host resolved for this tenant. The
 * primary (career) URL is still tried first because the career stack carries
 * fields the board does not -- versionId, remoteStatusKey, careerLevel.
 */
export async function fetchJobDetail(tenant, listing, { detailHost = null } = {}) {
  const url = absoluteJobUrl(tenant, listing);
  const opts = {
    ua: config.browserUA, timeoutMs: 45_000, label: `detail ${listing.jobId}`,
    headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
  };

  let note = null;
  try {
    const { text } = await requestText(url, opts);
    const parsed = parseDetail(tenant.platform, url, text, listing);
    if (parsed.detailOk) return parsed;
    note = parsed.note;
  } catch (err) { note = err.message; }

  if (detailHost) {
    const boardUrl = boardJobUrl(detailHost, listing.jobId);
    try {
      const { text } = await requestText(boardUrl, opts);
      const ld = jsonLdJobPosting(text);
      if (ld) return fromBoardLd(boardUrl, ld, listing);
      note = `${note}; board fallback: no JobPosting`;
    } catch (err) { note = `${note}; board fallback: ${err.message}`; }
  }
  return { url, detailOk: false, note };
}

export function absoluteJobUrl(tenant, listing) {
  if (listing.url?.startsWith('http')) return listing.url;
  const path = listing.url ?? '';
  // A tenant on its own domain serves the job page there; the *.softgarden.io
  // host can 404 for it (jdsports.softgarden.io does, jobs.jdsports.de does not).
  const host = tenant.customDomain || tenant.host;
  // `new URL` rather than concatenation so the "./jobs/.." and "../job/.." that
  // board pages emit collapse instead of being stored literally.
  return new URL(path.startsWith('/') ? path : `/${path}`, `https://${host}`).href;
}

export const boardJobUrl = (host, jobId) => `https://${host}/job/${jobId}`;

/**
 * Hosts that might serve this tenant's job pages, best first.
 *
 * Some career pages are "landing" projects (context.projectRole === 'landing'):
 * the widget lists their jobs and even reports a /jobs/<id>/<slug>/ link, but
 * the landing app has no job route, so every one of those URLs 404s. The
 * postings are served by the company's own board instead, under a shorter
 * slug -- ueber-uns-schuelerhilfe is served by schuelerhilfe.softgarden.io.
 * Dropping leading slug segments finds it, and we only ever accept a candidate
 * that actually returns a JobPosting for a real job id.
 */
export function detailHostCandidates(slug) {
  const parts = String(slug ?? '').split('-').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const cand = parts.slice(i).join('-');
    if (cand && !out.includes(cand)) out.push(`${cand}.softgarden.io`);
  }
  return out;
}

/**
 * Find the board host serving `sampleJobId`, or null. Verified by fetching a
 * real posting -- never inferred from the name alone.
 */
export async function resolveDetailHost(tenant, sampleJobId, { maxTries = 6 } = {}) {
  for (const host of detailHostCandidates(tenant.slug).slice(0, maxTries)) {
    try {
      const { text } = await requestText(boardJobUrl(host, sampleJobId), {
        ua: config.browserUA, timeoutMs: 30_000, label: `resolve ${host}`,
        headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
      });
      if (jsonLdJobPosting(text)) return host;
    } catch { /* 404 for this candidate; try the next */ }
  }
  return null;
}
