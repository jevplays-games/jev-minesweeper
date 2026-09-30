import test from 'node:test';import assert from 'node:assert/strict';
import {boardFromMines,applyBoardAction,observeBoard,generateBoard} from '../public/shared/engine.js';
import {analyzeObservation,decisionSurface,choose} from '../public/shared/solver.js';
import {buildRequest} from '../public/shared/decisions.js';import {config,seeds} from './helpers.js';
test('binomial coefficient handles edge cases',()=>{assert.equal(choose(5,2),10n);assert.equal(choose(5,-1),0n);assert.equal(choose(5,6),0n);assert.equal(choose(0,0),1n);});
test('flags are annotations, not assumed mines',()=>{const b=boardFromMines(3,3,[0,8]);applyBoardAction(b,{type:'reveal',cell:4},10);applyBoardAction(b,{type:'setFlag',cell:1,value:true},20);const a=analyzeObservation(observeBoard(b),'jev');assert.ok(!a.mines.includes(1));assert.ok(a.risks[1].value<1);});
test('unconstrained exact probability uses global mine count',()=>{const b=boardFromMines(3,3,[0,8]);const a=analyzeObservation(observeBoard(b),'jev');assert.equal(a.exactComplete,true);assert.equal(a.risks[3].value,2/9);});
test('global combinatorial weighting distinguishes frontier and off-frontier risks',()=>{const b=boardFromMines(3,3,[1,8]);applyBoardAction(b,{type:'reveal',cell:0},10);const a=analyzeObservation(observeBoard(b),'jev');assert.ok(Math.abs(a.risks[1].value-1/3)<1e-12);assert.ok(Math.abs(a.risks[8].value-1/5)<1e-12);assert.equal(a.exactComplete,true);});
test('partial enumeration never reports exactness',()=>{const b=boardFromMines(3,3,[1,8]);applyBoardAction(b,{type:'reveal',cell:0},10);const a=analyzeObservation(observeBoard(b),'jev',{nodes:1});assert.equal(a.exactComplete,false);assert.equal(a.cutoffReason,'node_limit');assert.equal(a.risks[1].source,'heuristic');});
test('easy and normal have no exhaustive enumeration',()=>{const b=boardFromMines(3,3,[1,8]);for(const level of['easy','normal'])assert.equal(analyzeObservation(observeBoard(b),level).exactComplete,false);});
test('equivalent observations yield identical candidate surfaces',()=>{const a=boardFromMines(3,3,[0]),b=boardFromMines(3,3,[2]);applyBoardAction(a,{type:'reveal',cell:4},10);applyBoardAction(b,{type:'reveal',cell:4},10);assert.deepEqual(observeBoard(a),observeBoard(b));assert.deepEqual(decisionSurface(observeBoard(a),'jev'),decisionSurface(observeBoard(b),'jev'));});
test('candidate caps hold at every difficulty',()=>{const b=boardFromMines(9,9,[0,2,4,6,8,20,40,60,70,80]);for(const[level,cap]of[['easy',8],['normal',16],['hard',24],['jev',32]])assert.ok(decisionSurface(observeBoard(b),level).candidates.length<=cap);});
test('JEV payload is bounded and omits private fields',async()=>{const b=await generateBoard(config,seeds.human,40);applyBoardAction(b,{type:'reveal',cell:40},0);const o=observeBoard(b),s=decisionSurface(o,'jev'),{request}=buildRequest(o,s);assert.ok(Buffer.byteLength(JSON.stringify(request))<=24576);assert.equal(request.state.seeds,undefined);assert.equal(request.state.board.mines,undefined);assert.equal(request.state.board.adjacent,undefined);});
test('proven-safe deductions agree with hidden truth over 100 seeded boards',async()=>{for(let i=0;i<100;i++){const b=await generateBoard(config,i.toString(16).padStart(64,'0'),40);applyBoardAction(b,{type:'reveal',cell:40},0);const a=analyzeObservation(observeBoard(b),'jev');for(const cell of a.safe)assert.equal(b.mines[cell],0,`false safe: seed ${i} cell ${cell}`);for(const cell of a.mines)assert.equal(b.mines[cell],1,`false mine: seed ${i} cell ${cell}`);}});
test('terminal board has no candidates',()=>{const b=boardFromMines(3,3,[0]);applyBoardAction(b,{type:'reveal',cell:0},0);assert.equal(decisionSurface(observeBoard(b),'normal').candidates.length,0);});
test('exact risk agrees with independent exhaustive truth enumeration on small boards',()=>{
 for(let seed=0;seed<30;seed++){
  const mineA=seed%16,mineB=(mineA+3+seed%9)%16;if(mineA===mineB)continue;
  const b=boardFromMines(4,4,[mineA,mineB]);for(let c=0;c<16;c++){if(!b.mines[c]&&b.adjacent[c]>0){applyBoardAction(b,{type:'reveal',cell:c},0);break;}}
  if(b.status!=='active')continue;const o=observeBoard(b),a=analyzeObservation(o,'jev');assert.equal(a.exactComplete,true);
  const hidden=o.cells.flatMap((v,i)=>v<0?[i]:[]),counts=Object.fromEntries(hidden.map(i=>[i,0]));let total=0;
  for(let x=0;x<hidden.length;x++)for(let y=x+1;y<hidden.length;y++){
   const candidate=boardFromMines(4,4,[hidden[x],hidden[y]]);
   if(o.cells.every((v,i)=>v<0||candidate.adjacent[i]===v)){total++;counts[hidden[x]]++;counts[hidden[y]]++;}
  }
  assert.ok(total>0);for(const cell of hidden)assert.ok(Math.abs(a.risks[cell].value-counts[cell]/total)<1e-12,`seed ${seed}, cell ${cell}`);
 }
});
