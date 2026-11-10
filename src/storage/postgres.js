/**
 * Postgres adapter, used when SG_DB_URL is set. `pg` is an optionalDependency:
 * the SQLite path needs no install at all, so a plain `git clone` still runs.
 *
 * Portability notes for the shared SQL in repository.js:
 *   - `?` placeholders are rewritten to $1..$n here
 *   - boolean-ish columns are SMALLINT in the Postgres schema so the 0/1 values
 *     the SQLite path uses work unchanged
 *   - the shared queries avoid SQLite-only scalars (no MAX(a,b), no
 *     datetime('now')) and use RETURNING, which both backends support
 */
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const bind = (params) => params.map((v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
});

export async function createPostgresStore(connectionString) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error('SG_DB_URL is set but the "pg" driver is not installed. '
      + 'Run `npm install pg`, or unset SG_DB_URL to use SQLite.');
  }
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString, max: 10 });
  // Fail fast on a bad URL rather than at the first query.
  const probe = await pool.connect();
  probe.release();

  const query = async (sql, params) => pool.query(toPgPlaceholders(sql), bind(params));

  return {
    dialect: 'postgres',
    async exec(sql) { await pool.query(sql); },
    async run(sql, params = []) { await query(sql, params); },
    async get(sql, params = []) { return (await query(sql, params)).rows[0] ?? null; },
    async all(sql, params = []) { return (await query(sql, params)).rows; },
    async insertReturningId(sql, params = []) {
      return (await query(sql, params)).rows[0]?.id ?? null;
    },
    async close() { await pool.end(); },
  };
}

export { toPgPlaceholders };
