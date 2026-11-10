import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportCsv(rows, path) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) { await writeFile(path, ''); return 0; }
  const cols = Object.keys(rows[0]);
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(','));
  await writeFile(path, [cols.join(','), ...body].join('\n') + '\n');
  return rows.length;
}

export async function exportNdjson(rows, path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return rows.length;
}
