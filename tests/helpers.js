import {createMatch,startMatch,applyMatchAction,adjudicate,finish} from '../shared/engine.js';
import {makeEvent,exportReplay} from '../shared/replay.js';
import {MODEL,SCORE_LEVELS} from '../shared/decisions.js';
import {POLICY_VERSION} from '../shared/solver.js';
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
