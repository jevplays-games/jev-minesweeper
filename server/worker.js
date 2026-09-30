/**
 * Cloudflare Worker entry: one `handle(request, env, ctx)` written against Web APIs only. The same function runs in production (wrangler),
 * in the local Node shim (server/main.js, with `env.DB` backed by node:sqlite through server/local-db.js) and directly in the tests.
 *   env.DB      D1 database            env.ASSETS  static assets (public/)
 *   env.FETCH   optional fetch override (tests)   env.CLOCK  optional clock override (tests)
 */
import {loadConfig, gameConfig, competitionKey, now as clock} from './config.js';
import {Store} from './db.js';
import {getSession, ownerKey, csrf, httpError, equal, securityHeaders, allowDiscordFraming, hasBearerSession, RateLimiter, sessionCookie, hash} from './security.js';
import {discordReady, loginUrl, oauthCallback, interaction, resolveContext, authorizeScope} from './discord.js';
import {activityConfig, createActivitySession} from './activity.js';
import {create, snapshot, action, loadOwned, replayPage, eventsPage, operations, maintenance} from './matches.js';
import {aggregateMatches, csv} from '../public/shared/analytics.js';
import {PRESETS, RuleError} from '../public/shared/engine.js';
const limiter = new RateLimiter();
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers}});
const file = (status, body, type, filename) => new Response(body, {status, headers: {'Content-Type': type, 'Cache-Control': 'no-store', ...(filename ? {'Content-Disposition': `attachment; filename="${filename}"`} : {})}});
async function readBody(request, maxBytes = 16384) {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) throw httpError(413, 'request_too_large');
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array(0);
  const chunks = []; let length = 0;
  for (;;) { const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > maxBytes) { await reader.cancel(); throw httpError(413, 'request_too_large'); } chunks.push(value); }
  const all = new Uint8Array(length); let offset = 0; for (const c of chunks) { all.set(c, offset); offset += c.length; } return all;
}
function jsonBody(raw, request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw httpError(415, 'json_required');
  let body; try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw httpError(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(422, 'object_required'); return body;
}
function keysOnly(body, allowed) { if (Object.keys(body).some(k => !allowed.includes(k))) throw httpError(422, 'unexpected_field'); }
function requestId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw httpError(422, 'invalid_request_id'); }
function validateActionBody(body) {
  keysOnly(body, ['requestId','expectedBoardRevision','action']); requestId(body.requestId);
  const action = body.action;
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw httpError(422, 'invalid_action');
  if (!['start','reveal','setFlag','chord','resign'].includes(action.type)) throw httpError(422, 'invalid_action_type');
  keysOnly(action, action.type === 'setFlag' ? ['type','cell','value'] : action.type === 'resign' ? ['type'] : ['type','cell']);
  if (action.type !== 'resign' && (!Number.isInteger(action.cell) || action.cell < 0 || action.cell >= 480)) throw httpError(422, 'invalid_cell');
  if (action.type === 'setFlag' && typeof action.value !== 'boolean') throw httpError(422, 'invalid_flag_value');
  if (!['start','resign'].includes(action.type) && (!Number.isInteger(body.expectedBoardRevision) || body.expectedBoardRevision < 0)) throw httpError(422, 'revision_required');
}
export function weekStart(now = Date.now()) { const d = new Date(now); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.getTime(); }
const HISTORY_COLUMNS = 'id,board_preset,ai_difficulty,competition_key,guild_id,channel_id,phase,ranked_requested,eligible,verification,outcome,outcome_reason,human_clear_ms,created_at,started_at,finished_at,eligibility_reasons_json';
function filters(query) {
  const preset = query.get('preset') || 'beginner', difficulty = query.get('difficulty') || 'normal', period = query.get('period') || 'all', mode = query.get('mode') || 'all';
  if (!Object.hasOwn(PRESETS, preset) || !['easy','normal','hard','jev'].includes(difficulty) || !['all','week'].includes(period) || !['all','ranked','practice'].includes(mode)) throw httpError(422, 'invalid_filter');
  return {preset, difficulty, period, mode};
}
function publicRow(r) { const {eligibility_reasons_json, ...row} = r; return {...row, eligibilityReasons: JSON.parse(eligibility_reasons_json || '[]')}; }
export async function leaderboard(store, config, session, query, now = Date.now()) {
  const f = filters(query), scope = query.get('scope') || 'world', context = authorizeScope(session, scope, now);
  const key = competitionKey(gameConfig(config, f.preset, f.difficulty));
  const since = f.period === 'week' ? weekStart(now) : 0;
  const cursor = query.get('cursor') || '0'; if (!/^\d{1,6}$/.test(cursor)) throw httpError(422, 'invalid_cursor');
  let where = "m.eligible=1 AND m.verification='verified' AND m.phase='complete' AND m.competition_key=? AND m.finished_at>=?";
  const args = [key, since];
  if (scope !== 'world') { where += ' AND m.guild_id=?'; args.push(context.guildId); }
  if (scope === 'channel') { where += ' AND m.channel_id=?'; args.push(context.channelId); }
  // Ranking is computed in SQL (one row per player), so a large history costs the Worker almost no CPU; only the players on the returned
  // page have their result rows fetched, to derive streaks and the other per-player aggregates exactly as before.
  const offset = Number(cursor), base = `FROM matches m JOIN users u ON u.discord_id=m.user_id WHERE ${where} AND m.outcome IS NOT NULL AND m.outcome!='void'`;
  const total = (await store.get(`SELECT count(DISTINCT m.user_id) AS n ${base}`, ...args)).n;
  const page = await store.all(`SELECT m.user_id AS userId,u.display_name AS displayName ${base} GROUP BY m.user_id
    ORDER BY (count(*)>=20) DESC, (sum(m.outcome='win')*1.0/count(*)) DESC, count(*) DESC, coalesce(min(m.human_clear_ms),9e18), m.user_id LIMIT 50 OFFSET ?`, ...args, offset);
  const rows = page.length ? await store.all(`SELECT m.id,m.user_id,m.outcome,m.human_clear_ms,m.finished_at,m.eligible,m.verification FROM matches m WHERE ${where} AND m.user_id IN (${page.map(() => '?').join(',')}) ORDER BY m.finished_at,m.id LIMIT 4000`, ...args, ...page.map(p => p.userId)) : [];
  const byUser = new Map(); for (const r of rows) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
  let rank = offset; // qualified players sort first, so their rank is simply their position
  const entries = page.map(p => { const e = {userId: p.userId, displayName: p.displayName, ...aggregateMatches(byUser.get(p.userId) ?? [])}; e.provisional = e.completed < 20; e.rank = e.provisional ? null : ++rank; return e; });
  return {scope, ...f, competitionKey: key, qualificationMatches: 20, weeklyBoundary: 'Monday 00:00 UTC', entries, totalPlayers: total, nextCursor: offset + 50 < total ? String(offset + 50) : null};
}
async function adminAnalytics(app) {
  const {store} = app, since = app.now() - 86400000;
  return {window: 'last 24 hours for audit metrics; all retained matches for result metrics',
    activeMatches: (await store.get("SELECT count(*) AS n FROM matches WHERE phase IN ('ready','running')")).n,
    pendingVerification: (await store.get("SELECT count(*) AS n FROM matches WHERE phase='complete' AND verification='pending'")).n,
    results: await store.all('SELECT outcome,verification,eligible,count(*) AS count FROM matches GROUP BY outcome,verification,eligible'),
    auditTypes24h: await store.all('SELECT type,count(*) AS count FROM audit_events WHERE at>=? GROUP BY type', since),
    rejections24h: await store.all("SELECT json_extract(data_json,'$.code') AS reason,count(*) AS count FROM audit_events WHERE type='action_rejected' AND at>=? GROUP BY reason", since),
    decisions: await store.all("SELECT json_extract(event_json,'$.decision.source') AS source,count(*) AS count,avg(json_extract(event_json,'$.decision.latencyMs')) AS mean_latency_ms FROM match_events WHERE json_extract(event_json,'$.actor')='jev' GROUP BY source"),
    measuredUsage: await store.get("SELECT coalesce(sum(json_extract(event_json,'$.decision.response.usage.input_tokens')),0) AS successful_input_tokens,coalesce(sum(json_extract(event_json,'$.decision.response.usage.output_tokens')),0) AS successful_output_tokens FROM match_events"),
    privacy: 'No names, IP addresses, OAuth codes, session secrets, or active layouts included.'};
}
async function route(app, request, url, out) {
  const {store, config} = app, route = url.pathname, method = request.method;
  if (route.length > 256) throw httpError(414, 'path_too_long');
  const ip = request.headers.get('cf-connecting-ip') || (config.dev ? request.headers.get('x-local-address') : null) || 'unknown';
  if (!limiter.take(`ip:${ip}`, config.requestsPerMinute, 60000, app.now())) throw httpError(429, 'rate_limit');
  if (!route.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(method)) throw httpError(405, 'method_not_allowed');
    const response = await app.env.ASSETS.fetch(request);
    out.document = response.headers.get('content-type')?.startsWith('text/html') ?? false;
    return response;
  }
  if (url.origin !== config.origin) throw httpError(400, 'host_rejected');
  const quotaBucket = async name => hash(`${config.rateLimitSalt}|${name}|${ip}|${Math.floor(app.now() / 600000)}`);
  if (method === 'GET' && route === '/api/health') { app.waitUntil(maintenance(app).catch(() => {})); return json(200, {ok: true, version: '1.0.0'}); }
  if (method === 'POST' && route === '/api/discord/interactions') {
    if (!config.discordPublicKey) throw httpError(503, 'discord_not_configured');
    return json(200, await interaction({raw: await readBody(request, 65536), headers: request.headers, store, config, now: app.now()}));
  }
  if (route === '/api/admin/analytics' && method === 'GET') {
    if (!config.adminToken || !equal(request.headers.get('authorization') || '', `Bearer ${config.adminToken}`)) throw httpError(403, 'admin_access_denied');
    return json(200, await adminAnalytics(app));
  }
  if (method === 'GET' && route === '/api/activity/config') return json(200, activityConfig(config));
  if (method === 'POST' && route === '/api/activity/session') {
    if (await store.consume(await quotaBucket('activity'), 'activity_sessions', config.sessionsPer10Min, app.now() + 1200000) === null) throw httpError(429, 'session_creation_rate_limit');
    const body = jsonBody(await readBody(request), request); keysOnly(body, ['code']);
    return json(200, await createActivitySession({store, config, origin: request.headers.get('origin'), code: body.code, fetchImpl: app.fetch, now: app.now()}));
  }
  const creating = route === '/api/me' || route === '/api/auth/discord';
  if (creating && !request.headers.get('cookie') && !await hasBearerSession(request, store) && await store.consume(await quotaBucket('sessions'), 'sessions', config.sessionsPer10Min, app.now() + 1200000) === null) throw httpError(429, 'session_creation_rate_limit');
  const session = await getSession(request, store, config, {create: creating, now: app.now()});
  if (session?.setCookie) out.cookies.push(session.setCookie);
  if (method === 'GET' && route === '/api/me') {
    app.waitUntil(maintenance(app).catch(() => {}));
    const user = session.user_id ? await store.get('SELECT discord_id AS id,display_name AS displayName,avatar_hash AS avatar FROM users WHERE discord_id=?', session.user_id) : null;
    const active = await store.get("SELECT id FROM matches WHERE owner_key=? AND phase IN ('ready','running')", ownerKey(session));
    return json(200, {user, csrfToken: session.csrf_token, activeMatchId: active?.id ?? null, context: session.data.context?.expiresAt > app.now() ? session.data.context : null, features: {discord: discordReady(config), jev: Boolean(config.jevKey), model: config.model}, presets: PRESETS});
  }
  if (method === 'GET' && route === '/api/auth/discord') return new Response(null, {status: 302, headers: {'Cache-Control': 'no-store', Location: await loginUrl(store, config, session, app.now())}});
  if (method === 'GET' && route === '/api/auth/discord/callback') {
    const done = await oauthCallback({store, config, session, params: url.searchParams, fetchImpl: app.fetch, now: app.now()});
    out.cookies.push(done.setCookie); return new Response(null, {status: 302, headers: {'Cache-Control': 'no-store', Location: config.origin}});
  }
  if (method === 'GET' && route === '/api/leaderboard') { app.waitUntil(maintenance(app).catch(() => {})); return json(200, await leaderboard(store, config, session, url.searchParams, app.now())); }
  if (!session) throw httpError(401, 'session_required');
  const owner = ownerKey(session);
  if (method === 'POST') csrf(request, session, config);
  if (method === 'POST' && route === '/api/logout') { await store.run('DELETE FROM sessions WHERE token_hash=?', session.token_hash); out.cookies.push(sessionCookie(config, '', 0)); return json(200, {ok: true}); }
  if (method === 'GET' && route === '/api/analytics/profile') {
    const f = filters(url.searchParams), clauses = ['owner_key=?','board_preset=?','ai_difficulty=?',"phase='complete'"], args = [owner,f.preset,f.difficulty];
    if (f.period === 'week') { clauses.push('finished_at>=?'); args.push(weekStart(app.now())); }
    if (f.mode === 'ranked') clauses.push("eligible=1 AND verification='verified'");
    if (f.mode === 'practice') clauses.push('eligible=0');
    const rows = await store.all(`SELECT ${HISTORY_COLUMNS} FROM matches WHERE ${clauses.join(' AND ')} ORDER BY finished_at DESC,id DESC`, ...args);
    const cursor = url.searchParams.get('cursor') || '0'; if (!/^\d{1,6}$/.test(cursor)) throw httpError(422, 'invalid_cursor');
    const offset = Number(cursor);
    return json(200, {filters: f, summary: aggregateMatches(rows), total: rows.length, matches: rows.slice(offset, offset+50).map(publicRow), nextCursor: offset+50<rows.length ? String(offset+50) : null, comparisonWarning: 'Summary uses the selected filters. Mixed versions are descriptive only; official leaderboards use an exact competition key.'});
  }
  if (method === 'GET' && route === '/api/exports/history.csv') {
    const rows = (await store.all(`SELECT ${HISTORY_COLUMNS} FROM matches WHERE owner_key=? ORDER BY created_at`, owner)).map(publicRow);
    return file(200, csv(rows), 'text/csv; charset=utf-8', 'minesweeper-history.csv');
  }
  if (method === 'GET' && route === '/api/exports/me.json') {
    const rows = (await store.all(`SELECT ${HISTORY_COLUMNS} FROM matches WHERE owner_key=? ORDER BY created_at`, owner)).map(publicRow);
    const user = session.user_id ? await store.get('SELECT discord_id,display_name,avatar_hash,created_at,last_seen_at FROM users WHERE discord_id=?', session.user_id) : null;
    return file(200, JSON.stringify({exportVersion: 1, user, matches: rows, summary: aggregateMatches(rows), note: 'Full sealed replays and detailed per-match analytics have separate owner-only export endpoints. Active layouts and session secrets are never exported.'}), 'application/json; charset=utf-8', 'minesweeper-profile.json');
  }
  if (method === 'POST' && route === '/api/matches') {
    const body = jsonBody(await readBody(request), request); keysOnly(body, ['requestId','boardPreset','aiDifficulty','mode','context','launchTicket']); requestId(body.requestId);
    if (!['practice','ranked'].includes(body.mode) || !['world','current'].includes(body.context || 'world')) throw httpError(422, 'invalid_mode_or_context');
    gameConfig(config, body.boardPreset, body.aiDifficulty);
    // Idempotent creation is resolved before trying to redeem its already-consumed ticket.
    const existing = await store.get('SELECT id FROM matches WHERE owner_key=? AND creation_request_id=?', owner, body.requestId);
    const context = existing ? null : await resolveContext(store, session, body, config, app.now());
    return json(201, await create(app, session, body, context));
  }
  const match = route.match(/^\/api\/matches\/([a-f0-9-]{36})(?:\/(actions|replay|operations|export))?$/);
  if (!match) throw httpError(404, 'not_found');
  const [, matchId, operation = 'snapshot'] = match;
  if (method === 'GET' && operation === 'snapshot') return json(200, await snapshot(app, matchId, owner));
  if (method === 'POST' && operation === 'actions') {
    if (!limiter.take(`actions:${owner}`, 120, 10000, app.now())) throw httpError(429, 'action_rate_limit');
    const body = jsonBody(await readBody(request), request), began = app.now();
    validateActionBody(body);
    let result;
    try { result = await action(app, matchId, owner, body); }
    catch (e) { if (e.code !== 'match_not_found') app.waitUntil(store.audit('action_rejected', {matchId, owner, data: {code: e.code || 'internal_error', status: e.status || 500}, at: app.now()}).catch(() => {})); throw e; }
    app.waitUntil(store.audit('api_request', {matchId, owner, data: {method, operation: 'actions', status: 200, latencyMs: app.now() - began}, at: app.now()}).catch(() => {}));
    return json(200, result);
  }
  if (method === 'GET') {
    const m = await loadOwned(app, matchId, owner);
    const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : 1;
    if (operation === 'replay') return new Response(await replayPage(app, m, from), {status: 200, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
    if (operation === 'operations') return json(200, await operations(app, m));
    if (operation === 'export') {
      const format = url.searchParams.get('format') || 'jsonl';
      if (format !== 'jsonl') throw httpError(422, 'invalid_export_format', 'Only jsonl is produced by the server; analytics JSON and CSV are derived from the replay in the browser.');
      const page = await eventsPage(app, m, from);
      return new Response(page.text, {status: 200, headers: {'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Next-Seq': page.next === null ? '' : String(page.next)}});
    }
  }
  throw httpError(405, 'method_not_allowed');
}
export async function handle(request, env, ctx) {
  let config;
  try { config = loadConfig(env); if (!env.DB) throw new Error('DB binding missing'); }
  catch (e) { console.error(JSON.stringify({event: 'configuration_error', message: e.message})); return json(503, {error: {code: 'server_configuration_required', message: 'The server is not configured.'}}); }
  const app = {env, config, store: new Store(env.DB), fetch: env.FETCH ?? ((...args) => fetch(...args)), now: () => clock(env), waitUntil: promise => { if (ctx?.waitUntil) ctx.waitUntil(promise); else promise.catch(() => {}); }};
  const out = {cookies: [], document: false}, url = new URL(request.url);
  let response;
  try { response = await route(app, request, url, out); }
  catch (e) {
    const status = e.status || (e instanceof RuleError ? 422 : 500), code = e.code || (status === 500 ? 'internal_error' : 'request_failed');
    if (status >= 500) console.error(JSON.stringify({event: 'request_error', code, message: config.dev ? e.message : undefined, path: url.pathname.replace(/[a-f0-9-]{36}/g, ':id')}));
    response = json(status, {error: {code, message: status === 500 ? 'An internal error occurred. Your server-held game has not been replaced.' : e.message}}, status === 429 ? {'Retry-After': '10'} : {});
  }
  const headers = new Headers(response.headers);
  securityHeaders(headers, config);
  if (out.document && url.searchParams.has('frame_id')) allowDiscordFraming(headers);
  for (const cookie of out.cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}
export default {fetch: handle};
