import test from 'node:test';import assert from 'node:assert/strict';
import {direct,options,act,ORIGIN} from './helpers.js';
import {createSession} from '../server/security.js';import {Store} from '../server/db.js';
const events=(d,id)=>d.rows('SELECT event_json FROM match_events WHERE match_id=? ORDER BY seq',id).map(r=>JSON.parse(r.event_json));
const jevEvents=(d,id)=>events(d,id).filter(e=>e.actor==='jev');
async function begin(d,g,over={}){const {data:s}=await g.post('/api/matches',options(over));const r=await g.post(`/api/matches/${s.id}/actions`,act({type:'start',cell:40}));assert.equal(r.status,200);return r.data.snapshot;}
const poll=(g,id)=>g.get(`/api/matches/${id}`);
async function untilSettled(d,g,id,limit=200){let s;for(let i=0;i<limit;i++){s=(await poll(g,id)).data;if(s.eligibility.verification!=='pending')return s;await d.idle();}return s;}

test('opponent moves are applied at their scheduled instants however late the poll arrives',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);await d.idle();
  for(let i=0;i<3;i++){await poll(g,s.id);await d.idle();}
  assert.equal(d.rows('SELECT count(*) AS n FROM jev_decisions WHERE match_id=?',s.id)[0].n,3,'the queue fills to the pipeline depth');
  d.clock.advance(5000);
  const snap=(await poll(g,s.id)).data;
  const moves=jevEvents(d,s.id);
  assert.deepEqual(moves.map(e=>e.atMs),[1000,2000,3000],'stamped at their due time, not at the (late) poll');
  assert.ok(moves.every(e=>['jev','forced'].includes(e.decision.source)&&e.decision.schedulingLagMs===0&&e.decision.scheduledAtMs===e.atMs));
  assert.ok(moves.some(e=>e.decision.source==='jev'||e.decision.candidates.length===1));
  assert.equal(snap.boards.jev.revision,4,'opening plus three moves');
  assert.ok(snap.eligibility.reasons.includes('scheduling_miss'),'the fourth slot passed with nothing ready, so the race is no longer like-for-like');
 }finally{await d.close();}
});
test('steady polling keeps the one-second schedule and stays free of scheduling misses',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);
  for(let i=0;i<24;i++){d.clock.advance(500);await poll(g,s.id);await d.idle();}
  const snap=(await poll(g,s.id)).data,moves=jevEvents(d,s.id);
  if(snap.boards.jev.status==='active')assert.ok(moves.length>=11,`${moves.length} moves in 12 s`);else assert.ok(moves.length>=1);
  assert.deepEqual(moves.map(e=>e.atMs),moves.map((_,i)=>(i+1)*1000));
  assert.ok(!snap.eligibility.reasons.includes('scheduling_miss'));
  assert.equal(events(d,s.id).at(0).type,'start');
 }finally{await d.close();}
});
test('an idle match is abandoned lazily, stamped 30 s after the last owner contact',async()=>{
 const d=await direct({}, {key:true});try{
  const g=await d.guest(),s=await begin(d,g);await d.idle();
  d.clock.advance(40000);
  const snap=(await poll(g,s.id)).data;
  assert.equal(snap.outcome,'loss');assert.equal(snap.outcomeReason,'abandoned');assert.equal(snap.finishedAtMs,30000);
  assert.equal(events(d,s.id).at(-1).type,'abandon');
 }finally{await d.close();}
});
test('a ready board expires lazily and does not block the next game',async()=>{
 const d=await direct();try{
  const g=await d.guest(),{data:first}=await g.post('/api/matches',options());
  d.clock.advance(130000);
  const second=await g.post('/api/matches',options());assert.equal(second.status,201);assert.notEqual(second.data.id,first.id);
  const old=(await poll(g,first.id)).data;assert.equal(old.outcome,'void');assert.equal(old.outcomeReason,'ready_expired');
 }finally{await d.close();}
});
test('a live match blocks a second game, but an abandoned one settles and frees the slot',async()=>{
 const d=await direct();try{
  const g=await d.guest(),s=await begin(d,g);
  assert.equal((await g.post('/api/matches',options())).status,409);
  d.clock.advance(31000);
  assert.equal((await g.post('/api/matches',options())).status,201);
  assert.equal((await poll(g,s.id)).data.outcomeReason,'abandoned');
 }finally{await d.close();}
});
test('verification is bounded and resumable: a long match needs several steps and then verifies',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g,{boardPreset:'expert',aiDifficulty:'easy'});
  let snap=(await poll(g,s.id)).data;
  for(let i=0;i<30;i++){d.clock.advance(250);snap=(await poll(g,s.id)).data;const covered=snap.boards.human.cells.flatMap((v,j)=>v===-1?[j]:[]);const r=await g.post(`/api/matches/${s.id}/actions`,act({type:'setFlag',cell:covered[0],value:true},{expectedBoardRevision:snap.boards.human.revision}));assert.equal(r.status,200);await d.idle();}
  const end=await g.post(`/api/matches/${s.id}/actions`,act({type:'resign'}));assert.equal(end.status,200);
  const total=events(d,s.id).length;assert.ok(total>=30,`${total} events`);
  let cursors=0;snap=end.data.snapshot;
  for(let i=0;i<100&&snap.eligibility.verification==='pending';i++){await d.idle();if(d.sql('SELECT verify_cursor_json AS c FROM matches WHERE id=?',s.id).c)cursors++;snap=(await poll(g,s.id)).data;}
  assert.equal(snap.eligibility.verification,'verified');assert.ok(cursors>=2,`resumed from a persisted cursor ${cursors} times`);
  assert.equal(d.sql('SELECT verify_cursor_json AS c FROM matches WHERE id=?',s.id).c,null);
 }finally{await d.close();}
});
test('a tampered journal is rejected and cannot become eligible',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);
  for(let i=0;i<6;i++){d.clock.advance(500);await poll(g,s.id);await d.idle();}
  const target=jevEvents(d,s.id)[0];
  d.app.database.raw.prepare("UPDATE match_events SET event_json=replace(event_json,'\"atMs\":1000','\"atMs\":1001') WHERE match_id=? AND seq=?").run(s.id,target.seq);
  await g.post(`/api/matches/${s.id}/actions`,act({type:'resign'}));
  const snap=await untilSettled(d,g,s.id);
  assert.equal(snap.eligibility.verification,'rejected');assert.equal(snap.eligibility.eligible,false);assert.ok(snap.eligibility.reasons.includes('verification_failed'));
  assert.equal((await g.get(`/api/matches/${s.id}/operations`)).status,409,'no analytics for an unverified journal');
 }finally{await d.close();}
});
test('two consecutive failed attempts degrade to the cheapest solver budget, flagged and never ranked, and still verify',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),{data:s}=await g.post('/api/matches',options());
  d.app.database.raw.prepare('UPDATE matches SET prep_rev=1,prep_attempts=2 WHERE id=?').run(s.id);
  await g.post(`/api/matches/${s.id}/actions`,act({type:'start',cell:40}));await d.idle();
  assert.equal(d.rows('SELECT * FROM jev_decisions WHERE match_id=?',s.id).length,0,'a command carries no background work');
  await poll(g,s.id);await d.idle();
  assert.equal(d.calls.length,0,'a degraded decision makes no provider call');
  const stored=JSON.parse(d.sql('SELECT decision_json AS j FROM jev_decisions WHERE match_id=?',s.id).j);
  assert.equal(stored.errorCode,'cpu_guard');assert.equal(stored.fallback,true);assert.equal(stored.source,'local');assert.equal(stored.solver.cutoffReason,'disabled');
  d.clock.advance(1500);const snap=(await poll(g,s.id)).data;assert.ok(snap.eligibility.reasons.includes('jev_fallback'));
  await g.post(`/api/matches/${s.id}/actions`,act({type:'resign'}));
  assert.equal((await untilSettled(d,g,s.id)).eligibility.verification,'verified','the verifier replays the decision under the same reduced budget');
 }finally{await d.close();}
});
test('a stale queued decision is discarded, unranks the match and is never applied',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);await poll(g,s.id);await d.idle();
  d.app.database.raw.prepare("UPDATE jev_decisions SET decision_json=replace(decision_json,'\"observationHash\":\"','\"observationHash\":\"0') WHERE match_id=?").run(s.id);
  d.clock.advance(1500);const snap=(await poll(g,s.id)).data;
  assert.ok(snap.eligibility.reasons.includes('stale_jev_decision'));assert.equal(jevEvents(d,s.id).length,0);
  assert.equal(d.rows('SELECT * FROM jev_decisions WHERE match_id=?',s.id).length,0);
 }finally{await d.close();}
});
test('the model is only ever sent the opponent\'s public observation and finite candidates',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);
  for(let i=0;i<8;i++){d.clock.advance(500);await poll(g,s.id);await d.idle();}
  assert.ok(d.calls.length>=4);
  const priv=JSON.parse(d.sql('SELECT private_state_json AS j FROM matches WHERE id=?',s.id).j);
  for(const c of d.calls){
   assert.equal(c.url,'https://api.typesafe.ai/v1/systemone');assert.equal(c.auth,'Bearer test-only-not-a-real-key');
   assert.deepEqual(Object.keys(c.request.state).sort(),['board','candidates','constraints','legend']);
   const text=JSON.stringify(c.request);
   for(const secret of[priv.seeds.human,priv.seeds.jev,priv.commitments.human,priv.commitments.jev])assert.ok(!text.includes(secret));
   assert.ok(!/"mines"|"adjacent"|"seeds"|"human"|history/.test(text));
   assert.ok(c.request.state.candidates.length>=2&&c.request.state.candidates.length<=32);
  }
 }finally{await d.close();}
});
test('quota reservation: the per-day provider ceiling is reserved up front, then falls back visibly, never as jev',async()=>{
 const d=await direct({MAX_JEV_CALLS_PER_DAY:'2'},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);
  for(let i=0;i<10;i++){d.clock.advance(500);await poll(g,s.id);await d.idle();}
  const stored=jevEvents(d,s.id).map(e=>e.decision).filter(x=>x.candidates.length>1);
  assert.equal(stored[0].source,'jev');
  const later=stored.slice(1);assert.ok(later.length>0);
  assert.ok(later.every(x=>x.source==='local'&&x.errorCode==='provider_budget'&&x.fallback===true&&x.attempts.length===0));
  assert.equal(d.calls.length,1,'one real call: two units were reserved, one refunded, and the next reservation no longer fit');
  const counter=d.sql("SELECT value FROM counters WHERE name='jev_calls'");assert.ok(counter.value<=2);
 }finally{await d.close();}
});
test('a provider failure is a labelled fallback and the match is unranked',async()=>{
 const d=await direct({FETCH:async()=>new Response('{}',{status:500})},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);
  for(let i=0;i<4;i++){d.clock.advance(1000);await poll(g,s.id);await d.idle();}
  const decisions=jevEvents(d,s.id).map(e=>e.decision).filter(x=>x.candidates.length>1);assert.ok(decisions.length>0);
  assert.ok(decisions.every(x=>x.source==='local'&&x.fallback===true&&x.errorCode==='http_500'));
  assert.ok((await poll(g,s.id)).data.eligibility.reasons.includes('jev_fallback'));
 }finally{await d.close();}
});
test('only a verified, fully live, signed-in match can rank and reach the leaderboard',async()=>{
 const d=await direct({DISCORD_CLIENT_ID:'123456789012345678',DISCORD_CLIENT_SECRET:'x'},{key:true});try{
  const store=new Store(d.app.database);
  await store.run('INSERT INTO users(discord_id,display_name,created_at,last_seen_at) VALUES(?,?,?,?)','223344556677889900','Ranked Rita',0,0);
  const {raw,session}=await createSession(store,{sessionAbsoluteMs:86400000},'223344556677889900',{},d.clock.now);
  const user={cookie:`jev_session=${raw}`,csrf:session.csrf_token,get:p=>d.call(p,{session:{cookie:`jev_session=${raw}`}}),post:(p,b)=>d.call(p,{body:b,session:{cookie:`jev_session=${raw}`,csrf:session.csrf_token}})};
  const s=await begin(d,user,{mode:'ranked'});
  for(let i=0;i<4;i++){d.clock.advance(500);await poll(user,s.id);await d.idle();}
  await user.post(`/api/matches/${s.id}/actions`,act({type:'resign'}));
  const done=await untilSettled(d,user,s.id);
  assert.equal(done.eligibility.verification,'verified');assert.deepEqual(done.eligibility.reasons,[]);assert.equal(done.eligibility.eligible,true);
  assert.ok(jevEvents(d,s.id).some(e=>e.decision.source==='jev'),'a real model call is in the record');
  const board=(await d.call('/api/leaderboard?preset=beginner&difficulty=normal')).data;assert.equal(board.entries.length,1);assert.equal(board.entries[0].displayName,'Ranked Rita');
  // The same account with a fallback decision is verified but not eligible.
  d.env.FETCH=async()=>new Response('{}',{status:503});
  const t=await begin(d,user,{mode:'ranked'});for(let i=0;i<4;i++){d.clock.advance(1000);await poll(user,t.id);await d.idle();}
  await user.post(`/api/matches/${t.id}/actions`,act({type:'resign'}));
  const second=await untilSettled(d,user,t.id);assert.equal(second.eligibility.verification,'verified');assert.equal(second.eligibility.eligible,false);
  assert.equal((await d.call('/api/leaderboard?preset=beginner&difficulty=normal')).data.entries[0].completed,1);
 }finally{await d.close();}
});
test('housekeeping runs lazily from requests, one small job at a time',async()=>{
 const d=await direct({EVENT_RETENTION_DAYS:'1'});try{
  const g=await d.guest(),s=await begin(d,g);
  d.clock.advance(200000);
  for(let i=0;i<6;i++){d.clock.advance(25000);await d.call('/api/health');await d.idle();}
  assert.equal(d.sql('SELECT phase FROM matches WHERE id=?',s.id).phase,'complete','the abandoned match was settled without its owner');
  assert.equal(d.sql('SELECT verification FROM matches WHERE id=?',s.id).verification,'verified','and its verification was pushed along');
  const saved=d.sql('SELECT * FROM sessions');
  d.clock.advance(3*86400000);
  for(let i=0;i<6;i++){d.clock.advance(25000);await d.call('/api/health');await d.idle();}
  assert.ok(d.sql('SELECT events_pruned_at AS t FROM matches WHERE id=?',s.id).t);assert.equal(d.rows('SELECT * FROM match_events WHERE match_id=?',s.id).length,0);
  d.app.database.raw.prepare('INSERT OR REPLACE INTO sessions(token_hash,user_id,csrf_token,data_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(saved.token_hash,null,saved.csrf_token,'{}',d.clock.now,d.clock.now,d.clock.now+86400000);
  assert.equal((await g.get(`/api/matches/${s.id}/replay`)).status,410);assert.equal((await g.get(`/api/matches/${s.id}/export?format=jsonl`)).status,410);
 }finally{await d.close();}
});
test('capacity and quota ceilings answer 429 instead of exhausting the free plan',async()=>{
 const d=await direct({MAX_ACTIVE_MATCHES:'1',MAX_MATCHES_PER_DAY:'3',SESSIONS_PER_10_MIN:'4'});try{
  const a=await d.guest(),b=await d.guest();await begin(d,a);
  assert.equal((await b.post('/api/matches',options())).status,429);
  d.clock.advance(120000);assert.equal((await b.post('/api/matches',options())).status,201);
  d.clock.advance(120000);const c=await d.guest();assert.equal((await c.post('/api/matches',options())).status,201);
  d.clock.advance(120000);const e=await d.guest();assert.equal((await e.post('/api/matches',options())).status,429,'daily match cap');
  const blocked=await d.call('/api/me');assert.equal(blocked.status,429,'session creation cap');
 }finally{await d.close();}
});
test('a missing configuration is reported instead of serving a half-working Worker',async()=>{
 const {default:worker}=await import('../server/worker.js');
 const bare=await worker.fetch(new Request(ORIGIN+'/api/health'),{},{waitUntil(){}});assert.equal(bare.status,503);
 const prod=await worker.fetch(new Request('https://minesweeper.jevplay.games/api/health'),{APP_ORIGIN:'https://minesweeper.jevplay.games'},{waitUntil(){}});assert.equal(prod.status,503);
});
test('a database failure during verification is retried, not mistaken for a bad journal',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g);
  for(let i=0;i<4;i++){d.clock.advance(600);await poll(g,s.id);await d.idle();}
  await g.post(`/api/matches/${s.id}/actions`,act({type:'resign'}));
  const db=d.app.database,real=db.prepare;let failing=true,hits=0;
  db.prepare=sql=>{if(failing&&sql.includes('FROM match_events WHERE match_id=? AND seq>?')){hits++;throw new Error('D1_ERROR: network connection lost');}return real(sql);};
  for(let i=0;i<3;i++){await poll(g,s.id);await d.idle();}
  assert.ok(hits>0);assert.equal(d.sql('SELECT verification FROM matches WHERE id=?',s.id).verification,'pending');assert.equal(d.sql('SELECT verify_lease_until AS l FROM matches WHERE id=?',s.id).l,null,'the lease is released so the next step can run');
  failing=false;db.prepare=real;
  assert.equal((await untilSettled(d,g,s.id)).eligibility.verification,'verified');
 }finally{await d.close();}
});
test('a database failure while computing a decision does not unrank the match',async()=>{
 const d=await direct({},{key:true});try{
  const g=await d.guest(),s=await begin(d,g),db=d.app.database,real=db.prepare;let failing=true;
  db.prepare=sql=>{if(failing&&sql.includes('INSERT INTO jev_decisions')){throw new Error('D1_ERROR: overloaded');}return real(sql);};
  await poll(g,s.id);await d.idle();
  failing=false;db.prepare=real;
  const snap=(await poll(g,s.id)).data;await d.idle();assert.ok(!snap.eligibility.reasons.includes('solver_failure'));
  assert.equal(d.rows('SELECT * FROM jev_decisions WHERE match_id=?',s.id).length,1,'the next attempt succeeded');assert.equal(d.sql('SELECT prep_attempts AS a FROM matches WHERE id=?',s.id).a,0);
 }finally{await d.close();}
});
