import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {loadConfig, gameConfig, competitionKey} from './config.js';
import {Store} from './db.js';
import {Workers} from './workers.js';
import {Matches} from './matches.js';
import {getSession, ownerKey, csrf, httpError, equal, securityHeaders, allowDiscordFraming, hasBearerSession, RateLimiter, writeCookie} from './security.js';
import {discordReady, loginUrl, oauthCallback, interaction, resolveContext, authorizeScope} from './discord.js';
import {activityConfig, createActivitySession} from './activity.js';
import {aggregateMatches, csv} from '../shared/analytics.js';
import {PRESETS, RuleError} from '../shared/engine.js';
function send(res, status, body, contentType = 'application/json; charset=utf-8', filename = null) {
  if (res.writableEnded) return;
  res.statusCode = status; res.setHeader('Content-Type', contentType); res.setHeader('Cache-Control', 'no-store');
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req, maxBytes = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > maxBytes) throw httpError(413, 'request_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function jsonBody(raw, req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw httpError(415, 'json_required');
  let body; try { body = JSON.parse(raw); } catch { throw httpError(400, 'invalid_json'); }
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
export function leaderboard(store, config, session, query, now = Date.now()) {
  const f = filters(query), scope = query.get('scope') || 'world', context = authorizeScope(session, scope, now);
  const key = competitionKey(gameConfig(config, f.preset, f.difficulty));
  const since = f.period === 'week' ? weekStart(now) : 0;
  const cursor = query.get('cursor') || '0'; if (!/^\d{1,6}$/.test(cursor)) throw httpError(422, 'invalid_cursor');
  let where = "m.eligible=1 AND m.verification='verified' AND m.phase='complete' AND m.competition_key=? AND m.finished_at>=?";
  const args = [key, since];
  if (scope !== 'world') { where += ' AND m.guild_id=?'; args.push(context.guildId); }
  if (scope === 'channel') { where += ' AND m.channel_id=?'; args.push(context.channelId); }
  const all = store.all(`SELECT m.id,m.user_id,m.outcome,m.human_clear_ms,m.finished_at,m.eligible,m.verification,u.display_name FROM matches m JOIN users u ON u.discord_id=m.user_id WHERE ${where} ORDER BY m.finished_at,m.id`, ...args);
  const byUser = new Map(); for (const r of all) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
  const entries = [...byUser].map(([id, rows]) => ({userId: id, displayName: rows[0].display_name, ...aggregateMatches(rows)}));
  entries.sort((a,b) => Number(b.completed >= 20) - Number(a.completed >= 20) || b.clearWinRate - a.clearWinRate || b.completed - a.completed || (a.clearTimeMs.min ?? Infinity) - (b.clearTimeMs.min ?? Infinity) || a.userId.localeCompare(b.userId));
  let rank = 0; for (const e of entries) { e.provisional = e.completed < 20; e.rank = e.provisional ? null : ++rank; }
  const offset = Number(cursor), page = entries.slice(offset, offset + 50);
  return {scope, ...f, competitionKey: key, qualificationMatches: 20, weeklyBoundary: 'Monday 00:00 UTC', entries: page, totalPlayers: entries.length, nextCursor: offset + 50 < entries.length ? String(offset + 50) : null};
}
export async function createApp({config = loadConfig(), store = null, workers = null, chooser, fetchImpl = fetch} = {}) {
  store ??= new Store(config.database); workers ??= new Workers(2);
  const manager = new Matches(store, config, workers, {chooser}); await manager.recover();
  const limiter = new RateLimiter(), root = new URL('../', import.meta.url);
  const assets = new Map([['/', ['public/index.html','text/html; charset=utf-8']], ['/index.html',['public/index.html','text/html; charset=utf-8']], ['/game.css',['public/game.css','text/css; charset=utf-8']], ['/game.js',['public/game.js','text/javascript; charset=utf-8']], ['/api.js',['public/api.js','text/javascript; charset=utf-8']], ['/offline.js',['public/offline.js','text/javascript; charset=utf-8']], ['/activity.js',['public/activity.js','text/javascript; charset=utf-8']], ['/vendor/discord-embedded-app-sdk.js',['public/vendor/discord-embedded-app-sdk.js','text/javascript; charset=utf-8']], ['/brand/icon.svg',['public/brand/icon.svg','image/svg+xml']], ['/brand/mark.svg',['public/brand/mark.svg','image/svg+xml']], ['/brand/brand.css',['public/brand/brand.css','text/css; charset=utf-8']], ['/brand/brand.js',['public/brand/brand.js','text/javascript; charset=utf-8']], ['/brand/inter-var.woff2',['public/brand/inter-var.woff2','font/woff2']], ['/brand/OFL.txt',['public/brand/OFL.txt','text/plain; charset=utf-8']]]);
  for (const name of ['engine','solver','decisions','replay','analytics']) assets.set(`/shared/${name}.js`, [`shared/${name}.js`, 'text/javascript; charset=utf-8']);
  const server = createServer(async (req, res) => {
    securityHeaders(res, config); const began = performance.now(); let session = null, matchId = null, route = '', ownedMatch = false;
    try {
      const url = new URL(req.url, config.origin); route = url.pathname;
      if (route.length > 256) throw httpError(414, 'path_too_long');
      const remote = req.socket.remoteAddress || 'unknown';
      const forwarded = config.trustProxy && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote) ? req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
      const ip = forwarded || remote;
      if (!limiter.take(`ip:${ip}`, 3000, 60000)) throw httpError(429, 'rate_limit');
      if (req.method === 'GET' && route === '/api/health') return send(res, 200, {ok: true, version: '1.0.0'});
      if (req.method === 'GET' && assets.has(route)) {
        const [path, type] = assets.get(route);
        if (type.startsWith('text/html') && url.searchParams.has('frame_id')) allowDiscordFraming(res);
        return send(res, 200, await readFile(new URL(path, root)), type);
      }
      if (!route.startsWith('/api/')) throw httpError(404, 'not_found');
      if (req.method === 'POST' && route === '/api/discord/interactions') {
        const raw = await readBody(req, 65536); return send(res, 200, interaction({raw, headers: req.headers, store, config}));
      }
      if (route === '/api/admin/analytics' && req.method === 'GET') {
        if (!config.adminToken || !equal(req.headers.authorization || '', `Bearer ${config.adminToken}`)) throw httpError(403, 'admin_access_denied');
        const since = Date.now() - 86400000;
        return send(res, 200, {window: 'last 24 hours for audit metrics; all retained matches for result metrics', activeMatches: manager.active.size, workerQueue: workers.queue.length, results: store.all('SELECT outcome,verification,eligible,count(*) AS count FROM matches GROUP BY outcome,verification,eligible'), auditTypes24h: store.all('SELECT type,count(*) AS count FROM audit_events WHERE at>=? GROUP BY type', since), rejections24h: store.all("SELECT json_extract(data_json,'$.code') AS reason,count(*) AS count FROM audit_events WHERE type='action_rejected' AND at>=? GROUP BY reason", since), decisions: store.all("SELECT json_extract(event_json,'$.decision.source') AS source,count(*) AS count,avg(json_extract(event_json,'$.decision.latencyMs')) AS mean_latency_ms FROM match_events WHERE json_extract(event_json,'$.actor')='jev' GROUP BY source"), measuredUsage: store.get("SELECT coalesce(sum(json_extract(event_json,'$.decision.response.usage.input_tokens')),0) AS successful_input_tokens,coalesce(sum(json_extract(event_json,'$.decision.response.usage.output_tokens')),0) AS successful_output_tokens FROM match_events"), privacy: 'No names, IP addresses, OAuth codes, session secrets, or active layouts included.'});
      }
      if (req.method === 'GET' && route === '/api/activity/config') return send(res, 200, activityConfig(config));
      if (req.method === 'POST' && route === '/api/activity/session') {
        if (!limiter.take(`activity-session:${ip}`, 60, 600000)) throw httpError(429, 'session_creation_rate_limit');
        const body = jsonBody(await readBody(req), req); keysOnly(body, ['code']);
        return send(res, 200, await createActivitySession({store, config, origin: req.headers.origin, code: body.code, fetchImpl}));
      }
      const create = route === '/api/me' || route === '/api/auth/discord';
      if (create && !req.headers.cookie && !hasBearerSession(req, store) && !limiter.take(`sessions:${ip}`, 60, 600000)) throw httpError(429, 'session_creation_rate_limit');
      session = getSession(req, res, store, config, {create});
      if (req.method === 'GET' && route === '/api/me') {
        const user = session.user_id ? store.get('SELECT discord_id AS id,display_name AS displayName,avatar_hash AS avatar FROM users WHERE discord_id=?', session.user_id) : null;
        const active = store.get("SELECT id FROM matches WHERE owner_key=? AND phase IN ('ready','running')", ownerKey(session));
        return send(res, 200, {user, csrfToken: session.csrf_token, activeMatchId: active?.id ?? null, context: session.data.context?.expiresAt > Date.now() ? session.data.context : null, features: {discord: discordReady(config), jev: Boolean(config.jevKey), model: config.model}, presets: PRESETS});
      }
      if (req.method === 'GET' && route === '/api/auth/discord') {
        res.statusCode = 302; res.setHeader('Cache-Control','no-store'); res.setHeader('Location', loginUrl(store, config, session)); return res.end();
      }
      if (req.method === 'GET' && route === '/api/auth/discord/callback') {
        await oauthCallback({store, config, session, params: url.searchParams, res, fetchImpl}); res.statusCode = 302; res.setHeader('Location', config.origin); res.setHeader('Cache-Control','no-store'); return res.end();
      }
      if (req.method === 'GET' && route === '/api/leaderboard') return send(res, 200, leaderboard(store, config, session, url.searchParams));
      if (!session) throw httpError(401, 'session_required');
      const owner = ownerKey(session);
      if (req.method === 'POST') csrf(req, session, config);
      if (req.method === 'POST' && route === '/api/logout') { store.run('DELETE FROM sessions WHERE token_hash=?', session.token_hash); writeCookie(res, config, '', 0); return send(res, 200, {ok: true}); }
      if (req.method === 'GET' && route === '/api/analytics/profile') {
        const f = filters(url.searchParams), clauses = ['owner_key=?','board_preset=?','ai_difficulty=?',"phase='complete'"], args = [owner,f.preset,f.difficulty];
        if (f.period === 'week') { clauses.push('finished_at>=?'); args.push(weekStart()); }
        if (f.mode === 'ranked') clauses.push("eligible=1 AND verification='verified'");
        if (f.mode === 'practice') clauses.push('eligible=0');
        const rows = store.all(`SELECT ${HISTORY_COLUMNS} FROM matches WHERE ${clauses.join(' AND ')} ORDER BY finished_at DESC,id DESC`, ...args);
        const cursor = url.searchParams.get('cursor') || '0'; if (!/^\d{1,6}$/.test(cursor)) throw httpError(422,'invalid_cursor');
        const offset = Number(cursor);
        return send(res, 200, {filters: f, summary: aggregateMatches(rows), total: rows.length, matches: rows.slice(offset, offset+50).map(publicRow), nextCursor: offset+50<rows.length ? String(offset+50) : null, comparisonWarning: 'Summary uses the selected filters. Mixed versions are descriptive only; official leaderboards use an exact competition key.'});
      }
      if (req.method === 'GET' && route === '/api/exports/history.csv') {
        const rows = store.all(`SELECT ${HISTORY_COLUMNS} FROM matches WHERE owner_key=? ORDER BY created_at`, owner).map(publicRow);
        return send(res,200,csv(rows),'text/csv; charset=utf-8','minesweeper-history.csv');
      }
      if (req.method === 'GET' && route === '/api/exports/me.json') {
        const rows = store.all(`SELECT ${HISTORY_COLUMNS} FROM matches WHERE owner_key=? ORDER BY created_at`, owner).map(publicRow);
        const user = session.user_id ? store.get('SELECT discord_id,display_name,avatar_hash,created_at,last_seen_at FROM users WHERE discord_id=?',session.user_id) : null;
        return send(res,200,{exportVersion:1,user,matches:rows,summary:aggregateMatches(rows),note:'Full sealed replays and detailed per-match analytics have separate owner-only export endpoints. Active layouts and session secrets are never exported.'},'application/json; charset=utf-8','minesweeper-profile.json');
      }
      if (req.method === 'POST' && route === '/api/matches') {
        if (!limiter.take(`create:${owner}`,30,3600000)) throw httpError(429,'match_creation_rate_limit');
        const body = jsonBody(await readBody(req),req); keysOnly(body,['requestId','boardPreset','aiDifficulty','mode','context','launchTicket']); requestId(body.requestId);
        if (!['practice','ranked'].includes(body.mode) || !['world','current'].includes(body.context || 'world')) throw httpError(422,'invalid_mode_or_context');
        gameConfig(config,body.boardPreset,body.aiDifficulty);
        // Idempotent creation is resolved before trying to redeem its already-consumed ticket.
        const existing = store.get('SELECT id FROM matches WHERE owner_key=? AND creation_request_id=?',owner,body.requestId);
        const context = existing ? null : resolveContext(store,session,body,config);
        const snapshot = await manager.create(session,body,context); return send(res,201,snapshot);
      }
      const match = route.match(/^\/api\/matches\/([a-f0-9-]{36})(?:\/(actions|events|replay|analytics|export))?$/);
      if (!match) throw httpError(404,'not_found');
      matchId = match[1]; const operation = match[2] || 'snapshot';
      const m = manager.load(matchId,owner); ownedMatch = true;
      if (req.method === 'GET' && operation === 'snapshot') { m.lastSeen = Date.now(); return send(res,200,manager.view(m)); }
      if (req.method === 'GET' && operation === 'events') {
        res.statusCode=200; res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-store'); res.setHeader('X-Accel-Buffering','no'); res.setHeader('Connection','keep-alive');
        let unsubscribe;
        try { unsubscribe = manager.subscribe(matchId,owner,snapshot => { if (!res.writableEnded) res.write(`id: ${snapshot.seq}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`); }); } catch(e) { throw e; }
        const heartbeat = setInterval(() => {
          const valid = store.get('SELECT expires_at FROM sessions WHERE token_hash=?',session.token_hash);
          if (!valid || valid.expires_at <= Date.now()) { res.write('event: auth-expired\ndata: {}\n\n'); res.end(); return; }
          store.run('UPDATE sessions SET last_seen_at=? WHERE token_hash=?',Date.now(),session.token_hash);
          if (!res.writableEnded) res.write(': heartbeat\n\n');
        },15000);
        req.on('close',()=>{clearInterval(heartbeat);unsubscribe();}); return;
      }
      if (req.method === 'POST' && operation === 'actions') {
        if (!limiter.take(`actions:${owner}`,120,10000)) throw httpError(429,'action_rate_limit');
        const body = jsonBody(await readBody(req),req); validateActionBody(body);
        return send(res,200,await manager.action(matchId,owner,body));
      }
      if (req.method === 'GET' && operation === 'replay') {
        if (m.state.phase !== 'complete') throw httpError(409,'replay_available_after_match');
        return send(res,200,manager.replayFor(m),'application/json; charset=utf-8',`minesweeper-${matchId}-replay.json`);
      }
      if (req.method === 'GET' && operation === 'analytics') {
        if (!limiter.take(`analytics:${owner}`,12,60000)) throw httpError(429,'analytics_rate_limit');
        return send(res,200,await manager.analytics(matchId,owner));
      }
      if (req.method === 'GET' && operation === 'export') {
        const format = url.searchParams.get('format') || 'json';
        if (!['json','csv','timeline','jsonl'].includes(format)) throw httpError(422,'invalid_export_format');
        if (format === 'jsonl') {
          if (m.state.phase !== 'complete') throw httpError(409,'export_available_after_match');
          return send(res,200,m.events.map(e=>JSON.stringify(e)).join('\n')+'\n','application/x-ndjson; charset=utf-8',`minesweeper-${matchId}-events.jsonl`);
        }
        const analysis = await manager.analytics(matchId,owner);
        return send(res,200,format==='json'?analysis:csv(format==='csv'?analysis.actions:analysis.timeline),format==='json'?'application/json; charset=utf-8':'text/csv; charset=utf-8',`minesweeper-${matchId}-${format==='json'?'analytics.json':format==='csv'?'actions.csv':'timeline.csv'}`);
      }
      throw httpError(405,'method_not_allowed');
    } catch(e) {
      const status = e.status || (e instanceof RuleError ? 422 : 500), code = e.code || (status===500?'internal_error':'request_failed');
      if (ownedMatch && matchId && session && route.endsWith('/actions')) store.audit('action_rejected',{matchId,owner:ownerKey(session),data:{code,status}});
      if (status>=500) console.error(JSON.stringify({event:'request_error',code,path:route.replace(/[a-f0-9-]{36}/g,':id')}));
      if (res.headersSent) { res.end(); return; }
      if (status===429) res.setHeader('Retry-After','10');
      send(res,status,{error:{code,message:status===500?'An internal error occurred. Your server-held game has not been replaced.':e.message}});
    } finally {
      if (ownedMatch && matchId && session && !route.endsWith('/events')) store.audit('api_request',{matchId,owner:ownerKey(session),data:{method:req.method,operation:route.split('/').at(-1),status:res.statusCode,latencyMs:performance.now()-began}});
    }
  });
  server.requestTimeout=30000; server.headersTimeout=15000; server.keepAliveTimeout=5000;
  const cleanup = setInterval(()=>store.prune(Date.now(),config.retentionDays),3600000); cleanup.unref();
  let closing=false;
  return {server,store,workers,manager,config,
    async listen() { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);}); if(config.port===0){config.port=server.address().port;config.origin=`http://${config.host}:${config.port}`;} return config.origin; },
    async close() { if(closing)return; closing=true;clearInterval(cleanup); await manager.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await workers.close(); store.close(); }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp(); const address = await app.listen();
  console.log(JSON.stringify({event:'server_started',origin:address,opponent:app.config.jevKey?'JEV':'local heuristic (not JEV)',discordConfigured:discordReady(app.config)}));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await app.close();process.exit(0);});
}
