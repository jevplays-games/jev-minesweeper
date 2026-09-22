let csrfToken = null;
export function setCsrf(token) { csrfToken = token; }
export async function request(path, {method = 'GET', body, retry = false} = {}) {
  const options = {method, credentials: 'same-origin', headers: {}};
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  if (method !== 'GET') options.headers['X-CSRF-Token'] = csrfToken || '';
  let response;
  try { response = await fetch(path, options); }
  catch (error) { if (retry) return request(path, {method,body,retry:false}); throw Object.assign(error, {code:'network_error'}); }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Request failed'), {code:data.error?.code,status:response.status});
  return data;
}
export function subscribe(id, onSnapshot, onConnection) {
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
  const response = await fetch(path,{credentials:'same-origin'});
  if (!response.ok) { const data=await response.json();throw new Error(data.error?.message || 'Export failed'); }
  const filename=response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||fallbackName;
  download(await response.text(),filename,response.headers.get('Content-Type')||'text/plain');
}
