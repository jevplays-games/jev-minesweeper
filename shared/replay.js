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
export async function verifyReplay(replay, {checkDecisions = true, allowIncomplete = false} = {}) {
  if (!replay || replay.format !== 'jev-arcade-replay' || replay.version !== REPLAY_VERSION || replay.engineVersion !== ENGINE_VERSION || replay.generatorVersion !== GENERATOR_VERSION || replay.policyVersion !== POLICY_VERSION || !Array.isArray(replay.events) || replay.events.length > 4005) throw new Error('unsupported_replay');
  const state = await createMatch(replay.config, replay.seeds, replay.matchId);
  if (canonical(state.commitments) !== canonical(replay.commitments)) throw new Error('commitment_mismatch');
  let previous = null;
  const requestIds = new Set();
  for (let i = 0; i < replay.events.length; i++) {
    const event = replay.events[i];
    if (event.seq !== i + 1 || event.previousHash !== previous || event.hash !== await eventHash(event)) throw new Error('event_hash_mismatch');
    if (event.requestId) { if (requestIds.has(event.requestId)) throw new Error('duplicate_request_id'); requestIds.add(event.requestId); }
    if (state.phase === 'complete') throw new Error('events_after_completion');
    if (checkDecisions && event.type === 'action' && event.actor === 'jev') {
      const d = event.decision;
      if (!d || d.policyVersion !== POLICY_VERSION || d.model !== state.config.model || d.boardRevision !== state.boards.jev.revision) throw new Error('decision_metadata_mismatch');
      const observation = observeBoard(state.boards.jev);
      if (d.observationHash !== await digest(observation)) throw new Error('observation_hash_mismatch');
      const surface = decisionSurface(observation, state.config.aiDifficulty);
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
    await applyRecordedEvent(state, event); previous = event.hash;
  }
  if (previous !== replay.headHash) throw new Error('head_hash_mismatch');
  if (!allowIncomplete && state.phase !== 'complete') throw new Error('incomplete_replay');
  if (canonical(resultOf(state)) !== canonical(replay.result)) throw new Error('result_mismatch');
  return {verified: true, events: replay.events.length, state};
}
