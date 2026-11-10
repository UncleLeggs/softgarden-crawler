import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/storage/index.js';
import { toPgPlaceholders } from '../src/storage/postgres.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const freshPath = () => join(mkdtempSync(join(tmpdir(), 'sgstore-')), 'test.db');

test('the sqlite store is the default and coerces undefined to NULL', async () => {
  const store = await createStore({ url: null, path: freshPath() });
  assert.equal(store.dialect, 'sqlite');
  await store.exec('CREATE TABLE t (a TEXT, b TEXT, c INTEGER)');
  await store.run('INSERT INTO t (a, b, c) VALUES (?, ?, ?)', ['x', undefined, true]);
  const row = await store.get('SELECT * FROM t');
  assert.equal(row.a, 'x');
  assert.equal(row.b, null, 'undefined must become NULL');
  assert.equal(row.c, 1, 'booleans must become 0/1');
  await store.close();
});

test('get returns null rather than undefined when nothing matches', async () => {
  const store = await createStore({ url: null, path: freshPath() });
  assert.equal(await store.get('SELECT * FROM tenants WHERE slug = ?', ['nope']), null);
  await store.close();
});

test('insertReturningId works via RETURNING on both backends', async () => {
  const store = await createStore({ url: null, path: freshPath() });
  const id = await store.insertReturningId(
    'INSERT INTO runs (mode, started_at) VALUES (?, ?) RETURNING id', ['test', new Date().toISOString()]);
  assert.ok(Number(id) > 0);
  await store.close();
});

test('migration is idempotent, so a restart does not fail', async () => {
  const path = freshPath();
  const a = await createStore({ url: null, path });
  await a.close();
  const b = await createStore({ url: null, path });
  assert.equal(b.dialect, 'sqlite');
  await b.close();
});

test('placeholders are rewritten positionally for Postgres', () => {
  assert.equal(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(toPgPlaceholders('INSERT INTO t VALUES (?,?,?)'), 'INSERT INTO t VALUES ($1,$2,$3)');
  assert.equal(toPgPlaceholders('SELECT 1'), 'SELECT 1');
});

test('a bad SG_DB_URL fails with an actionable message, not a driver stack', async () => {
  await assert.rejects(
    () => createStore({ url: 'postgres://nobody@127.0.0.1:1/none', migrate: false }),
    (err) => {
      // Either pg is absent (our message) or the connection is refused (pg's).
      assert.match(err.message, /pg|ECONNREFUSED|connect/i);
      return true;
    });
});

/**
 * The two schemas must stay in step: the repository writes one set of column
 * names to whichever backend is configured, so a column added to one file and
 * forgotten in the other is a runtime failure only on the untested backend.
 */
test('the sqlite and postgres schemas declare the same tables and columns', () => {
  const read = (f) => readFileSync(join(HERE, '..', 'src', 'storage', f), 'utf8');
  const parse = (sql) => {
    const tables = {};
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      const cols = m[2].split('\n')
        .map((l) => l.trim().replace(/--.*$/, '').trim())
        .filter((l) => l && !/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CONSTRAINT)/i.test(l))
        .map((l) => l.split(/\s+/)[0].replace(/,$/, ''))
        .filter(Boolean);
      tables[m[1]] = cols.sort();
    }
    return tables;
  };
  const lite = parse(read('schema.sqlite.sql'));
  const pg = parse(read('schema.postgres.sql'));
  assert.deepEqual(Object.keys(pg).sort(), Object.keys(lite).sort(), 'table sets must match');
  for (const t of Object.keys(lite)) {
    assert.deepEqual(pg[t], lite[t], `columns of "${t}" must match across backends`);
  }
});
