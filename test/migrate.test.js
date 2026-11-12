import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/storage/index.js';
import { declaredColumns, syncColumns } from '../src/storage/migrate.js';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'sgmig-')), 'test.db');

test('declaredColumns reads names and definitions, skipping table constraints', () => {
  const t = declaredColumns(`
CREATE TABLE IF NOT EXISTS t (
  a TEXT NOT NULL,
  b INTEGER DEFAULT 0,   -- a comment
  c TEXT,
  PRIMARY KEY (a),
  UNIQUE (b)
);
`);
  assert.deepEqual([...t.get('t').keys()], ['a', 'b', 'c']);
  assert.match(t.get('t').get('b'), /^b INTEGER DEFAULT 0$/);
});

/**
 * The bug this guards: the schema files use CREATE TABLE IF NOT EXISTS, so a
 * column added after a release silently never reaches an existing database.
 * That is how detail notes were written nowhere for a whole run.
 */
test('a column added to the schema reaches a database that already exists', async () => {
  const path = freshPath();
  const a = await createStore({ url: null, path });
  await a.exec('CREATE TABLE IF NOT EXISTS legacy (\n  id INTEGER,\n  keep TEXT\n);');
  await a.run('INSERT INTO legacy (id, keep) VALUES (?, ?)', [1, 'row survives']);

  const added = await syncColumns(a, 'CREATE TABLE IF NOT EXISTS legacy (\n  id INTEGER,\n  keep TEXT,\n  fresh TEXT\n);');
  assert.deepEqual(added, ['legacy.fresh']);
  const row = await a.get('SELECT keep, fresh FROM legacy WHERE id = 1');
  assert.equal(row.keep, 'row survives', 'existing rows must be preserved');
  assert.equal(row.fresh, null);

  // Running it again must add nothing.
  assert.deepEqual(await syncColumns(a, 'CREATE TABLE IF NOT EXISTS legacy (\n  id INTEGER,\n  keep TEXT,\n  fresh TEXT\n);'), []);
  await a.close();
});

test('it refuses a NOT NULL column with no default rather than failing the run', async () => {
  const store = await createStore({ url: null, path: freshPath() });
  await store.exec('CREATE TABLE IF NOT EXISTS t2 (\n  id INTEGER\n);');
  await store.run('INSERT INTO t2 (id) VALUES (1)');
  const added = await syncColumns(store, 'CREATE TABLE IF NOT EXISTS t2 (\n  id INTEGER,\n  must TEXT NOT NULL\n);');
  assert.deepEqual(added, [], 'must be skipped, not attempted');
  assert.equal(Number((await store.get('SELECT COUNT(*) AS n FROM t2')).n), 1);
  await store.close();
});

test('the real schema migrates an existing database to the current columns', async () => {
  const path = freshPath();
  const a = await createStore({ url: null, path });   // current schema
  await a.close();
  const b = await createStore({ url: null, path });   // reopen: nothing to add
  const cols = (await b.all("SELECT name FROM pragma_table_info('jobs')")).map((r) => r.name);
  assert.ok(cols.includes('detail_note'), 'jobs.detail_note must exist');
  const tcols = (await b.all("SELECT name FROM pragma_table_info('tenants')")).map((r) => r.name);
  assert.ok(tcols.includes('detail_host'), 'tenants.detail_host must exist');
  await b.close();
});
