import { config } from './config.js';
import { requestText } from './http.js';
import { cleanCompanyName } from './normalize.js';

export const PLATFORM = {
  CAREER_NEXT: 'career-next',       // Next.js career pages, ids in __NEXT_DATA__
  CAREER_EMBEDDED: 'career-embedded', // server-rendered, ids as plain JSON keys
  BOARD: 'board',                   // legacy Apache Wicket career board
};

function idsFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[1]); } catch { return null; }
  const data = d?.props?.pageProps?.data ?? {};
  const userId = data.context?.frontendOAuthClientUuid4;
  const projectId = data.context?.projectUuid4;
  const pageId = data.page?.id;
  if (!userId || !projectId || !pageId) return null;
  return {
    userId, projectId, pageId,
    locale: data.context?.defaultLocale ?? 'de',
    companyName: cleanCompanyName(data.page?.apiData?.companyData?.companyName
      ?? data.page?.apiData?.seo?.customer?.name ?? ''),
    platform: PLATFORM.CAREER_NEXT,
  };
}

// Server-rendered career pages carry the same widget ids as plain JSON keys.
function idsFromEmbedded(html) {
  const grab = (k) => html.match(
    new RegExp(`"${k}"\\s*:\\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"`))?.[1];
  const userId = grab('userId'); const projectId = grab('projectId'); const pageId = grab('pageId');
  if (!userId || !projectId || !pageId) return null;
  return {
    userId, projectId, pageId,
    locale: html.match(/<html[^>]*\blang="([a-z]{2})"/i)?.[1] ?? 'de',
    companyName: '',
    platform: PLATFORM.CAREER_EMBEDDED,
  };
}

/**
 * Detect which of the three career-site generations a tenant runs.
 * Tries career.softgarden.de first because only that stack exposes the widget
 * API; falls back to softgarden.io, which is the legacy board.
 */
export async function detectTenant(slug, seenOn = ['career.softgarden.de', 'softgarden.io']) {
  const hosts = [];
  if (seenOn.includes('career.softgarden.de')) hosts.push(`${slug}.career.softgarden.de`);
  if (seenOn.includes('softgarden.io')) hosts.push(`${slug}.softgarden.io`);

  let lastNote = 'no host responded';
  for (const host of hosts) {
    let page;
    try {
      page = await requestText(`https://${host}/`, {
        ua: config.browserUA, timeoutMs: 45_000, label: host,
        headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
      });
    } catch (err) { lastNote = `${host}: ${err.message}`; continue; }

    const { text: html, finalUrl } = page;
    const finalHost = new URL(finalUrl).hostname;
    const titleName = cleanCompanyName(html.match(/<title>([^<]*)/)?.[1] ?? '');

    const ids = idsFromNextData(html) ?? idsFromEmbedded(html);
    if (ids) {
      // Spread ids FIRST: its companyName is empty on the server-rendered
      // variant, and spreading it last would overwrite the title fallback.
      return {
        ...ids,
        slug, host, live: true,
        customDomain: finalHost !== host ? finalHost : null,
        companyName: ids.companyName || titleName || null,
        note: null,
      };
    }

    // Legacy board: the listing renders every job server-side.
    if (/\/job\/\d+/.test(html) || /vacancies|career board|karriere board/i.test(html)) {
      return {
        slug, host, live: true, platform: PLATFORM.BOARD,
        customDomain: finalHost !== host ? finalHost : null,
        companyName: titleName || null,
        userId: null, projectId: null, pageId: null,
        locale: html.match(/<html[^>]*\blang="([a-z]{2})"/i)?.[1] ?? 'de',
        note: null,
      };
    }
    lastNote = `${host}: unrecognised page`;
  }
  return { slug, host: null, live: false, platform: null, customDomain: null,
    companyName: null, userId: null, projectId: null, pageId: null, locale: null, note: lastNote };
}
