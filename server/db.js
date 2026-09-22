import {DatabaseSync} from 'node:sqlite';
import {readFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path); this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); if (value?.then) throw new Error('SQLite transaction callback must be synchronous'); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  match(id) { return this.get('SELECT * FROM matches WHERE id=?', id); }
  events(id) { return this.all('SELECT event_json FROM match_events WHERE match_id=? ORDER BY seq', id).map(r => JSON.parse(r.event_json)); }
  audit(type, {matchId = null, owner = null, data = {}, at = Date.now()} = {}) {
    this.run('INSERT INTO audit_events(match_id,owner_key,at,type,data_json) VALUES(?,?,?,?,?)', matchId, owner, at, type, JSON.stringify(data));
  }
  audits(id) { return this.all('SELECT at,type,data_json FROM audit_events WHERE match_id=? ORDER BY id', id).map(r => ({at: r.at, type: r.type, data: JSON.parse(r.data_json)})); }
  prune(now, days) {
    this.transaction(() => {
      this.run('DELETE FROM sessions WHERE expires_at<?', now);
      this.run('DELETE FROM launch_tickets WHERE expires_at<?', now);
      this.run('DELETE FROM audit_events WHERE at<?', now - days * 86400000);
    });
  }
  close() { this.db.close(); }
}
