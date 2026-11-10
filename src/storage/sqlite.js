import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * node:sqlite is synchronous; the store interface is async so that the Postgres
 * adapter can satisfy the same shape. Wrapping sync calls costs a microtask and
 * keeps every caller backend-agnostic.
 *
 * node:sqlite also rejects `undefined` where SQL wants NULL, and listing records
 * legitimately lack detail fields until a detail fetch fills them in -- so every
 * parameter is coerced here rather than at each call site.
 */
const bind = (params) => params.map((v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
});

export function createSqliteStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');

  return {
    dialect: 'sqlite',
    async exec(sql) { db.exec(sql); },
    async run(sql, params = []) { db.prepare(sql).run(...bind(params)); },
    async get(sql, params = []) { return db.prepare(sql).get(...bind(params)) ?? null; },
    async all(sql, params = []) { return db.prepare(sql).all(...bind(params)); },
    // Both backends support RETURNING, so id retrieval is portable.
    async insertReturningId(sql, params = []) {
      const row = db.prepare(sql).get(...bind(params));
      return row?.id ?? null;
    },
    async close() { db.close(); },
  };
}
