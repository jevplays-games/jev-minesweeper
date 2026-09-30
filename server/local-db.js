/** Local, test-only implementation of the Cloudflare D1 binding on node:sqlite (Node >= 22.16). It is deliberately the same shape the
 *  Worker sees (`prepare().bind().first()/all()/run()`, `batch()`), so the application code and the tests exercise real SQLite. Not a second backend. */
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
export function localDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  // A database file written by the pre-Cloudflare build has the same table names but not this schema; refuse it instead of half-working.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='matches'").get() && !db.prepare("SELECT 1 FROM sqlite_master WHERE name='d1_migrations'").get()) { db.close(); throw new Error(`${path} was created by the earlier standalone build. Move it aside (or delete it) so the D1 schema in migrations/ can be applied.`); }
  // Same bookkeeping idea as `wrangler d1 migrations apply`: each file runs once.
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const name of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    if (db.prepare('SELECT 1 FROM d1_migrations WHERE name=?').get(name)) continue;
    db.exec(readFileSync(resolve(migrationsDir, name), 'utf8')); db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
  }
  const cache = new Map();
  const prepared = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  class Statement {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { if (args.some(a => a === undefined)) throw new TypeError('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\''); return new Statement(this.sql, args); }
    async first(column) { const row = prepared(this.sql).get(...this.args); return row ? (column ? row[column] : {...row}) : null; }
    async all() { return {success: true, results: prepared(this.sql).all(...this.args).map(r => ({...r})), meta: {changes: 0}}; }
    async run() { return this.runSync(); }
    runSync() {
      const s = prepared(this.sql);
      // Statements with RETURNING produce rows; run() still reports changes like D1.
      if (/\bRETURNING\b/i.test(this.sql)) { const rows = s.all(...this.args); return {success: true, results: rows.map(r => ({...r})), meta: {changes: rows.length, last_row_id: 0}}; }
      const r = s.run(...this.args); return {success: true, results: [], meta: {changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid)}};
    }
  }
  return {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => s.runSync()); db.exec('COMMIT'); return results; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); return {success: true}; },
    close() { db.close(); }, raw: db
  };
}
