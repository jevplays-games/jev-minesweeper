/**
 * Match lifecycle on a runtime with no background threads and a small per-request CPU budget (Cloudflare Workers Free).
 *
 * There is no in-process coordinator. A match is a D1 row plus its event journal, and time is applied lazily: every owner request first
 * runs `advance()`, which replays whatever the schedule made due since the last request (the opponent's one-move-per-second decisions,
 * 100 ms adjudication, ready expiry, 30 s abandonment) with each event stamped at the moment it was due, then appends them in one
 * compare-and-swap commit. The opponent's decisions are computed ahead of that schedule by `prepareJev()` (under a durable lease) and
 * queued in `jev_decisions`; result verification runs as bounded steps in `verifyStep()`.
 */
import {createMatch, startMatch, clone, observeMatch, observeBoard, applyMatchAction, applyBoardAction, adjudicate, finish, digest} from '../public/shared/engine.js';
import {makeEvent, resultOf, ReplayVerifier, REPLAY_VERSION} from '../public/shared/replay.js';
import {publicDecision} from '../public/shared/decisions.js';
import {chooseJevAction} from './jev.js';
import {gameConfig, competitionKey} from './config.js';
import {httpError, ownerKey, hash} from './security.js';
const ACTIVE = "('ready','running')";
const seed = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
const parse = row => ({row, state: JSON.parse(row.private_state_json), reasons: JSON.parse(row.eligibility_reasons_json)});
const isUnique = e => String(e?.message ?? e).includes('UNIQUE');
export const unrank = (m, reason) => { if (!m.reasons.includes(reason)) m.reasons.push(reason); };
/** makeEvent() only needs the journal length and head hash, so a matching view of "persisted + pending" is enough. */
const chainOf = (m, added) => ({get length() { return m.row.event_count + added.length; }, at: () => added.at(-1) ?? (m.row.head_hash ? {hash: m.row.head_hash} : undefined)});
const newWork = row => ({added: [], hashes: new Map(), consumed: [], wipeQueue: false, audits: [], nextDue: row.jev_next_due_ms, lastDecision: row.last_decision_json, dirty: false, queue: null});
export function elapsed(m, now) {
  const {state, row} = m;
  return state.phase === 'ready' ? 0 : state.phase === 'complete' ? state.finishedAtMs : Math.max(state.lastAtMs, Math.max(0, now - row.started_at));
}
/** Earliest instant at which adjudicate() would end the match, or Infinity. */
function terminalTime(state) {
  const {human, jev} = state.boards, width = state.config.adjudicationMs, times = [state.config.deadlineMs];
  const cleared = [human, jev].filter(b => b?.status === 'cleared');
  if (cleared.length) times.push((Math.min(...cleared.map(b => Math.floor(b.terminalAtMs / width))) + 1) * width);
  if (human.status === 'exploded' && jev.status === 'exploded') times.push(state.lastAtMs);
  return Math.min(...times);
}
export async function loadOwned(app, id, owner) {
  const row = await app.store.match(id);
  if (!row || row.owner_key !== owner) throw httpError(404, 'match_not_found');
  return parse(row);
}
export function view(app, m, now = app.now()) {
  const {row} = m, decision = row.last_decision_json ? JSON.parse(row.last_decision_json) : null;
  return {...observeMatch(m.state), elapsedMs: elapsed(m, now), lastEventAtMs: m.state.lastAtMs, serverNow: now, startedAt: row.started_at, seq: row.event_count,
    eligibility: {requested: Boolean(row.ranked_requested), eligible: Boolean(row.eligible), verification: row.verification, reasons: [...m.reasons]},
    opponent: app.config.jevKey ? m.reasons.some(x => x === 'jev_fallback' || x === 'provider_budget') ? 'JEV with local fallback — unofficial' : 'JEV + visible-state constraint solver' : 'Local heuristic — not JEV',
    decision, context: row.guild_id ? {guildId: row.guild_id, channelId: row.channel_id} : null};
}
async function queueMeta(app, m, w) {
  if (!w.queue) w.queue = await app.store.all('SELECT revision,ready_at_ms FROM jev_decisions WHERE match_id=? ORDER BY revision', m.row.id);
  return w.queue;
}
/**
 * Replays everything the schedule made due up to `now` into `w` (pending events + bookkeeping) and into m.state. Nothing is written here.
 * Events are applied in time order; ties go to adjudication, then to the owner-contact rules, then to the opponent.
 */
export async function advance(app, m, w, now) {
  const {config} = app, {row, state} = m;
  if (state.phase === 'complete') return;
  if (state.phase === 'ready') {
    if (now - row.created_at >= config.readyLifetimeMs) { finish(state, 'void', 'ready_expired', 0); unrank(m, 'ready_expired'); w.added.push(await makeEvent(chainOf(m, w.added), 'void', 'system', 0, {reason: 'ready_expired'})); }
    return;
  }
  const t = Math.max(state.lastAtMs, Math.max(0, now - row.started_at)), contact = row.last_seen_at ?? row.started_at;
  for (let guard = 0; guard < 64 && state.phase === 'running'; guard++) {
    const due = [], term = terminalTime(state);
    if (term <= t) due.push({at: Math.max(term, state.lastAtMs), rank: 0, kind: 'adjudicate'});
    if (now - contact >= config.disconnectGraceMs) due.push({at: Math.max(state.lastAtMs, contact - row.started_at + config.disconnectGraceMs), rank: 1, kind: 'abandon'});
    if (row.event_count + w.added.length >= config.maxActions) due.push({at: state.lastAtMs, rank: 1, kind: 'action_limit'});
    let head = null;
    if (state.boards.jev.status === 'active') {
      head = (await queueMeta(app, m, w)).find(q => !w.consumed.includes(q.revision));
      if (head) { const at = Math.max(w.nextDue, head.ready_at_ms, state.lastAtMs); if (at <= t) due.push({at, rank: 2, kind: 'jev'}); }
    }
    if (!due.length) break;
    due.sort((a, b) => a.at - b.at || a.rank - b.rank);
    const {at, kind} = due[0], chain = chainOf(m, w.added);
    if (kind === 'adjudicate') {
      if (!adjudicate(state, at)) break;
      w.added.push(await makeEvent(chain, 'adjudicate', 'system', at));
    } else if (kind === 'abandon') {
      finish(state, 'loss', 'abandoned', at); w.added.push(await makeEvent(chain, 'abandon', 'system', at));
    } else if (kind === 'action_limit') {
      finish(state, 'void', 'action_limit', at); unrank(m, 'action_limit'); w.added.push(await makeEvent(chain, 'void', 'system', at, {reason: 'action_limit'}));
    } else {
      const stored = await app.store.get('SELECT decision_json FROM jev_decisions WHERE match_id=? AND revision=?', row.id, head.revision), d = JSON.parse(stored.decision_json), jev = state.boards.jev;
      if (d.boardRevision !== jev.revision || d.observationHash !== await digest(observeBoard(jev))) {
        unrank(m, 'stale_jev_decision'); w.audits.push(['stale_jev_decision', {}]); w.wipeQueue = true; w.queue = []; w.dirty = true; break;
      }
      if (d.fallback) unrank(m, 'jev_fallback');
      if (at - w.nextDue > config.lateToleranceMs && !m.reasons.includes('scheduling_miss')) { unrank(m, 'scheduling_miss'); w.audits.push(['scheduling_miss', {lateMs: at - w.nextDue}]); }
      d.scheduledAtMs = w.nextDue; d.appliedAtMs = at; d.schedulingLagMs = at - w.nextDue;
      const expectedRevision = jev.revision, next = clone(state); applyMatchAction(next, 'jev', d.selected.action, at);
      Object.assign(state, next); w.added.push(await makeEvent(chain, 'action', 'jev', at, {expectedRevision, action: d.selected.action}, d));
      w.consumed.push(head.revision); w.nextDue = at + state.config.jevIntervalMs; w.lastDecision = JSON.stringify(publicDecision(d));
    }
  }
  // The opponent's slot passed and no decision was ready in time: the match can no longer be a like-for-like ranked race.
  if (state.phase === 'running' && state.boards.jev.status === 'active' && t - w.nextDue > config.lateToleranceMs && !m.reasons.includes('scheduling_miss')) {
    unrank(m, 'scheduling_miss'); w.audits.push(['scheduling_miss', {lateMs: t - w.nextDue}]); w.dirty = true;
  }
}
/**
 * One compare-and-swap write: the row, the new journal events and their bookkeeping land together or not at all. A concurrent invocation
 * that got there first makes the `version` guard match zero rows, every dependent statement is skipped, and this throws 409.
 */
export async function commit(app, m, w, {touch = true} = {}) {
  const {store} = app, {row, state} = m, now = app.now(), tag = crypto.randomUUID(), completed = state.phase === 'complete', becameComplete = completed && row.phase !== 'complete';
  if (becameComplete) {
    if (state.openingOnly) unrank(m, 'opening_only_clear');
    if (state.outcome === 'void') unrank(m, state.outcomeReason);
  }
  const result = completed ? resultOf(state) : null, last = w.added.at(-1);
  const next = {
    phase: state.phase, started_at: row.started_at, finished_at: completed ? (row.started_at === null ? now : row.started_at + state.finishedAtMs) : null,
    outcome: state.outcome, outcome_reason: state.outcomeReason, human_clear_ms: result?.humanClearMs ?? null, result_json: result ? JSON.stringify(result) : null,
    sealed_head_hash: completed ? (last?.hash ?? row.head_hash) : null, eligibility_reasons_json: JSON.stringify(m.reasons),
    event_count: row.event_count + w.added.length, head_hash: last ? last.hash : row.head_hash, jev_next_due_ms: w.nextDue, last_decision_json: w.lastDecision,
    last_seen_at: touch ? now : row.last_seen_at
  };
  const guard = 'EXISTS(SELECT 1 FROM matches WHERE id=? AND write_tag=?)';
  const statements = [store.stmt(`UPDATE matches SET private_state_json=?,phase=?,started_at=?,finished_at=?,outcome=?,outcome_reason=?,human_clear_ms=?,result_json=?,sealed_head_hash=?,eligibility_reasons_json=?,event_count=?,head_hash=?,jev_next_due_ms=?,last_decision_json=?,last_seen_at=?,version=version+1,write_tag=? WHERE id=? AND version=?`,
    JSON.stringify(state), next.phase, next.started_at, next.finished_at, next.outcome, next.outcome_reason, next.human_clear_ms, next.result_json, next.sealed_head_hash, next.eligibility_reasons_json, next.event_count, next.head_hash, next.jev_next_due_ms, next.last_decision_json, next.last_seen_at, tag, row.id, row.version)];
  for (const event of w.added) {
    statements.push(store.stmt(`INSERT INTO match_events(match_id,seq,request_id,request_body_hash,event_json) SELECT ?,?,?,?,? WHERE ${guard}`, row.id, event.seq, event.requestId ?? null, w.hashes.get(event.seq) ?? null, JSON.stringify(event), row.id, tag));
  }
  if (becameComplete || w.wipeQueue) statements.push(store.stmt(`DELETE FROM jev_decisions WHERE match_id=? AND ${guard}`, row.id, row.id, tag));
  else if (w.consumed.length) statements.push(store.stmt(`DELETE FROM jev_decisions WHERE match_id=? AND revision<=? AND ${guard}`, row.id, Math.max(...w.consumed), row.id, tag));
  const audits = [...w.audits]; if (becameComplete) audits.push(['game_completed', {outcome: state.outcome, reason: state.outcomeReason}]);
  for (const [type, data] of audits) statements.push(store.stmt(`INSERT INTO audit_events(match_id,owner_key,at,type,data_json) SELECT ?,?,?,?,? WHERE ${guard}`, row.id, row.owner_key, now, type, JSON.stringify(data), row.id, tag));
  const results = await store.batch(statements);
  if (results[0].meta.changes !== 1) throw httpError(409, 'match_busy', 'The match changed while this request ran; retry.');
  Object.assign(row, next, {version: row.version + 1, write_tag: tag});
}
/** Loads the match fresh and runs `body`; when another invocation won the compare-and-swap in between, retries on the new state. */
async function withMatch(app, id, owner, body, tries = 3) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    const m = owner === null ? parse(await app.store.match(id)) : await loadOwned(app, id, owner), w = newWork(m.row), now = app.now();
    try { return {m, w, out: await body(m, w, now)}; }
    catch (e) { if (e.code !== 'match_busy') throw e; last = e; }
  }
  throw last;
}
/** Settle whatever is due on a match nobody is currently watching (no contact update). */
const settleIdle = (app, id, owner) => withMatch(app, id, owner, async (m, w, at) => { await advance(app, m, w, at); if (w.added.length || w.dirty) await commit(app, m, w, {touch: false}); });
export async function create(app, session, options, context) {
  const {store, config} = app, owner = ownerKey(session), bodyHash = await digest(options), now = app.now();
  const previous = await store.get('SELECT * FROM matches WHERE owner_key=? AND creation_request_id=?', owner, options.requestId);
  if (previous) { if (previous.creation_body_hash !== bodyHash) throw httpError(409, 'idempotency_conflict'); return view(app, parse(previous), now); }
  const active = await store.get(`SELECT id FROM matches WHERE owner_key=? AND phase IN ${ACTIVE}`, owner);
  if (active) {
    // An abandoned or expired match settles lazily; only a genuinely live one blocks a new game.
    await settleIdle(app, active.id, owner).catch(e => { if (e.code !== 'match_busy') throw e; });
    if (await store.get(`SELECT id FROM matches WHERE owner_key=? AND phase IN ${ACTIVE}`, owner)) throw httpError(409, 'active_match_exists', 'Finish or resign the current match before creating another.');
  }
  const live = await store.get(`SELECT count(*) AS n FROM matches WHERE phase IN ${ACTIVE} AND last_seen_at>=?`, now - config.disconnectGraceMs - 2 * config.contactThrottleMs);
  if (live.n >= config.maxActiveMatches) throw httpError(429, 'server_at_capacity');
  const day = new Date(now).toISOString().slice(0, 10), bucket = await hash(`${config.rateLimitSalt}|create|${owner}|${Math.floor(now / 3600000)}`);
  if (await store.consume(bucket, 'matches_hour', config.matchesPerHour, now + 7200000) === null) throw httpError(429, 'match_creation_rate_limit');
  if (await store.consume(`day:${day}`, 'matches', config.maxMatchesPerDay, now + 172800000) === null) throw httpError(429, 'daily_match_capacity', 'The daily match capacity is used up. Try again tomorrow, or use offline practice.');
  const cfg = gameConfig(config, options.boardPreset, options.aiDifficulty);
  const state = await createMatch(cfg, {human: seed(), jev: seed()}, crypto.randomUUID());
  const reasons = []; if (options.mode !== 'ranked') reasons.push('practice_mode'); if (!session.user_id) reasons.push('guest'); if (!config.jevKey) reasons.push('jev_not_configured');
  const row = {id: state.id, competition_key: competitionKey(cfg), guild_id: context?.guildId ?? null, channel_id: context?.channelId ?? null, ranked_requested: Number(options.mode === 'ranked'), reasons: JSON.stringify(reasons), state: JSON.stringify(state)};
  const columns = 'id,owner_key,creation_request_id,creation_body_hash,user_id,competition_key,board_preset,ai_difficulty,guild_id,channel_id,config_json,private_state_json,phase,ranked_requested,eligibility_reasons_json,created_at,last_seen_at';
  const values = [row.id, owner, options.requestId, bodyHash, session.user_id, row.competition_key, options.boardPreset, options.aiDifficulty, row.guild_id, row.channel_id, JSON.stringify(cfg), row.state, 'ready', row.ranked_requested, row.reasons, now, now];
  // A launch ticket is redeemed and the match created in one batch: the INSERT only proceeds when this very request consumed the ticket.
  const insert = context?.ticketHash
    ? store.stmt(`INSERT INTO matches(${columns}) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM launch_tickets WHERE token_hash=? AND consumed_by=?)`, ...values, context.ticketHash, row.id)
    : store.stmt(`INSERT INTO matches(${columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...values);
  const statements = [];
  if (context?.ticketHash) statements.push(store.stmt('UPDATE launch_tickets SET consumed_at=?,consumed_by=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>? AND discord_user_id=?', now, row.id, context.ticketHash, now, session.user_id));
  statements.push(insert);
  if (context?.ticketHash) {
    // The community context is only granted when this very request created the match, i.e. redeemed the ticket.
    const {ticketHash, ...grant} = context; session.data.context = grant;
    statements.push(store.stmt('UPDATE sessions SET data_json=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM matches WHERE id=?)', JSON.stringify(session.data), session.token_hash, row.id));
  }
  statements.push(store.stmt("INSERT INTO audit_events(match_id,owner_key,at,type,data_json) SELECT ?,?,?,'game_created',? WHERE EXISTS(SELECT 1 FROM matches WHERE id=?)", row.id, owner, now, JSON.stringify({mode: options.mode, difficulty: options.aiDifficulty, preset: options.boardPreset}), row.id));
  let results;
  try { results = await store.batch(statements); }
  catch (e) {
    if (!isUnique(e)) throw e;
    // A concurrent duplicate of this request (same owner, same id) or a second live match: report it the way the pre-checks would have.
    const again = await store.get('SELECT * FROM matches WHERE owner_key=? AND creation_request_id=?', owner, options.requestId);
    if (again) { if (again.creation_body_hash !== bodyHash) throw httpError(409, 'idempotency_conflict'); return view(app, parse(again), now); }
    throw httpError(409, 'active_match_exists', 'Finish or resign the current match before creating another.');
  }
  if (context?.ticketHash && results[0].meta.changes !== 1) throw httpError(403, 'launch_ticket_rejected');
  return view(app, parse(await store.match(row.id)), now);
}
/** GET snapshot: settle whatever is due, refresh owner contact, and (off the response path) top up the opponent queue or advance verification. */
export async function snapshot(app, id, owner) {
  const {m, w, out: now} = await withMatch(app, id, owner, async (m, w, now) => {
    const wasLive = m.state.phase !== 'complete';
    await advance(app, m, w, now);
    if (w.added.length || w.dirty) await commit(app, m, w, {touch: wasLive});
    else if (wasLive && now - (m.row.last_seen_at ?? 0) >= app.config.contactThrottleMs) { await app.store.run(`UPDATE matches SET last_seen_at=? WHERE id=? AND phase IN ${ACTIVE}`, now, m.row.id); m.row.last_seen_at = now; }
    return now;
  });
  schedule(app, m, w);
  return view(app, m, now);
}
export async function action(app, id, owner, body) {
  const {store, config} = app;
  const {m, w, out} = await withMatch(app, id, owner, async (m, w, now) => {
    const bodyHash = await digest(body);
    const existing = await store.get('SELECT seq,request_body_hash FROM match_events WHERE match_id=? AND request_id=?', id, body.requestId);
    if (existing) {
      if (existing.request_body_hash !== bodyHash) throw httpError(409, 'idempotency_conflict');
      await store.audit('idempotent_retry', {matchId: id, owner, at: now}); return {acceptedSeq: existing.seq, idempotent: true, now};
    }
    if (m.state.phase === 'complete') throw httpError(409, 'match_complete');
    await advance(app, m, w, now);
    // Whatever the schedule already made due is real even when this particular request is then refused, so it is committed first.
    const fail = async error => { if (w.added.length || w.dirty) await commit(app, m, w, {touch: false}).catch(() => {}); throw error; };
    if (m.state.phase === 'complete') return fail(httpError(409, 'match_complete'));
    const atMs = elapsed(m, now);
    const record = async (type, actor, at, payload) => { const event = await makeEvent(chainOf(m, w.added), type, actor, at, payload, null, body.requestId); w.added.push(event); w.hashes.set(event.seq, bodyHash); };
    try {
      if (body.action.type === 'start') {
        if (m.state.phase !== 'ready') throw httpError(409, 'already_started');
        const next = clone(m.state); await startMatch(next, body.action.cell); m.state = next; m.row.started_at = now; w.nextDue = 1000;
        await record('start', 'human', 0, {cell: body.action.cell});
        w.audits.push(['game_started', {}]);
      } else if (body.action.type === 'resign') {
        if (m.state.phase === 'ready') { finish(m.state, 'void', 'ready_expired', 0); unrank(m, 'ready_cancelled'); await record('void', 'system', 0, {reason: 'ready_expired'}); }
        else { finish(m.state, 'loss', 'resigned', atMs); await record('resign', 'human', atMs, {}); }
      } else {
        if (m.state.phase !== 'running') throw httpError(409, 'not_running');
        if (body.expectedBoardRevision !== m.state.boards.human.revision) throw httpError(409, 'stale_board_revision');
        if (m.row.event_count + w.added.length >= config.maxActions) throw httpError(429, 'match_action_limit');
        const expectedRevision = m.state.boards.human.revision, next = clone(m.state);
        applyMatchAction(next, 'human', body.action, atMs); m.state = next;
        await record('action', 'human', atMs, {expectedRevision, action: body.action});
      }
    } catch (e) { return fail(e); }
    await commit(app, m, w, {touch: true});
    return {acceptedSeq: m.row.event_count, idempotent: false, now};
  });
  schedule(app, m, w, {light: true});
  return {acceptedSeq: out.acceptedSeq, idempotent: out.idempotent, snapshot: view(app, m, out.now)};
}
/**
 * Off-path follow-ups, never awaited by the response: top up the opponent queue, or push a finished match's verification along.
 * Each invocation does at most one heavy thing. A command never carries background work (the poll that follows it does), and a poll that
 * already applied opponent moves defers the next decision to the following poll unless the queue would run dry.
 */
function schedule(app, m, w, {light = false} = {}) {
  if (light) return;
  const {row, state} = m, now = app.now();
  if (state.phase === 'complete') { if (row.verification === 'pending' && !(row.verify_lease_until > now)) app.waitUntil(verifyStep(app, row.id).catch(() => {})); return; }
  if (state.phase !== 'running' || state.boards.jev.status !== 'active' || row.prep_lease_until > now) return;
  const queued = (w.queue ?? []).filter(q => !w.consumed.includes(q.revision)).length;
  if (w.wipeQueue || queued >= app.config.pipelineDepth) return;
  if (w.consumed.length && queued > 0) return;
  app.waitUntil(prepareJev(app, row.id).catch(() => {}));
}
/**
 * Computes one future opponent decision under a durable lease. The opponent's own board never depends on the human's, so decisions can be
 * computed ahead: this speculatively applies the already queued moves to a private copy of the opponent's board and decides the next one.
 * Only the opponent's public observation is used. After two consecutive failed attempts at a position (a killed invocation, e.g. CPU limit)
 * the next attempt degrades to the cheapest solver budget; that decision is flagged `cpu_guard`, never ranked, and replayed under the same
 * reduced budget.
 */
export async function prepareJev(app, id) {
  const {store, config} = app, began = app.now();
  const row = await store.match(id);
  if (!row || row.phase !== 'running' || row.prep_lease_until > began) return false;
  const state = JSON.parse(row.private_state_json), jev = state.boards.jev;
  if (jev.status !== 'active') return false;
  let queue = await store.all('SELECT revision,action_json FROM jev_decisions WHERE match_id=? ORDER BY revision', id);
  if (queue.some((q, i) => q.revision !== jev.revision + i)) { await store.run('DELETE FROM jev_decisions WHERE match_id=?', id); queue = []; }
  if (queue.length >= config.pipelineDepth) return false;
  const target = jev.revision + queue.length, token = crypto.randomUUID();
  const lease = await store.get(`UPDATE matches SET prep_lease_until=?,prep_token=?,prep_attempts=CASE WHEN prep_rev=? THEN prep_attempts+1 ELSE 1 END,prep_rev=? WHERE id=? AND phase='running' AND (prep_lease_until IS NULL OR prep_lease_until<=?) RETURNING prep_attempts`,
    began + config.providerTimeoutMs * 2 + 6000, token, target, target, id, began);
  if (!lease) return false;
  const release = () => store.run('UPDATE matches SET prep_lease_until=NULL WHERE id=? AND prep_token=?', id, token);
  let reserved = 0, dayBucket = null;
  try {
    const board = clone(jev);
    for (const q of queue) applyBoardAction(board, JSON.parse(q.action_json), 0);
    if (board.status !== 'active') { await release(); return false; }
    const observation = observeBoard(board), degraded = lease.prep_attempts >= 3;
    let forceLocal = row.provider_calls >= config.maxCallsPerMatch;
    if (!degraded && !forceLocal && config.jevKey) {
      dayBucket = `day:${new Date(began).toISOString().slice(0, 10)}`;
      // Reserve the worst case (two attempts) before calling out; unused units are returned afterwards.
      if (await store.consume(dayBucket, 'jev_calls', config.maxJevCallsPerDay, began + 172800000, 2) === null) { forceLocal = true; dayBucket = null; } else reserved = 2;
    }
    let decision;
    try { decision = await chooseJevAction({observation, difficulty: state.config.aiDifficulty, config, fetchImpl: app.fetch, forceLocal, degraded}); }
    catch (e) { throw Object.assign(e, {solver: true}); }
    if (reserved) { await store.refund(dayBucket, 'jev_calls', reserved - decision.attempts.length); reserved = 0; }
    const ready = Math.max(0, app.now() - row.started_at);
    const results = await store.batch([
      store.stmt(`INSERT INTO jev_decisions(match_id,revision,ready_at_ms,action_json,decision_json) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND prep_token=? AND phase='running')`, id, target, ready, JSON.stringify(decision.selected.action), JSON.stringify(decision), id, token),
      store.stmt('UPDATE matches SET prep_lease_until=NULL,prep_attempts=0,provider_calls=provider_calls+? WHERE id=? AND prep_token=?', decision.attempts.length, id, token),
      store.stmt("INSERT INTO audit_events(match_id,owner_key,at,type,data_json) SELECT ?,?,?,'jev_decision_ready',? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND prep_token=?)", id, row.owner_key, app.now(), JSON.stringify({source: decision.source, latencyMs: decision.latencyMs, attempts: decision.attempts.length, degraded}), id, token)
    ]);
    return results[0].meta.changes === 1;
  } catch (e) {
    if (reserved) await store.refund(dayBucket, 'jev_calls', reserved).catch(() => {});
    await release().catch(() => {});
    // Only a failure of the decision itself unranks the match; a database or network hiccup just leaves the slot for the next attempt.
    if (e.solver) await flagFailure(app, id, e.code || 'solver_failure').catch(() => {});
    return false;
  }
}
/** Mark a match unranked (and audit why) through the normal CAS, so it cannot be lost to a concurrent commit. */
async function flagFailure(app, id, code) {
  await withMatch(app, id, null, async m => {
    if (m.reasons.includes('solver_failure')) return;
    unrank(m, 'solver_failure');
    await app.store.batch([app.store.stmt('UPDATE matches SET eligibility_reasons_json=?,version=version+1 WHERE id=? AND version=?', JSON.stringify(m.reasons), id, m.row.version), app.store.auditStatement('jev_solver_failure', {matchId: id, owner: m.row.owner_key, data: {code}, at: app.now()})]);
  });
}
// Verification budget per step, in abstract units of about 0.2 ms of CPU on a warm isolate (calibrated by `npm run bench:cpu`). A decision
// costs in proportion to the size of the position it was made in (legal actions) and the enumeration it needed; a step always completes at
// least one event, and one decision's cost is bounded by the solver caps, so a step fits the request budget.
export const VERIFY_STEP_UNITS = 20;
export function eventCost(event) {
  const d = event.decision;
  return d ? 2 + Math.ceil((d.legalCount ?? 0) / 40) + Math.ceil((d.solver?.nodes ?? 0) / 800) : 1;
}
/**
 * Verifies a finished match's sealed journal a bounded slice at a time (the same ReplayVerifier that verifyReplay() uses), resuming from a
 * persisted cursor. Only a match that verifies completely can become eligible. Returns 'verified', 'rejected', 'pending' (more to do) or 'skipped'.
 */
export async function verifyStep(app, id) {
  const {store} = app, began = app.now();
  const row = await store.match(id);
  if (!row || row.phase !== 'complete' || row.verification !== 'pending' || row.verify_lease_until > began) return 'skipped';
  const token = crypto.randomUUID();
  const got = await store.run("UPDATE matches SET verify_lease_until=?,verify_token=? WHERE id=? AND verification='pending' AND phase='complete' AND (verify_lease_until IS NULL OR verify_lease_until<=?)", began + 20000, token, id, began);
  if (got.changes !== 1) return 'skipped';
  const reasons = JSON.parse(row.eligibility_reasons_json);
  const conclude = async (verification, failure = null) => {
    const eligible = verification === 'verified' && row.ranked_requested && row.user_id && !reasons.length && row.outcome !== 'void';
    const final = failure ? [...reasons, 'verification_failed'] : reasons;
    const r = await store.batch([
      store.stmt("UPDATE matches SET verification=?,eligible=?,eligibility_reasons_json=?,verify_cursor_json=NULL,verify_lease_until=NULL,version=version+1 WHERE id=? AND verify_token=? AND verification='pending'", verification, Number(Boolean(eligible)), JSON.stringify(final), id, token),
      store.stmt(`INSERT INTO audit_events(match_id,owner_key,at,type,data_json) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND verify_token=? AND verification=?)`, id, row.owner_key, app.now(), verification === 'verified' ? 'score_verified' : 'verification_failed', JSON.stringify(verification === 'verified' ? {eligible: Boolean(eligible)} : {code: failure}), id, token, verification)
    ]);
    return r[0].meta.changes === 1 ? verification : 'skipped';
  };
  // What the journal says is judged (a failure rejects the match for good); a database hiccup is not evidence about the journal, so it
  // only releases the lease and the next step retries.
  const judged = async work => { try { return await work(); } catch (e) { throw Object.assign(e, {rejected: true}); } };
  try {
    const state = JSON.parse(row.private_state_json);
    const verifier = row.verify_cursor_json ? ReplayVerifier.restore(JSON.parse(row.verify_cursor_json))
      : await judged(() => ReplayVerifier.create({format: 'jev-arcade-replay', version: REPLAY_VERSION, engineVersion: state.engineVersion, generatorVersion: state.generatorVersion, policyVersion: state.config.policyVersion, matchId: row.id, config: state.config, seeds: state.seeds, commitments: state.commitments}));
    let spent = 0;
    while (verifier.count < row.event_count && spent < VERIFY_STEP_UNITS) {
      const rows = await store.all('SELECT event_json FROM match_events WHERE match_id=? AND seq>? ORDER BY seq LIMIT 6', id, verifier.count);
      if (!rows.length) throw Object.assign(new Error('journal_incomplete'), {rejected: true});
      for (const r of rows) {
        if (spent >= VERIFY_STEP_UNITS) break;
        await judged(async () => { const event = JSON.parse(r.event_json); spent += eventCost(event); await verifier.feed(event); });
      }
    }
    if (verifier.count < row.event_count) {
      await store.run('UPDATE matches SET verify_cursor_json=?,verify_lease_until=NULL WHERE id=? AND verify_token=?', JSON.stringify(verifier.cursor()), id, token);
      return 'pending';
    }
    await judged(() => verifier.finish({headHash: row.head_hash, result: JSON.parse(row.result_json)}));
    return await conclude('verified');
  } catch (e) {
    if (e.rejected) return conclude('rejected', e.code || e.message || 'verification_failed');
    await store.run('UPDATE matches SET verify_lease_until=NULL WHERE id=? AND verify_token=?', id, token).catch(() => {});
    return 'pending';
  }
}
// A long match's journal is several megabytes (each opponent decision carries its candidates and the model's answers), more than one
// invocation can move on a small CPU budget, so journals are served in pages that the client stitches back together.
const PAGE_EVENTS = 24, PAGE_CHARS = 600000;
async function journalPage(app, m, from) {
  if (!Number.isInteger(from) || from < 1) throw httpError(422, 'invalid_page');
  if (m.row.events_pruned_at) throw httpError(410, 'replay_expired', 'The event journal was removed under the retention policy.');
  const fetched = await app.store.all('SELECT seq,event_json FROM match_events WHERE match_id=? AND seq>=? ORDER BY seq LIMIT ?', m.row.id, from, PAGE_EVENTS), rows = []; let chars = 0;
  for (const r of fetched) { if (rows.length && chars + r.event_json.length > PAGE_CHARS) break; rows.push(r); chars += r.event_json.length; }
  const last = rows.at(-1)?.seq ?? from - 1;
  return {rows, from, next: last < m.row.event_count ? last + 1 : null};
}
/**
 * One page of the sealed replay. The stored event JSON is spliced in unparsed (no parse/stringify round trip), and every page carries the
 * small replay header, so the client rebuilds the exact `jev-arcade-replay` document by concatenating `events` across pages.
 */
export async function replayPage(app, m, from = 1) {
  if (m.state.phase !== 'complete') throw httpError(409, 'replay_available_after_match');
  const {row, state} = m, page = await journalPage(app, m, from);
  const header = JSON.stringify({format: 'jev-arcade-replay', version: REPLAY_VERSION, engineVersion: state.engineVersion, generatorVersion: state.generatorVersion, policyVersion: state.config.policyVersion, matchId: state.id, config: state.config, seeds: state.seeds, commitments: state.commitments, headHash: row.head_hash, result: JSON.parse(row.result_json),
    metadata: {createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, competitionKey: row.competition_key, eligible: Boolean(row.eligible), eligibilityReasons: m.reasons, verification: row.verification, scope: row.guild_id ? {guildId: row.guild_id, channelId: row.channel_id} : {world: true}}});
  return `{"page":{"from":${page.from},"count":${page.rows.length},"total":${row.event_count},"next":${page.next}},"header":${header},"events":[${page.rows.map(r => r.event_json).join(',')}]}`;
}
/** One page of the journal as JSON lines; the next page (if any) is named in `next`. */
export async function eventsPage(app, m, from = 1) {
  if (m.state.phase !== 'complete') throw httpError(409, 'export_available_after_match');
  const page = await journalPage(app, m, from);
  return {text: page.rows.map(r => r.event_json + String.fromCharCode(10)).join(''), next: page.next};
}
/** Server-side operational evidence only (request latencies, rejections, retries); the analytics themselves are derived from the replay. */
export async function operations(app, m) {
  if (m.state.phase !== 'complete') throw httpError(409, 'analytics_available_after_match');
  if (m.row.verification !== 'verified') throw httpError(409, 'replay_not_verified');
  return {matchId: m.row.id, audits: await app.store.audits(m.row.id), pricePerMillion: app.config.pricePerMillion};
}
/**
 * Lazy housekeeping in place of cron triggers (the account's cron allowance is used up). Called from a few cheap routes; a durable
 * counter row admits one run per 20 s across all isolates, and each run does exactly one of three small jobs in rotation.
 */
export async function maintenance(app) {
  const {store, config} = app, now = app.now();
  const claimed = await store.get("INSERT INTO counters(bucket,name,value,expires_at) VALUES('maintenance','tick',1,?) ON CONFLICT(bucket,name) DO UPDATE SET value=value+1,expires_at=excluded.expires_at WHERE counters.expires_at<=? RETURNING value", now + 20000, now);
  if (!claimed) return null;
  const job = claimed.value % 3;
  if (job === 0) {
    await store.prune(now, config.retentionDays);
    const cutoff = now - config.eventRetentionDays * 86400000;
    const old = await store.all("SELECT id FROM matches WHERE phase='complete' AND finished_at<? AND events_pruned_at IS NULL ORDER BY finished_at LIMIT 3", cutoff);
    for (const {id} of old) await store.batch([store.stmt('DELETE FROM match_events WHERE match_id=?', id), store.stmt('DELETE FROM jev_decisions WHERE match_id=?', id), store.stmt('UPDATE matches SET events_pruned_at=?,verify_cursor_json=NULL WHERE id=?', now, id)]);
    return 'prune';
  }
  if (job === 1) {
    const idle = await store.all(`SELECT id FROM matches WHERE phase IN ${ACTIVE} AND last_seen_at<? ORDER BY last_seen_at LIMIT 3`, now - config.disconnectGraceMs - 2 * config.contactThrottleMs);
    for (const {id} of idle) await settleIdle(app, id, null).catch(() => {});
    return 'settle';
  }
  const pending = await store.get("SELECT id FROM matches WHERE verification='pending' AND phase='complete' ORDER BY finished_at LIMIT 1");
  if (pending) await verifyStep(app, pending.id).catch(() => {});
  return 'verify';
}
