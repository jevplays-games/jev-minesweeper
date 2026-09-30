/** Thin async layer over the D1 binding (`env.DB`). Everything goes through prepare().bind().first()/all()/run() and batch(),
 *  which is the interface both Cloudflare D1 and the local node:sqlite shim (server/local-db.js) implement. */
const norm = args => args.map(a => a === undefined ? null : a);
export class Store {
  constructor(db) { this.db = db; }
  stmt(sql, ...args) { return this.db.prepare(sql).bind(...norm(args)); }
  async get(sql, ...args) { return (await this.stmt(sql, ...args).first()) ?? null; }
  async all(sql, ...args) { return (await this.stmt(sql, ...args).all()).results; }
  async run(sql, ...args) { const r = await this.stmt(sql, ...args).run(); return {changes: r.meta?.changes ?? 0}; }
  /** Atomic: D1 executes a batch as one transaction and rolls it back if any statement throws. */
  async batch(statements) { return this.db.batch(statements); }
  match(id) { return this.get('SELECT * FROM matches WHERE id=?', id); }
  auditStatement(type, {matchId = null, owner = null, data = {}, at = Date.now()} = {}) {
    return this.stmt('INSERT INTO audit_events(match_id,owner_key,at,type,data_json) VALUES(?,?,?,?,?)', matchId, owner, at, type, JSON.stringify(data));
  }
  async audit(type, options = {}) { await this.auditStatement(type, options).run(); }
  audits(id) { return this.all('SELECT at,type,data_json FROM audit_events WHERE match_id=? ORDER BY id', id).then(rows => rows.map(r => ({at: r.at, type: r.type, data: JSON.parse(r.data_json)}))); }
  /** Atomic fixed-window quota: returns the new value, or null when `limit` is already reached (nothing is consumed then). */
  async consume(bucket, name, limit, expiresAt, amount = 1) {
    if (amount > limit) return null;
    const row = await this.get(`INSERT INTO counters(bucket,name,value,expires_at) VALUES(?,?,?,?)
      ON CONFLICT(bucket,name) DO UPDATE SET value=value+excluded.value,expires_at=excluded.expires_at WHERE counters.value+excluded.value<=? RETURNING value`, bucket, name, amount, expiresAt, limit);
    return row ? row.value : null;
  }
  /** Return unused reserved units (never below zero). */
  async refund(bucket, name, amount) { if (amount > 0) await this.run('UPDATE counters SET value=max(0,value-?) WHERE bucket=? AND name=?', amount, bucket, name); }
  async prune(now, days) {
    await this.batch([
      this.stmt('DELETE FROM sessions WHERE expires_at<?', now), this.stmt('DELETE FROM launch_tickets WHERE expires_at<?', now),
      this.stmt('DELETE FROM audit_events WHERE at<?', now - days * 86400000), this.stmt('DELETE FROM counters WHERE expires_at<?', now)
    ]);
  }
}
