import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, chmodSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
try {
  const source = resolve(process.env.DATABASE_PATH || 'data/minesweeper.sqlite');
  const target = resolve(process.argv[2] || `backups/minesweeper-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
  if (!existsSync(source)) throw new Error('Source database does not exist; start the application first.');
  if (existsSync(target)) throw new Error('Backup destination already exists; refusing to overwrite.');
  mkdirSync(dirname(target), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(source);
  try { db.exec('PRAGMA busy_timeout=10000'); db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
  chmodSync(target, 0o600);
  const check = new DatabaseSync(target, {readOnly: true});
  let integrity;
  try { integrity = check.prepare('PRAGMA integrity_check').get().integrity_check; } finally { check.close(); }
  if (integrity !== 'ok') throw new Error('Backup integrity check failed.');
  console.log(JSON.stringify({backup: target, integrity, warning: 'Contains private game and session data. Restrict access.'}, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
