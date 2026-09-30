/**
 * CPU cost of the hot request paths against the Workers Free budget (10 ms CPU per invocation).
 *
 * Every operation runs through the same code the Worker runs (server/worker.js + server/matches.js), on real SQLite via the D1-compatible
 * wrapper. "Invocation" cost = the request plus everything it schedules with waitUntil, because Workers bills both to one invocation.
 * Caveats, stated in the report: this is Node's V8 on this machine, not workerd; local SQLite time is counted although D1 time is I/O on
 * Cloudflare (so numbers are conservative there); and a cold isolate runs unoptimised code, which `--cold` measures by starting a fresh
 * process per sample. Workers' own clocks do not advance during CPU work, so production cannot self-time; the budgets in the code are static.
 *
 *   npm run bench:cpu                       # warm matrix + cold samples, writes reports/cpu/
 *   node bench/cpu.js --matches 12 --out reports/cpu --cold 6
 */
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createApp} from '../server/main.js';
import worker from '../server/worker.js';
import {Store} from '../server/db.js';
import {loadConfig} from '../server/config.js';
import {snapshot, prepareJev, verifyStep, maintenance, VERIFY_STEP_UNITS} from '../server/matches.js';
import {validResponse} from '../tests/helpers.js';
import {distribution} from '../public/shared/analytics.js';
import {ENGINE_VERSION} from '../public/shared/engine.js';
import {POLICY_VERSION} from '../public/shared/solver.js';
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const ORIGIN = 'http://localhost:8787', BUDGET_MS = 10;
// process.cpuUsage() ticks at ~15.6 ms on Windows, far too coarse. Everything here is synchronous CPU on one thread (no network, no timers,
// SQLite in-process), so elapsed high-resolution time is the CPU time, plus any GC pause, which Workers also pays.
const cpuMs = () => performance.now();
async function harness(extra = {}) {
  let t = 1_800_000_000_000; const tasks = new Set();
  const provider = async (_url, options) => new Response(JSON.stringify(validResponse(JSON.parse(options.body))), {status: 200});
  const env = {PORT: '8787', APP_ORIGIN: ORIGIN, TYPESAFE_API_KEY: 'bench-only-not-a-real-key', FETCH: provider, MAX_ACTIVE_MATCHES: '64', API_REQUESTS_PER_MINUTE: '10000000', MATCHES_PER_HOUR: '100000', SESSIONS_PER_10_MIN: '100000', MAX_MATCHES_PER_DAY: '1000000', MAX_JEV_CALLS_PER_DAY: '1000000', ...extra};
  const app = await createApp({env}); app.env.CLOCK = () => t;
  const ctx = {waitUntil(p) { const q = Promise.resolve(p).catch(() => {}).finally(() => tasks.delete(q)); tasks.add(q); }};
  const drain = async () => { while (tasks.size) await Promise.allSettled([...tasks]); };
  /** CPU for one invocation: the request and every background task it started. */
  async function measure(fn) { const a = cpuMs(); const out = await fn(); await drain(); return {ms: cpuMs() - a, out}; }
  async function call(path, {body, raw, session, headers = {}} = {}) {
    const init = {method: body === undefined && raw === undefined ? 'GET' : 'POST', headers: {...(session ? {cookie: session.cookie} : {}), ...headers}};
    if (raw !== undefined) { init.body = raw; init.headers['content-type'] = 'application/json'; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; init.headers.origin = ORIGIN; if (session) init.headers['x-csrf-token'] = session.csrf; }
    const r = await worker.fetch(new Request(ORIGIN + path, init), app.env, ctx), text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; } return {status: r.status, data, headers: r.headers, bytes: text.length};
  }
  const core = {env: app.env, config: loadConfig(app.env), store: new Store(app.database), fetch: provider, now: () => t, waitUntil: ctx.waitUntil};
  const guest = async () => { const r = await call('/api/me'); const s = {cookie: r.headers.getSetCookie()[0].split(';')[0], csrf: r.data.csrfToken}; return s; };
  return {app, core, call, guest, measure, drain, advance: ms => { t += ms; }, get now() { return t; }, close: () => app.close()};
}
const summarize = ms => { const d = distribution(ms); return {n: d.count, p50: d.p50, p95: d.p95, p99: d.p99, max: d.max, over10: ms.filter(x => x > BUDGET_MS).length}; };
const r2 = x => x === null || x === undefined ? null : Math.round(x * 100) / 100;

async function playMatch(h, {preset, difficulty, samples, first}) {
  const g = await h.guest(), created = await h.call('/api/matches', {body: {requestId: crypto.randomUUID(), boardPreset: preset, aiDifficulty: difficulty, mode: 'practice', context: 'world'}, session: g});
  const id = created.data.id, cell = Math.floor(PRESET_H[preset] / 2) * PRESET_W[preset] + Math.floor(PRESET_W[preset] / 2);
  const start = await h.measure(() => h.call(`/api/matches/${id}/actions`, {body: {requestId: crypto.randomUUID(), action: {type: 'start', cell}}, session: g}));
  samples.start.push(start.ms); if (first) first.start = start.ms;
  let moves = 0;
  const db = h.app.database.raw, counts = () => ({events: db.prepare('SELECT event_count AS n FROM matches WHERE id=?').get(id).n, queued: db.prepare('SELECT count(*) AS n FROM jev_decisions WHERE match_id=?').get(id).n});
  // The client polls a running match every 600 ms; each poll is one invocation. Classify what each one ended up doing.
  for (let step = 0; step < 150; step++) {
    h.advance(600);
    const before = counts(), poll = await h.measure(() => h.call(`/api/matches/${id}`, {session: g})), after = counts();
    const kind = after.events > before.events ? 'pollApply' : after.queued > before.queued ? 'pollPrepare' : 'pollIdle';
    samples[kind].push(poll.ms); if (first && first[kind] === undefined) first[kind] = poll.ms;
    const view = poll.out.data; if (view.phase !== 'running' || view.boards.jev.status !== 'active') break;
    // A human command mid-game (flag a covered cell). Commands never carry background work.
    const covered = view.boards.human.cells.indexOf(-1);
    if (covered >= 0 && view.boards.human.status === 'active' && step % 4 === 0) {
      h.advance(100);
      const act = await h.measure(() => h.call(`/api/matches/${id}/actions`, {body: {requestId: crypto.randomUUID(), expectedBoardRevision: view.boards.human.revision, action: {type: 'setFlag', cell: covered, value: true}}, session: g}));
      if (act.out.status === 200) samples.action.push(act.ms);
    }
    moves++;
  }
  // Direct cost of computing one decision (solver + request build + digest + D1), measured in isolation from any request.
  const row = h.app.database.raw.prepare('SELECT * FROM matches WHERE id=?').get(id);
  await h.call(`/api/matches/${id}/actions`, {body: {requestId: crypto.randomUUID(), action: {type: 'resign'}}, session: g});
  await h.drain();
  return {id, g, row, moves};
}
const PRESET_W = {beginner: 9, intermediate: 16, expert: 30}, PRESET_H = {beginner: 9, intermediate: 16, expert: 16};

async function warmMatrix() {
  const matches = Number(arg('--matches', '10')), out = [];
  for (const [preset, level] of [['beginner', 'jev'], ['intermediate', 'jev'], ['expert', 'normal'], ['expert', 'hard'], ['expert', 'jev']]) {
    const h = await harness(), samples = {start: [], pollApply: [], pollPrepare: [], pollIdle: [], action: [], verifyStep: []}, verify = {steps: [], perMatch: []};
    let events = 0;
    for (let m = 0; m < matches; m++) {
      const played = await playMatch(h, {preset, difficulty: level, samples});
      // Verification: drive it exactly as the Worker does, one bounded step per invocation.
      let steps = 0, final = 'pending';
      while (final === 'pending' && steps < 400) { const r = await h.measure(() => verifyStep(h.core, played.id)); if (r.out !== 'skipped') samples.verifyStep.push(r.ms); final = r.out; steps++; }
      // 'skipped' means the polls that ended the match already verified it; the database is the source of truth.
      final = h.app.database.raw.prepare('SELECT verification FROM matches WHERE id=?').get(played.id).verification;
      verify.perMatch.push({steps, result: final}); events += h.app.database.raw.prepare('SELECT event_count AS n FROM matches WHERE id=?').get(played.id).n;
      if (m === 0) { const rep = await h.measure(() => h.call(`/api/matches/${played.id}/replay`, {session: played.g})); samples.replay = [rep.ms]; samples.replayBytes = [rep.out.bytes]; }
    }
    // Isolated decision cost (solver + request build + digest + D1 round trips), with no request around it: a private core whose
    // waitUntil does nothing, so only the explicit prepareJev() calls compute.
    const prepare = [], quiet = {...h.core, waitUntil: () => {}};
    for (let m = 0; m < Math.max(4, matches / 2); m++) {
      const g = await h.guest(), created = await h.call('/api/matches', {body: {requestId: crypto.randomUUID(), boardPreset: preset, aiDifficulty: level, mode: 'practice', context: 'world'}, session: g});
      const id = created.data.id, owner = h.app.database.raw.prepare('SELECT owner_key FROM matches WHERE id=?').get(id).owner_key;
      await h.call(`/api/matches/${id}/actions`, {body: {requestId: crypto.randomUUID(), action: {type: 'start', cell: Math.floor(PRESET_H[preset] / 2) * PRESET_W[preset] + Math.floor(PRESET_W[preset] / 2)}}, session: g});
      await h.drain();
      for (let k = 0; k < 60; k++) {
        const r = await h.measure(() => prepareJev(quiet, id));
        if (r.out) prepare.push(r.ms);
        h.advance(1000); const v = await snapshot(quiet, id, owner);
        if (v.phase !== 'running' || v.boards.jev.status !== 'active') break;
      }
      await h.call(`/api/matches/${id}/actions`, {body: {requestId: crypto.randomUUID(), action: {type: 'resign'}}, session: g}); await h.drain();
    }
    samples.prepare = prepare;
    const verified = verify.perMatch.filter(x => x.result === 'verified').length;
    out.push({preset, level, matches, events, verified, verifyStepsPerMatch: summarize(verify.perMatch.map(x => x.steps)), ops: Object.fromEntries(Object.entries(samples).filter(([k]) => !k.endsWith('Bytes')).map(([k, v]) => [k, summarize(v)])), replayBytes: samples.replayBytes?.[0] ?? null});
    console.error(`${preset}/${level}: ${verified}/${matches} verified`);
    await h.close();
  }
  return out;
}
async function staticOps() {
  const h = await harness(), out = {};
  const many = async (label, n, fn) => { const s = []; for (let i = 0; i < n; i++) s.push((await h.measure(fn)).ms); out[label] = summarize(s); };
  await many('session create (GET /api/me, new guest)', 30, () => h.call('/api/me'));
  const g = await h.guest();
  await many('match create (POST /api/matches) beginner', 20, async () => { const gg = await h.guest(); return h.call('/api/matches', {body: {requestId: crypto.randomUUID(), boardPreset: 'beginner', aiDifficulty: 'normal', mode: 'practice', context: 'world'}, session: gg}); });
  await many('match create (POST /api/matches) expert', 20, async () => { const gg = await h.guest(); return h.call('/api/matches', {body: {requestId: crypto.randomUUID(), boardPreset: 'expert', aiDifficulty: 'jev', mode: 'practice', context: 'world'}, session: gg}); });
  for (const preset of ['beginner', 'expert']) {
    const s = [];
    for (let i = 0; i < 20; i++) { const gg = await h.guest(), c = await h.call('/api/matches', {body: {requestId: crypto.randomUUID(), boardPreset: preset, aiDifficulty: 'easy', mode: 'practice', context: 'world'}, session: gg}); s.push((await h.measure(() => h.call(`/api/matches/${c.data.id}/actions`, {body: {requestId: crypto.randomUUID(), action: {type: 'start', cell: 40}}, session: gg}))).ms); }
    out[`start (POST actions: two board generations) ${preset}`] = summarize(s);
  }
  // Discord interaction: signed webhook verified with Web Crypto Ed25519.
  const pair = generateKeyPairSync('ed25519'), publicHex = pair.publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('hex');
  const h2 = await harness({DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'x', DISCORD_PUBLIC_KEY: publicHex});
  const s2 = [];
  for (let i = 0; i < 30; i++) {
    const raw = JSON.stringify({id: String(444444444444444444n + BigInt(i)), application_id: '123456789012345678', type: 2, guild_id: '555555555555555555', channel_id: '666666666666666666', channel: {type: 0}, member: {user: {id: '222222222222222222'}}, data: {name: 'jev', options: [{name: 'play', type: 1}]}});
    const stamp = String(Math.floor(h2.now / 1000)), signature = sign(null, Buffer.concat([Buffer.from(stamp), Buffer.from(raw)]), pair.privateKey).toString('hex');
    const r = await h2.measure(() => h2.call('/api/discord/interactions', {raw, headers: {'x-signature-timestamp': stamp, 'x-signature-ed25519': signature}}));
    if (r.out.status !== 200) throw new Error(`interaction ${r.out.status}`); s2.push(r.ms);
  }
  out['Discord slash-command interaction (Ed25519 verify + ticket insert)'] = summarize(s2);
  await h2.close();
  // Leaderboard and profile over synthetic verified history.
  for (const rows of [200, 2000]) {
    const db = h.app.database.raw, key = `${ENGINE_VERSION}|${POLICY_VERSION}|jev-1.13.0|beginner|normal|1000|100`;
    db.exec('BEGIN');
    const user = db.prepare('INSERT OR IGNORE INTO users(discord_id,display_name,created_at,last_seen_at) VALUES(?,?,0,0)'), ins = db.prepare("INSERT INTO matches(id,owner_key,creation_request_id,creation_body_hash,user_id,competition_key,board_preset,ai_difficulty,config_json,private_state_json,phase,eligible,verification,outcome,human_clear_ms,created_at,finished_at) VALUES(?,?,?,?,?,?,'beginner','normal','{}','{}','complete',1,'verified',?,?,0,?)");
    for (let i = 0; i < rows; i++) { const uid = String(10000000000000000n + BigInt(i % 200)); user.run(uid, `Player ${i % 200}`); ins.run(`lb-${rows}-${i}`, `u:${uid}`, `r${rows}-${i}`, 'h', uid, key, i % 3 ? 'win' : 'loss', 30000 + i, i + 1); }
    db.exec('COMMIT');
    await many(`leaderboard (${db.prepare("SELECT count(*) AS n FROM matches WHERE eligible=1").get().n} verified rows, 200 players)`, 8, () => h.call('/api/leaderboard'));
  }
  const m = []; for (let i = 0; i < 6; i++) m.push((await h.measure(() => maintenance(h.core))).ms); out['maintenance job (one of three, rotating)'] = summarize(m);
  await h.close();
  return out;
}
function cold() {
  const samples = Number(arg('--cold', '6')), rows = [];
  for (let i = 0; i < samples; i++) {
    const r = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--first', '--seed', String(i)], {encoding: 'utf8', timeout: 120000});
    try { rows.push(JSON.parse(r.stdout.trim().split('\n').at(-1))); } catch { /* skip a failed sample */ }
  }
  return rows;
}
async function firstCalls() {
  // One fresh process, one expert/jev match: costs of the FIRST invocation of each kind (unoptimised code).
  const h = await harness(), first = {}, samples = {start: [], pollApply: [], pollPrepare: [], pollIdle: [], action: [], verifyStep: []};
  const played = await playMatch(h, {preset: 'expert', difficulty: 'jev', samples, first});
  const s = await h.measure(() => verifyStep(h.core, played.id)); first.verifyStep = s.ms;
  await h.close(); console.log(JSON.stringify(first));
}
if (args.includes('--first')) { await firstCalls(); process.exit(0); }
const started = new Date().toISOString(), matrix = await warmMatrix(), statics = await staticOps(), coldRows = args.includes('--no-cold') ? [] : cold();
const coldSummary = {}; for (const k of ['start', 'pollApply', 'pollPrepare', 'verifyStep']) { const v = coldRows.map(r => r[k]).filter(x => typeof x === 'number'); if (v.length) coldSummary[k] = summarize(v); }
const report = {generatedAt: started, runtime: process.version, platform: `${process.platform} ${process.arch}`, budgetMs: BUDGET_MS, verifyStepUnits: VERIFY_STEP_UNITS, engineVersion: ENGINE_VERSION, policyVersion: POLICY_VERSION,
  method: 'High-resolution elapsed time (single thread, no I/O waits) around a full Worker invocation (request + waitUntil work) against real SQLite via the D1-compatible wrapper, Node V8 (not workerd).',
  limitations: ['Not workerd: absolute numbers differ on Cloudflare hardware; treat the 10 ms budget comparison as indicative with about 1.5x margin needed.', 'Local SQLite time is counted here; on Cloudflare D1 time is I/O and not CPU, so DB-heavy numbers are conservative.', 'A cold isolate runs unoptimised code; the cold rows fresh-process each sample.', 'Workers clocks do not advance during CPU, so the production code uses static budgets, not timers.'],
  matrix, staticOps: statics, coldFirstInvocation: coldSummary, coldSamples: coldRows.length};
const out = resolve(arg('--out', 'reports/cpu')); await mkdir(out, {recursive: true});
await writeFile(resolve(out, 'cpu.json'), JSON.stringify(report, null, 2));
const line = (label, s) => `| ${label} | ${s.n} | ${r2(s.p50)} | ${r2(s.p95)} | ${r2(s.max)} | ${s.over10} |`;
let md = `# CPU cost of the hot request paths (Workers Free budget: ${BUDGET_MS} ms per invocation)\n\nGenerated ${started} on Node ${process.version} (${report.platform}). ${report.method}\n\n${report.limitations.map(x => '- ' + x).join('\n')}\n\nEngine ${ENGINE_VERSION}, policy ${POLICY_VERSION}, verification step budget ${VERIFY_STEP_UNITS} units.\n\n## Match play, by board and opponent level (warm)\n\n`;
for (const m of matrix) {
  md += `### ${m.preset} / ${m.level} (${m.matches} matches, ${m.events} events, ${m.verified}/${m.matches} verified, replay ${m.replayBytes} bytes)\n\n| Operation | n | p50 ms | p95 ms | max ms | over ${BUDGET_MS} ms |\n|---|---:|---:|---:|---:|---:|\n`;
  const names = {start: 'start (POST actions)', pollApply: 'poll that applies due opponent move(s)', pollPrepare: 'poll that computes the next opponent decision', pollIdle: 'poll with nothing to do', action: 'human command (with schedule catch-up)', prepare: 'compute one decision in isolation (solver + request + D1)', verifyStep: `verification step (${VERIFY_STEP_UNITS} units)`, replay: 'replay export'};
  for (const [k, v] of Object.entries(m.ops)) md += line(names[k] ?? k, v) + '\n';
  md += `\nVerification steps per match: p50 ${r2(m.verifyStepsPerMatch.p50)}, max ${r2(m.verifyStepsPerMatch.max)}.\n\n`;
}
md += `## Other paths (warm)\n\n| Operation | n | p50 ms | p95 ms | max ms | over ${BUDGET_MS} ms |\n|---|---:|---:|---:|---:|---:|\n${Object.entries(statics).map(([k, v]) => line(k, v)).join('\n')}\n\n`;
if (Object.keys(coldSummary).length) md += `## First invocation in a fresh process (cold JIT), expert / jev\n\n| Operation | n | p50 ms | p95 ms | max ms | over ${BUDGET_MS} ms |\n|---|---:|---:|---:|---:|---:|\n${Object.entries(coldSummary).map(([k, v]) => line(k, v)).join('\n')}\n`;
await writeFile(resolve(out, 'report.md'), md);
console.log(md);
