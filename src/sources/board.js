import { config } from '../config.js';
import { requestText } from '../http.js';
import { decodeEntities } from '../normalize.js';

/**
 * Legacy Wicket career board listing.
 *
 * It renders every job server-side in one response -- a 1912-job tenant returns
 * all 1912 /job/<id> links in a single ~2 MB page, and its "pagination" markup
 * is client-side only. So one fetch is the complete list; counts are exact, not
 * floors. We still de-duplicate by job id because each job appears in several
 * link variants (title, location, category...).
 */
export async function fetchBoardListings(tenant) {
  const { text: html } = await requestText(`https://${tenant.host}/`, {
    ua: config.browserUA, timeoutMs: 60_000, label: `board ${tenant.slug}`,
    headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
  });

  const byId = new Map();
  for (const m of html.matchAll(/href="([^"]*?\/job\/(\d+)[^"]*)"/g)) {
    const [, rawHref, id] = m;
    if (byId.has(id)) continue;
    const href = decodeEntities(rawHref);
    byId.set(id, {
      jobId: id,
      url: href.startsWith('http') ? href : `https://${tenant.host}${href.startsWith('/') ? '' : '/'}${href}`,
      title: null, location: null, category: null, careerLevel: null,
      workTime: null, lat: null, lng: null, datePosted: null, categories: null,
    });
  }
  return { jobs: [...byId.values()], total: byId.size };
}
