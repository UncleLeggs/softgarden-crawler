import { config } from '../config.js';
import { requestJson } from '../http.js';

/**
 * schema.org DataFeed at {host}/jobs.feed.json.
 *
 * Only the career.softgarden.de stack serves this; on softgarden.io it 404s.
 * Its value here is cheap change detection: the feed carries a feed-level
 * dateModified (there is NO per-job dateModified -- jobs carry datePosted), so
 * one small request tells us whether a tenant changed at all before we spend
 * requests on listings and details.
 *
 * Its field values are also the messiest of the three sources -- mixed
 * German/English regions and country names, "-" as a postal code, and no
 * validThrough anywhere -- so we read it for timing, not for truth.
 */
export async function fetchFeedMeta(tenant) {
  try {
    const feed = await requestJson(`https://${tenant.host}/jobs.feed.json`, {
      ua: config.browserUA, timeoutMs: 30_000, retries: 2, label: `feed ${tenant.slug}`,
    });
    const items = feed.dataFeedElement ?? [];
    return {
      available: true,
      dateModified: feed.dateModified ?? null,
      jobCount: items.length,
    };
  } catch (err) {
    return { available: false, dateModified: null, jobCount: null, note: err.message };
  }
}
