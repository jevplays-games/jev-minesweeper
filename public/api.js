let csrfToken = null, bearer = null; // bearer is set only inside a Discord Activity, where cookies are not sent
export function setCsrf(token) { csrfToken = token; }
export function setBearer(token) { bearer = token; }
const authHeaders = () => bearer ? {Authorization: `Bearer ${bearer}`} : {};
export async function request(path, {method = 'GET', body, retry = false} = {}) {
  const options = {method, credentials: 'same-origin', headers: {...authHeaders()}};
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  if (method !== 'GET') options.headers['X-CSRF-Token'] = csrfToken || '';
  let response;
  try { response = await fetch(path, options); }
  catch (error) { if (retry) return request(path, {method,body,retry:false}); throw Object.assign(error, {code:'network_error'}); }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Request failed'), {code:data.error?.code,status:response.status});
  return data;
}
// There is no server push: the game runs on a host with no long-lived connections, so the client polls the match. Every poll also
// applies whatever the schedule made due (opponent moves, adjudication) and tops up the opponent's next decisions on the server.
const pollDelay = snapshot => snapshot.phase === 'running' ? 600 : snapshot.phase === 'ready' ? 3000 : snapshot.eligibility?.verification === 'pending' ? 350 : 0;
export function subscribe(id, onSnapshot, onConnection) {
  let stopped = false, timer = null, inFlight = false;
  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true; let next = 1500;
    try {
      const snapshot = await request(`/api/matches/${id}`);
      if (stopped) return;
      onConnection(true); onSnapshot(snapshot); next = pollDelay(snapshot);
      if (!next) { stopped = true; return; } // finished and verified: nothing left to follow
    } catch (error) {
      if (stopped) return;
      if (error.status === 401) { stopped = true; onConnection(false, 'Session expired. Refresh and sign in again.'); return; }
      onConnection(false); next = 3000;
    } finally { inFlight = false; }
    timer = setTimeout(tick, next);
  }
  const visible = () => { if (!document.hidden && !stopped) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', visible);
  tick();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
}
/** The server serves a sealed replay in pages (a long match is megabytes); this stitches them back into the exact replay document. */
export async function fetchReplay(id) {
  let from = 1, header = null; const events = [];
  while (from) { const page = await request(`/api/matches/${id}/replay?from=${from}`); header ??= page.header; events.push(...page.events); from = page.page.next; }
  const {headHash, result, metadata, ...head} = header;
  return {...head, events, headHash, result, metadata};
}
export function download(value, filename, type='application/json') {
  const blob = new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type});
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function downloadEndpoint(path, fallbackName) {
  const response = await fetch(path,{credentials:'same-origin',headers:authHeaders()});
  if (!response.ok) { const data=await response.json();throw new Error(data.error?.message || 'Export failed'); }
  const filename=response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||fallbackName;
  download(await response.text(),filename,response.headers.get('Content-Type')||'text/plain');
}
