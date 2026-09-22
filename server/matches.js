import {randomBytes, randomUUID} from 'node:crypto';
import {createMatch, startMatch, clone, observeMatch, observeBoard, applyMatchAction, adjudicate, finish, canonical, digest} from '../shared/engine.js';
import {makeEvent, resultOf, exportReplay} from '../shared/replay.js';
import {publicDecision} from '../shared/decisions.js';
import {chooseJevAction} from './jev.js';
import {gameConfig, competitionKey} from './config.js';
import {httpError, ownerKey, saveSession} from './security.js';
export class Matches {
  constructor(store, config, workers, {chooser = chooseJevAction, now = Date.now} = {}) {
    this.store = store; this.config = config; this.workers = workers; this.chooser = chooser; this.now = now;
    this.active = new Map(); this.locks = new Map(); this.subscribers = new Map(); this.analyticsJobs = new Map(); this.closed = false;
    if (!config.disableScheduler) this.timer = setInterval(() => this.tickAll(), 50);
  }
  lock(key, fn) {
    const prior = this.locks.get(key) || Promise.resolve();
    const run = prior.catch(() => {}).then(fn); this.locks.set(key, run);
    run.finally(() => { if (this.locks.get(key) === run) this.locks.delete(key); }).catch(() => {}); return run;
  }
  audit(type, m, data = {}) { this.store.audit(type, {matchId: m.state.id, owner: m.row.owner_key, data, at: this.now()}); }
  async recover() {
    const rows = this.store.all("SELECT * FROM matches WHERE phase IN ('ready','running')");
    for (const row of rows) {
      const m = this.hydrate(row); this.active.set(row.id, m);
      const atMs = m.state.phase === 'ready' ? 0 : Math.max(m.state.lastAtMs, this.now() - row.started_at);
      finish(m.state, 'void', 'server_restart', atMs); this.unrank(m, 'server_restart');
      await this.commit(m, await makeEvent(m.events, 'void', 'system', atMs, {reason: 'server_restart'}));
    }
  }
  hydrate(row) { return {row, state: JSON.parse(row.private_state_json), events: this.store.events(row.id), reasons: JSON.parse(row.eligibility_reasons_json), lastSeen: this.now(), nextDue: 1000, pending: null, readyDecision: null, lastDecision: null, misses: new Set(), providerCalls: 0}; }
  load(id, owner) {
    const row = this.store.match(id);
    if (!row || row.owner_key !== owner) throw httpError(404, 'match_not_found');
    const m = this.active.get(id) || this.hydrate(row); m.row = row;
    if (row.phase !== 'complete') this.active.set(id, m);
    return m;
  }
  unrank(m, reason) {
    if (!m.reasons.includes(reason)) m.reasons.push(reason);
    this.store.run('UPDATE matches SET eligible=0,eligibility_reasons_json=? WHERE id=?', JSON.stringify(m.reasons), m.state.id);
  }
  async create(session, options, context) {
    const owner = ownerKey(session);
    return this.lock(`owner:${owner}`, async () => {
      const bodyHash = await digest(options);
      const previous = this.store.get('SELECT * FROM matches WHERE owner_key=? AND creation_request_id=?', owner, options.requestId);
      if (previous) { if (previous.creation_body_hash !== bodyHash) throw httpError(409, 'idempotency_conflict'); return this.view(this.load(previous.id, owner)); }
      if (this.store.get("SELECT id FROM matches WHERE owner_key=? AND phase IN ('ready','running')", owner)) throw httpError(409, 'active_match_exists', 'Finish or resign the current match before creating another.');
      if (this.active.size >= this.config.maxActiveMatches) throw httpError(429, 'server_at_capacity');
      const config = gameConfig(this.config, options.boardPreset, options.aiDifficulty);
      const state = await createMatch(config, {human: randomBytes(32).toString('hex'), jev: randomBytes(32).toString('hex')}, randomUUID());
      const now = this.now(), reasons = [];
      if (options.mode !== 'ranked') reasons.push('practice_mode');
      if (!session.user_id) reasons.push('guest');
      if (!this.config.jevKey) reasons.push('jev_not_configured');
      const row = {id: state.id, owner_key: owner, creation_request_id: options.requestId, creation_body_hash: bodyHash, user_id: session.user_id, competition_key: competitionKey(config), board_preset: options.boardPreset, ai_difficulty: options.aiDifficulty, guild_id: context?.guildId ?? null, channel_id: context?.channelId ?? null, phase: 'ready', ranked_requested: Number(options.mode === 'ranked'), eligible: 0, eligibility_reasons_json: JSON.stringify(reasons), verification: 'pending', created_at: now, started_at: null, finished_at: null, outcome: null, private_state_json: JSON.stringify(state)};
      this.store.transaction(() => {
        if (context?.ticketHash) { const changed = this.store.run('UPDATE launch_tickets SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>? AND discord_user_id=?', now, context.ticketHash, now, session.user_id); if (changed.changes !== 1) throw httpError(403, 'launch_ticket_rejected'); }
        this.store.run('INSERT INTO matches(id,owner_key,creation_request_id,creation_body_hash,user_id,competition_key,board_preset,ai_difficulty,guild_id,channel_id,config_json,private_state_json,phase,ranked_requested,eligibility_reasons_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', row.id, owner, row.creation_request_id, bodyHash, row.user_id, row.competition_key, row.board_preset, row.ai_difficulty, row.guild_id, row.channel_id, JSON.stringify(config), row.private_state_json, 'ready', row.ranked_requested, row.eligibility_reasons_json, now);
        if (context?.ticketHash) { const {ticketHash, ...grant} = context; session.data.context = grant; saveSession(this.store, session); }
      });
      const m = this.hydrate(this.store.match(row.id)); this.active.set(row.id, m); this.audit('game_created', m, {mode: options.mode, difficulty: options.aiDifficulty, preset: options.boardPreset}); return this.view(m);
    });
  }
  elapsed(m) { return m.state.phase === 'ready' ? 0 : m.state.phase === 'complete' ? m.state.finishedAtMs : Math.max(m.state.lastAtMs, Math.max(0, this.now() - m.row.started_at)); }
  view(m) {
    const row = this.store.match(m.state.id) || m.row;
    return {...observeMatch(m.state), elapsedMs: this.elapsed(m), lastEventAtMs: m.state.lastAtMs, serverNow: this.now(), startedAt: row.started_at, seq: m.events.length, eligibility: {requested: Boolean(row.ranked_requested), eligible: Boolean(row.eligible), verification: row.verification, reasons: [...m.reasons]}, opponent: this.config.jevKey ? m.reasons.some(x => x === 'jev_fallback' || x === 'provider_budget') ? 'JEV with local fallback — unofficial' : 'JEV + visible-state constraint solver' : 'Local heuristic — not JEV', decision: publicDecision(m.lastDecision || m.events.findLast(e => e.decision)?.decision), context: row.guild_id ? {guildId: row.guild_id, channelId: row.channel_id} : null};
  }
  emit(m) {
    const snapshot = this.view(m), set = this.subscribers.get(m.state.id);
    for (const callback of set || []) { try { callback(snapshot); } catch {} }
  }
  subscribe(id, owner, callback) {
    const m = this.load(id, owner); m.lastSeen = this.now();
    let set = this.subscribers.get(id); if (!set) { set = new Set(); this.subscribers.set(id, set); }
    if (set.size >= 4) throw httpError(429, 'too_many_streams');
    set.add(callback); this.audit('stream_open', m); callback(this.view(m));
    return () => { set.delete(callback); if (!set.size) this.subscribers.delete(id); m.lastSeen = this.now(); };
  }
  async commit(m, event, requestBodyHash = null) {
    m.events.push(event); const completed = m.state.phase === 'complete';
    const result = completed ? resultOf(m.state) : null;
    this.store.transaction(() => {
      this.store.run('INSERT INTO match_events(match_id,seq,request_id,request_body_hash,event_json) VALUES(?,?,?,?,?)', m.state.id, event.seq, event.requestId, requestBodyHash, JSON.stringify(event));
      this.store.run('UPDATE matches SET private_state_json=?,phase=?,started_at=?,finished_at=?,outcome=?,outcome_reason=?,human_clear_ms=?,result_json=?,sealed_head_hash=?,eligibility_reasons_json=? WHERE id=?', JSON.stringify(m.state), m.state.phase, m.row.started_at, completed ? m.row.started_at === null ? this.now() : m.row.started_at + m.state.finishedAtMs : null, m.state.outcome, m.state.outcomeReason, result?.humanClearMs ?? null, result ? JSON.stringify(result) : null, completed ? event.hash : null, JSON.stringify(m.reasons), m.state.id);
    });
    this.emit(m);
    if (completed) await this.seal(m);
  }
  replayFor(m) {
    const row = this.store.match(m.state.id);
    return exportReplay(m.state, m.events, {createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, competitionKey: row.competition_key, eligible: Boolean(row.eligible), eligibilityReasons: m.reasons, verification: row.verification, scope: row.guild_id ? {guildId: row.guild_id, channelId: row.channel_id} : {world: true}});
  }
  async seal(m) {
    m.pending = null; m.readyDecision = null;
    if (m.state.openingOnly) this.unrank(m, 'opening_only_clear');
    if (m.state.outcome === 'void') this.unrank(m, m.state.outcomeReason);
    this.audit('game_completed', m, {outcome: m.state.outcome, reason: m.state.outcomeReason});
    try {
      await this.workers.run('verify', {replay: this.replayFor(m)});
      const eligible = m.row.ranked_requested && m.row.user_id && !m.reasons.length && m.state.outcome !== 'void';
      this.store.run("UPDATE matches SET verification='verified',eligible=? WHERE id=?", Number(Boolean(eligible)), m.state.id);
      this.audit('score_verified', m, {eligible: Boolean(eligible)});
    } catch (e) {
      this.unrank(m, 'verification_failed'); this.store.run("UPDATE matches SET verification='rejected',eligible=0 WHERE id=?", m.state.id); this.audit('verification_failed', m, {code: e.code || e.message});
    }
    this.active.delete(m.state.id); this.emit(m);
  }
  prepare(m) {
    if (this.closed || m.state.phase !== 'running' || m.state.boards.jev.status !== 'active' || m.pending || m.readyDecision) return;
    const marker = {}, observation = observeBoard(m.state.boards.jev); m.pending = marker;
    this.chooser({observation, difficulty: m.state.config.aiDifficulty, config: this.config, workers: this.workers, forceLocal: m.providerCalls >= this.config.maxCallsPerMatch}).then(decision => {
      if (m.pending !== marker || m.state.phase !== 'running') return;
      m.pending = null; m.readyDecision = decision; m.providerCalls += decision.attempts.length;
      this.audit('jev_decision_ready', m, {source: decision.source, latencyMs: decision.latencyMs, attempts: decision.attempts.length});
    }).catch(e => {
      if (m.pending !== marker || m.state.phase !== 'running' || this.closed) return;
      m.pending = null; this.unrank(m, 'solver_failure'); this.audit('jev_solver_failure', m, {code: e.code || 'solver_failure'});
      // No silent random move: worker faults remain visible and the coordinator retries.
      m.nextDue = this.elapsed(m) + 1000;
    });
  }
  async terminalIfDue(m, atMs) {
    const next = clone(m.state);
    if (adjudicate(next, atMs)) { m.state = next; await this.commit(m, await makeEvent(m.events, 'adjudicate', 'system', atMs)); return true; }
    return false;
  }
  async action(id, owner, body) {
    return this.lock(id, async () => {
      const m = this.load(id, owner); m.lastSeen = this.now();
      const bodyHash = await digest(body);
      const existing = this.store.get('SELECT request_body_hash,event_json FROM match_events WHERE match_id=? AND request_id=?', id, body.requestId);
      if (existing) { if (existing.request_body_hash !== bodyHash) throw httpError(409, 'idempotency_conflict'); this.audit('idempotent_retry', m); return {acceptedSeq: JSON.parse(existing.event_json).seq, idempotent: true, snapshot: this.view(m)}; }
      if (m.state.phase === 'complete') throw httpError(409, 'match_complete');
      const atMs = this.elapsed(m);
      if (m.state.phase === 'running' && await this.terminalIfDue(m, atMs)) throw httpError(409, 'match_complete');
      if (body.action.type === 'start') {
        if (m.state.phase !== 'ready') throw httpError(409, 'already_started');
        const next = clone(m.state); await startMatch(next, body.action.cell); m.state = next; m.row.started_at = this.now(); m.nextDue = 1000;
        await this.commit(m, await makeEvent(m.events, 'start', 'human', 0, {cell: body.action.cell}, null, body.requestId), bodyHash);
        this.audit('game_started', m); this.prepare(m);
      } else if (body.action.type === 'resign') {
        if (m.state.phase === 'ready') { finish(m.state, 'void', 'ready_expired', 0); this.unrank(m, 'ready_cancelled'); await this.commit(m, await makeEvent(m.events, 'void', 'system', 0, {reason: 'ready_expired'}, null, body.requestId), bodyHash); }
        else { finish(m.state, 'loss', 'resigned', atMs); await this.commit(m, await makeEvent(m.events, 'resign', 'human', atMs, {}, null, body.requestId), bodyHash); }
      } else {
        if (m.state.phase !== 'running') throw httpError(409, 'not_running');
        if (body.expectedBoardRevision !== m.state.boards.human.revision) throw httpError(409, 'stale_board_revision');
        if (m.events.length >= this.config.maxActions) throw httpError(429, 'match_action_limit');
        const expectedRevision = m.state.boards.human.revision, next = clone(m.state);
        applyMatchAction(next, 'human', body.action, atMs); m.state = next;
        await this.commit(m, await makeEvent(m.events, 'action', 'human', atMs, {expectedRevision, action: body.action}, null, body.requestId), bodyHash);
      }
      return {acceptedSeq: m.events.length, idempotent: false, snapshot: this.view(m)};
    });
  }
  async tick(id) {
    return this.lock(id, async () => {
      const m = this.active.get(id); if (!m || m.state.phase === 'complete' || this.closed) return;
      if (m.state.phase === 'ready') {
        if (this.now() - m.row.created_at >= this.config.readyLifetimeMs) { finish(m.state, 'void', 'ready_expired', 0); this.unrank(m, 'ready_expired'); await this.commit(m, await makeEvent(m.events, 'void', 'system', 0, {reason: 'ready_expired'})); }
        return;
      }
      const atMs = this.elapsed(m);
      if (await this.terminalIfDue(m, atMs)) return;
      if (!this.subscribers.get(id)?.size && this.now() - m.lastSeen >= this.config.disconnectGraceMs) {
        finish(m.state, 'loss', 'abandoned', atMs); await this.commit(m, await makeEvent(m.events, 'abandon', 'system', atMs)); return;
      }
      if (m.events.length >= this.config.maxActions) {
        finish(m.state, 'void', 'action_limit', atMs); this.unrank(m, 'action_limit'); await this.commit(m, await makeEvent(m.events, 'void', 'system', atMs, {reason: 'action_limit'})); return;
      }
      if (m.state.boards.jev.status !== 'active') return;
      this.prepare(m);
      if (atMs < m.nextDue) return;
      if (atMs - m.nextDue > this.config.lateToleranceMs && !m.misses.has(m.state.boards.jev.revision)) {
        m.misses.add(m.state.boards.jev.revision); this.unrank(m, 'scheduling_miss'); this.audit('scheduling_miss', m, {lateMs: atMs - m.nextDue}); this.emit(m);
      }
      const d = m.readyDecision; if (!d) return;
      m.readyDecision = null;
      if (d.boardRevision !== m.state.boards.jev.revision || d.observationHash !== await digest(observeBoard(m.state.boards.jev))) { this.unrank(m, 'stale_jev_decision'); this.audit('stale_jev_decision', m); return; }
      if (d.fallback) this.unrank(m, 'jev_fallback');
      d.scheduledAtMs = m.nextDue; d.appliedAtMs = atMs; d.schedulingLagMs = atMs - m.nextDue;
      const expectedRevision = m.state.boards.jev.revision, next = clone(m.state);
      applyMatchAction(next, 'jev', d.selected.action, atMs); m.state = next; m.lastDecision = d;
      await this.commit(m, await makeEvent(m.events, 'action', 'jev', atMs, {expectedRevision, action: d.selected.action}, d));
      m.nextDue = atMs + m.state.config.jevIntervalMs; this.prepare(m);
    });
  }
  tickAll() {
    for (const id of this.active.keys()) {
      if (this.locks.has(id)) continue;
      this.tick(id).catch(e => { const m = this.active.get(id); if (m && !this.closed) { this.unrank(m, 'coordinator_error'); this.audit('coordinator_error', m, {code: e.code || 'internal_error'}); } });
    }
  }
  async analytics(id, owner) {
    const m = this.load(id, owner), row = this.store.match(id);
    if (m.state.phase !== 'complete') throw httpError(409, 'analytics_available_after_match');
    if (row.verification !== 'verified') throw httpError(409, 'replay_not_verified');
    if (row.analytics_json) return JSON.parse(row.analytics_json);
    if (!this.analyticsJobs.has(id)) {
      const job = this.workers.run('analytics', {replay: this.replayFor(m), options: {audits: this.store.audits(id), pricePerMillion: this.config.pricePerMillion, verified: true}}).then(result => { this.store.run('UPDATE matches SET analytics_json=? WHERE id=?', JSON.stringify(result), id); return result; }).finally(() => this.analyticsJobs.delete(id));
      this.analyticsJobs.set(id, job);
    }
    return this.analyticsJobs.get(id);
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled([...this.locks.values()]);
    for (const m of this.active.values()) {
      if (m.state.phase === 'complete') continue;
      const atMs = this.elapsed(m);
      finish(m.state, 'void', 'server_restart', atMs); this.unrank(m, 'server_restart');
      try { await this.commit(m, await makeEvent(m.events, 'void', 'system', atMs, {reason: 'server_restart'})); } catch {}
    }
  }
}
