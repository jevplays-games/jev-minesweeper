import {resolve} from 'node:path';
import {PRESETS, ENGINE_VERSION} from '../shared/engine.js';
import {POLICY_VERSION} from '../shared/solver.js';
import {MODEL} from '../shared/decisions.js';
function number(env, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`); return n;
}
export function loadConfig(env = process.env) {
  const port = number(env, 'PORT', 3000, 0, 65535), origin = env.APP_ORIGIN || `http://localhost:${port}`;
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username) throw new Error('APP_ORIGIN must be a bare HTTP(S) origin');
  const production = env.NODE_ENV === 'production';
  if (production && parsed.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN');
  return {trustProxy: env.TRUST_PROXY === '1', host: env.HOST || '127.0.0.1', port, origin: parsed.origin, production, database: resolve(env.DATABASE_PATH || 'data/minesweeper.sqlite'), jevKey: env.TYPESAFE_API_KEY || '', model: env.JEV_MODEL || MODEL, jevEndpoint: 'https://api.typesafe.ai/v1/systemone', discordClientId: env.DISCORD_CLIENT_ID || '', discordClientSecret: env.DISCORD_CLIENT_SECRET || '', discordPublicKey: env.DISCORD_PUBLIC_KEY || '', adminToken: env.ANALYTICS_ADMIN_TOKEN || '', pricePerMillion: env.JEV_INPUT_PRICE_PER_MILLION ? number(env, 'JEV_INPUT_PRICE_PER_MILLION', null, 0) : null, maxActiveMatches: number(env, 'MAX_ACTIVE_MATCHES', 8, 1, 64), providerTimeoutMs: number(env, 'JEV_TIMEOUT_MS', 3000, 100, 10000), lateToleranceMs: 100, maxActions: 2000, sessionAbsoluteMs: 86400000, sessionIdleMs: 3600000, launchLifetimeMs: 600000, contextLifetimeMs: 1800000, disconnectGraceMs: 30000, readyLifetimeMs: 120000, retentionDays: number(env, 'RETENTION_DAYS', 30, 1, 3650), maxCallsPerMatch: number(env, 'MAX_JEV_CALLS_PER_MATCH', 250, 1, 1000), disableScheduler: false};
}
export function gameConfig(config, preset = 'beginner', difficulty = 'normal') {
  if (!Object.hasOwn(PRESETS, preset) || !['easy', 'normal', 'hard', 'jev'].includes(difficulty)) throw Object.assign(new Error('Invalid game options'), {status: 422, code: 'invalid_options'});
  return {...PRESETS[preset], preset, aiDifficulty: difficulty, model: config.model, policyVersion: POLICY_VERSION, engineVersion: ENGINE_VERSION, adjudicationMs: 100, deadlineMs: 900000, jevIntervalMs: 1000, lateToleranceMs: config.lateToleranceMs};
}
export function competitionKey(config) { return [ENGINE_VERSION, POLICY_VERSION, config.model, config.preset, config.aiDifficulty, config.jevIntervalMs, config.lateToleranceMs].join('|'); }
