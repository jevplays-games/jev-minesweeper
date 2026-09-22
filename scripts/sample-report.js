/** Deterministic synthetic regression match, NOT a human performance result. */
import {mkdir,writeFile} from 'node:fs/promises';
import {createMatch,startMatch,observeBoard,applyMatchAction,adjudicate} from '../shared/engine.js';
import {decisionSurface} from '../shared/solver.js';
import {makeEvent,exportReplay,verifyReplay} from '../shared/replay.js';
import {analyzeReplay,csv} from '../shared/analytics.js';
import {chooseJevAction} from '../server/jev.js';
import {loadConfig,gameConfig} from '../server/config.js';
const config={...loadConfig(),jevKey:''},state=await createMatch(gameConfig(config),{human:'a'.repeat(64),jev:'b'.repeat(64)},'synthetic-sample-match');

const events=[];await startMatch(state,40);events.push(await makeEvent(events,'start','human',0,{cell:40}));
let humanDue=600,jevDue=1000;
for(let step=0;step<500&&state.phase==='running';step++){
 const actor=humanDue<=jevDue?'human':'jev',atMs=Math.min(humanDue,jevDue);
 if(adjudicate(state,atMs)){events.push(await makeEvent(events,'adjudicate','system',atMs));break;}
 const b=state.boards[actor];
 if(b.status==='active'){
  const observation=observeBoard(b),decision=actor==='jev'?await chooseJevAction({observation,difficulty:'normal',config}):null;
  const action=decision?.selected.action||decisionSurface(observation,'normal').candidates[0]?.action;
  if(action){const expectedRevision=b.revision;applyMatchAction(state,actor,action,atMs);events.push(await makeEvent(events,'action',actor,atMs,{expectedRevision,action},decision));}
 }
 if(actor==='human')humanDue+=600;else jevDue+=1000;
}
if(state.phase!=='complete')throw new Error('Sample did not terminate.');
const replay=exportReplay(state,events,{fixture:true,eligible:false,verification:'verified',eligibilityReasons:['synthetic_regression_fixture'],note:'Both players are scripted local policies. No human performance or live JEV result is represented.'});
await verifyReplay(replay);const analytics=await analyzeReplay(replay);
await mkdir('reports/sample',{recursive:true});
await writeFile('reports/sample/replay.json',JSON.stringify(replay,null,2));
await writeFile('reports/sample/analytics.json',JSON.stringify(analytics,null,2));
await writeFile('reports/sample/actions.csv',csv(analytics.actions));
await writeFile('reports/sample/timeline.csv',csv(analytics.timeline));
await writeFile('reports/sample/events.jsonl',events.map(x=>JSON.stringify(x)).join('\n')+'\n');
console.log(JSON.stringify({fixture:true,events:events.length,result:state.outcome,humanActions:analytics.players.human.actions,opponentActions:analytics.players.jev.actions},null,2));
