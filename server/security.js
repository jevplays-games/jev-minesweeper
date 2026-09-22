import {randomBytes, createHash, timingSafeEqual, createPublicKey, verify} from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = text => createHash('sha256').update(text).digest('hex');
export const httpError = (status, code, message = code.replaceAll('_', ' ')) => Object.assign(new Error(message), {status, code});
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y);
}
export function cookieName(config) { return config.production ? '__Host-jev_session' : 'jev_session'; }
export function cookies(header = '') {
  const result = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return result;
}
export function writeCookie(res, config, raw, maxAge = 86400) {
  res.setHeader('Set-Cookie', `${cookieName(config)}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.production ? '; Secure' : ''}`);
}
export function createSession(store, config, userId = null, data = {}, now = Date.now()) {
  const raw = token(), session = {token_hash: hash(raw), user_id: userId, csrf_token: token(), data, created_at: now, last_seen_at: now, expires_at: now + config.sessionAbsoluteMs};
  store.run('INSERT INTO sessions(token_hash,user_id,csrf_token,data_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)', session.token_hash, userId, session.csrf_token, JSON.stringify(data), now, now, session.expires_at);
  return {raw, session};
}
export function getSession(req, res, store, config, {create = false, now = Date.now()} = {}) {
  const raw = cookies(req.headers.cookie)[cookieName(config)];
  let s = typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw) ? store.get('SELECT * FROM sessions WHERE token_hash=?', hash(raw)) : null;
  if (s && (s.expires_at <= now || s.last_seen_at + config.sessionIdleMs <= now)) { store.run('DELETE FROM sessions WHERE token_hash=?', s.token_hash); s = null; }
  if (!s && create) { const created = createSession(store, config, null, {}, now); s = created.session; writeCookie(res, config, created.raw); }
  if (s) { s.data ??= JSON.parse(s.data_json); if (now - s.last_seen_at > 10000) { store.run('UPDATE sessions SET last_seen_at=? WHERE token_hash=?', now, s.token_hash); s.last_seen_at = now; } }
  return s;
}
export const ownerKey = session => session.user_id ? `u:${session.user_id}` : `s:${session.token_hash}`;
export function saveSession(store, session) { store.run('UPDATE sessions SET data_json=? WHERE token_hash=?', JSON.stringify(session.data), session.token_hash); }
export function csrf(req, session, config) {
  if (!session) throw httpError(401, 'session_required');
  if (req.headers.origin !== config.origin || !equal(req.headers['x-csrf-token'], session.csrf_token)) throw httpError(403, 'csrf_rejected');
}
export function verifyDiscordSignature(raw, headers, publicKeyHex, now = Date.now()) {
  const timestamp = headers['x-signature-timestamp'], signature = headers['x-signature-ed25519'];
  if (!/^[a-f0-9]{64}$/i.test(publicKeyHex) || !/^\d{10,12}$/.test(timestamp || '') || !/^[a-f0-9]{128}$/i.test(signature || '') || Math.abs(now - Number(timestamp) * 1000) > 300000) return false;
  try {
    const key = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki'});
    return verify(null, Buffer.concat([Buffer.from(timestamp), raw]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
export class RateLimiter {
  constructor(maxKeys = 10000) { this.buckets = new Map(); this.maxKeys = maxKeys; }
  take(key, limit, windowMs, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || now >= b.reset) { b = {count: 0, reset: now + windowMs}; this.buckets.set(key, b); }
    if (++b.count > limit) return false;
    if (this.buckets.size > this.maxKeys) { for (const [k, v] of this.buckets) if (now >= v.reset) this.buckets.delete(k); if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value); }
    return true;
  }
}
export function securityHeaders(res, config) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
