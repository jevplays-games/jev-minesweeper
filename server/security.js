// Web APIs only (Web Crypto, Request/Response/Headers): this module runs unchanged on Cloudflare Workers and in the local Node shim.
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), x => parseInt(x, 16));
export const httpError = (status, code, message = code.replaceAll('_', ' ')) => Object.assign(new Error(message), {status, code});
export const token = () => {
  let text = ''; for (const b of crypto.getRandomValues(new Uint8Array(32))) text += String.fromCharCode(b);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
export const hash = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
/** Constant-time comparison for equal-length strings; the length itself is not secret here. */
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}
export function cookieName(config) { return config.production ? '__Host-jev_session' : 'jev_session'; }
export function cookies(header = '') {
  const result = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return result;
}
export function sessionCookie(config, raw, maxAge = 86400) {
  return `${cookieName(config)}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.production ? '; Secure' : ''}`;
}
export async function createSession(store, config, userId = null, data = {}, now = Date.now()) {
  const raw = token(), session = {token_hash: await hash(raw), user_id: userId, csrf_token: token(), data, created_at: now, last_seen_at: now, expires_at: now + config.sessionAbsoluteMs};
  await store.run('INSERT INTO sessions(token_hash,user_id,csrf_token,data_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)', session.token_hash, userId, session.csrf_token, JSON.stringify(data), now, now, session.expires_at);
  return {raw, session};
}
/** The statement form, for callers that must create a session in the same atomic batch as other writes. */
export async function sessionStatement(store, config, userId, data = {}, now = Date.now()) {
  const raw = token(), session = {token_hash: await hash(raw), user_id: userId, csrf_token: token(), data, created_at: now, last_seen_at: now, expires_at: now + config.sessionAbsoluteMs};
  return {raw, session, statement: store.stmt('INSERT INTO sessions(token_hash,user_id,csrf_token,data_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)', session.token_hash, userId, session.csrf_token, JSON.stringify(data), now, now, session.expires_at)};
}
// Inside a Discord Activity the browser will not send our SameSite cookie, so the game holds the session token in memory and sends it as a bearer.
export const activityOrigin = config => /^\d{5,25}$/.test(config.discordClientId || '') ? `https://${config.discordClientId}.discordsays.com` : null;
export function bearerToken(request) { const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || ''); return m ? m[1] : null; }
export async function hasBearerSession(request, store) { const raw = bearerToken(request); return Boolean(raw && await store.get('SELECT 1 AS ok FROM sessions WHERE token_hash=?', await hash(raw))); }
/** Returns the session (or null). A newly created guest session carries `setCookie` for the caller to attach to its response. */
export async function getSession(request, store, config, {create = false, now = Date.now()} = {}) {
  const bearer = bearerToken(request), raw = bearer ?? cookies(request.headers.get('cookie') || '')[cookieName(config)];
  let s = typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw) ? await store.get('SELECT * FROM sessions WHERE token_hash=?', await hash(raw)) : null;
  if (s && (s.expires_at <= now || s.last_seen_at + config.sessionIdleMs <= now)) { await store.run('DELETE FROM sessions WHERE token_hash=?', s.token_hash); s = null; }
  if (!s && create) { const created = await createSession(store, config, null, {}, now); s = created.session; s.setCookie = sessionCookie(config, created.raw); }
  if (s && bearer) s.via = 'bearer';
  if (s) { s.data ??= JSON.parse(s.data_json); if (now - s.last_seen_at > 10000) { await store.run('UPDATE sessions SET last_seen_at=? WHERE token_hash=?', now, s.token_hash); s.last_seen_at = now; } }
  return s;
}
export const ownerKey = session => session.user_id ? `u:${session.user_id}` : `s:${session.token_hash}`;
export const saveSessionStatement = (store, session) => store.stmt('UPDATE sessions SET data_json=? WHERE token_hash=?', JSON.stringify(session.data), session.token_hash);
export async function saveSession(store, session) { await saveSessionStatement(store, session).run(); }
export function csrf(request, session, config) {
  if (!session) throw httpError(401, 'session_required');
  const framed = session.via === 'bearer' ? activityOrigin(config) : null, origin = request.headers.get('origin');
  if ((origin !== config.origin && !(framed && origin === framed)) || !equal(request.headers.get('x-csrf-token'), session.csrf_token)) throw httpError(403, 'csrf_rejected');
}
/** Ed25519 over the exact raw bytes: `timestamp` followed by the body. Web Crypto only; no node:crypto. */
export async function verifyDiscordSignature(raw, headers, publicKeyHex, now = Date.now()) {
  const timestamp = headers.get('x-signature-timestamp'), signature = headers.get('x-signature-ed25519');
  if (!/^[a-f0-9]{64}$/i.test(publicKeyHex || '') || !/^\d{10,12}$/.test(timestamp || '') || !/^[a-f0-9]{128}$/i.test(signature || '') || Math.abs(now - Number(timestamp) * 1000) > 300000) return false;
  try {
    // Standard name first; older workerd builds only know the NODE-ED25519 spelling of the same algorithm.
    let algorithm = {name: 'Ed25519'}, key;
    try { key = await crypto.subtle.importKey('raw', unhex(publicKeyHex), algorithm, false, ['verify']); }
    catch { algorithm = {name: 'NODE-ED25519', namedCurve: 'NODE-ED25519'}; key = await crypto.subtle.importKey('raw', unhex(publicKeyHex), algorithm, false, ['verify']); }
    const stamp = encoder.encode(timestamp), message = new Uint8Array(stamp.length + raw.length); message.set(stamp); message.set(raw, stamp.length);
    return await crypto.subtle.verify(algorithm.name, key, unhex(signature), message);
  } catch { return false; }
}
/** Per-isolate burst limiter. Best-effort only on Workers (isolates come and go); the D1 quotas in db.js are the durable limits. */
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
// Discord shows an Activity inside its own iframe. Only the HTML document loaded with Discord's frame_id may be framed, and only by Discord.
export const ACTIVITY_FRAME_ANCESTORS = 'frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com';
export function allowDiscordFraming(headers) {
  headers.delete('X-Frame-Options');
  headers.set('Content-Security-Policy', String(headers.get('Content-Security-Policy')).replace("frame-ancestors 'none'", ACTIVITY_FRAME_ANCESTORS));
}
export function securityHeaders(headers, config) {
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.production) headers.set('Strict-Transport-Security', 'max-age=31536000');
}
