/** Solver consumes public observations ONLY. Flags are annotations, never assumed mines. */
import {neighbors, actionId, getLegalActions} from './engine.js';
export const POLICY_VERSION = 'ms-policy-1.1.0';
export const BUDGETS = Object.freeze({
  easy: {candidates: 8, subsets: false, variables: 0, nodes: 0},
  normal: {candidates: 16, subsets: true, variables: 0, nodes: 0},
  hard: {candidates: 24, subsets: true, variables: 18, nodes: 8000},
  jev: {candidates: 32, subsets: true, variables: 24, nodes: 20000}
});
// Propagation rounds are capped so that one decision has a bounded cost on a small-CPU host (expert boards settle in at most 10).
const MAX_ROUNDS = 10;
// Constraint identity is a fixed-seed Zobrist signature of the cell set (two 32-bit XOR words, folded to 53 bits). It is deterministic, so
// the server, the replay verifier and the browser always agree, and the signature of "superset minus subset" needs no 400-cell join.
const Z1 = new Int32Array(512), Z2 = new Int32Array(512);
{ let x = 0x9e3779b9; const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x | 0; }; for (let i = 0; i < 512; i++) { Z1[i] = next(); Z2[i] = next(); } }
// Binomial rows are pure functions of n, so they are memoised per isolate (bounded) instead of recomputed in the risk loops.
const ROWS = new Map();
function row(n) {
  let r = ROWS.get(n);
  if (r) return r;
  r = Array(n + 1); r[0] = 1n;
  for (let k = 0; k < n; k++) r[k + 1] = r[k] * BigInt(n - k) / BigInt(k + 1);
  if (ROWS.size >= 96) ROWS.clear();
  ROWS.set(n, r); return r;
}
export function choose(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0n;
  return row(n)[k];
}
function convolve(a, b) {
  const result = Array(a.length + b.length - 1).fill(0n);
  a.forEach((x, i) => b.forEach((y, j) => { result[i + j] += x * y; })); return result;
}
function enumerate(cells, constraints, budget) {
  const index = new Map(cells.map((c, i) => [c, i]));
  const cs = constraints.map(c => ({ids: c.cells.map(x => index.get(x)), total: c.total}));
  const counts = Array(cells.length + 1).fill(0n), mines = cells.map(() => Array(cells.length + 1).fill(0n));
  const assignment = Array(cells.length).fill(-1); let complete = true;
  function dfs(pos, used) {
    if (++budget.used > budget.max) { complete = false; return; }
    for (const c of cs) {
      let s = 0, left = 0;
      for (const i of c.ids) { if (assignment[i] === -1) left++; else s += assignment[i]; }
      if (s > c.total || s + left < c.total) return;
    }
    if (pos === cells.length) {
      counts[used]++; assignment.forEach((v, i) => { if (v === 1) mines[i][used]++; }); return;
    }
    for (const v of [0, 1]) { assignment[pos] = v; dfs(pos + 1, used + v); if (!complete) break; }
    assignment[pos] = -1;
  }
  dfs(0, 0); return {cells, counts, mines, complete};
}
export function analyzeObservation(observation, difficulty = 'normal', overrides = {}) {
  const budget = {...BUDGETS[difficulty], ...overrides};
  if (!BUDGETS[difficulty]) throw new Error('Unknown difficulty');
  const {cells, width, height, mineCount} = observation;
  const hidden = cells.map((x, i) => x < 0 && x !== -3 ? i : -1).filter(i => i >= 0);
  const safe = new Set(), mines = new Set();
  const originals = cells.flatMap((value, i) => value >= 0 ? [{cells: neighbors(i, width, height).filter(c => cells[c] === -1 || cells[c] === -2), total: value, source: i}] : []);
  const exploded = cells.filter(x => x === -3).length;
  // Active observations never contain exploded cells. Keep terminal analysis conservative.
  if (exploded || observation.status !== 'active') return {safe: [], mines: [], risks: {}, constraints: [], frontier: [], components: 0, nodes: 0, exactComplete: false, cutoffReason: 'inactive', contradiction: false};
  let constraints = [], contradiction = false;
  const globalConstraint = {cells: hidden, total: mineCount, source: 'global'};
  let rounds = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds++;
    let changed = false; const seen = new Map();
    function commit(length, a, b, make, total, source) {
      if (total < 0 || total > length) { contradiction = true; return; }
      if (!length) { if (total !== 0) contradiction = true; return; }
      const key = (a >>> 0) * 2097152 + ((b >>> 0) & 2097151), old = seen.get(key); // 53-bit signature
      if (old) { if (old.total !== total) contradiction = true; return; }
      if (seen.size < 512) seen.set(key, {cells: make(), total, source, a, b});
    }
    // Every caller passes a fresh, ascending list.
    function add(list, total, source) { let a = 0, b = 0; for (const x of list) { a ^= Z1[x]; b ^= Z2[x]; } commit(list.length, a, b, () => list, total, source); }
    const known = safe.size + mines.size > 0;
    for (let n = 0; n <= originals.length; n++) {
      const c = n < originals.length ? originals[n] : globalConstraint;
      if (!known) { add(c.cells.slice(), c.total, c.source); continue; }
      let minesHere = 0; const open = [];
      for (const i of c.cells) { if (mines.has(i)) minesHere++; else if (!safe.has(i)) open.push(i); }
      add(open, c.total - minesHere, c.source);
    }
    constraints = [...seen.values()];
    if (budget.subsets) {
      // A subset must contain the superset's cell at its first position, so only constraints holding that cell are compared.
      // Visiting order (a ascending, then b ascending) is unchanged, so the produced constraints are identical.
      const originalLength = constraints.length, sets = constraints.map(c => new Set(c.cells)), holders = new Map();
      for (let b = 0; b < originalLength; b++) for (const x of constraints[b].cells) { const list = holders.get(x); if (list) list.push(b); else holders.set(x, [b]); }
      for (let a = 0; a < originalLength; a++) {
        const ca = constraints[a], inA = sets[a];
        for (const b of holders.get(ca.cells[0]) ?? []) {
          const cb = constraints[b], inB = sets[b];
          if (ca.cells.length >= cb.cells.length) continue;
          if (ca.cells.every(x => inB.has(x))) commit(cb.cells.length - ca.cells.length, cb.a ^ ca.a, cb.b ^ ca.b, () => cb.cells.filter(x => !inA.has(x)), cb.total - ca.total, 'subset');
        }
      }
      constraints = [...seen.values()];
    }
    for (const c of constraints) {
      if (c.total === 0) for (const i of c.cells) { if (!safe.has(i)) { safe.add(i); changed = true; } }
      if (c.total === c.cells.length) for (const i of c.cells) { if (!mines.has(i)) { mines.add(i); changed = true; } }
    }
    if ([...safe].some(x => mines.has(x))) contradiction = true;
    if (contradiction || !changed) break;
  }
  if (contradiction) { safe.clear(); mines.clear(); }
  const unknown = hidden.filter(i => !safe.has(i) && !mines.has(i));
  const local = originals.map(c => ({cells: c.cells.filter(i => !safe.has(i) && !mines.has(i)), total: c.total - c.cells.filter(i => mines.has(i)).length})).filter(c => c.cells.length);
  const frontier = [...new Set(local.flatMap(c => c.cells))].sort((a, b) => a - b);
  const connected = [], unseen = new Set(frontier), frontierSet = new Set(frontier), touching = new Map();
  local.forEach((c, index) => { for (const x of c.cells) { const list = touching.get(x); if (list) list.push(index); else touching.set(x, [index]); } });
  while (unseen.size) {
    const queue = [unseen.values().next().value], component = new Set(queue); unseen.delete(queue[0]);
    for (let p = 0; p < queue.length; p++) for (const index of touching.get(queue[p]) ?? []) for (const i of local[index].cells) {
      if (!component.has(i)) { component.add(i); unseen.delete(i); queue.push(i); }
    }
    connected.push([...component].sort((a, b) => a - b));
  }
  const risks = {};
  for (const i of safe) risks[i] = {value: 0, source: 'proof'};
  for (const i of mines) risks[i] = {value: 1, source: 'proof'};
  const remaining = mineCount - mines.size, baseline = unknown.length ? Math.max(0, Math.min(1, remaining / unknown.length)) : 0;
  for (const i of unknown) risks[i] = {value: baseline, source: 'heuristic'};
  let exactComplete = false, cutoffReason = budget.variables ? null : 'disabled'; const nodes = {used: 0, max: budget.nodes};
  if (budget.variables && !contradiction) {
    if (connected.some(c => c.length > budget.variables)) cutoffReason = 'component_limit';
    else {
      const enumerated = connected.map(c => { const inC = new Set(c); return enumerate(c, local.filter(x => x.cells.some(i => inC.has(i))), nodes); });
      if (enumerated.some(c => !c.complete)) cutoffReason = 'node_limit';
      else {
        const unconstrained = unknown.filter(i => !frontierSet.has(i));
        const distribution = enumerated.reduce((acc, c) => convolve(acc, c.counts), [1n]);
        const total = distribution.reduce((sum, v, k) => sum + v * choose(unconstrained.length, remaining - k), 0n);
        if (total === 0n) { contradiction = true; cutoffReason = 'no_solutions'; }
        else {
          const set = (i, numerator) => {
            risks[i] = {value: Number(numerator) / Number(total), source: 'exact'};
            if (numerator === 0n) safe.add(i); else if (numerator === total) mines.add(i);
          };
          enumerated.forEach((c, ci) => {
            const other = enumerated.filter((_, j) => ci !== j).reduce((acc, x) => convolve(acc, x.counts), [1n]);
            c.cells.forEach((i, index) => {
              let numerator = 0n;
              c.mines[index].forEach((v, k) => other.forEach((ways, otherK) => { numerator += v * ways * choose(unconstrained.length, remaining - k - otherK); }));
              set(i, numerator);
            });
          });
          if (unconstrained.length) {
            const numerator = distribution.reduce((sum, v, k) => sum + v * choose(unconstrained.length - 1, remaining - k - 1), 0n);
            for (const i of unconstrained) set(i, numerator);
          }
          exactComplete = true; cutoffReason = null;
        }
      }
    }
  }
  if (contradiction) { safe.clear(); mines.clear(); for (const i of hidden) risks[i] = {value: mineCount / Math.max(1, hidden.length), source: 'heuristic'}; }
  return {safe: [...safe].sort((a, b) => a - b), mines: [...mines].sort((a, b) => a - b), risks, constraints: constraints.map(({cells, total}) => ({cells, total})), frontier, components: connected.length, largestComponent: Math.max(0, ...connected.map(c => c.length)), nodes: nodes.used, rounds, exactComplete, cutoffReason, contradiction};
}
export function decisionSurface(observation, difficulty = 'normal', overrides = {}) {
  const analysis = analyzeObservation(observation, difficulty, overrides), safe = new Set(analysis.safe), mines = new Set(analysis.mines);
  const legal = getLegalActions(observation), candidates = [], touches = new Map(), frontierSet = new Set(analysis.frontier);
  for (const c of analysis.constraints) for (const x of c.cells) touches.set(x, (touches.get(x) ?? 0) + 1);
  for (const action of legal) {
    const ns = neighbors(action.cell, observation.width, observation.height);
    let group = 2, risk = analysis.risks[action.cell] || {value: 0.5, source: 'heuristic'}, evidence = [];
    if (action.type === 'reveal') {
      if (mines.has(action.cell)) continue;
      if (safe.has(action.cell)) { group = 0; evidence.push('PROVEN_SAFE'); }
      else evidence.push('UNCERTAIN_REVEAL');
    } else if (action.type === 'chord') {
      if (!ns.filter(i => observation.cells[i] === -1).every(i => safe.has(i)) || !ns.filter(i => observation.cells[i] === -2).every(i => mines.has(i))) continue;
      group = 0; risk = {value: 0, source: 'proof'}; evidence.push('PROVEN_SAFE_CHORD');
    } else if (action.value) {
      if (!mines.has(action.cell)) continue;
      group = 1; risk = {value: 0, source: 'proof'}; evidence.push('PROVEN_MINE_FLAG');
    } else {
      if (mines.has(action.cell)) continue;
      group = safe.has(action.cell) ? 0 : 3; risk = {value: 0, source: 'proof'}; evidence.push(safe.has(action.cell) ? 'REMOVE_INCORRECT_FLAG' : 'UNFLAG_TO_CONTINUE');
    }
    const frontierTouches = touches.get(action.cell) ?? 0;
    const coveredNeighbors = ns.filter(i => observation.cells[i] < 0).length;
    const progress = action.type === 'chord' ? ns.filter(i => observation.cells[i] === -1).length + 10 : frontierTouches + coveredNeighbors / 10;
    candidates.push({id: actionId(action), action, group, risk, evidence, progress, row: Math.floor(action.cell / observation.width) + 1, column: action.cell % observation.width + 1, frontierTouches, coveredNeighbors, frontier: frontierSet.has(action.cell)});
  }
  candidates.sort((a, b) => a.group - b.group || a.risk.value - b.risk.value || b.progress - a.progress || a.action.cell - b.action.cell || a.id.localeCompare(b.id));
  const minGroup = candidates[0]?.group;
  let selected = candidates.filter(c => c.group === minGroup);
  const cap = overrides.candidates ?? BUDGETS[difficulty].candidates;
  if (selected.length > cap) {
    const unconstrained = selected.find(c => !c.frontier && c.action.type === 'reveal');
    selected = selected.slice(0, cap);
    if (unconstrained && !selected.includes(unconstrained) && minGroup === 2) selected[cap - 1] = unconstrained;
  }
  return {candidates: selected, legalCount: legal.length, analysis};
}
export function localDecision(surface) { return surface.candidates[0] || null; }
