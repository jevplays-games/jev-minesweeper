/** Explicitly unofficial, browser-only practice. No server score submission. */
import {createMatch,startMatch,observeMatch,observeBoard,applyMatchAction,adjudicate,finish,digest,clone} from '/shared/engine.js';
import {decisionSurface,POLICY_VERSION} from '/shared/solver.js';
import {buildRequest,selectCandidate,publicDecision} from '/shared/decisions.js';
import {makeEvent,exportReplay} from '/shared/replay.js';
import {analyzeReplay} from '/shared/analytics.js';
const seed=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
export class OfflineGame {
  static async create(config,onUpdate) {
    const g=new OfflineGame();g.state=await createMatch(config,{human:seed(),jev:seed()},crypto.randomUUID());g.events=[];g.onUpdate=onUpdate;g.lastDecision=null;g.startedAt=null;g.nextDue=1000;g.queue=Promise.resolve();g.closed=false;
    g.timer=setInterval(()=>g.serial(()=>g.tick()).catch(()=>{}),100);g.emit();return g;
  }
  serial(fn){const next=this.queue.catch(()=>{}).then(fn);this.queue=next;return next;}
  elapsed(){return this.state.phase==='ready'?0:this.state.phase==='complete'?this.state.finishedAtMs:Math.max(this.state.lastAtMs,Date.now()-this.startedAt);}
  view(){return {...observeMatch(this.state),elapsedMs:this.elapsed(),lastEventAtMs:this.state.lastAtMs,serverNow:Date.now(),startedAt:this.startedAt,seq:this.events.length,eligibility:{requested:false,eligible:false,verification:this.state.phase==='complete'?'local-only':'pending',reasons:['offline_practice']},opponent:'Offline local heuristic — not JEV',decision:publicDecision(this.lastDecision),offline:true};}
  emit(){this.onUpdate(this.view());}
  async event(type,actor,atMs,payload={},decision=null){this.events.push(await makeEvent(this.events,type,actor,atMs,payload,decision));this.emit();}
  async due(atMs){const next=clone(this.state);if(adjudicate(next,atMs)){this.state=next;await this.event('adjudicate','system',atMs);return true;}return false;}
  async action(body){return this.serial(async()=>{
    if(this.closed||this.state.phase==='complete')throw new Error('Offline match complete');
    const atMs=this.elapsed();if(this.state.phase==='running'&&await this.due(atMs))return;
    const action=body.action;
    if(action.type==='start'){await startMatch(this.state,action.cell);this.startedAt=Date.now();await this.event('start','human',0,{cell:action.cell});}
    else if(action.type==='resign'){
      if(this.state.phase==='ready'){finish(this.state,'void','ready_expired',0);await this.event('void','system',0,{reason:'ready_expired'});}
      else{finish(this.state,'loss','resigned',atMs);await this.event('resign','human',atMs);}
    }else{const expectedRevision=this.state.boards.human.revision;applyMatchAction(this.state,'human',action,atMs);await this.event('action','human',atMs,{action,expectedRevision});}
  });}
  async tick(){
    if(this.closed||this.state.phase!=='running')return;
    let atMs=this.elapsed();if(await this.due(atMs))return;
    if(this.state.boards.jev.status!=='active'||atMs<this.nextDue)return;
    const started=performance.now(),observation=observeBoard(this.state.boards.jev),surface=decisionSurface(observation,this.state.config.aiDifficulty);
    const {candidates}=buildRequest(observation,surface,this.state.config.model),selected=selectCandidate(candidates).selected;
    const d={id:crypto.randomUUID(),policyVersion:POLICY_VERSION,model:this.state.config.model,boardRevision:observation.revision,observationHash:await digest(observation),candidates,legalCount:surface.legalCount,solver:{nodes:surface.analysis.nodes,exactComplete:surface.analysis.exactComplete,cutoffReason:surface.analysis.cutoffReason},solverMs:performance.now()-started,requestBytes:0,source:candidates.length===1?'forced':'local',fallback:false,errorCode:'offline_practice',attempts:[],response:null,selected,latencyMs:performance.now()-started};
    atMs=this.elapsed();if(await this.due(atMs))return;
    applyMatchAction(this.state,'jev',selected.action,atMs);this.lastDecision=d;await this.event('action','jev',atMs,{action:selected.action,expectedRevision:d.boardRevision},d);this.nextDue=atMs+1000;
  }
  replay(){return exportReplay(this.state,this.events,{eligible:false,verification:'local-only',eligibilityReasons:['offline_practice'],competitionKey:'offline-practice'});}
  async analytics(){return analyzeReplay(this.replay());}
  close(){this.closed=true;clearInterval(this.timer);}
}
