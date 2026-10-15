import {PRESETS, ENGINE_VERSION} from '../public/shared/engine.js';
import {POLICY_VERSION} from '../public/shared/solver.js';
import {MODEL} from '../public/shared/decisions.js';
function number(env, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`); return n;
}
/**
 * Why `value` is not a bare HTTP(S) origin, or null when it is (decision D9). The raw value, minus one trailing "/", must equal its own
 * URL.origin, so userinfo (even a lone password), paths, queries and fragments, including empty `?` and `#`, are refused, never normalised.
 */
function originProblem(value) {
  if (/[@?#*]/.test(value)) return 'forbidden_character';
  let parsed; try { parsed = new URL(value); } catch { return 'not_a_url'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'not_http';
  return value.replace(/\/$/, '') === parsed.origin ? null : 'not_bare_origin';
}
const warnedLegacy = new Set();
/**
 * LEGACY_APP_ORIGINS entries that pass D9 and match APP_ORIGIN's scheme (http only in local development). A bad entry is skipped with
 * one structured warning per isolate; it never fails the deployment, so a typo cannot take the primary host down. The log carries the
 * entry's position and reason, not its text, which could hold a credential.
 */
function legacyOrigins(raw, primary, dev) {
  const admitted = [];
  String(raw || '').split(',').map(s => s.trim()).forEach((entry, index) => {
    if (!entry) return;
    let reason = originProblem(entry);
    const origin = reason ? null : new URL(entry).origin;
    if (!reason && new URL(origin).protocol !== primary.protocol) reason = 'scheme_mismatch';
    if (!reason && origin.startsWith('http:') && !dev) reason = 'http_outside_local_development';
    if (!reason) { if (origin !== primary.origin && !admitted.includes(origin)) admitted.push(origin); return; }
    const key = `${index}|${reason}|${entry}`;
    if (!warnedLegacy.has(key)) { warnedLegacy.add(key); console.warn(JSON.stringify({event: 'configuration_warning', key: 'LEGACY_APP_ORIGINS', index, reason, action: 'entry_skipped'})); }
  });
  return admitted;
}
/**
 * The configuration for one request. A request to a legacy host is served as that host: its own origin for the host check, CSRF,
 * the OAuth redirect_uri and launch links, so a player on the old address never gets bounced across hosts (cookies are host-only).
 */
export function forRequest(config, request) {
  const origin = new URL(request.url).origin;
  return config.legacyOrigins.includes(origin) ? {...config, origin} : config;
}
/** Wall clock. `env.CLOCK` lets tests drive the match clock deterministically; the Worker never sets it. */
export const now = env => env.CLOCK ? env.CLOCK() : Date.now();
/**
 * Runtime configuration from the Worker `env` (vars + secrets). Nothing here reads process state, so the same function runs on Cloudflare
 * and in the local Node shim. `DEV_LOCAL` marks local development: it relaxes the secrets that are mandatory in production.
 */
export function loadConfig(env = {}) {
  const dev = Boolean(env.DEV_LOCAL) && env.DEV_LOCAL !== '0';
  const origin = env.APP_ORIGIN || (dev ? 'http://localhost:3000' : '');
  if (!origin) throw new Error('APP_ORIGIN is required');
  if (originProblem(origin)) throw new Error('APP_ORIGIN must be a bare HTTP(S) origin');
  const parsed = new URL(origin);
  const production = parsed.protocol === 'https:' && !dev;
  if (!dev && parsed.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN');
  const salt = env.RATE_LIMIT_SALT || (dev ? 'local-development-only' : '');
  if (!salt) throw new Error('RATE_LIMIT_SALT is required outside local development');
  return {
    dev, production, origin: parsed.origin,
    // Pre-rename hosts (minesweeper.jevplay.games) this deployment still answers on until the 301 cutover. Comma-separated.
    legacyOrigins: legacyOrigins(env.LEGACY_APP_ORIGINS, parsed, dev), rateLimitSalt: salt,
    jevKey: env.TYPESAFE_API_KEY || '', model: env.JEV_MODEL || MODEL, jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
    discordClientId: env.DISCORD_CLIENT_ID || '', discordClientSecret: env.DISCORD_CLIENT_SECRET || '', discordPublicKey: env.DISCORD_PUBLIC_KEY || '',
    adminToken: env.ANALYTICS_ADMIN_TOKEN || '', pricePerMillion: env.JEV_INPUT_PRICE_PER_MILLION ? number(env, 'JEV_INPUT_PRICE_PER_MILLION', null, 0) : null,
    maxActiveMatches: number(env, 'MAX_ACTIVE_MATCHES', 8, 1, 64), providerTimeoutMs: number(env, 'JEV_TIMEOUT_MS', 3000, 100, 10000),
    lateToleranceMs: 100, maxActions: 2000, sessionAbsoluteMs: 86400000, sessionIdleMs: 3600000, launchLifetimeMs: 600000, contextLifetimeMs: 1800000,
    // Owner contact is recorded at most every contactThrottleMs, so the effective abandonment window is disconnectGraceMs +/- that.
    disconnectGraceMs: 30000, contactThrottleMs: 5000, readyLifetimeMs: 120000,
    retentionDays: number(env, 'RETENTION_DAYS', 30, 1, 3650), eventRetentionDays: number(env, 'EVENT_RETENTION_DAYS', 30, 1, 3650),
    maxCallsPerMatch: number(env, 'MAX_JEV_CALLS_PER_MATCH', 250, 1, 1000),
    // Daily ceilings that keep a free Cloudflare/TypeSafe allowance from being exhausted by one client.
    maxJevCallsPerDay: number(env, 'MAX_JEV_CALLS_PER_DAY', 5000, 0, 1000000), maxMatchesPerDay: number(env, 'MAX_MATCHES_PER_DAY', 300, 1, 1000000),
    requestsPerMinute: number(env, 'API_REQUESTS_PER_MINUTE', 3000, 1, 10000000),
    matchesPerHour: number(env, 'MATCHES_PER_HOUR', 30, 1, 100000), sessionsPer10Min: number(env, 'SESSIONS_PER_10_MIN', 60, 1, 100000),
    // How many opponent decisions may be computed ahead of the one-move-per-second schedule (absorbs poll jitter).
    pipelineDepth: number(env, 'JEV_PIPELINE_DEPTH', 3, 1, 6)
  };
}
export function gameConfig(config, preset = 'beginner', difficulty = 'normal') {
  if (!Object.hasOwn(PRESETS, preset) || !['easy', 'normal', 'hard', 'jev'].includes(difficulty)) throw Object.assign(new Error('Invalid game options'), {status: 422, code: 'invalid_options'});
  return {...PRESETS[preset], preset, aiDifficulty: difficulty, model: config.model, policyVersion: POLICY_VERSION, engineVersion: ENGINE_VERSION, adjudicationMs: 100, deadlineMs: 900000, jevIntervalMs: 1000, lateToleranceMs: config.lateToleranceMs};
}
export function competitionKey(config) { return [ENGINE_VERSION, POLICY_VERSION, config.model, config.preset, config.aiDifficulty, config.jevIntervalMs, config.lateToleranceMs].join('|'); }
