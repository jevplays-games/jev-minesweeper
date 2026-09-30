import {digest} from '../public/shared/engine.js';
import {decisionSurface, POLICY_VERSION} from '../public/shared/solver.js';
import {buildRequest, validateResponse, selectCandidate} from '../public/shared/decisions.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const utf8Length = text => new TextEncoder().encode(text).length;
function error(code) { return Object.assign(new Error(code), {code}); }
async function boundedJson(response, maxBytes = 262144) {
  if (!response.body?.getReader) return response.json(); // Injectable mock Response support.
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try { while (true) { const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > maxBytes) throw error('invalid_response_size'); chunks.push(value); } }
  finally { reader.releaseLock(); }
  const all = new Uint8Array(length); let offset = 0; for (const c of chunks) { all.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw error('invalid_json'); }
}
/**
 * Picks the opponent's action for one public observation. The model only chooses among candidates the solver supplied and its answer is
 * validated against them; it never receives hidden state. `source` is 'jev' only when a real, validated model response was used.
 *  - forceLocal: the per-match or daily provider budget is spent -> local ranking, flagged as a fallback.
 *  - degraded:   an earlier attempt at this position died (e.g. exceeded the host's CPU limit) -> cheapest solver budget, never ranked.
 */
export async function chooseJevAction({observation, difficulty, config, fetchImpl = (...a) => fetch(...a), forceLocal = false, degraded = false}) {
  const began = performance.now(), solverStart = performance.now();
  const surface = decisionSurface(observation, difficulty, degraded ? {variables: 0, nodes: 0} : {});
  const solverMs = performance.now() - solverStart;
  const {request, candidates} = buildRequest(observation, surface, config.model);
  const decision = {id: crypto.randomUUID(), policyVersion: POLICY_VERSION, model: config.model, boardRevision: observation.revision, observationHash: await digest(observation), candidates, legalCount: surface.legalCount, solver: {nodes: surface.analysis.nodes, exactComplete: surface.analysis.exactComplete, cutoffReason: surface.analysis.cutoffReason, components: surface.analysis.components, largestComponent: surface.analysis.largestComponent ?? 0, safeCount: surface.analysis.safe.length}, solverMs, requestBytes: utf8Length(JSON.stringify(request)), source: 'local', fallback: false, errorCode: null, attempts: [], response: null, selected: null, latencyMs: 0};
  if (degraded) { decision.errorCode = 'cpu_guard'; decision.fallback = true; }
  else if (candidates.length === 1) decision.source = 'forced';
  else if (!config.jevKey || forceLocal) { decision.errorCode = forceLocal ? 'provider_budget' : 'not_configured'; decision.fallback = Boolean(config.jevKey); }
  else {
    const end = performance.now() + config.providerTimeoutMs;
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now(), entry = {attempt: attempt + 1, status: null, errorCode: null, latencyMs: 0, usage: null};
      let retryable = false, wait = 150 * 2 ** attempt;
      try {
        const remaining = Math.floor(end - performance.now()); if (remaining <= 0) throw error('timeout');
        const response = await fetchImpl(config.jevEndpoint, {method: 'POST', headers: {'Authorization': `Bearer ${config.jevKey}`, 'Content-Type': 'application/json'}, body: JSON.stringify(request), signal: AbortSignal.timeout(remaining)});
        entry.status = response.status;
        if (!response.ok) {
          retryable = [429, 500, 502, 503, 504, 529].includes(response.status);
          const retryAfter = response.headers?.get('retry-after');
          if (retryAfter) { const seconds = Number(retryAfter); wait = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()); }
          await response.body?.cancel?.(); throw error(`http_${response.status}`);
        }
        const body = await boundedJson(response);
        // Only retain validated token counts; an invalid payload cannot forge billing data.
        if (body.usage && ['input_tokens','output_tokens'].every(k => Number.isSafeInteger(body.usage[k]) && body.usage[k] >= 0)) entry.usage = body.usage;
        decision.response = validateResponse(body, request); decision.source = 'jev'; decision.errorCode = null;
      } catch (e) {
        entry.errorCode = ['TimeoutError', 'AbortError'].includes(e.name) ? 'timeout' : typeof e.code === 'string' ? e.code : 'network_error';
        decision.errorCode = entry.errorCode; decision.response = null;
        if (entry.errorCode === 'network_error') retryable = true;
      }
      entry.latencyMs = performance.now() - start; decision.attempts.push(entry);
      if (decision.source === 'jev') break;
      if (attempt === 0 && retryable && Number.isFinite(wait) && wait >= 0 && performance.now() + wait + 50 < end) await delay(wait);
      else break;
    }
    if (decision.source !== 'jev') decision.fallback = true;
  }
  decision.selected = selectCandidate(candidates, decision.response).selected;
  if (!decision.selected) throw error('no_legal_candidate');
  decision.latencyMs = performance.now() - began;
  return decision;
}
