/** Typed TypeSafe request and strict response validation; reusable by replay verification. */
import {clone, actionId} from './engine.js';
export const MODEL = 'jev-1.13.0';
// Smallest increment the provider reports probabilities and expected scores on.
export const PROBABILITY_GRAIN = 0.01;
export const SCORE_LEVELS = ['Little useful continuation', 'Limited continuation', 'Moderate continuation', 'Strong continuation', 'Very strong continuation'];
const prob = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
function assert(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
function distribution(values, keys) {
  assert(values && typeof values === 'object' && !Array.isArray(values), 'invalid_distribution');
  assert(Object.keys(values).length === keys.length && keys.every(k => Object.hasOwn(values, k) && prob(values[k])), 'invalid_distribution_keys');
  // Each bucket is rounded to the grain, so the sum can drift by half a grain per bucket.
  // This is the worst-case accumulation of that rounding, not slack for arbitrary drift.
  const sumTolerance = keys.length * (PROBABILITY_GRAIN / 2);
  assert(Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - 1) <= sumTolerance, 'invalid_distribution_sum');
}
export function buildRequest(observation, surface, model = MODEL) {
  const candidates = clone(surface.candidates);
  function build() {
    const questions = {preferred_action: {type: 'choice', instructions: 'Choose the candidate action with the strongest continuation opportunity using only the supplied visible Minesweeper evidence. Hidden mines are unknown. Flags are not assumed correct.', criteria: Object.fromEntries(candidates.map(c => [c.id, `Row ${c.row}, column ${c.column}; ${c.action.type}; evidence ${c.evidence.join(', ')}; visible frontier touches ${c.frontierTouches}; covered neighbors ${c.coveredNeighbors}.`]))}};
    for (const c of candidates) {
      if (c.risk.source === 'heuristic' && c.action.type === 'reveal') questions[`safe_${c.id}`] = {type: 'noul', instructions: `Given ONLY the visible evidence, does candidate ${c.id}, row ${c.row} column ${c.column}, reveal no mine?`};
      questions[`progress_${c.id}`] = {type: 'score', instructions: `Assess useful continuation after candidate ${c.id}, row ${c.row} column ${c.column}, conditional on survival. Use the supplied evidence and do not invent hidden information.`, criteria: SCORE_LEVELS};
    }
    return {model, state: {board: {width: observation.width, height: observation.height, mineCount: observation.mineCount, rows: Array.from({length: observation.height}, (_, r) => observation.cells.slice(r * observation.width, (r + 1) * observation.width).map(x => x === -1 ? '#' : x === -2 ? 'F' : String(x)).join(' '))}, legend: '# covered; F player flag (not evidence); digits revealed adjacent mine counts.', constraints: surface.analysis.constraints.slice(0, 80), candidates: candidates.map(({id, action, evidence, risk, frontierTouches, coveredNeighbors}) => ({id, action, evidence, risk: risk.source === 'heuristic' ? {source: 'unknown'} : risk, frontierTouches, coveredNeighbors}))}, questions};
  }
  let request = build();
  while (new TextEncoder().encode(JSON.stringify(request)).length > 24576 && candidates.length > 1) { candidates.pop(); request = build(); }
  assert(candidates.length > 0 && new TextEncoder().encode(JSON.stringify(request)).length <= 24576, 'request_size_limit');
  return {request, candidates};
}
export function validateResponse(response, request) {
  assert(response && response.model === request.model, 'model_mismatch');
  assert(response.answers && typeof response.answers === 'object', 'missing_answers');
  for (const [id, q] of Object.entries(request.questions)) {
    const a = response.answers[id]; assert(a && a.type === q.type, 'answer_type_mismatch');
    if (q.type === 'noul') assert(prob(a.noul), 'invalid_noul');
    else {
      assert(prob(a.confidence), 'invalid_confidence');
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria); distribution(a.probabilities, keys);
        assert(keys.includes(a.choice), 'unknown_candidate');
        assert(a.probabilities[a.choice] + 0.000001 >= Math.max(...Object.values(a.probabilities)), 'choice_not_maximal');
      } else {
        const keys = q.criteria.map((_, i) => String(i)); distribution(a.probabilities, keys);
        assert(a.legend && keys.every(k => a.legend[k] === q.criteria[Number(k)]), 'score_legend_mismatch');
        const expected = keys.reduce((sum, k) => sum + Number(k) * a.probabilities[k], 0);
        // mean = sum(k * p_k); each p_k may be off by half a grain, so the mean can drift by
        // half*sum(k), and the reported score is itself rounded by up to half a grain.
        const half = PROBABILITY_GRAIN / 2, n = keys.length;
        const meanTolerance = half * (n * (n - 1) / 2) + half;
        assert(Number.isFinite(a.score) && a.score >= 0 && a.score <= keys.length - 1 && Math.abs(a.score - expected) <= meanTolerance, 'invalid_score');
      }
    }
  }
  assert(response.usage && ['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(response.usage[k]) && response.usage[k] >= 0), 'invalid_usage');
  return response;
}
export function selectCandidate(candidates, response = null) {
  const evaluated = candidates.map(c => {
    const safety = response?.answers[`safe_${c.id}`]?.noul;
    return {...clone(c), evaluatedRisk: safety === undefined ? c.risk : {value: 1 - safety, source: 'model-estimate'}, continuation: response?.answers[`progress_${c.id}`]?.score ?? c.progress, choiceProbability: response?.answers.preferred_action?.probabilities[c.id] ?? 0};
  });
  evaluated.sort((a, b) => a.group - b.group || a.evaluatedRisk.value - b.evaluatedRisk.value || b.continuation - a.continuation || b.choiceProbability - a.choiceProbability || a.action.cell - b.action.cell || a.id.localeCompare(b.id));
  return {selected: evaluated[0] ?? null, evaluated};
}
export function publicDecision(decision) {
  if (!decision) return null;
  const selected = decision.selected;
  return {id: decision.id, source: decision.source, model: decision.model, selectedActionId: selected?.id ?? null, action: selected?.action ?? null, candidateCount: decision.candidates?.length ?? 0, risk: selected?.evaluatedRisk ?? null, choiceConfidence: decision.response?.answers.preferred_action?.confidence ?? null, continuation: selected?.continuation ?? null, latencyMs: decision.latencyMs, solverMs: decision.solverMs ?? 0, nodes: decision.solver?.nodes ?? 0, exactComplete: decision.solver?.exactComplete ?? false, evidence: selected?.evidence ?? [], fallback: decision.fallback, errorCode: decision.errorCode ?? null, requestBytes: decision.requestBytes ?? 0, inputTokens: decision.response?.usage.input_tokens ?? null};
}
export function sameAction(a, b) { return actionId(a) === actionId(b); }
