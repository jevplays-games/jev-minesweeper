import test from 'node:test';import assert from 'node:assert/strict';
import {boardFromMines,observeBoard} from '../shared/engine.js';import {decisionSurface} from '../shared/solver.js';
import {buildRequest,validateResponse,selectCandidate,MODEL} from '../shared/decisions.js';import {chooseJevAction} from '../server/jev.js';import {validResponse,roundedResponse} from './helpers.js';
const observation=observeBoard(boardFromMines(3,3,[0,8]));const surface=decisionSurface(observation,'normal'),built=buildRequest(observation,surface);
const cfg={model:MODEL,jevKey:'test-only-not-a-real-key',jevEndpoint:'https://example.invalid',providerTimeoutMs:500};
test('documented TypeSafe response shape validates',()=>assert.equal(validateResponse(validResponse(built.request),built.request).model,MODEL));
for(const[field,mutate]of[
 ['wrong model',r=>{r.model='other';}],['missing answer',r=>{delete r.answers.preferred_action;}],['unknown choice',r=>{r.answers.preferred_action.choice='illegal';}],['negative probability',r=>{r.answers.preferred_action.probabilities[built.candidates[0].id]=-1;}],['bad probability sum',r=>{r.answers.preferred_action.probabilities[built.candidates[0].id]=.5;}],['invalid confidence',r=>{r.answers.preferred_action.confidence=2;}],['invalid noul',r=>{r.answers['safe_'+built.candidates[0].id].noul=NaN;}],['score mismatch',r=>{r.answers['progress_'+built.candidates[0].id].score=0;}],['invalid usage',r=>{r.usage.input_tokens=-1;}]
])test(`rejects ${field}`,()=>{const r=validResponse(built.request);mutate(r);assert.throws(()=>validateResponse(r,built.request));});
test('model risk influences uncertain-cell selection',()=>{const r=validResponse(built.request);r.answers['safe_'+built.candidates[0].id].noul=.01;const selected=selectCandidate(built.candidates,r).selected;assert.notEqual(selected.id,built.candidates[0].id);assert.equal(selected.evaluatedRisk.source,'model-estimate');});
test('remote adapter applies validated typed response',async()=>{const d=await chooseJevAction({observation,difficulty:'normal',config:cfg,fetchImpl:async(_url,options)=>new Response(JSON.stringify(validResponse(JSON.parse(options.body))),{status:200})});assert.equal(d.source,'jev');assert.equal(d.fallback,false);assert.equal(d.attempts.length,1);});
test('missing key is explicitly local, not a fabricated JEV call',async()=>{const d=await chooseJevAction({observation,difficulty:'normal',config:{...cfg,jevKey:''}});assert.equal(d.source,'local');assert.equal(d.response,null);assert.equal(d.attempts.length,0);assert.equal(d.errorCode,'not_configured');});
test('provider authentication failures are not retried',async()=>{let calls=0;const d=await chooseJevAction({observation,difficulty:'normal',config:cfg,fetchImpl:async()=>{calls++;return new Response('{}',{status:401});}});assert.equal(calls,1);assert.equal(d.fallback,true);assert.equal(d.errorCode,'http_401');});
test('Retry-After longer than recovery budget is honored without retry',async()=>{let calls=0;const d=await chooseJevAction({observation,difficulty:'normal',config:cfg,fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'10'}});}});assert.equal(calls,1);assert.equal(d.source,'local');});
test('retryable overload gets one bounded retry',async()=>{let calls=0;const d=await chooseJevAction({observation,difficulty:'normal',config:cfg,fetchImpl:async(_u,options)=>{if(++calls===1)return new Response('{}',{status:529,headers:{'Retry-After':'0'}});return new Response(JSON.stringify(validResponse(JSON.parse(options.body))),{status:200});}});assert.equal(calls,2);assert.equal(d.source,'jev');});
test('malformed response falls back and records failure',async()=>{const d=await chooseJevAction({observation,difficulty:'normal',config:cfg,fetchImpl:async()=>new Response('not json',{status:200})});assert.equal(d.fallback,true);assert.equal(d.errorCode,'invalid_json');});
test('timeout cannot hang the game adapter',async()=>{const d=await chooseJevAction({observation,difficulty:'normal',config:{...cfg,providerTimeoutMs:20},fetchImpl:(_u,{signal})=>new Promise((_resolve,reject)=>{const hold=setTimeout(()=>reject(new Error('test watchdog')),200);signal.addEventListener('abort',()=>{clearTimeout(hold);reject(signal.reason);},{once:true});})});assert.equal(d.source,'local');assert.equal(d.errorCode,'timeout');});
test('provider-rounded distributions validate: tolerances derive from the 0.01 grain, not exact arithmetic',()=>{
 const r=roundedResponse(built.request);
 const score=Object.entries(built.request.questions).find(([,q])=>q.type==='score')[0];
 const a=r.answers[score],keys=Object.keys(a.probabilities);
 const mean=keys.reduce((s,k)=>s+Number(k)*a.probabilities[k],0);
 assert.ok(Math.abs(a.score-mean)>0.005,'fixture must actually exercise rounding drift');
 assert.equal(validateResponse(r,built.request).model,MODEL);
});
test('rounding tolerance still fails closed on a genuinely inconsistent score',()=>{
 const r=roundedResponse(built.request);
 const score=Object.entries(built.request.questions).find(([,q])=>q.type==='score')[0];
 r.answers[score].score=0;
 assert.throws(()=>validateResponse(r,built.request));
});
