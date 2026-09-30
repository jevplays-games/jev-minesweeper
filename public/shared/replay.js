import {createMatch, startMatch, applyMatchAction, adjudicate, finish, digest, canonical, observeBoard, ENGINE_VERSION, GENERATOR_VERSION} from './engine.js';
import {decisionSurface, POLICY_VERSION} from './solver.js';
import {buildRequest, validateResponse, selectCandidate, sameAction} from './decisions.js';
export const REPLAY_VERSION = 1;
export async function eventHash(event) {
  const {hash, ...body} = event; return digest(body);
}
export async function makeEvent(events, type, actor, atMs, payload = {}, decision = null, requestId = null) {
  const event = {seq: events.length + 1, type, actor, atMs, payload, decision, requestId, previousHash: events.at(-1)?.hash ?? null};
  event.hash = await eventHash(event); return event;
}
export async function applyRecordedEvent(state, event) {
  if (!Number.isFinite(event.atMs) || event.atMs < state.lastAtMs) throw new Error('non_monotonic_event');
  switch (event.type) {
    case 'start':
      if (event.actor !== 'human' || event.atMs !== 0) throw new Error('invalid_start_event');
      await startMatch(state, event.payload.cell); break;
    case 'action': {
      const board = state.boards[event.actor];
      if (!board || event.payload.expectedRevision !== board.revision) throw new Error('revision_mismatch');
      applyMatchAction(state, event.actor, event.payload.action, event.atMs); break;
    }
    case 'adjudicate':
      if (event.actor !== 'system' || !adjudicate(state, event.atMs)) throw new Error('invalid_terminal_adjudication'); break;
    case 'resign':
      if (event.actor !== 'human') throw new Error('invalid_resignation');
      finish(state, 'loss', 'resigned', event.atMs); break;
    case 'abandon':
      if (event.actor !== 'system') throw new Error('invalid_abandonment');
      finish(state, 'loss', 'abandoned', event.atMs); break;
    case 'void':
      if (event.actor !== 'system' || !['server_restart', 'ready_expired', 'service_shutdown', 'action_limit'].includes(event.payload.reason)) throw new Error('invalid_void');
      if (state.phase === 'ready' && !['server_restart', 'ready_expired'].includes(event.payload.reason)) throw new Error('invalid_ready_void');
      finish(state, 'void', event.payload.reason, event.atMs); break;
    default: throw new Error('unknown_event_type');
  }
  return state;
}
export function resultOf(state) {
  return {outcome: state.outcome, reason: state.outcomeReason, finishedAtMs: state.finishedAtMs, openingOnly: state.openingOnly, humanStatus: state.boards.human?.status ?? 'ready', jevStatus: state.boards.jev?.status ?? 'ready', humanRevealed: state.boards.human?.revealedSafe ?? 0, jevRevealed: state.boards.jev?.revealedSafe ?? 0, humanClearMs: state.boards.human?.status === 'cleared' ? state.boards.human.terminalAtMs : null, jevClearMs: state.boards.jev?.status === 'cleared' ? state.boards.jev.terminalAtMs : null};
}
export function exportReplay(state, events, metadata = {}) {
  if (state.phase !== 'complete') throw new Error('replay_not_sealed');
  return {format: 'jev-arcade-replay', version: REPLAY_VERSION, engineVersion: ENGINE_VERSION, generatorVersion: GENERATOR_VERSION, policyVersion: POLICY_VERSION, matchId: state.id, config: state.config, seeds: state.seeds, commitments: state.commitments, events, headHash: events.at(-1)?.hash ?? null, result: resultOf(state), metadata};
}
/** Incremental replay verifier. Feeding events one at a time (with a JSON cursor between calls) lets a server with a small per-request
 *  CPU budget verify a long match across several requests, while verifyReplay() below stays the single-shot form used everywhere else. */
export class ReplayVerifier {
  constructor(header, state, {checkDecisions = true, previous = null, count = 0} = {}) {
    this.header = header; this.state = state; this.checkDecisions = checkDecisions; this.previous = previous; this.count = count; this.requestIds = new Set();
  }
  static assertHeader(replay) {
    if (!replay || replay.format !== 'jev-arcade-replay' || replay.version !== REPLAY_VERSION || replay.engineVersion !== ENGINE_VERSION || replay.generatorVersion !== GENERATOR_VERSION || replay.policyVersion !== POLICY_VERSION) throw new Error('unsupported_replay');
  }
  static async create(replay, options = {}) {
    ReplayVerifier.assertHeader(replay);
    const state = await createMatch(replay.config, replay.seeds, replay.matchId);
    if (canonical(state.commitments) !== canonical(replay.commitments)) throw new Error('commitment_mismatch');
    return new ReplayVerifier({config: replay.config, seeds: replay.seeds, matchId: replay.matchId}, state, options);
  }
  /** Continue from a persisted cursor: only trusted, server-written cursors may be restored. */
  static restore(cursor, options = {}) { return new ReplayVerifier(cursor.header, cursor.state, {...options, previous: cursor.previous, count: cursor.count}); }
  cursor() { return {header: this.header, state: this.state, previous: this.previous, count: this.count}; }
  async feed(event) {
    const state = this.state;
    if (event.seq !== this.count + 1 || event.previousHash !== this.previous || event.hash !== await eventHash(event)) throw new Error('event_hash_mismatch');
    if (event.requestId) { if (this.requestIds.has(event.requestId)) throw new Error('duplicate_request_id'); this.requestIds.add(event.requestId); }
    if (state.phase === 'complete') throw new Error('events_after_completion');
    if (this.checkDecisions && event.type === 'action' && event.actor === 'jev') {
      const d = event.decision;
      if (!d || d.policyVersion !== POLICY_VERSION || d.model !== state.config.model || d.boardRevision !== state.boards.jev.revision) throw new Error('decision_metadata_mismatch');
      const observation = observeBoard(state.boards.jev);
      if (d.observationHash !== await digest(observation)) throw new Error('observation_hash_mismatch');
      // A cpu_guard decision ran under a reduced solver budget; the verifier can only ever tighten the policy, never widen it.
      const surface = decisionSurface(observation, state.config.aiDifficulty, degradedOverrides(d));
      const built = buildRequest(observation, surface, d.model);
      if (canonical(built.candidates) !== canonical(d.candidates)) throw new Error('candidate_mismatch');
      let expected;
      if (d.source === 'jev') {
        validateResponse(d.response, built.request);
        if (d.fallback) throw new Error('remote_fallback_contradiction');
        expected = selectCandidate(built.candidates, d.response).selected;
      } else if (['forced', 'local'].includes(d.source)) {
        if (d.source === 'forced' && built.candidates.length !== 1) throw new Error('false_forced_decision');
        expected = selectCandidate(built.candidates).selected;
      } else throw new Error('unsupported_decision_source');
      if (!expected || canonical(expected) !== canonical(d.selected) || !sameAction(expected.action, event.payload.action)) throw new Error('decision_selection_mismatch');
    }
    await applyRecordedEvent(state, event); this.previous = event.hash; this.count++;
  }
  async finish({headHash, result, allowIncomplete = false}) {
    if (this.previous !== headHash) throw new Error('head_hash_mismatch');
    if (!allowIncomplete && this.state.phase !== 'complete') throw new Error('incomplete_replay');
    if (canonical(resultOf(this.state)) !== canonical(result)) throw new Error('result_mismatch');
    return {verified: true, events: this.count, state: this.state};
  }
}
/** Solver overrides a recorded decision may legitimately carry: only the reduced budget of an explicitly flagged (unranked) cpu_guard decision. */
export function degradedOverrides(decision) {
  return decision?.errorCode === 'cpu_guard' && decision.fallback === true ? {variables: 0, nodes: 0} : {};
}
export async function verifyReplay(replay, {checkDecisions = true, allowIncomplete = false} = {}) {
  ReplayVerifier.assertHeader(replay);
  if (!Array.isArray(replay.events) || replay.events.length > 4005) throw new Error('unsupported_replay');
  const verifier = await ReplayVerifier.create(replay, {checkDecisions});
  for (const event of replay.events) await verifier.feed(event);
  return verifier.finish({headHash: replay.headHash, result: replay.result, allowIncomplete});
}
