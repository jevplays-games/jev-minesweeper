import {PRESETS, ENGINE_VERSION} from '../public/shared/engine.js';
import {POLICY_VERSION} from '../public/shared/solver.js';
import {MODEL} from '../public/shared/decisions.js';
function number(env, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`); return n;
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
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username) throw new Error('APP_ORIGIN must be a bare HTTP(S) origin');
  const production = parsed.protocol === 'https:' && !dev;
  if (!dev && parsed.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN');
  const salt = env.RATE_LIMIT_SALT || (dev ? 'local-development-only' : '');
  if (!salt) throw new Error('RATE_LIMIT_SALT is required outside local development');
  return {
    dev, production, origin: parsed.origin, rateLimitSalt: salt,
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
