import { stat, mkdir, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { gunzipSync, constants as zc } from 'node:zlib';
import { config, TARGETS, IGNORE_SLUGS } from './config.js';
import { request, requestJson } from './http.js';
import { log } from './logger.js';

/**
 * Why the static index files and not index.commoncrawl.org:
 * the CDX API rate-limits hard and goes down for long stretches (sustained
 * 504s on every query, including trivial ones). The files under
 * data.commoncrawl.org are reliable.
 *
 * Why one bulk download and not range-request binary search over cluster.idx:
 * binary search is ~14 small range requests per prefix, and CloudFront's WAF
 * treats that burst as abuse -- it then returns an immediate 403 "Request
 * blocked" for every request from your IP for a while. One cached GET plus a
 * handful of block reads stays well inside what they tolerate.
 */
export async function latestCrawlIds(n = 1) {
  const list = await requestJson(config.collinfo, { label: 'collinfo.json' });
  return list.slice(0, n).map((c) => c.id); // newest first
}

export async function cachedClusterIdx(crawlId) {
  const path = join(config.cacheDir, `${crawlId}-cluster.idx`);
  try {
    const st = await stat(path);
    if (st.size > 0) { log.info(`cluster.idx cached (${(st.size / 1e6).toFixed(0)} MB) ${crawlId}`); return path; }
  } catch { /* not cached */ }

  await mkdir(config.cacheDir, { recursive: true });
  const url = `${config.dataHost}/cc-index/collections/${crawlId}/indexes/cluster.idx`;
  log.info(`downloading cluster.idx (~100 MB, cached in ${config.cacheDir}/)`);
  const res = await request(url, { timeoutMs: 600_000, label: 'cluster.idx' });
  if (!res.ok) throw new Error(`cluster.idx HTTP ${res.status} for ${crawlId}`);
  const tmp = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, path);
  const { size } = await stat(path);
  log.info(`cluster.idx saved (${(size / 1e6).toFixed(0)} MB)`);
  return path;
}

const keyOf = (line) => line.split(' ')[0];

export function prefixUpperBound(surt) {
  return surt.slice(0, -1) + String.fromCharCode(surt.charCodeAt(surt.length - 1) + 1);
}

/**
 * Blocks that can hold records for `surt`: the last block starting at or before
 * it (records with the prefix may begin mid-block), plus every block starting
 * inside the prefix range. cluster.idx is sorted, one line per block:
 *   <surt-key> <timestamp>\t<cdx file>\t<offset>\t<length>\t<block#>
 */
export async function blocksForPrefix(idxPath, surt) {
  const upper = prefixUpperBound(surt);
  const rl = createInterface({ input: createReadStream(idxPath), crlfDelay: Infinity });
  const picked = [];
  let prev = null;
  try {
    for await (const line of rl) {
      const p = line.split('\t');
      if (p.length < 4) continue;
      const offset = Number(p[2]); const length = Number(p[3]);
      if (!p[1] || !Number.isFinite(offset) || !Number.isFinite(length)) continue;
      const block = { key: keyOf(line), file: p[1], offset, length };

      if (block.key >= surt && block.key < upper) {
        if (prev && !picked.length) picked.push(prev);
        picked.push(block);
      } else if (block.key >= upper) {
        if (!picked.length && prev && prev.key <= surt) picked.push(prev);
        break;
      }
      prev = block;
    }
  } finally { rl.close(); }
  if (!picked.length && prev && prev.key <= surt) picked.push(prev);
  return [...new Map(picked.map((b) => [`${b.file}:${b.offset}`, b])).values()];
}

// cdx blocks are concatenated gzip members; salvage what decompresses.
function gunzipLenient(buf) {
  for (const opts of [undefined, { finishFlush: zc.Z_SYNC_FLUSH }]) {
    try { return gunzipSync(buf, opts).toString('utf8'); } catch { /* next */ }
  }
  return '';
}

async function hostsForTarget(crawlId, idxPath, target) {
  const blocks = await blocksForPrefix(idxPath, target.surt);
  if (!blocks.length) return new Set();
  const re = new RegExp(`^${target.surt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z0-9-]+)\\)`, 'gm');
  const hosts = new Set();
  for (const b of blocks) {
    const url = `${config.dataHost}/cc-index/collections/${crawlId}/indexes/${b.file}`;
    const res = await request(url, {
      headers: { range: `bytes=${b.offset}-${b.offset + b.length - 1}` },
      label: `${b.file}@${b.offset}`, timeoutMs: 180_000,
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`range HTTP ${res.status} ${b.file}`);
    const text = gunzipLenient(Buffer.from(await res.arrayBuffer()));
    if (!text) { log.warn(`could not decompress ${b.file}@${b.offset}`); continue; }
    for (const m of text.matchAll(re)) hosts.add(`${m[1]}.${target.domain}`);
  }
  log.info(`${target.domain}: ${blocks.length} block(s), ${hosts.size} hosts`);
  return hosts;
}

export function slugFromHost(host) {
  const m = host.match(/^([a-z0-9-]+)\.(?:career\.softgarden\.de|softgarden\.io)$/);
  if (!m || IGNORE_SLUGS.has(m[1])) return null;
  return m[1];
}

/** Returns Map<slug, Set<domain>>, merged across crawls. */
export async function discoverSlugs({ crawls = config.crawls } = {}) {
  const ids = await latestCrawlIds(crawls);
  log.info(`crawls: ${ids.join(', ')}`);
  const seen = new Map();
  for (const crawlId of ids) {
    let idxPath;
    try { idxPath = await cachedClusterIdx(crawlId); }
    catch (err) { log.warn(`skip ${crawlId}: ${err.message}`); continue; }

    for (const target of TARGETS) {
      try {
        for (const host of await hostsForTarget(crawlId, idxPath, target)) {
          const slug = slugFromHost(host);
          if (!slug) continue;
          if (!seen.has(slug)) seen.set(slug, new Set());
          seen.get(slug).add(target.domain);
        }
      } catch (err) {
        // One bad crawl or prefix must not sink the run.
        log.warn(`skip ${crawlId} ${target.domain}: ${err.message}`);
      }
    }
  }
  return seen;
}
