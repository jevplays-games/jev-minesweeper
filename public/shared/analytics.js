/** Exhaustive recorded-event analytics. Truth-derived fields are computed ONLY after sealing. */
import {createMatch, observeBoard, neighbors} from './engine.js';
import {applyRecordedEvent, verifyReplay} from './replay.js';
import {analyzeObservation} from './solver.js';
export const ANALYTICS_VERSION = 'ms-analytics-1.1.0';
export const ratio = (n, d) => d > 0 ? n / d : null;
export const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function quantile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b), index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index); return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
export function distribution(xs) {
  xs = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  const average = mean(xs);
  return {count: xs.length, sum: xs.reduce((a, b) => a + b, 0), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null, mean: average, p50: quantile(xs, .5), p90: quantile(xs, .9), p95: quantile(xs, .95), p99: quantile(xs, .99), populationStdDev: average === null ? null : Math.sqrt(mean(xs.map(x => (x - average) ** 2)))};
}
export function wilson(wins, games, z = 1.959963984540054) {
  if (!games) return {lower: null, upper: null};
  const p = wins / games, d = 1 + z * z / games, center = (p + z * z / (2 * games)) / d;
  const margin = z / d * Math.sqrt(p * (1 - p) / games + z * z / (4 * games * games));
  return {lower: Math.max(0, center - margin), upper: Math.min(1, center + margin)};
}
export function calibration(samples) {
  const bins = Array.from({length: 10}, (_, i) => ({lower: i / 10, upper: (i + 1) / 10, count: 0, predictionSum: 0, successes: 0}));
  for (const {p, y} of samples) {
    const b = bins[Math.min(9, Math.floor(p * 10))]; b.count++; b.predictionSum += p; b.successes += y;
  }
  const reliability = bins.map(b => ({...b, meanPrediction: ratio(b.predictionSum, b.count), observedFrequency: ratio(b.successes, b.count)}));
  return {count: samples.length, brier: mean(samples.map(s => (s.p - s.y) ** 2)), logLoss: mean(samples.map(s => -(s.y * Math.log(Math.max(1e-12, s.p)) + (1 - s.y) * Math.log(Math.max(1e-12, 1 - s.p))))), expectedCalibrationError: samples.length ? reliability.reduce((sum, b) => sum + b.count / samples.length * Math.abs((b.meanPrediction ?? 0) - (b.observedFrequency ?? 0)), 0) : null, bins: reliability};
}
function boardStructure(board, firstCell) {
  const n = board.mines.length, visited = new Set(), openingSizes = [], openingCells = new Set();
  for (let i = 0; i < n; i++) {
    if (board.mines[i] || board.adjacent[i] !== 0 || visited.has(i)) continue;
    const queue = [i], component = new Set([i]); visited.add(i);
    for (let p = 0; p < queue.length; p++) for (const c of neighbors(queue[p], board.width, board.height)) {
      if (board.mines[c]) continue;
      component.add(c);
      if (board.adjacent[c] === 0 && !visited.has(c)) { visited.add(c); queue.push(c); }
    }
    for (const c of component) openingCells.add(c);
    openingSizes.push(component.size);
  }
  const isolatedNumbers = board.mines.reduce((sum, mine, i) => sum + (!mine && board.adjacent[i] > 0 && !openingCells.has(i) ? 1 : 0), 0);
  const histogram = Array(9).fill(0);
  board.adjacent.forEach((v, i) => { if (!board.mines[i]) histogram[v]++; });
  const corner = i => [0, board.width - 1, n - board.width, n - 1].includes(i);
  const edge = i => i < board.width || i >= n - board.width || i % board.width === 0 || i % board.width === board.width - 1;
  return {width: board.width, height: board.height, cellCount: n, mineCount: board.mineCount, mineDensity: board.mineCount / n, safeCellCount: n - board.mineCount, zeroCells: histogram[0], adjacencyHistogram: histogram, zeroRegions: openingSizes.length, openingSizeDistribution: distribution(openingSizes), isolatedNumberCells: isolatedNumbers, threeBV: openingSizes.length + isolatedNumbers, edgeMines: board.mines.reduce((s, m, i) => s + (m && edge(i) ? 1 : 0), 0), cornerMines: board.mines.reduce((s, m, i) => s + (m && corner(i) ? 1 : 0), 0), firstCell, firstCellRow: Math.floor(firstCell / board.width) + 1, firstCellColumn: firstCell % board.width + 1};
}
function newPlayer(n) {
  return {actions: 0, reveals: 0, flagsPlaced: 0, flagsRemoved: 0, chords: 0, safeChords: 0, unsafeChords: 0, correctFlagPlacements: 0, incorrectFlagPlacements: 0, incorrectFlagsRemoved: 0, correctFlagsRemoved: 0, safeCellsFromActions: 0, safeCellsFromOpening: 0, zeroExpansionActions: 0, zeroExpansionCells: 0, uncertainRevealActions: 0, provenSafeRevealActions: 0, knownMineRevealActions: 0, uncertainSurvivals: 0, uncertainExplosions: 0, uncertainRevealsWhileProvenSafeAvailable: 0, explodedWhileProvenSafeAvailable: 0, exactRiskCoveredActions: 0, exactRiskRegret: [], actionTimes: [], gaps: [], yields: [], risks: [], frontierSizes: [], componentSizes: [], availableSafeCounts: [], heatmaps: {commands: Array(n).fill(0), revealAtMs: Array(n).fill(null), flagPlacements: Array(n).fill(0), uncertainReveals: Array(n).fill(0)}, terminalAtMs: null, status: 'ready'};
}
/** Event-stream computation; supports worker execution. No network inference is performed. */
export async function analyzeReplay(replay, {audits = [], pricePerMillion = null, verified = false} = {}) {
  if (!verified) await verifyReplay(replay);
  if (!replay.result || replay.result.outcome === null) throw new Error('analytics_require_sealed_replay');
  const state = await createMatch(replay.config, replay.seeds, replay.matchId);
  const n = state.config.width * state.config.height;
  const players = {human: newPlayer(n), jev: newPlayer(n)}, timeline = [], actions = [], structures = {};
  const jevDecisions = [], selectedSafety = [], allSafety = [];
  const race = {humanAheadMs: 0, jevAheadMs: 0, tiedMs: 0, leadChanges: 0, humanPeakLeadCells: 0, jevPeakLeadCells: 0, humanLeadAreaCellMs: 0};
  let lastTime = 0, lastLead = 0, lastNonzeroSign = 0;
  for (const event of replay.events) {
    const dt = event.atMs - lastTime;
    if (lastLead > 0) race.humanAheadMs += dt; else if (lastLead < 0) race.jevAheadMs += dt; else race.tiedMs += dt;
    race.humanLeadAreaCellMs += lastLead * dt;
    if (event.type === 'action') {
      const b = state.boards[event.actor], p = players[event.actor], action = event.payload.action;
      const observation = observeBoard(b), before = b.revealedSafe, analysis = analyzeObservation(observation, 'jev');
      const flagsBefore = b.flags.reduce((a, b) => a + b, 0), atCell = action.cell;
      const risk = analysis.risks[atCell];
      const isReveal = action.type === 'reveal';
      const safeAvailable = analysis.safe.filter(i => !b.flags[i]).length;
      const uncertain = isReveal && !analysis.safe.includes(atCell) && !analysis.mines.includes(atCell);
      const exactValues = Object.values(analysis.risks).filter(r => ['exact', 'proof'].includes(r.source)).map(r => r.value);
      const minKnownRisk = exactValues.length ? Math.min(...exactValues) : null;
      p.actions++; p.actionTimes.push(event.atMs); p.gaps.push(event.atMs - (p.actionTimes.at(-2) ?? 0));
      p.heatmaps.commands[atCell]++; p.frontierSizes.push(analysis.frontier.length); p.componentSizes.push(analysis.largestComponent ?? 0); p.availableSafeCounts.push(safeAvailable);
      if (isReveal) {
        p.reveals++;
        if (uncertain) { p.uncertainRevealActions++; p.heatmaps.uncertainReveals[atCell]++; if (safeAvailable) p.uncertainRevealsWhileProvenSafeAvailable++; }
        else if (analysis.safe.includes(atCell)) p.provenSafeRevealActions++; else p.knownMineRevealActions++;
        if (risk && ['exact', 'proof'].includes(risk.source)) { p.exactRiskCoveredActions++; p.risks.push(risk.value); if (minKnownRisk !== null) p.exactRiskRegret.push(Math.max(0, risk.value - minKnownRisk)); }
      } else if (action.type === 'chord') p.chords++;
      else if (action.value) { p.flagsPlaced++; p.heatmaps.flagPlacements[atCell]++; if (b.mines[atCell]) p.correctFlagPlacements++; else p.incorrectFlagPlacements++; }
      else { p.flagsRemoved++; if (b.mines[atCell]) p.correctFlagsRemoved++; else p.incorrectFlagsRemoved++; }
      const revealedBefore = [...b.revealed];
      await applyRecordedEvent(state, event);
      const safeDelta = b.revealedSafe - before, exploded = b.status === 'exploded';
      p.safeCellsFromActions += safeDelta; p.yields.push(safeDelta);
      for (let i = 0; i < n; i++) if (!revealedBefore[i] && b.revealed[i]) p.heatmaps.revealAtMs[i] = event.atMs;
      if (isReveal && safeDelta > 1) { p.zeroExpansionActions++; p.zeroExpansionCells += safeDelta - 1; }
      if (action.type === 'chord') { if (exploded) p.unsafeChords++; else p.safeChords++; }
      if (uncertain) { if (exploded) p.uncertainExplosions++; else p.uncertainSurvivals++; }
      if (exploded && safeAvailable) p.explodedWhileProvenSafeAvailable++;
      actions.push({seq: event.seq, actor: event.actor, atMs: event.atMs, type: action.type, flagValue: action.value ?? null, cell: atCell, row: Math.floor(atCell / b.width) + 1, column: atCell % b.width + 1, safeDelta, revealedSafe: b.revealedSafe, flagsBefore, flagsAfter: b.flags.reduce((a, b) => a + b, 0), exploded, classification: isReveal ? uncertain ? 'uncertain_under_bounded_solver' : analysis.safe.includes(atCell) ? 'proven_safe' : 'known_mine' : action.type, riskValue: isReveal ? risk?.value ?? null : null, riskSource: isReveal ? risk?.source ?? null : null, provenSafeAvailable: safeAvailable, frontierCells: analysis.frontier.length, componentCount: analysis.components, solverNodes: analysis.nodes, solverExactComplete: analysis.exactComplete, solverCutoff: analysis.cutoffReason, opponentSource: event.decision?.source ?? null, decisionLatencyMs: event.decision?.latencyMs ?? null});
      if (event.decision) {
        const d = event.decision; jevDecisions.push(d);
        for (const c of d.candidates) {
          const answer = d.response?.answers[`safe_${c.id}`];
          if (answer && c.action.type === 'reveal') {
            const sample = {p: answer.noul, y: Number(!b.mines[c.action.cell]), decisionId: d.id, candidate: c.id};
            allSafety.push(sample); if (c.id === d.selected.id) selectedSafety.push(sample);
          }
        }
      }
    } else {
      await applyRecordedEvent(state, event);
      if (event.type === 'start') for (const actor of ['human', 'jev']) {
        const b = state.boards[actor], p = players[actor]; structures[actor] = boardStructure(b, state.firstCell);
        p.safeCellsFromOpening = b.revealedSafe;
        b.revealed.forEach((yes, i) => { if (yes) p.heatmaps.revealAtMs[i] = 0; });
      }
    }
    const h = state.boards.human?.revealedSafe ?? 0, j = state.boards.jev?.revealedSafe ?? 0, lead = h - j;
    race.humanPeakLeadCells = Math.max(race.humanPeakLeadCells, lead); race.jevPeakLeadCells = Math.max(race.jevPeakLeadCells, -lead);
    const sign = Math.sign(lead); if (sign && lastNonzeroSign && sign !== lastNonzeroSign) race.leadChanges++; if (sign) lastNonzeroSign = sign;
    timeline.push({seq: event.seq, atMs: event.atMs, actor: event.actor, event: event.type, humanSafe: h, jevSafe: j, humanLead: lead, humanStatus: state.boards.human?.status ?? 'ready', jevStatus: state.boards.jev?.status ?? 'ready'});
    lastLead = lead; lastTime = event.atMs;
  }
  for (const actor of ['human', 'jev']) {
    const b = state.boards[actor], p = players[actor]; if (!b) continue;
    const flagged = b.flags.reduce((a, b) => a + b, 0), correct = b.flags.reduce((sum, yes, i) => sum + (yes && b.mines[i] ? 1 : 0), 0);
    const activeMs = b.terminalAtMs ?? state.finishedAtMs;
    Object.assign(p, {status: b.status, terminalAtMs: b.terminalAtMs, activeMs, revealedSafe: b.revealedSafe, safeCompletionRate: b.revealedSafe / (n - b.mineCount), clearMs: b.status === 'cleared' ? b.terminalAtMs : null, revealedMineCells: b.revealed.reduce((sum, v, i) => sum + (v && b.mines[i] ? 1 : 0), 0), unrevealedSafeCells: n - b.mineCount - b.revealedSafe, flagsAtEnd: flagged, correctFlagsAtEnd: correct, incorrectFlagsAtEnd: flagged - correct, unflaggedMinesAtEnd: b.mineCount - correct, flagPrecision: ratio(correct, flagged), flagRecall: correct / b.mineCount, flagF1: ratio(2 * correct, flagged + b.mineCount), flagPlacementPrecision: ratio(p.correctFlagPlacements, p.flagsPlaced), flagChurn: p.flagsRemoved, firstActionMs: p.actionTimes[0] ?? null, lastActionMs: p.actionTimes.at(-1) ?? null, commandsPerSecond: ratio(p.actions * 1000, activeMs), safeCellsPerAction: ratio(p.safeCellsFromActions, p.actions), revealYield: distribution(p.yields), inputGapMs: distribution(p.gaps), maximumIdleGapMs: p.gaps.length ? Math.max(...p.gaps) : null, idleGapsOver2s: p.gaps.filter(x => x > 2000).length, idleGapsOver5s: p.gaps.filter(x => x > 5000).length, idleGapsOver10s: p.gaps.filter(x => x > 10000).length, uncertainRevealRate: ratio(p.uncertainRevealActions, p.reveals), uncertainRevealSurvivalRate: ratio(p.uncertainSurvivals, p.uncertainRevealActions), proofCoverage: ratio(p.provenSafeRevealActions + p.knownMineRevealActions, p.reveals), exactRiskCoverage: ratio(p.exactRiskCoveredActions, p.reveals), exactChosenRisk: distribution(p.risks), knownAlternativeRiskRegret: distribution(p.exactRiskRegret), frontierSize: distribution(p.frontierSizes), largestComponent: distribution(p.componentSizes), provenSafeOptions: distribution(p.availableSafeCounts), threeBVPerSecondOnClear: b.status === 'cleared' ? ratio(structures[actor].threeBV * 1000, b.terminalAtMs) : null, explodedCell: b.explodedCell});
    delete p.actionTimes; delete p.gaps; delete p.yields; delete p.risks; delete p.exactRiskRegret; delete p.frontierSizes; delete p.componentSizes; delete p.availableSafeCounts;
  }
  const countBy = (xs, key) => xs.reduce((acc, x) => { const k = key(x) ?? 'none'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const attempts = jevDecisions.flatMap(d => d.attempts || []), measuredUsages = attempts.filter(a => a.usage), inputTokens = measuredUsages.reduce((s, a) => s + a.usage.input_tokens, 0), outputTokens = measuredUsages.reduce((s, a) => s + a.usage.output_tokens, 0);
  const opponent = {decisions: jevDecisions.length, sourceCounts: countBy(jevDecisions, d => d.source), remoteDecisions: jevDecisions.filter(d => d.source === 'jev').length, forcedDecisions: jevDecisions.filter(d => d.source === 'forced').length, localDecisions: jevDecisions.filter(d => d.source === 'local').length, fallbackDecisions: jevDecisions.filter(d => d.fallback).length, fallbackReasons: countBy(jevDecisions.filter(d => d.fallback), d => d.errorCode), providerAttempts: attempts.length, providerStatusCounts: countBy(attempts, a => String(a.status ?? a.errorCode)), retryCount: jevDecisions.reduce((s, d) => s + Math.max(0, (d.attempts?.length ?? 0) - 1), 0), invalidResponseCount: attempts.filter(a => a.errorCode?.startsWith('invalid') || a.errorCode?.includes('mismatch') || a.errorCode === 'unknown_candidate').length, latencyMs: distribution(jevDecisions.map(d => d.latencyMs)), providerLatencyMs: distribution(attempts.map(a => a.latencyMs)), solverMs: distribution(jevDecisions.map(d => d.solverMs)), candidates: distribution(jevDecisions.map(d => d.candidates.length)), legalActions: distribution(jevDecisions.map(d => d.legalCount)), solverNodes: distribution(jevDecisions.map(d => d.solver?.nodes)), exactEnumerationRate: ratio(jevDecisions.filter(d => d.solver?.exactComplete).length, jevDecisions.length), solverCutoffReasons: countBy(jevDecisions, d => d.solver?.cutoffReason), choiceConfidence: distribution(jevDecisions.map(d => d.response?.answers.preferred_action?.confidence)), selectedRiskSource: countBy(jevDecisions, d => d.selected?.evaluatedRisk?.source), requestBytes: distribution(jevDecisions.map(d => d.requestBytes)), tokenUsage: {inputTokens, outputTokens, measuredAttempts: measuredUsages.length, unknownAttempts: attempts.length - measuredUsages.length}, estimatedCost: {currency: 'USD', configuredInputPricePerMillion: pricePerMillion, amount: pricePerMillion === null ? null : inputTokens / 1e6 * pricePerMillion, scope: 'measured input usage only; not a bill or guaranteed total', usageComplete: measuredUsages.length === attempts.length}, calibration: {selected: calibration(selectedSafety), allEvaluated: calibration(allSafety), warning: 'Safety forecasts only, not Choice confidence. Repeated candidates are correlated; selected and all-evaluated populations differ.'}};
  const operations = {auditEvents: audits.length, types: countBy(audits, a => a.type), rejectedRequests: audits.filter(a => a.type === 'action_rejected').length, rejectionReasons: countBy(audits.filter(a => a.type === 'action_rejected'), a => a.data?.code), idempotentRetries: audits.filter(a => a.type === 'idempotent_retry').length, reconnects: audits.filter(a => a.type === 'stream_open').length - (audits.some(a => a.type === 'stream_open') ? 1 : 0), schedulingMisses: audits.filter(a => a.type === 'scheduling_miss').length, requestLatencyMs: distribution(audits.filter(a => a.type === 'api_request').map(a => a.data?.latencyMs))};
  return {analyticsVersion: ANALYTICS_VERSION, matchId: replay.matchId, generatedFrom: 'sealed authoritative event replay', metadata: replay.metadata, configuration: replay.config, result: replay.result, match: {durationMs: replay.result.finishedAtMs, acceptedEvents: replay.events.length, acceptedCommands: actions.length, mineDensity: replay.config.mineCount / n, independentLayouts: true}, players, boards: structures, race, opponent, operations, timeline, actions, decisionJournal: jevDecisions, limitations: ['Commands are accepted server actions, not physical mouse clicks or client reaction-time measurements.', 'Uncertain means unresolved by the bounded hindsight solver, not proof that guessing was logically necessary.', 'Risk regret compares available exact/proven alternatives only; partial enumeration is never called exact.', '3BV is a static opening-count proxy, not a no-guess guarantee or a rating of logical difficulty.', 'Active time includes network delay and is not a pure human cognition measurement.', 'Calibration on one match can be sparse and correlated. Aggregate matched configurations before interpretation.', 'No live truth-derived analytics are released before the match is sealed.']};
}
export function aggregateMatches(rows) {
  const completed = rows.filter(r => r.outcome && r.outcome !== 'void'), wins = completed.filter(r => r.outcome === 'win').length, losses = completed.filter(r => r.outcome === 'loss').length, draws = completed.filter(r => r.outcome === 'draw').length;
  const clearTimes = completed.map(r => r.human_clear_ms).filter(v => v !== null && v !== undefined);
  let currentStreak = 0, bestStreak = 0, previous = 0;
  for (const r of [...completed].sort((a, b) => a.finished_at - b.finished_at || String(a.id).localeCompare(String(b.id)))) { previous = r.outcome === 'win' ? previous + 1 : 0; bestStreak = Math.max(bestStreak, previous); currentStreak = previous; }
  return {matches: rows.length, completed: completed.length, voided: rows.filter(r => r.outcome === 'void').length, wins, losses, draws, clearWinRate: ratio(wins, completed.length), clearWinRate95PercentWilson: wilson(wins, completed.length), actualClears: clearTimes.length, actualClearRate: ratio(clearTimes.length, completed.length), clearTimeMs: distribution(clearTimes), currentWinStreak: currentStreak, bestWinStreak: bestStreak, verifiedRanked: completed.filter(r => r.eligible && r.verification === 'verified').length};
}
/** CSV formula neutralization applies to strings only; numeric negatives remain numbers. */
export function csv(rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const escape = v => { if (v === null || v === undefined) return ''; if (typeof v === 'object') v = JSON.stringify(v); if (typeof v === 'string' && /^[=+\-@\t\r\n]/.test(v)) v = `'${v}`; const s = String(v); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return columns.map(escape).join(',') + '\r\n' + rows.map(row => columns.map(k => escape(row[k])).join(',')).join('\r\n') + '\r\n';
}
