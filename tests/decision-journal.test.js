import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatch,startMatch,observeBoard,applyMatchAction,adjudicate,finish} from '../public/shared/engine.js';
import {makeEvent,exportReplay,eventHash,verifyReplay} from '../public/shared/replay.js';
import {analyzeReplay} from '../public/shared/analytics.js';
import {chooseJevAction} from '../server/jev.js';
import {config,seeds,validResponse} from './helpers.js';
async function fixture(){
 const state=await createMatch({...config,aiDifficulty:'easy'},seeds,'mocked-provider-fixture'),events=[];
 await startMatch(state,0);events.push(await makeEvent(events,'start','human',0,{cell:0}));
 for(let step=1;step<=40&&state.phase==='running';step++){
  const atMs=step*1000;if(adjudicate(state,atMs)){events.push(await makeEvent(events,'adjudicate','system',atMs));break;}
  if(state.boards.jev.status!=='active'){finish(state,'loss','resigned',atMs);events.push(await makeEvent(events,'resign','human',atMs));break;}
  const d=await chooseJevAction({observation:observeBoard(state.boards.jev),difficulty:'easy',config:{jevKey:'mock-only-not-real',model:config.model,providerTimeoutMs:1000,jevEndpoint:'https://provider.invalid'},fetchImpl:async(url,options)=>new Response(JSON.stringify(validResponse(JSON.parse(options.body))),{status:200})});
  const expectedRevision=state.boards.jev.revision,action=d.selected.action;applyMatchAction(state,'jev',action,atMs);events.push(await makeEvent(events,'action','jev',atMs,{expectedRevision,action},d));
 }
 if(state.phase!=='complete'){const atMs=events.at(-1).atMs+1000;finish(state,'loss','resigned',atMs);events.push(await makeEvent(events,'resign','human',atMs));}
 return exportReplay(state,events,{fixture:true,eligible:false,verification:'verified'});
}
async function rehash(replay){let previous=null;for(const e of replay.events){e.previousHash=previous;e.hash=await eventHash(e);previous=e.hash;}replay.headHash=previous;return replay;}
test('recorded mocked provider choices verify without network inference',async()=>{const replay=await fixture();assert.ok(replay.events.some(e=>e.decision?.source==='jev'));const verified=await verifyReplay(replay);assert.equal(verified.verified,true);});
test('recorded provider usage and decision totals reconcile to analytics',async()=>{const replay=await fixture(),a=await analyzeReplay(replay);const decisions=replay.events.filter(e=>e.decision).map(e=>e.decision);assert.equal(a.opponent.decisions,decisions.length);assert.equal(a.opponent.providerAttempts,decisions.reduce((s,d)=>s+d.attempts.length,0));assert.equal(a.opponent.tokenUsage.inputTokens,a.opponent.providerAttempts*128);assert.equal(a.opponent.calibration.allEvaluated.count,decisions.reduce((s,d)=>s+Object.keys(d.response?.answers||{}).filter(k=>k.startsWith('safe_')).length,0));});
for(const [name,mutate] of[
 ['observation hash',d=>d.observationHash='forged'],
 ['model',d=>d.model='forged-model'],
 ['candidate',d=>d.candidates[0].coveredNeighbors=999],
 ['selected action',d=>d.selected.action.cell=999],
 ['false forced source',d=>d.source='forced'],
 ['invalid provider probability',d=>d.response.answers.preferred_action.probabilities[d.response.answers.preferred_action.choice]=2]
])test(`rehashing cannot legitimize a changed ${name} in an applied decision`,async()=>{const replay=await fixture();const event=replay.events.find(e=>e.decision?.source==='jev'&&e.decision.candidates.length>1);assert.ok(event);mutate(event.decision);await rehash(replay);await assert.rejects(verifyReplay(replay));});
