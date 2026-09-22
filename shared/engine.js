/** Pure Minesweeper rules. No DOM, network, wall clock, or unrecorded randomness. */
export const ENGINE_VERSION = 'ms-race-1.0.0';
export const GENERATOR_VERSION = 'hmac-shuffle-1';
export const PRESETS = Object.freeze({
  beginner: {width: 9, height: 9, mineCount: 10},
  intermediate: {width: 16, height: 16, mineCount: 40},
  expert: {width: 30, height: 16, mineCount: 99}
});
export const LEVELS = ['easy', 'normal', 'hard', 'jev'];
export const clone = value => structuredClone(value);
export class RuleError extends Error {
  constructor(code, message = code) { super(message); this.name = 'RuleError'; this.code = code; }
}
export function canonical(value) {
  if (value === undefined) throw new TypeError('Undefined is not canonical JSON');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export async function digest(value) {
  const data = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function validateConfig(config) {
  const {width, height, mineCount} = config;
  if (![width, height, mineCount].every(Number.isInteger) || width < 3 || height < 3 || width > 30 || height > 30 || width * height > 480 || mineCount < 1 || mineCount > width * height - 9) throw new RuleError('invalid_config');
  if (config.aiDifficulty !== undefined && !LEVELS.includes(config.aiDifficulty)) throw new RuleError('invalid_difficulty');
  return config;
}
export function neighbors(cell, width, height) {
  const result = [], row = Math.floor(cell / width), col = cell % width;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if ((dr || dc) && row + dr >= 0 && row + dr < height && col + dc >= 0 && col + dc < width) result.push((row + dr) * width + col + dc);
  }
  return result;
}
function requireCell(cell, n) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= n) throw new RuleError('invalid_cell');
}
export function boardFromMines(width, height, mineCells) {
  const n = width * height, mines = Array(n).fill(0), adjacent = Array(n).fill(0);
  for (const cell of mineCells) { requireCell(cell, n); if (mines[cell]) throw new RuleError('duplicate_mine'); mines[cell] = 1; }
  for (let cell = 0; cell < n; cell++) adjacent[cell] = neighbors(cell, width, height).reduce((sum, i) => sum + mines[i], 0);
  return {width, height, mineCount: mineCells.length, mines, adjacent, revealed: Array(n).fill(0), flags: Array(n).fill(0), revision: 0, revealedSafe: 0, status: 'active', terminalAtMs: null, explodedCell: null};
}
/** HMAC counter stream + unbiased, versioned Fisher-Yates shuffle. */
export async function generateBoard(config, seed, firstCell) {
  validateConfig(config); requireCell(firstCell, config.width * config.height);
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new RuleError('invalid_seed');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const domain = `${GENERATOR_VERSION}|${config.width}|${config.height}|${config.mineCount}|${firstCell}|`;
  let counter = 0, buffer = [], offset = 0;
  async function word() {
    if (offset >= buffer.length) {
      const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(domain + counter++));
      const view = new DataView(bytes); buffer = Array.from({length: 8}, (_, i) => view.getUint32(i * 4, false)); offset = 0;
    }
    return buffer[offset++];
  }
  async function below(bound) {
    const limit = Math.floor(4294967296 / bound) * bound;
    let x; do { x = await word(); } while (x >= limit);
    return x % bound;
  }
  const excluded = new Set([firstCell, ...neighbors(firstCell, config.width, config.height)]);
  const available = Array.from({length: config.width * config.height}, (_, i) => i).filter(i => !excluded.has(i));
  for (let i = available.length - 1; i > 0; i--) { const j = await below(i + 1); [available[i], available[j]] = [available[j], available[i]]; }
  return boardFromMines(config.width, config.height, available.slice(0, config.mineCount));
}
export async function seedCommitment(config, actor, seed) {
  return digest({generator: GENERATOR_VERSION, config, actor, seed});
}
export async function createMatch(config, seeds, id = 'local') {
  validateConfig(config);
  const complete = {adjudicationMs: 100, deadlineMs: 900000, jevIntervalMs: 1000, ...clone(config)};
  if (![complete.adjudicationMs, complete.deadlineMs, complete.jevIntervalMs].every(x => Number.isInteger(x) && x > 0)) throw new RuleError('invalid_timing');
  return {id, engineVersion: ENGINE_VERSION, generatorVersion: GENERATOR_VERSION, config: complete, seeds: clone(seeds), commitments: {human: await seedCommitment(complete, 'human', seeds.human), jev: await seedCommitment(complete, 'jev', seeds.jev)}, phase: 'ready', firstCell: null, boards: {human: null, jev: null}, outcome: null, outcomeReason: null, finishedAtMs: null, openingOnly: false, lastAtMs: 0};
}
export async function startMatch(state, firstCell) {
  if (state.phase !== 'ready') throw new RuleError('already_started');
  const boards = await Promise.all(['human', 'jev'].map(actor => generateBoard(state.config, state.seeds[actor], firstCell)));
  state.phase = 'running'; state.firstCell = firstCell;
  ['human', 'jev'].forEach((actor, i) => { state.boards[actor] = boards[i]; applyBoardAction(boards[i], {type: 'reveal', cell: firstCell}, 0); });
  state.openingOnly = boards.some(b => b.status === 'cleared');
  return state;
}
export function getLegalActions(observation) {
  if (observation.status !== 'active') return [];
  const result = [];
  for (let i = 0; i < observation.cells.length; i++) {
    const value = observation.cells[i];
    if (value === -1) result.push({type: 'reveal', cell: i}, {type: 'setFlag', cell: i, value: true});
    else if (value === -2) result.push({type: 'setFlag', cell: i, value: false});
    else if (value > 0) {
      const ns = neighbors(i, observation.width, observation.height);
      if (ns.filter(c => observation.cells[c] === -2).length === value && ns.some(c => observation.cells[c] === -1)) result.push({type: 'chord', cell: i});
    }
  }
  return result;
}
export function applyBoardAction(board, action, atMs) {
  if (!board || board.status !== 'active') throw new RuleError('board_inactive');
  const {type, cell} = action; requireCell(cell, board.mines.length);
  if (!Number.isFinite(atMs) || atMs < 0) throw new RuleError('invalid_time');
  const delta = {revealed: [], flags: [], exploded: false, safeDelta: 0};
  if (type === 'setFlag') {
    if (typeof action.value !== 'boolean' || board.revealed[cell]) throw new RuleError('illegal_flag');
    if (Boolean(board.flags[cell]) === action.value) throw new RuleError('no_change');
    board.flags[cell] = Number(action.value); delta.flags.push({cell, value: action.value});
  } else if (type === 'reveal' || type === 'chord') {
    let targets;
    if (type === 'reveal') {
      if (board.revealed[cell] || board.flags[cell]) throw new RuleError('illegal_reveal');
      targets = [cell];
    } else {
      const ns = neighbors(cell, board.width, board.height);
      if (!board.revealed[cell] || board.adjacent[cell] === 0 || ns.filter(c => board.flags[c]).length !== board.adjacent[cell]) throw new RuleError('illegal_chord');
      targets = ns.filter(c => !board.revealed[c] && !board.flags[c]);
      if (!targets.length) throw new RuleError('no_change');
    }
    const queue = [...targets], queued = new Set(queue);
    for (let p = 0; p < queue.length; p++) {
      const c = queue[p];
      if (board.revealed[c] || board.flags[c]) continue;
      board.revealed[c] = 1; delta.revealed.push(c);
      if (board.mines[c]) { delta.exploded = true; board.explodedCell ??= c; continue; }
      board.revealedSafe++; delta.safeDelta++;
      if (board.adjacent[c] === 0) for (const n of neighbors(c, board.width, board.height)) {
        if (!queued.has(n) && !board.flags[n] && !board.revealed[n]) { queue.push(n); queued.add(n); }
      }
    }
    if (delta.exploded) { board.status = 'exploded'; board.terminalAtMs = atMs; }
    else if (board.revealedSafe === board.mines.length - board.mineCount) { board.status = 'cleared'; board.terminalAtMs = atMs; }
  } else throw new RuleError('invalid_action');
  board.revision++;
  return delta;
}
export function finish(state, outcome, reason, atMs) {
  if (state.phase !== 'running' && reason !== 'server_restart' && reason !== 'ready_expired') throw new RuleError('not_running');
  state.phase = 'complete'; state.outcome = outcome; state.outcomeReason = reason; state.finishedAtMs = atMs; state.lastAtMs = atMs;
  return true;
}
export function adjudicate(state, atMs) {
  if (state.phase !== 'running') return false;
  if (!Number.isFinite(atMs) || atMs < state.lastAtMs) throw new RuleError('non_monotonic_time');
  state.lastAtMs = atMs;
  const {human, jev} = state.boards, width = state.config.adjudicationMs;
  const clear = [human, jev].filter(b => b.status === 'cleared');
  if (clear.length) {
    const firstBucket = Math.min(...clear.map(b => Math.floor(b.terminalAtMs / width)));
    if (atMs >= (firstBucket + 1) * width) {
      const h = human.status === 'cleared' && Math.floor(human.terminalAtMs / width) === firstBucket;
      const j = jev.status === 'cleared' && Math.floor(jev.terminalAtMs / width) === firstBucket;
      return finish(state, h && j ? 'draw' : h ? 'win' : 'loss', h && j ? 'simultaneous_clear' : h ? 'human_cleared_first' : 'jev_cleared_first', atMs);
    }
  }
  if (human.status === 'exploded' && jev.status === 'exploded') return finish(state, 'draw', 'both_exploded', atMs);
  if (atMs >= state.config.deadlineMs) return finish(state, 'draw', 'deadline', atMs);
  return false;
}
export function applyMatchAction(state, actor, action, atMs) {
  if (!['human', 'jev'].includes(actor)) throw new RuleError('invalid_actor');
  if (state.phase !== 'running') throw new RuleError('not_running');
  if (!Number.isFinite(atMs) || atMs < state.lastAtMs) throw new RuleError('non_monotonic_time');
  // A server must adjudicate elapsed intervals before accepting the next action.
  if (atMs >= state.config.deadlineMs) throw new RuleError('deadline');
  const terminal = Object.values(state.boards).filter(b => b.status === 'cleared');
  if (terminal.some(b => atMs >= (Math.floor(b.terminalAtMs / state.config.adjudicationMs) + 1) * state.config.adjudicationMs)) throw new RuleError('adjudication_due');
  const result = applyBoardAction(state.boards[actor], action, atMs); state.lastAtMs = atMs; return result;
}
/** The only active-state projection allowed across trust boundaries. */
export function observeBoard(board, config = null) {
  if (!board) return {...config, cells: Array(config.width * config.height).fill(-1), status: 'ready', revision: 0, revealedSafe: 0, flagsPlaced: 0, terminalAtMs: null};
  return {width: board.width, height: board.height, mineCount: board.mineCount, cells: board.revealed.map((x, i) => x ? (board.mines[i] ? -3 : board.adjacent[i]) : board.flags[i] ? -2 : -1), status: board.status, revision: board.revision, revealedSafe: board.revealedSafe, flagsPlaced: board.flags.reduce((s, x) => s + x, 0), terminalAtMs: board.terminalAtMs};
}
export function observeMatch(state) {
  return {id: state.id, engineVersion: state.engineVersion, config: clone(state.config), commitments: clone(state.commitments), phase: state.phase, firstCell: state.firstCell, boards: {human: observeBoard(state.boards.human, state.config), jev: observeBoard(state.boards.jev, state.config)}, outcome: state.outcome, outcomeReason: state.outcomeReason, finishedAtMs: state.finishedAtMs, openingOnly: state.openingOnly};
}
export function actionId(action) { return `${action.type === 'setFlag' ? action.value ? 'flag' : 'unflag' : action.type}_${action.cell}`; }
