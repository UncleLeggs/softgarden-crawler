import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import { createSqliteStore } from './sqlite.js';
import { createPostgresStore } from './postgres.js';
import { syncColumns } from './migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * SQLite by default so `git clone && npm run crawl` works with nothing
 * installed. Set SG_DB_URL to point at Postgres instead.
 */
export async function createStore({ url = config.dbUrl, path = config.dbPath, migrate = true } = {}) {
  const store = url ? await createPostgresStore(url) : createSqliteStore(path);
  log.debug(`storage: ${store.dialect}${url ? '' : ` (${path})`}`);
  if (migrate) {
    const schema = await readFile(join(HERE, `schema.${store.dialect}.sql`), 'utf8');
    await store.exec(schema);
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing database, so columns
    // added to the schema after a release need an explicit ALTER.
    await syncColumns(store, schema);
  }
  return store;
}
