import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blocksForPrefix, slugFromHost, prefixUpperBound } from '../src/commoncrawl.js';

test('slugFromHost accepts both domains and rejects Softgarden\'s own hosts', () => {
  assert.equal(slugFromHost('home24.career.softgarden.de'), 'home24');
  assert.equal(slugFromHost('home24.softgarden.io'), 'home24');
  assert.equal(slugFromHost('www.career.softgarden.de'), null);
  assert.equal(slugFromHost('pcw-api.softgarden.io'), null);
  assert.equal(slugFromHost('a.b.career.softgarden.de'), null);
  assert.equal(slugFromHost('softgarden.de'), null);
});

test('prefixUpperBound increments the last character', () => {
  assert.equal(prefixUpperBound('de,softgarden,career,'), 'de,softgarden,career-');
  assert.equal(prefixUpperBound('io,softgarden,'), 'io,softgarden-');
});

// cluster.idx lists only block boundaries, so the records we want usually start
// mid-block. These cases pin the selection logic that made production work.
async function fixture(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-'));
  const p = join(dir, 'cluster.idx');
  await writeFile(p, lines.join('\n') + '\n');
  return p;
}
const line = (key, file, off, len) => `${key} 20261008063800\t${file}\t${off}\t${len}\t1`;

test('picks the preceding block when no boundary starts inside the prefix', async () => {
  // Real shape: career records sit between softexpress and softgarden,jobdb.
  const p = await fixture([
    line('de,softcotton)/x', 'cdx-00169.gz', 100, 10),
    line('de,softexpress)/y', 'cdx-00169.gz', 110, 240),
    line('de,softgarden,jobdb)/z', 'cdx-00169.gz', 350, 190),
  ]);
  const blocks = await blocksForPrefix(p, 'de,softgarden,career,');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].offset, 110);
  assert.equal(blocks[0].length, 240);
});

test('spans every block that starts inside the prefix, plus the one before', async () => {
  // Real shape: .io records span several blocks.
  const p = await fixture([
    line('io,softatlas)/a', 'cdx-00202.gz', 1000, 100),
    line('io,softgarden,certificate)/b', 'cdx-00202.gz', 1100, 100),
    line('io,softgarden,gfo-online)/c', 'cdx-00202.gz', 1200, 100),
    line('io,softlist)/d', 'cdx-00202.gz', 1300, 100),
  ]);
  const blocks = await blocksForPrefix(p, 'io,softgarden,');
  assert.deepEqual(blocks.map((b) => b.offset), [1000, 1100, 1200]);
});

test('returns nothing when the prefix is past the end of the index', async () => {
  const p = await fixture([line('aa,zzz)/a', 'cdx-1.gz', 0, 10)]);
  const blocks = await blocksForPrefix(p, 'zz,nothing,');
  assert.equal(blocks.length, 1); // the trailing block may still contain it
  const none = await blocksForPrefix(await fixture([line('zz,aaa)/a', 'cdx-1.gz', 0, 10)]), 'aa,bbb,');
  assert.equal(none.length, 0);
});
