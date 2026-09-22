import {request,setCsrf,subscribe,download,downloadEndpoint} from './api.js';
import {PRESETS,createMatch,observeMatch} from '/shared/engine.js';
import {applyRecordedEvent} from '/shared/replay.js';
import {csv} from '/shared/analytics.js';
import {MODEL} from '/shared/decisions.js';
import {POLICY_VERSION} from '/shared/solver.js';
const $=id=>document.getElementById(id);
let me=null,snapshot=null,unsubscribe=null,offline=null,report=null,reportIsOffline=false,reportReplay=null,livePoints=[],focusCell=40,flagMode=false,actionQueue=Promise.resolve(),historyCursor=null,leaderboardCursor=null,frames=[],lastAutoReport=null;
let receivedAt=performance.now(),receivedElapsed=0;
const text=(id,value)=>{$(id).textContent=value;};
const number=(v,digits=0)=>v===null||v===undefined||!Number.isFinite(v)?'—':v.toLocaleString(undefined,{maximumFractionDigits:digits});
const percent=(v,digits=1)=>v===null||v===undefined?'—':`${number(v*100,digits)}%`;
const ms=v=>v===null||v===undefined?'—':v<1000?`${number(v)} ms`:`${number(v/1000,2)} s`;
const time=v=>{const seconds=Math.max(0,v)/1000;return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${(seconds%60).toFixed(1).padStart(4,'0')}`;};
function notify(message,type=''){text('notice',message);$('notice').className=`notice ${type}`;}
function connection(ok,message){text('connection',offline?'Offline practice':ok?'Connected':'Reconnecting');$('connection').className=`connection ${ok?'online':'offline'}`;if(message)notify(message,'error');}
function preferences(){try{return JSON.parse(localStorage.getItem('jev-ms-preferences')||'{}');}catch{return{};}}
function savePreferences(){try{localStorage.setItem('jev-ms-preferences',JSON.stringify({preset:$('preset').value,difficulty:$('difficulty').value,analysis:$('analysisToggle').checked,cellSize:$('cellSize').value}));}catch{}}
const prefs=preferences();if(Object.hasOwn(PRESETS,prefs.preset))$('preset').value=prefs.preset;if(['easy','normal','hard','jev'].includes(prefs.difficulty))$('difficulty').value=prefs.difficulty;if(typeof prefs.analysis==='boolean')$('analysisToggle').checked=prefs.analysis;
if(prefs.cellSize==='large')$('cellSize').value='large';
let launch=null;try{const fragment=new URLSearchParams(location.hash.slice(1));launch=fragment.get('launch')||sessionStorage.getItem('jev-ms-launch');if(fragment.has('launch')){sessionStorage.setItem('jev-ms-launch',launch);history.replaceState(null,'',location.pathname);}}catch{}
function emptyBoard(){const c=PRESETS[$('preset').value];return {...c,cells:Array(c.width*c.height).fill(-1),status:'ready',revision:0,revealedSafe:0,flagsPlaced:0,terminalAtMs:null};}
function renderBoard(element,board,interactive=false){
  element.classList.toggle('large',$('cellSize').value==='large');
  const signature=`${board.width}x${board.height}:${interactive}`;
  if(element.dataset.signature!==signature){
    element.replaceChildren();element.dataset.signature=signature;element.style.setProperty('--cols',board.width);element.setAttribute('aria-rowcount',board.height);element.setAttribute('aria-colcount',board.width);
    for(let r=0;r<board.height;r++){const row=document.createElement('div');row.className='board-row';row.setAttribute('role','row');
      for(let c=0;c<board.width;c++){const cell=document.createElement(interactive?'button':'span');cell.className='cell';cell.dataset.cell=r*board.width+c;cell.setAttribute('role','gridcell');if(interactive){cell.type='button';cell.tabIndex=-1;}row.append(cell);}element.append(row);
    }
  }
  focusCell=Math.min(focusCell,board.cells.length-1);
  for(const cell of element.querySelectorAll('[data-cell]')){
    const i=Number(cell.dataset.cell),v=board.cells[i];let label;
    cell.className=`cell ${v>=0?'open n'+v:v===-2?'flagged':v===-3?'exploded':''}`;
    cell.textContent=v===-1||v===0?'':v===-2?'⚑':v===-3?'✹':String(v);
    label=v===-1?'Covered':v===-2?'Flagged':v===-3?'Exploded mine':`Revealed. ${v} adjacent mines`;
    cell.setAttribute('aria-label',`Row ${Math.floor(i/board.width)+1}, column ${i%board.width+1}. ${label}.`);
    if(interactive){cell.tabIndex=i===focusCell?0:-1;cell.setAttribute('aria-disabled',String(board.status!=='active'&&board.status!=='ready'));}
  }
}
function update(next){
  if(snapshot?.id===next.id&&next.seq<snapshot.seq)return;
  const changedMatch=snapshot?.id!==next.id;
  if(changedMatch){livePoints=[];lastAutoReport=null;focusCell=Math.floor(next.config.height/2)*next.config.width+Math.floor(next.config.width/2);}
  snapshot=next;receivedAt=performance.now();receivedElapsed=next.elapsedMs;
  if(next.config.preset){$('preset').value=next.config.preset;$('difficulty').value=next.config.aiDifficulty;}
  const point={seq:next.seq,atMs:next.lastEventAtMs??next.elapsedMs,humanSafe:next.boards.human.revealedSafe,jevSafe:next.boards.jev.revealedSafe};
  if(livePoints.at(-1)?.seq===point.seq)livePoints[livePoints.length-1]=point;else livePoints.push(point);
  render();
  if(next.phase==='complete'&&(next.eligibility.verification==='verified'||next.offline)&&lastAutoReport!==next.id){lastAutoReport=next.id;loadReport(next.id,Boolean(next.offline)).catch(e=>text('reportStatus',e.message));}
}
function render(){
  const h=snapshot?.boards.human||emptyBoard(),j=snapshot?.boards.jev||emptyBoard(),target=h.width*h.height-h.mineCount;
  renderBoard($('humanBoard'),h,true);renderBoard($('jevBoard'),j,false);
  text('humanProgress',`${h.revealedSafe} / ${target}`);text('jevProgress',`${j.revealedSafe} / ${target}`);
  $('humanMeter').max=target;$('humanMeter').value=h.revealedSafe;$('jevMeter').max=target;$('jevMeter').value=j.revealedSafe;
  const phase=snapshot?.phase||'ready';
  text('humanStatus',h.status==='ready'?'Choose your opening':h.status==='active'?'Board active':h.status==='cleared'?'All safe cells cleared':'Mine hit · board ended');
  text('jevStatus',j.status==='ready'?'Waiting for your opening':j.status==='active'?'One move per second':j.status==='cleared'?'All safe cells cleared':'Mine hit · board ended');
  text('flagCount',`${h.flagsPlaced} flags / ${h.mineCount} mines`);
  const actualJev=me?.features.jev&&!offline;
  text('opponentTitle',actualJev?'JEV':'Local opponent');text('opponentBadge',snapshot?.opponent||(actualJev?'JEV + constraint solver':'Local heuristic · not JEV'));
  text('liveCompletion',percent(h.revealedSafe/target));const lead=h.revealedSafe-j.revealedSafe;text('liveLead',`${lead>0?'+':''}${lead}`);
  text('liveActions',Math.max(0,h.revision-(h.status==='ready'?0:1)));text('liveJevActions',Math.max(0,j.revision-(j.status==='ready'?0:1)));
  const e=snapshot?.eligibility;
  text('liveVerification',!snapshot?'Not started':phase!=='complete'?'Not yet final':e.verification==='verified'?(e.eligible?'Verified ranked':'Verified rules'):e.verification==='local-only'?'Local only':e.verification);
  text('matchMode',offline?'Offline · unofficial':e?.eligible?'Verified ranked':e?.requested&&!e?.reasons.length?'Ranked candidate':'Unofficial practice');
  $('resign').disabled=!snapshot||phase==='complete';$('loadReport').disabled=!snapshot||phase!=='complete';
  $('contextLabel').hidden=!(launch||me?.context);if(launch)$('context').value='current';
  $('decisionPanel').hidden=!$('analysisToggle').checked;
  renderDecision(snapshot?.decision);drawLive();
  if(phase==='complete'){
    const label={win:'You win',loss:'Opponent wins',draw:'Draw',void:'Match voided'}[snapshot.outcome];
    notify(`${label} · ${snapshot.outcomeReason.replaceAll('_',' ')}. ${e.eligible?'Verified ranked result.':`Unofficial: ${e.reasons.join(', ').replaceAll('_',' ')}.`} Post-game analytics are available below.`,snapshot.outcome==='win'?'success':'');
  }else if(phase==='running'){
    const message=h.status==='exploded'?'Your board exploded. The opponent must still clear; watch it finish or resign.':j.status==='exploded'?'The opponent exploded. Clear your board to win.':`Clear every safe cell. ${offline?'Offline practice is never ranked.':'Hidden layouts and official timing remain server-side.'}`;
    notify(message);
  }
}
function renderDecision(d){
  if(!d){text('decisionAction','Awaiting opening');text('decisionSource','A finite set of legal actions. A validated selection.');for(const id of ['decisionCandidates','decisionLatency','decisionRisk','decisionRiskSource','decisionConfidence','decisionNodes'])text(id,'—');$('decisionEvidence').replaceChildren();return;}
  const width=snapshot.config.width,cell=d.action?.cell;
  text('decisionAction',cell===undefined?'—':`${d.action.type==='setFlag'?(d.action.value?'Flag':'Unflag'):d.action.type==='chord'?'Chord':'Reveal'} R${Math.floor(cell/width)+1} C${cell%width+1}`);
  text('decisionSource',d.source==='jev'?`${d.model} · structured selection`:d.source==='forced'?'Single candidate · deterministic deduction':'Local heuristic · not a JEV inference');
  text('decisionCandidates',d.candidateCount);text('decisionLatency',ms(d.latencyMs));text('decisionRisk',percent(d.risk?.value));text('decisionRiskSource',d.risk?.source||'—');text('decisionConfidence',percent(d.choiceConfidence));text('decisionNodes',number(d.nodes));
  $('decisionEvidence').replaceChildren();for(const value of d.evidence){const item=document.createElement('span');item.className='evidence-tag';item.textContent=value.toLowerCase().replaceAll('_',' ');$('decisionEvidence').append(item);}
}
function canvasContext(canvas,height){const width=Math.max(220,canvas.clientWidth||700),dpr=window.devicePixelRatio||1;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.height=`${height}px`;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);return{ctx,width,height};}
function drawLive(){
  const {ctx,width,height}=canvasContext($('liveChart'),210),left=38,right=16,top=15,bottom=32;
  const target=snapshot?snapshot.config.width*snapshot.config.height-snapshot.config.mineCount:71,maxTime=Math.max(1000,...livePoints.map(p=>p.atMs));
  ctx.clearRect(0,0,width,height);ctx.font='10px system-ui';ctx.fillStyle='#9aaac1';ctx.strokeStyle='#2a3649';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=top+(height-top-bottom)*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();ctx.fillText(String(Math.round(target*(1-i/4))),3,y+3);}
  for(let i=0;i<=4;i++){const x=left+(width-left-right)*i/4;ctx.fillText(`${(maxTime*i/4000).toFixed(0)}s`,x-5,height-9);}
  for(const [key,color]of[['humanSafe','#63d4e7'],['jevSafe','#e9bb68']]){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();livePoints.forEach((p,i)=>{const x=left+p.atMs/maxTime*(width-left-right),y=top+(1-p[key]/target)*(height-top-bottom);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();const last=livePoints.at(-1);if(last){ctx.fillStyle=color;ctx.beginPath();ctx.arc(left+last.atMs/maxTime*(width-left-right),top+(1-last[key]/target)*(height-top-bottom),3,0,Math.PI*2);ctx.fill();}}
  if(!livePoints.length){ctx.fillStyle='#8ea0b8';ctx.font='12px system-ui';ctx.fillText('Start a match to see the race develop.',left+12,110);}
  table($('liveData'),['Event','Elapsed','Your safe cells','Opponent safe cells'],livePoints.map(p=>[p.seq,ms(p.atMs),p.humanSafe,p.jevSafe]));
}
function table(container,headers,rows){container.replaceChildren();if(!rows.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='No records for this selection yet.';container.append(empty);return;}
  const t=document.createElement('table'),head=document.createElement('thead'),hr=document.createElement('tr');for(const h of headers){const th=document.createElement('th');th.textContent=h;th.scope='col';hr.append(th);}head.append(hr);t.append(head);const body=document.createElement('tbody');for(const values of rows){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');if(value instanceof Node)td.append(value);else td.textContent=value===null||value===undefined?'—':String(value);tr.append(td);}body.append(tr);}t.append(body);container.append(t);
}
function stats(container,items){container.replaceChildren();for(const[label,value]of items){const d=document.createElement('div');d.className='stat';const l=document.createElement('span');l.textContent=label;const v=document.createElement('strong');v.textContent=value;d.append(l,v);container.append(d);}}
function switchTab(name){for(const button of document.querySelectorAll('[role=tab]')){const active=button.dataset.panel===name;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;$(`panel-${button.dataset.panel}`).hidden=!active;}if(name==='history')loadHistory().catch(showError);if(name==='leaderboards')loadLeaderboard().catch(e=>{text('leaderboardNote',e.message);});if(name==='live')drawLive();if(name==='report'&&report)drawHeatmaps();}
function showError(e){notify(e.message||String(e),'error');}
async function refreshMe(){me=await request('/api/me');setCsrf(me.csrfToken);text('identity',me.user?.displayName||'Guest player');$('login').hidden=Boolean(me.user);$('logout').hidden=!me.user;$('login').disabled=!me.features.discord;$('login').title=me.features.discord?'Sign in using Discord':'Discord credentials are not configured on this server';$('contextLabel').hidden=!(me.context||launch);return me;}
async function createServerMatch(){
  offline?.close();offline=null;unsubscribe?.();unsubscribe=null;if(!me)await refreshMe();
  const body={requestId:crypto.randomUUID(),boardPreset:$('preset').value,aiDifficulty:$('difficulty').value,mode:$('mode').value,context:$('context').value||'world'};
  if(launch)body.launchTicket=launch;
  const next=await request('/api/matches',{method:'POST',body,retry:true});
  if(launch){launch=null;try{sessionStorage.removeItem('jev-ms-launch');}catch{}await refreshMe();}
  update(next);unsubscribe=subscribe(next.id,update,connection);connection(true);return next;
}
async function newGame(useOffline=false){
  const selected={preset:$('preset').value,difficulty:$('difficulty').value,mode:$('mode').value};
  if(snapshot&&snapshot.phase!=='complete'){
    if(snapshot.phase==='running'&&!confirm('End the current match? A started server match records resignation as a loss.'))return;
    try{await submit({type:'resign'});}catch(e){if(!useOffline)throw e;notify('The server match may continue and become an abandonment loss. Offline practice is separate.','error');}
  }
  $('preset').value=selected.preset;$('difficulty').value=selected.difficulty;$('mode').value=selected.mode;
  if(useOffline){unsubscribe?.();unsubscribe=null;offline?.close();const {OfflineGame}=await import('./offline.js');offline=await OfflineGame.create({...PRESETS[$('preset').value],preset:$('preset').value,aiDifficulty:$('difficulty').value,model:MODEL,policyVersion:POLICY_VERSION,jevIntervalMs:1000,adjudicationMs:100,deadlineMs:900000},update);connection(false);notify('Offline practice. The local heuristic is not JEV, and these results cannot enter server leaderboards.');}
  else{await createServerMatch();notify('Choose any square on your board. The same coordinate opens on both independent layouts.');}
}
async function submit(action){
  if(!snapshot)await createServerMatch();
  const body={requestId:crypto.randomUUID(),expectedBoardRevision:snapshot.boards.human.revision,action};
  if(offline){await offline.action(body);return;}
  try{const response=await request(`/api/matches/${snapshot.id}/actions`,{method:'POST',body,retry:true});update(response.snapshot);}
  catch(e){if(e.status===409){try{update(await request(`/api/matches/${snapshot.id}`));}catch{}}throw e;}
}
function queueAction(fn){actionQueue=actionQueue.catch(()=>{}).then(fn).catch(showError);}
function clickCell(cell,kind='default'){
  queueAction(async()=>{
    if(!snapshot)await createServerMatch();
    if(snapshot.phase==='complete')return;
    const board=snapshot.boards.human;if(board.status==='exploded'||board.status==='cleared')return;
    if(snapshot.phase==='ready'){if(kind==='flag'||flagMode){notify('Choose the opening with Reveal mode before placing flags.');return;}await submit({type:'start',cell});return;}
    const value=board.cells[cell];
    if(kind==='chord'){if(value>0)await submit({type:'chord',cell});}
    else if(kind==='flag'||flagMode){if(value===-1||value===-2)await submit({type:'setFlag',cell,value:value!==-2});}
    else if(value===-1)await submit({type:'reveal',cell});
  });
}
$('humanBoard').addEventListener('click',e=>{const cell=e.target.closest('[data-cell]');if(cell){focusCell=Number(cell.dataset.cell);clickCell(focusCell);}});
$('humanBoard').addEventListener('contextmenu',e=>{const cell=e.target.closest('[data-cell]');if(cell){e.preventDefault();focusCell=Number(cell.dataset.cell);clickCell(focusCell,'flag');}});
$('humanBoard').addEventListener('dblclick',e=>{const cell=e.target.closest('[data-cell]');if(cell)clickCell(Number(cell.dataset.cell),'chord');});
$('humanBoard').addEventListener('keydown',e=>{
  const target=e.target.closest('[data-cell]');if(!target||e.ctrlKey||e.metaKey||e.altKey)return;const board=snapshot?.boards.human||emptyBoard(),i=Number(target.dataset.cell),row=Math.floor(i/board.width),col=i%board.width;let next=i;
  if(e.key==='ArrowRight')next=row*board.width+Math.min(board.width-1,col+1);else if(e.key==='ArrowLeft')next=row*board.width+Math.max(0,col-1);else if(e.key==='ArrowDown')next=Math.min(board.height-1,row+1)*board.width+col;else if(e.key==='ArrowUp')next=Math.max(0,row-1)*board.width+col;else if(e.key.toLowerCase()==='f'){e.preventDefault();clickCell(i,'flag');return;}else if(e.key.toLowerCase()==='c'){e.preventDefault();clickCell(i,'chord');return;}else return;
  e.preventDefault();focusCell=next;for(const cell of $('humanBoard').querySelectorAll('[data-cell]'))cell.tabIndex=Number(cell.dataset.cell)===next?0:-1;$('humanBoard').querySelector(`[data-cell="${next}"]`).focus();
});
function setMode(value){flagMode=value;$('flagMode').setAttribute('aria-pressed',String(value));$('revealMode').setAttribute('aria-pressed',String(!value));}
$('flagMode').onclick=()=>setMode(true);$('revealMode').onclick=()=>setMode(false);
$('newGame').onclick=()=>newGame().catch(showError);$('offline').onclick=()=>newGame(true).catch(showError);$('resign').onclick=()=>{if(confirm('Resign this match? A started match records a loss.'))queueAction(()=>submit({type:'resign'}));};
$('login').onclick=()=>{location.href='/api/auth/discord';};$('logout').onclick=async()=>{try{await request('/api/logout',{method:'POST'});location.reload();}catch(e){showError(e);}};
for(const id of ['preset','difficulty','analysisToggle','cellSize'])$(id).addEventListener('change',()=>{savePreferences();if(!snapshot||id==='cellSize')render();$('decisionPanel').hidden=!$('analysisToggle').checked;});
for(const button of document.querySelectorAll('[role=tab]')){button.addEventListener('click',()=>switchTab(button.dataset.panel));button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const tabs=[...document.querySelectorAll('[role=tab]')],index=tabs.indexOf(button),next=tabs[(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];switchTab(next.dataset.panel);next.focus();});}
async function loadReport(id=snapshot?.id,isOffline=Boolean(offline)){
  if(!id)return;text('reportStatus','Computing metrics from the sealed event log…');$('loadReport').disabled=true;
  try{report=isOffline?await offline.analytics():await request(`/api/matches/${id}/analytics`);reportIsOffline=isOffline;reportReplay=isOffline?offline.replay():null;renderReport();}
  finally{$('loadReport').disabled=!snapshot||snapshot.phase!=='complete';}
}
$('loadReport').onclick=()=>loadReport().catch(e=>{text('reportStatus',e.message);showError(e);});
function renderReport(){
  $('reportContent').hidden=false;const {players:p,opponent:o,result:r}=report;
  text('reportStatus',`${r.outcome.toUpperCase()} · ${r.reason.replaceAll('_',' ')} · ${report.matchId.slice(0,8)} · ${report.analyticsVersion} · ${reportIsOffline?'local-only':'server replay-derived'}`);
  stats($('reportSummary'),[['Your clear time',ms(r.humanClearMs)],['Your completion',percent(p.human.safeCompletionRate)],['Safe cells / command',number(p.human.safeCellsPerAction,2)],['Lead changes',number(report.race.leadChanges)],['Remote JEV decisions',number(o.remoteDecisions)],['Fallback decisions',number(o.fallbackDecisions)]]);
  const metrics=[['Accepted commands','actions',number],['Reveal commands','reveals',number],['Flag placements','flagsPlaced',number],['Flag removals','flagsRemoved',number],['Chord commands','chords',number],['Unsafe chords','unsafeChords',number],['Opening safe cells','safeCellsFromOpening',number],['Safe cells from commands','safeCellsFromActions',number],['Expansion actions','zeroExpansionActions',number],['Expansion bonus cells','zeroExpansionCells',number],['Proven-safe reveals','provenSafeRevealActions',number],['Uncertain reveals','uncertainRevealActions',number],['Uncertain survival rate','uncertainRevealSurvivalRate',percent],['Uncertain despite safe alternative','uncertainRevealsWhileProvenSafeAvailable',number],['Mine hit with safe alternative','explodedWhileProvenSafeAvailable',number],['Known-mine reveals','knownMineRevealActions',number],['Flags at end','flagsAtEnd',number],['Flag precision at end','flagPrecision',percent],['Flag recall at end','flagRecall',percent],['Flag F1 at end','flagF1',percent],['Incorrect flag placements','incorrectFlagPlacements',number],['Correct flags removed','correctFlagsRemoved',number],['Commands per active second','commandsPerSecond',v=>number(v,2)],['Safe cells per command','safeCellsPerAction',v=>number(v,2)],['First command after opening','firstActionMs',ms],['Active time','activeMs',ms],['Exact/proven risk coverage','exactRiskCoverage',percent],['Static 3BV / second on clear','threeBVPerSecondOnClear',v=>number(v,2)]];
  table($('comparison'),['Metric','You','Opponent'],metrics.map(([label,key,format])=>[label,format(p.human[key]),format(p.jev[key])]).concat([['Median command gap',ms(p.human.inputGapMs?.p50),ms(p.jev.inputGapMs?.p50)],['95th percentile command gap',ms(p.human.inputGapMs?.p95),ms(p.jev.inputGapMs?.p95)],['Static board 3BV',number(report.boards.human?.threeBV),number(report.boards.jev?.threeBV)]]));
  table($('opponentReport'),['Metric','Value'],[['Total decisions',number(o.decisions)],['Remote / forced / local',`${o.remoteDecisions} / ${o.forcedDecisions} / ${o.localDecisions}`],['Provider attempts / retries',`${o.providerAttempts} / ${o.retryCount}`],['Invalid responses',o.invalidResponseCount],['Decision median / p95',`${ms(o.latencyMs.p50)} / ${ms(o.latencyMs.p95)}`],['Provider median / p95',`${ms(o.providerLatencyMs.p50)} / ${ms(o.providerLatencyMs.p95)}`],['Mean candidates',number(o.candidates.mean,2)],['Mean choice confidence',percent(o.choiceConfidence.mean)],['Exact enumeration rate',percent(o.exactEnumerationRate)],['Measured input / output tokens',`${number(o.tokenUsage.inputTokens)} / ${number(o.tokenUsage.outputTokens)}`],['Attempts with unknown usage',o.tokenUsage.unknownAttempts],['Configured cost estimate',o.estimatedCost.amount===null?'Price not configured':`$${o.estimatedCost.amount.toFixed(6)} (measured usage only)`],['Scheduling misses',report.operations.schedulingMisses],['Rejected actions',report.operations.rejectedRequests],['Idempotent retries',report.operations.idempotentRetries],['Reconnects',report.operations.reconnects],['Selected safety Brier score',number(o.calibration.selected.brier,5)],['All-evaluated safety Brier score',number(o.calibration.allEvaluated.brier,5)]]);
  const calibrationRows=o.calibration.selected.bins.map((b,i)=>[`${b.lower.toFixed(1)}–${b.upper.toFixed(1)}`,b.count,percent(b.meanPrediction),percent(b.observedFrequency),o.calibration.allEvaluated.bins[i].count]);
  table($('calibration'),['Safety probability bin','Selected samples','Mean prediction','Observed safe rate','All-evaluated samples'],calibrationRows);
  text('actionCoverage',`Showing ${Math.min(200,report.actions.length)} of ${report.actions.length} accepted actions. CSV and JSON exports include every recorded action.`);
  table($('actionJournal'),['Event','Actor','Time','Action','Cell','Safe Δ','Classification','Risk / source','Safe alternatives'],report.actions.slice(0,200).map(a=>[a.seq,a.actor,ms(a.atMs),a.type+(a.flagValue===null?'':a.flagValue?' on':' off'),`R${a.row} C${a.column}`,a.safeDelta,a.classification,`${percent(a.riskValue)} / ${a.riskSource||'—'}`,a.provenSafeAvailable]));
  table($('decisionJournal'),['Decision','Source','Candidates','Chosen action','Mine risk','Latency','Input tokens','Fallback'],report.decisionJournal.slice(0,200).map(d=>[d.id.slice(0,8),d.source,d.candidates.length,d.selected.id,`${percent(d.selected.evaluatedRisk.value)} (${d.selected.evaluatedRisk.source})`,ms(d.latencyMs),d.response?.usage.input_tokens??'—',d.fallback?'Yes':'No']));
  text('reportLimitations',report.limitations.join(' '));renderMetricExplorer();drawHeatmaps();
}
function flatten(value,path='',out=[]){
  if(value===null||typeof value!=='object'){out.push([path,typeof value==='number'?number(value,6):value===null?'null / not available':String(value)]);return out;}
  if(Array.isArray(value)&&value.length>12){out.push([path,`${value.length} entries — full values in JSON export`]);return out;}
  for(const[k,v]of Object.entries(value)){if(['decisionJournal','actions','timeline'].includes(k))continue;flatten(v,path?`${path}.${k}`:k,out);}return out;
}
function renderMetricExplorer(){if(!report)return;const q=$('metricSearch').value.toLowerCase();table($('metricExplorer'),['Field','Value'],flatten(report).filter(([k])=>k.toLowerCase().includes(q)));}
$('metricSearch').oninput=renderMetricExplorer;
function drawHeatmaps(){if(!report)return;const type=$('heatmapType').value;for(const actor of['human','jev']){const values=report.players[actor].heatmaps[type],w=report.configuration.width,h=report.configuration.height;const{ctx,width,height}=canvasContext($(actor+'Heatmap'),270);ctx.clearRect(0,0,width,height);const max=Math.max(1,...values.filter(v=>v!==null)),size=Math.min((width-20)/w,(height-18)/h),x=(width-size*w)/2,y=(height-size*h)/2;
  for(let i=0;i<values.length;i++){const value=values[i],intensity=value===null?0:Math.max(.08,value/max);ctx.fillStyle=actor==='human'?`rgba(99,212,231,${.07+intensity*.86})`:`rgba(233,187,104,${.07+intensity*.86})`;ctx.fillRect(x+i%w*size+1,y+Math.floor(i/w)*size+1,size-2,size-2);if(size>=23){ctx.font='10px system-ui';ctx.textAlign='center';ctx.fillStyle=intensity>.5?'#07131f':'#c5d2e3';ctx.fillText(value===null?'·':type==='revealAtMs'?(value/1000).toFixed(0):String(value),x+(i%w+.5)*size,y+(Math.floor(i/w)+.5)*size+3);}}
}}
$('heatmapType').onchange=drawHeatmaps;
async function exportReport(format){if(!report)return;const id=report.matchId;if(!reportIsOffline){await downloadEndpoint(`/api/matches/${id}/export?format=${format}`,`minesweeper-${format}`);return;}if(format==='json')download(report,`minesweeper-${id}-analytics.json`);else if(format==='jsonl')download(reportReplay.events.map(e=>JSON.stringify(e)).join('\n')+'\n',`minesweeper-${id}-events.jsonl`,'application/x-ndjson');else download(csv(format==='csv'?report.actions:report.timeline),`minesweeper-${id}-${format}.csv`,'text/csv');}
$('exportJson').onclick=()=>exportReport('json').catch(showError);$('exportCsv').onclick=()=>exportReport('csv').catch(showError);$('exportTimeline').onclick=()=>exportReport('timeline').catch(showError);$('exportEvents').onclick=()=>exportReport('jsonl').catch(showError);
async function getReportReplay(){if(reportReplay)return reportReplay;reportReplay=await request(`/api/matches/${report.matchId}/replay`);return reportReplay;}
$('exportReplay').onclick=()=>getReportReplay().then(r=>download(r,`minesweeper-${r.matchId}-replay.json`)).catch(showError);
$('viewReplay').onclick=async()=>{try{const replay=await getReportReplay(),state=await createMatch(replay.config,replay.seeds,replay.matchId);frames=[{view:observeMatch(state),caption:'Before the protected opening'}];for(const e of replay.events){await applyRecordedEvent(state,e);frames.push({view:observeMatch(state),caption:`Event ${e.seq} · ${e.actor} ${e.type} · ${ms(e.atMs)}`});}$('replayStep').max=frames.length-1;$('replayStep').value='0';renderReplay();$('replayDialog').showModal();}catch(e){showError(e);}};
function renderReplay(){const frame=frames[Number($('replayStep').value)];if(!frame)return;text('replayCaption',frame.caption);renderBoard($('replayHuman'),frame.view.boards.human,false);renderBoard($('replayJev'),frame.view.boards.jev,false);}
$('replayStep').oninput=renderReplay;$('replayPrev').onclick=()=>{$('replayStep').value=Math.max(0,Number($('replayStep').value)-1);renderReplay();};$('replayNext').onclick=()=>{$('replayStep').value=Math.min(frames.length-1,Number($('replayStep').value)+1);renderReplay();};$('closeReplay').onclick=()=>$('replayDialog').close();
function filterQuery(period){return new URLSearchParams({preset:$('preset').value,difficulty:$('difficulty').value,period});}
async function loadHistory(cursor=null){const q=filterQuery($('historyPeriod').value);q.set('mode',$('historyMode').value);if(cursor)q.set('cursor',cursor);const data=await request(`/api/analytics/profile?${q}`),s=data.summary;stats($('historySummary'),[['Completed',number(s.completed)],['Wins / losses / draws',`${s.wins} / ${s.losses} / ${s.draws}`],['Clear-win rate',percent(s.clearWinRate)],['Best actual clear',ms(s.clearTimeMs.min)],['Current / best streak',`${s.currentWinStreak} / ${s.bestWinStreak}`]]);
  table($('historyTable'),['Finished','Difficulty','Result','Eligibility','Clear time','Report'],data.matches.map(m=>{const b=document.createElement('button');b.className='link-button';b.textContent='Inspect';b.onclick=()=>{switchTab('report');loadReport(m.id,false).catch(e=>text('reportStatus',e.message));};return[new Date(m.finished_at).toLocaleString(),m.ai_difficulty,m.outcome,m.eligible?'Ranked':'Unofficial',ms(m.human_clear_ms),b];}));historyCursor=data.nextCursor;$('historyMore').hidden=!historyCursor;
}
async function loadLeaderboard(cursor=null){const q=filterQuery($('leaderboardPeriod').value);q.set('scope',$('leaderboardScope').value);if(cursor)q.set('cursor',cursor);const data=await request(`/api/leaderboard?${q}`);table($('leaderboardTable'),['Rank','Player','Clear-win rate','W','L','D','Games','Best clear','Streak'],data.entries.map(e=>[e.provisional?`${e.completed}/20`:e.rank,e.displayName,percent(e.clearWinRate),e.wins,e.losses,e.draws,e.completed,ms(e.clearTimeMs.min),e.currentWinStreak]));text('leaderboardNote',`${data.totalPlayers} players · ${data.scope} · ${data.weeklyBoundary} · ${data.competitionKey}`);leaderboardCursor=data.nextCursor;$('leaderboardMore').hidden=!leaderboardCursor;}
$('refreshHistory').onclick=()=>loadHistory().catch(showError);$('historyMore').onclick=()=>loadHistory(historyCursor).catch(showError);for(const id of['historyPeriod','historyMode'])$(id).onchange=()=>loadHistory().catch(showError);
$('refreshLeaderboard').onclick=()=>loadLeaderboard().catch(e=>text('leaderboardNote',e.message));$('leaderboardMore').onclick=()=>loadLeaderboard(leaderboardCursor).catch(showError);for(const id of['leaderboardScope','leaderboardPeriod'])$(id).onchange=()=>loadLeaderboard().catch(e=>text('leaderboardNote',e.message));
$('exportHistory').onclick=()=>downloadEndpoint('/api/exports/history.csv','minesweeper-history.csv').catch(showError);$('exportProfile').onclick=()=>downloadEndpoint('/api/exports/me.json','minesweeper-profile.json').catch(showError);
window.addEventListener('resize',()=>{drawLive();if(report&&!$('panel-report').hidden)drawHeatmaps();});
setInterval(()=>{const elapsed=snapshot?.phase==='running'?receivedElapsed+performance.now()-receivedAt:receivedElapsed;text('clock',time(elapsed));},100);
render();
try{await refreshMe();connection(true);if(me.activeMatchId){update(await request(`/api/matches/${me.activeMatchId}`));unsubscribe=subscribe(me.activeMatchId,update,connection);}else if(launch)notify(me.user?'Discord launch detected. Create a match to redeem this channel context.':'Discord launch detected. Sign in with the account that invoked /jev play.');else if(!me.features.jev)notify('Local heuristic mode: no TypeSafe key is configured. Click your opening square to play an unofficial race.');render();}
catch(e){connection(false);notify('Server connection unavailable. Offline practice remains available in this already-loaded page.','error');}
