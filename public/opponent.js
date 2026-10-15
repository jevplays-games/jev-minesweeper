/** Who the opponent is, in words. Pure (no DOM), so it is unit-tested in Node. Stored ids ('jev', players.jev, jevSafe) never change;
 *  only what is shown does. The opponent is "Jev" only when the server has a TypeSafe key AND the match is a server match: a snapshot
 *  from browser-local practice carries `offline: true`, and that wins over whatever state the caller is in. */
export function opponentView({jevConfigured = false, offline = false, snapshot = null} = {}) {
  const isJev = Boolean(jevConfigured) && !offline && !snapshot?.offline;
  return {
    isJev,
    title: isJev ? 'Jev' : 'Local opponent',
    badge: snapshot?.opponent || (isJev ? 'Jev + constraint solver' : snapshot?.offline || offline ? 'Offline local heuristic — not Jev' : 'Local heuristic · not Jev'),
    versus: isJev ? 'vs Jev' : 'vs local opponent'
  };
}
const segment = (s, opponent) => s === 'jev' ? opponent : s === 'human' ? 'you'
  : s.replace(/^jev(?=[A-Z])/, opponent).replace(/^human(?=[A-Z])/, 'you');
/** A metric-explorer row label for a flattened report path. `remoteJev` is true only when the match used remote Jev decisions. */
export function metricLabel(path, {remoteJev = false} = {}) {
  return path.split('.').map(s => segment(s, remoteJev ? 'Jev' : 'opponent')).join(' › ');
}
/** The displayed value for a flattened report path: a configured model id that no decision used is marked as such. */
export function metricValue(path, value, {remoteJev = false} = {}) {
  return path === 'configuration.model' && !remoteJev ? `${value} (configured, not used: local opponent)` : value;
}
