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
// EventSource cannot send an Authorization header, so an Activity reads the same event stream with fetch.
function subscribeWithBearer(id, onSnapshot, onConnection) {
  const controller = new AbortController();
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api/matches/${id}/events`, {headers: authHeaders(), signal: controller.signal});
        if (!response.ok) throw new Error('stream_rejected');
        onConnection(true);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = '';
        for (;;) {
          const {done, value} = await reader.read(); if (done) break;
          buffer += value; let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
            if (event === 'snapshot' && data) { onConnection(true); onSnapshot(JSON.parse(data)); }
            else if (event === 'auth-expired') { controller.abort(); onConnection(false, 'Session expired. Refresh and sign in again.'); return; }
          }
        }
      } catch { if (controller.signal.aborted) return; }
      onConnection(false); await new Promise(resolve => setTimeout(resolve, 3000));
    }
  })();
  return () => controller.abort();
}
export function subscribe(id, onSnapshot, onConnection) {
  if (bearer) return subscribeWithBearer(id, onSnapshot, onConnection);
  const stream = new EventSource(`/api/matches/${id}/events`);
  stream.addEventListener('snapshot',event=>{onConnection(true);onSnapshot(JSON.parse(event.data));});
  stream.addEventListener('auth-expired',()=>{stream.close();onConnection(false,'Session expired. Refresh and sign in again.');});
  stream.onopen=()=>onConnection(true); stream.onerror=()=>onConnection(false);
  return ()=>stream.close();
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
