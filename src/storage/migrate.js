import { log } from '../logger.js';

/**
 * A deliberately tiny migrator.
 *
 * The schema files use CREATE TABLE IF NOT EXISTS, which is enough to create a
 * database but does nothing to one that already exists -- so a column added to
 * the schema never reaches a database from a previous release. That is how a
 * `note` produced by the crawler ended up being written nowhere: the column it
 * needed had simply never been added.
 *
 * Scope is intentionally narrow: it adds columns that the schema declares and
 * the live table lacks, and refuses anything else. It never drops, renames or
 * retypes a column, and it skips NOT NULL columns without a DEFAULT because
 * those cannot be added to a table that already holds rows.
 */
export function declaredColumns(sql) {
  const tables = new Map();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const cols = new Map();
    for (const raw of m[2].split('\n')) {
      const line = raw.trim().replace(/--.*$/, '').trim().replace(/,$/, '');
      if (!line || /^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CONSTRAINT|CHECK)\b/i.test(line)) continue;
      const name = line.split(/\s+/)[0];
      if (name) cols.set(name, line);
    }
    tables.set(m[1], cols);
  }
  return tables;
}

async function liveColumns(store, table) {
  const rows = store.dialect === 'postgres'
    ? await store.all('SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?', [table])
    : await store.all(`SELECT name FROM pragma_table_info('${table}')`);
  return new Set(rows.map((r) => r.name));
}

export async function syncColumns(store, schemaSql) {
  const added = [];
  for (const [table, cols] of declaredColumns(schemaSql)) {
    const live = await liveColumns(store, table);
    if (!live.size) continue; // table did not exist; CREATE TABLE already built it in full
    for (const [name, definition] of cols) {
      if (live.has(name)) continue;
      if (/\bNOT NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition)) {
        log.warn(`migration: cannot add ${table}.${name} (NOT NULL without DEFAULT); add it by hand`);
        continue;
      }
      await store.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      added.push(`${table}.${name}`);
    }
  }
  if (added.length) log.info(`migration: added ${added.join(', ')}`);
  return added;
}
