/** Same-engine, matched-seed benchmark. Local policies never masquerade as live JEV. */
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PRESETS, ENGINE_VERSION, GENERATOR_VERSION, generateBoard, applyBoardAction, observeBoard} from '../public/shared/engine.js';
import {decisionSurface, POLICY_VERSION} from '../public/shared/solver.js';
import {chooseJevAction} from '../server/jev.js';
import {loadConfig} from '../server/config.js';
import {distribution, wilson, csv} from '../public/shared/analytics.js';
const args = process.argv.slice(2);
function arg(key, fallback) { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; }
const count = Number(arg('--boards', '50')), preset = arg('--preset', 'beginner'), output = resolve(arg('--out', 'reports/benchmark'));
const namespace = arg('--seed-set', 'heldout-ms-v1'), remote = args.includes('--remote'), remoteLevel = arg('--difficulty', 'jev');
const config = loadConfig({...process.env, DEV_LOCAL: '1'});
if (!Number.isInteger(count) || count < 2 || count > 10000 || !Object.hasOwn(PRESETS,preset) || !['easy','normal','hard','jev'].includes(remoteLevel)) throw new Error('Usage: npm run bench -- --boards 100 --preset beginner [--out path] [--remote --difficulty jev]');
if (remote && !config.jevKey) throw new Error('--remote requires TYPESAFE_API_KEY. No local substitute will be reported as a live JEV benchmark.');
const policies = ['random','easy-local','normal-local','hard-local','jev-local', ...(remote ? [`remote-${remoteLevel}`] : [])];
const rows = [], traces = [], started = new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
function rng(seed) { let x = parseInt(seed.slice(0,8),16) || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
for (let index=0; index<count; index++) {
  const seed = hash(`${namespace}:${preset}:${index}`), firstCell = Math.floor(PRESETS[preset].height/2)*PRESETS[preset].width + Math.floor(PRESETS[preset].width/2);
  for (const policy of policies) {
    const board = await generateBoard(PRESETS[preset],seed,firstCell); applyBoardAction(board,{type:'reveal',cell:firstCell},0);
    const pickRandom = rng(hash(`random-policy:${seed}`)), latencies=[], decisionTrace=[];
    let moves=0, invalid=0, fallback=0, calls=0, inputTokens=0, outputTokens=0, uncertain=0, nodes=0;
    while(board.status==='active' && moves<2000) {
      const observation = observeBoard(board), start = performance.now(); let action, source=policy, risk=null, candidateCount=null;
      if(policy==='random') { const covered=observation.cells.flatMap((v,i)=>v===-1?[i]:[]); action={type:'reveal',cell:covered[Math.floor(pickRandom()*covered.length)]}; }
      else if(policy.startsWith('remote-')) {
        const decision=await chooseJevAction({observation,difficulty:remoteLevel,config,forceLocal:calls>=config.maxCallsPerMatch}); action=decision.selected.action; source=decision.source;
        risk=decision.selected.risk;candidateCount=decision.candidates.length;nodes+=decision.solver.nodes;fallback+=Number(decision.fallback);calls+=decision.attempts.length;
        for(const attempt of decision.attempts){inputTokens+=attempt.usage?.input_tokens||0;outputTokens+=attempt.usage?.output_tokens||0;}
      } else {
        const surface=decisionSurface(observation,policy.replace('-local',''));const selected=surface.candidates[0];
        if(!selected){invalid++;break;}action=selected.action;risk=selected.risk;candidateCount=surface.candidates.length;nodes+=surface.analysis.nodes;
      }
      const decisionMs=performance.now()-start;latencies.push(decisionMs);if(action.type==='reveal'&&(!risk||risk.value>0))uncertain++;
      try { applyBoardAction(board,action,(moves+1)*1000); } catch { invalid++; break; }
      moves++;decisionTrace.push({move:moves,action,source,risk,candidateCount,decisionMs,status:board.status,revealedSafe:board.revealedSafe});
    }
    rows.push({index,seed,firstCell,policy,preset,status:board.status,moves,clear:board.status==='cleared',clearLogicalMs:board.status==='cleared'?moves*1000:null,safeRevealed:board.revealedSafe,safeTotal:board.width*board.height-board.mineCount,invalid,fallback,providerAttempts:calls,inputTokens,outputTokens,uncertainReveals:uncertain,solverNodes:nodes,decisionLatencyMs:distribution(latencies)});
    traces.push({index,policy,seed,firstCell,decisions:decisionTrace});
  }
  if ((index+1)%10===0) console.log(`Completed ${index+1}/${count} matched boards (${policies.length} policies).`);
}
const summary=policies.map(policy=>{
  const r=rows.filter(x=>x.policy===policy),clears=r.filter(x=>x.clear);
  return{policy,boards:r.length,clears:clears.length,clearRate:clears.length/r.length,clearRate95PercentWilson:wilson(clears.length,r.length),explosions:r.filter(x=>x.status==='exploded').length,unfinished:r.filter(x=>!['cleared','exploded'].includes(x.status)).length,meanMoves:distribution(r.map(x=>x.moves)).mean,clearLogicalMs:distribution(clears.map(x=>x.clearLogicalMs)),decisionLatencyMs:distribution(traces.filter(x=>x.policy===policy).flatMap(x=>x.decisions.map(d=>d.decisionMs))),invalid:r.reduce((s,x)=>s+x.invalid,0),fallback:r.reduce((s,x)=>s+x.fallback,0),providerAttempts:r.reduce((s,x)=>s+x.providerAttempts,0),inputTokens:r.reduce((s,x)=>s+x.inputTokens,0)};
});
// Independent-board paired races. Swap each pair's seed allocation to reduce board advantage.
const races=[];
for(let a=0;a<policies.length;a++)for(let b=a+1;b<policies.length;b++){
 let wins=0,losses=0,draws=0;
 for(let i=0;i+1<count;i+=2)for(const swap of[false,true]){
  const left=rows.find(x=>x.index===i+Number(swap)&&x.policy===policies[a]);
  const right=rows.find(x=>x.index===i+Number(!swap)&&x.policy===policies[b]);
  const l=left.clearLogicalMs??Infinity,r=right.clearLogicalMs??Infinity;
  if(l===r)draws++;else if(l<r)wins++;else losses++;
 }
 races.push({left:policies[a],right:policies[b],races:wins+losses+draws,wins,losses,draws});
}
const metadata={generatedAt:new Date().toISOString(),startedAt:started,seedSet:namespace,preset,boards:count,policies,engineVersion:ENGINE_VERSION,generatorVersion:GENERATOR_VERSION,policyVersion:POLICY_VERSION,model:config.model,remoteRequested:remote,runtime:process.version,method:'Same seeds and opening for each standalone policy. Independent-board race pairs swap seed allocation. One action = 1000 logical ms; compute/service latency reported separately.',limitations:['Local policy results are NOT live JEV results.','This is an implementation baseline, not proof of human-level ability or an externally certified benchmark.','Seed set is deterministic and tunable; do not tune on this held-out namespace and then call it held-out.','Remote failures remain in the results and are counted as fallback; remote calls may incur charges.','Latency depends on this host and run; logical race time deliberately excludes it.']};
await mkdir(output,{recursive:true});
await writeFile(resolve(output,'runs.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
await writeFile(resolve(output,'traces.jsonl'),traces.map(x=>JSON.stringify(x)).join('\n')+'\n');
await writeFile(resolve(output,'summary.json'),JSON.stringify({metadata,summary,races},null,2));
await writeFile(resolve(output,'summary.csv'),csv(summary.map(x=>({...x,decisionLatencyMs:JSON.stringify(x.decisionLatencyMs),clearLogicalMs:JSON.stringify(x.clearLogicalMs)}))));
await writeFile(resolve(output,'races.csv'),csv(races));
const table=summary.map(x=>`| ${x.policy} | ${x.boards} | ${x.clears} | ${(100*x.clearRate).toFixed(1)}% | ${x.invalid} | ${x.fallback} | ${(x.decisionLatencyMs.p95??0).toFixed(2)} |`).join('\n');
await writeFile(resolve(output,'report.md'),`# Minesweeper benchmark\n\nGenerated ${metadata.generatedAt}. Runtime ${process.version}.\n\n**${remote?'Includes explicitly requested live TypeSafe calls. Inspect fallbacks before interpreting results.':'LOCAL BASELINES ONLY. No live TypeSafe/JEV calls were made.'}**\n\n${metadata.method}\n\nSeed namespace: \`${namespace}\`. Board preset: \`${preset}\`.\n\n| Policy | Boards | Clears | Clear rate | Invalid | Fallback | Decision p95 (ms) |\n|---|---:|---:|---:|---:|---:|---:|\n${table}\n\nSee summary.json for Wilson intervals, actual clear-only logical times, and swapped independent-board race results. runs.jsonl and traces.jsonl retain every measured game and selected action.\n\n## Limitations\n${metadata.limitations.map(x=>'- '+x).join('\n')}\n`);
console.log(JSON.stringify({output,boards:count,policyRuns:rows.length,raceComparisons:races.length,liveProviderCalls:rows.reduce((s,r)=>s+r.providerAttempts,0)},null,2));
