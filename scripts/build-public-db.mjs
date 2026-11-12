/**
 * Build a publication-safe copy of the database.
 *
 * The dashboard shows aggregates and a job list (title, place, link). It never
 * renders description text -- but that text is 180 MB of the 220 MB, and a
 * sample of 4,000 descriptions found an email address in 26% of them and a
 * phone number in 36%. Those are recruiter contact details belonging to other
 * companies, so they do not go on a public URL.
 *
 * This strips both description columns, keeps everything the dashboard needs,
 * and refuses to emit a file that still matches an email or phone pattern in
 * any text column. Coverage survives via jobs.has_description, which is why
 * that column exists.
 *
 *   node scripts/build-public-db.mjs data/softgarden.db data/public.db
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { createStore } from '../src/storage/index.js';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: node scripts/build-public-db.mjs <source.db> <dest.db>');
  process.exit(2);
}
const mb = (p) => (statSync(p).size / 1048576).toFixed(1);

for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) if (existsSync(f)) rmSync(f);
copyFileSync(src, dest);
console.log(`copied ${src} (${mb(src)} MB) -> ${dest}`);

// Bring the copy up to the current schema first: a database from an earlier
// run has no has_description column, and that is the one thing we must set
// before the text it is derived from is thrown away.
const migrated = await createStore({ url: null, path: dest, migrate: true });
await migrated.close();

const db = new DatabaseSync(dest);
const count = (sql) => db.prepare(sql).get().n;

// Preserve the coverage signal before the text it was derived from is removed.
db.exec(`UPDATE jobs SET has_description = CASE
           WHEN description_text IS NOT NULL AND description_text <> '' THEN 1
           WHEN description_html IS NOT NULL AND description_html <> '' THEN 1
           ELSE 0 END`);
const kept = count('SELECT COUNT(*) n FROM jobs WHERE has_description = 1');

db.exec('UPDATE jobs SET description_html = NULL, description_text = NULL');
db.exec('VACUUM');

// Verify: no email- or phone-shaped string may remain in any text column.
const TEXT = ['url', 'title', 'city', 'region', 'country', 'postal_code', 'street_address',
  'categories', 'company_name', 'apply_url', 'salary', 'employment_type', 'career_level',
  'work_experience', 'work_time', 'remote_status', 'remote_key', 'detail_note'];
// url and apply_url carry 8-digit job ids, which look exactly like a phone
// number to a digit-run test. They get the email-shape check only; every other
// column gets both.
const ID_BEARING = new Set(['url', 'apply_url']);
const leaks = [];
for (const col of TEXT) {
  const checks = [`${col} LIKE '%@%.%'`];
  if (!ID_BEARING.has(col)) {
    checks.push(`${col} GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'`);
  }
  const n = count(`SELECT COUNT(*) n FROM jobs WHERE ${checks.join(' OR ')}`);
  if (n) leaks.push(`${col}: ${n} rows`);
}
const stillText = count(`SELECT COUNT(*) n FROM jobs
  WHERE description_html IS NOT NULL OR description_text IS NOT NULL`);

db.close();

if (stillText) { console.error(`REFUSING: ${stillText} rows still carry description text`); process.exit(1); }
if (leaks.length) {
  console.error('REFUSING: contact-shaped values remain in:', leaks.join('; '));
  console.error('Inspect those columns before publishing.');
  process.exit(1);
}
console.log(`stripped descriptions; has_description preserved for ${kept} jobs`);
console.log(`wrote ${dest} (${mb(dest)} MB) -- no description text, no contact-shaped values`);
