import test from 'node:test';import assert from 'node:assert/strict';
import {winningReplay} from './helpers.js';import {verifyReplay,eventHash} from '../shared/replay.js';
import {analyzeReplay,calibration,distribution,wilson,csv,aggregateMatches} from '../shared/analytics.js';
const replay=await winningReplay();
test('complete replay reconstructs the winning outcome',async()=>{const r=await verifyReplay(replay);assert.equal(r.verified,true);assert.equal(r.state.outcome,'win');});
for(const[field,change]of[
 ['seed',r=>{r.seeds.human='c'.repeat(64);}],['result',r=>{r.result.outcome='loss';}],['action',r=>{r.events[1].payload.action.cell=81;}],['head hash',r=>{r.headHash='bad';}],['event order',r=>{r.events.reverse();}],['engine version',r=>{r.engineVersion='future';}],['policy version',r=>{r.policyVersion='other';}],['event time',r=>{r.events[1].atMs=-1;}]
])test(`tampered ${field} is rejected`,async()=>{const r=structuredClone(replay);change(r);await assert.rejects(verifyReplay(r));});
test('rehashing an illegal action does not bypass rule verification',async()=>{const r=structuredClone(replay);r.events[1].payload.action.cell=81;let previous=null;for(const e of r.events){e.previousHash=previous;e.hash=await eventHash(e);previous=e.hash;}r.headHash=previous;await assert.rejects(verifyReplay(r),/invalid_cell/);});
test('analytics reconcile opening and command reveal counts',async()=>{const a=await analyzeReplay(replay);const h=a.players.human;assert.equal(h.safeCellsFromOpening+h.safeCellsFromActions,h.revealedSafe);assert.equal(h.revealedSafe,71);assert.equal(h.clearMs,replay.result.humanClearMs);assert.equal(a.actions.length,h.actions);assert.equal(a.opponent.remoteDecisions,0);assert.equal(a.opponent.calibration.selected.brier,null);});
test('post-game heatmaps account for every accepted command',async()=>{const a=await analyzeReplay(replay);for(const actor of['human','jev'])assert.equal(a.players[actor].heatmaps.commands.reduce((a,b)=>a+b,0),a.players[actor].actions);});
test('race time accounting covers the full match',async()=>{const a=await analyzeReplay(replay);assert.equal(a.race.humanAheadMs+a.race.jevAheadMs+a.race.tiedMs,a.match.durationMs);});
test('3BV and adjacency histograms reconcile safe cells',async()=>{const a=await analyzeReplay(replay);for(const b of Object.values(a.boards)){assert.equal(b.adjacencyHistogram.reduce((a,b)=>a+b),b.safeCellCount);assert.equal(b.threeBV,b.zeroRegions+b.isolatedNumberCells);}});
test('empty samples produce null, not fabricated zero performance',()=>{assert.equal(distribution([]).mean,null);assert.equal(calibration([]).brier,null);assert.equal(wilson(0,0).lower,null);});
test('Brier score and calibration bins use safety probabilities correctly',()=>{const c=calibration([{p:.8,y:1},{p:.2,y:0}]);assert.ok(Math.abs(c.brier-.04)<1e-12);assert.equal(c.bins.reduce((s,b)=>s+b.count,0),2);});
test('probability one fits final calibration bin',()=>assert.equal(calibration([{p:1,y:1}]).bins[9].count,1));
test('quantiles use documented linear interpolation',()=>{const d=distribution([0,10,20,30]);assert.equal(d.p50,15);assert.equal(d.mean,15);});
test('draws count in the win-rate denominator and break streaks',()=>{const a=aggregateMatches([{id:'1',outcome:'win',finished_at:1},{id:'2',outcome:'win',finished_at:2},{id:'3',outcome:'draw',finished_at:3}]);assert.equal(a.clearWinRate,2/3);assert.equal(a.currentWinStreak,0);assert.equal(a.bestWinStreak,2);});
test('CSV neutralizes spreadsheet formulas and escapes quotes',()=>{const s=csv([{name:'=CMD()',other:'a,"b"',negative:-2}]);assert.ok(s.includes("'=CMD()"));assert.ok(s.includes('"a,""b"""'));assert.ok(s.includes('-2'));});
test('unknown provider usage is not assumed free',async()=>{const a=await analyzeReplay(replay,{pricePerMillion:null});assert.equal(a.opponent.estimatedCost.amount,null);assert.ok(a.opponent.estimatedCost.scope.includes('not a bill'));});
