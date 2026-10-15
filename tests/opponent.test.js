// What the opponent is called on screen. Regression for verifier defect D-1: with a TypeSafe key configured, Offline practice was titled
// "Jev" until the first move, because OfflineGame.create() emitted (and rendered) before game.js had assigned `offline`.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {opponentView,metricLabel,metricValue} from '../public/opponent.js';

test('an offline snapshot is never titled Jev, even with a key configured and before `offline` is assigned',()=>{
 const snapshot={offline:true,opponent:'Offline local heuristic — not Jev',phase:'ready'};
 for(const offline of[false,true]){const v=opponentView({jevConfigured:true,offline,snapshot});
  assert.equal(v.isJev,false);assert.equal(v.title,'Local opponent');assert.equal(v.versus,'vs local opponent');assert.equal(v.badge,'Offline local heuristic — not Jev');}
});
test('offline practice with no snapshot yet is local; a configured server match is Jev; no key is local',()=>{
 assert.equal(opponentView({jevConfigured:true,offline:true}).title,'Local opponent');
 assert.equal(opponentView({jevConfigured:true,offline:true}).badge,'Offline local heuristic — not Jev');
 const jev=opponentView({jevConfigured:true,snapshot:{opponent:'Jev + visible-state constraint solver'}});
 assert.deepEqual([jev.isJev,jev.title,jev.versus,jev.badge],[true,'Jev','vs Jev','Jev + visible-state constraint solver']);
 const local=opponentView({jevConfigured:false,snapshot:{opponent:'Local heuristic — not Jev'}});
 assert.deepEqual([local.isJev,local.title,local.versus],[false,'Local opponent','vs local opponent']);
 assert.equal(opponentView().versus,'vs local opponent');
});
test('the offline view marks itself offline, and game.js re-renders once `offline` is assigned',()=>{
 // offline.js imports browser-absolute module paths, so check its source rather than importing it.
 assert.match(readFileSync(new URL('../public/offline.js',import.meta.url),'utf8'),/view\(\)\{return \{[^]*offline:true\};\}/);
 assert.match(readFileSync(new URL('../public/game.js',import.meta.url),'utf8'),/offline=await OfflineGame\.create\([^;]*update\);render\(\);/);
});
test('metric explorer labels hide raw ids for local matches; stored keys are not changed',()=>{
 assert.equal(metricLabel('players.jev.revealedSafe'),'players › opponent › revealedSafe');
 assert.equal(metricLabel('boards.jev.threeBV'),'boards › opponent › threeBV');
 assert.equal(metricLabel('race.jevAheadMs'),'race › opponentAheadMs');
 assert.equal(metricLabel('players.human.clearMs'),'players › you › clearMs');
 assert.equal(metricLabel('players.jev.revealedSafe',{remoteJev:true}),'players › Jev › revealedSafe');
 assert.equal(metricLabel('opponent.remoteDecisions'),'opponent › remoteDecisions');
 assert.equal(metricValue('configuration.model','jev-1.13.0'),'jev-1.13.0 (configured, not used: local opponent)');
 assert.equal(metricValue('configuration.model','jev-1.13.0',{remoteJev:true}),'jev-1.13.0');
 assert.equal(metricValue('players.jev.actions','12'),'12');
});
