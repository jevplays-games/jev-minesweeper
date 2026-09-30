import {createMatch,startMatch,applyMatchAction,adjudicate,finish} from '../public/shared/engine.js';
import {makeEvent,exportReplay} from '../public/shared/replay.js';
import {MODEL,SCORE_LEVELS} from '../public/shared/decisions.js';
import {POLICY_VERSION} from '../public/shared/solver.js';
export const config={width:9,height:9,mineCount:10,preset:'beginner',aiDifficulty:'normal',model:MODEL,policyVersion:POLICY_VERSION,lateToleranceMs:100};
export const seeds={human:'a'.repeat(64),jev:'b'.repeat(64)};
export async function game(){const state=await createMatch(config,seeds,'test-match');await startMatch(state,40);return state;}
export async function winningReplay(){
 const state=await createMatch(config,seeds,'test-match'),events=[];await startMatch(state,40);events.push(await makeEvent(events,'start','human',0,{cell:40}));let at=100;
 for(let cell=0;cell<81;cell++){const b=state.boards.human;if(b.status!=='active')break;if(b.revealed[cell]||b.mines[cell])continue;const rev=b.revision,action={type:'reveal',cell};applyMatchAction(state,'human',action,at);events.push(await makeEvent(events,'action','human',at,{expectedRevision:rev,action}));at+=100;}
 if(!adjudicate(state,at))throw Error('fixture did not finish');events.push(await makeEvent(events,'adjudicate','system',at));return exportReplay(state,events,{eligible:false,verification:'verified',eligibilityReasons:['fixture']});
}
export function validResponse(request){
 const answers={};for(const[id,q]of Object.entries(request.questions)){
  if(q.type==='noul')answers[id]={type:'noul',noul:.8};
  else if(q.type==='choice'){const keys=Object.keys(q.criteria);answers[id]={type:'choice',choice:keys[0],probabilities:Object.fromEntries(keys.map((k,i)=>[k,i===0?1:0])),confidence:1};}
  else answers[id]={type:'score',score:3,legend:Object.fromEntries(q.criteria.map((v,i)=>[String(i),v])),probabilities:Object.fromEntries(q.criteria.map((_,i)=>[String(i),i===3?1:0])),confidence:1};
 }return{model:request.model,answers,usage:{input_tokens:128,output_tokens:32}};
}

/** A response shaped like the live provider actually answers: probabilities and scores
 *  reported on a 0.01 grain, so buckets do not sum to exactly 1 and the reported score
 *  does not exactly equal the distribution mean. validResponse() returns exact one-hot
 *  values the provider never produces, which is why the suite could not catch a
 *  validator whose tolerances were tighter than that rounding. */
export function roundedResponse(request){
  const r=validResponse(request);
  for(const[id,q]of Object.entries(request.questions)){
    const a=r.answers[id];
    if(q.type==='score'){
      // 0.02/0.23/0.47/0.21/0.07 sums to 1.00 but its mean is 2.08; report 2.09 as the
      // provider would after rounding the expected score independently.
      const p=[0.02,0.23,0.47,0.21,0.07];
      a.probabilities=Object.fromEntries(q.criteria.map((_,i)=>[String(i),p[i]??0]));
      a.score=2.09;
      a.confidence=0.62;
    } else if(q.type==='choice'){
      const keys=Object.keys(q.criteria);
      // Spread mass across candidates on the grain, leaving the top choice maximal.
      const each=Math.round((0.30/Math.max(1,keys.length-1))*100)/100;
      a.probabilities=Object.fromEntries(keys.map((k,i)=>[k,i===0?0.71:each]));
      a.choice=keys[0];
      a.confidence=0.71;
    }
  }
  return r;
}

/** A Worker environment for tests: real SQLite through the D1-compatible wrapper, the real handler, a controllable clock and provider. */
import {createApp} from '../server/main.js';
import worker from '../server/worker.js';
export const ORIGIN = 'http://localhost:8787';
export const HIGH = {MAX_ACTIVE_MATCHES: '64', MATCHES_PER_HOUR: '100000', SESSIONS_PER_10_MIN: '100000', MAX_MATCHES_PER_DAY: '1000000', MAX_JEV_CALLS_PER_DAY: '1000000'};
/** A stand-in for the TypeSafe endpoint. It answers the way the provider does and records every request it was sent. */
export function provider(calls = []) {
  return async (url, options) => { const request = JSON.parse(options.body); calls.push({url: String(url), auth: options.headers.Authorization, request}); return new Response(JSON.stringify(validResponse(request)), {status: 200, headers: {'Content-Type': 'application/json'}}); };
}
export async function direct(overrides = {}, {key = false} = {}) {
  let t = 1_800_000_000_000;
  const calls = [], app = await createApp({env: {PORT: '8787', APP_ORIGIN: ORIGIN, ...HIGH, ...(key ? {TYPESAFE_API_KEY: 'test-only-not-a-real-key', FETCH: provider(calls)} : {}), ...overrides}});
  app.env.CLOCK = () => t;
  const clock = {get now() { return t; }, set now(v) { t = v; }, advance(ms) { t += ms; return t; }};
  async function call(path, {method = path.startsWith('/api/') && arguments[1]?.body ? 'POST' : 'GET', body, session = null, headers = {}} = {}) {
    const init = {method: body === undefined ? method : 'POST', headers: {...(session ? {cookie: session.cookie} : {}), ...headers}};
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; init.headers.origin = ORIGIN; if (session) init.headers['x-csrf-token'] = session.csrf; }
    const response = await worker.fetch(new Request(ORIGIN + path, init), app.env, app.ctx);
    let data = null; const text = await response.text(); try { data = JSON.parse(text); } catch { data = text; }
    return {status: response.status, data, headers: response.headers};
  }
  async function guest() {
    const r = await call('/api/me'), cookie = r.headers.getSetCookie()[0].split(';')[0];
    return {cookie, csrf: r.data.csrfToken, me: r.data, get: (path) => call(path, {session: {cookie}}), post: (path, body) => call(path, {body, session: {cookie, csrf: r.data.csrfToken}})};
  }
  const sql = (q, ...a) => app.database.raw.prepare(q).get(...a), rows = (q, ...a) => app.database.raw.prepare(q).all(...a);
  return {app, env: app.env, clock, call, guest, calls, sql, rows, idle: () => app.idle(), close: () => app.close()};
}
export const options = (over = {}) => ({requestId: crypto.randomUUID(), boardPreset: 'beginner', aiDifficulty: 'normal', mode: 'practice', context: 'world', ...over});
export const act = (action, extra = {}) => ({requestId: crypto.randomUUID(), action, ...extra});

/** Stitches the paged replay endpoint back into the replay document, as the browser does (public/api.js fetchReplay). */
export async function pagedReplay(get, id) {
  let from = 1, header = null; const events = [];
  while (from) { const r = await get(`/api/matches/${id}/replay?from=${from}`); if (r.status !== 200) return r; header ??= r.data.header; events.push(...r.data.events); from = r.data.page.next; }
  const {headHash, result, metadata, ...head} = header;
  return {status: 200, data: {...head, events, headHash, result, metadata}};
}
