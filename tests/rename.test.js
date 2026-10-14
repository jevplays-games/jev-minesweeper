// Minesweeper -> SafeSweep rename: stored identifiers and the pre-rename host keep working.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import {join}from'node:path';import {tmpdir}from'node:os';
import {verifyReplay,exportReplay,REPLAY_FORMATS}from'../public/shared/replay.js';
import {loadConfig,gameConfig,competitionKey}from'../server/config.js';import {Store}from'../server/db.js';
import {localDatabase,defaultDatabasePath}from'../server/local-db.js';import {assets,leaderboard}from'../server/main.js';
import worker from'../server/worker.js';
import {winningReplay}from'./helpers.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/pre-rename-replay.json',import.meta.url),'utf8'));
const NEW='https://safesweep.jevplay.games',OLD='https://minesweeper.jevplay.games';

test('a replay sealed before the rename (exported by main@419df6d) still verifies',async()=>{
 assert.equal(fixture.format,'jev-arcade-replay');
 const r=await verifyReplay(structuredClone(fixture));assert.equal(r.verified,true);assert.equal(r.state.outcome,'win');
});
test('exports keep the pre-rename replay format; the jevplay-replay name is also accepted; anything else is not',async()=>{
 assert.equal((await winningReplay()).format,'jev-arcade-replay');assert.deepEqual(REPLAY_FORMATS,['jev-arcade-replay','jevplay-replay']);
 assert.equal((await verifyReplay({...structuredClone(fixture),format:'jevplay-replay'})).verified,true);
 await assert.rejects(verifyReplay({...structuredClone(fixture),format:'safesweep-replay'}),/unsupported_replay/);
});
test('pre-rename leaderboard rows (game_id minesweeper) rank on the same SafeSweep board as new rows',async()=>{
 const db=localDatabase(),store=new Store(db);
 try{
  const config=loadConfig({DEV_LOCAL:'1'}),key=competitionKey(gameConfig(config,'beginner','normal')),id='111111111111111111';
  db.raw.prepare('INSERT INTO users(discord_id,display_name,created_at,last_seen_at) VALUES(?,?,0,0)').run(id,'Alice');
  const insert=(n,gameId)=>db.raw.prepare(`INSERT INTO matches(id,owner_key,creation_request_id,creation_body_hash,user_id,${gameId?'game_id,':''}competition_key,board_preset,ai_difficulty,guild_id,channel_id,config_json,private_state_json,phase,eligible,verification,outcome,human_clear_ms,created_at,finished_at) VALUES(?,?,?,?,?,${gameId?'?,':''}?,'beginner','normal','g','c','{}','{}','complete',1,'verified','win',1000,0,?)`).run(...[`m-${n}`,`u:${id}`,`req-${n}`,'hash',id,...(gameId?[gameId]:[]),key,n+1]);
  for(let i=0;i<12;i++)insert(i,null);for(let i=12;i<20;i++)insert(i,'safesweep');
  assert.deepEqual(db.raw.prepare('SELECT game_id,count(*) AS n FROM matches GROUP BY game_id ORDER BY game_id').all().map(r=>({...r})),[{game_id:'minesweeper',n:12},{game_id:'safesweep',n:8}]);
  const board=await leaderboard(store,config,null,new URLSearchParams());
  assert.equal(board.entries.length,1);assert.equal(board.entries[0].completed,20);assert.equal(board.entries[0].rank,1);
 }finally{db.close();}
});

const env=(over={})=>({APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:OLD,RATE_LIMIT_SALT:'x'.repeat(32),DISCORD_CLIENT_ID:'1552421309139521628',DISCORD_CLIENT_SECRET:'test-only',DB:localDatabase(),ASSETS:assets,...over});
const call=(e,url,init)=>worker.fetch(new Request(url,init),e,{waitUntil(){}});
test('LEGACY_APP_ORIGINS is parsed, deduplicated and must match the APP_ORIGIN scheme',()=>{
 assert.deepEqual(loadConfig({APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:` ${OLD} , ${NEW}`,RATE_LIMIT_SALT:'x'}).legacyOrigins,[OLD]);
 assert.deepEqual(loadConfig({APP_ORIGIN:NEW,RATE_LIMIT_SALT:'x'}).legacyOrigins,[]);
 assert.throws(()=>loadConfig({APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:'http://minesweeper.jevplay.games',RATE_LIMIT_SALT:'x'}),/same scheme/);
 assert.throws(()=>loadConfig({APP_ORIGIN:NEW,LEGACY_APP_ORIGINS:OLD+'/path',RATE_LIMIT_SALT:'x'}),/bare HTTP/);
});
test('one deployment serves the new host and the pre-rename host, and nothing else',async()=>{
 const e=env();
 try{
  for(const origin of[NEW,OLD]){const r=await call(e,origin+'/api/health');assert.equal(r.status,200,origin);assert.equal((await call(e,origin+'/')).status,200,origin);}
  const other=await call(e,'https://evil.example/api/health');assert.equal(other.status,400);assert.equal((await other.json()).error.code,'host_rejected');
  const without=env({LEGACY_APP_ORIGINS:undefined});try{assert.equal((await call(without,OLD+'/api/health')).status,400);}finally{without.DB.close();}
 }finally{e.DB.close();}
});
test('a player on the pre-rename host stays on it: OAuth redirect_uri and CSRF use the host the request came to',async()=>{
 const e=env();
 try{
  for(const origin of[NEW,OLD]){
   const me=await call(e,origin+'/api/me'),cookie=me.headers.getSetCookie()[0].split(';')[0],{csrfToken}=await me.json();
   const login=await call(e,origin+'/api/auth/discord',{headers:{cookie}});assert.equal(login.status,302);
   assert.equal(new URL(login.headers.get('location')).searchParams.get('redirect_uri'),`${origin}/api/auth/discord/callback`);
   const post=(o)=>call(e,origin+'/api/logout',{method:'POST',headers:{cookie,origin:o,'x-csrf-token':csrfToken,'content-type':'application/json'},body:'{}'});
   const cross=origin===NEW?OLD:NEW;assert.equal((await post(cross)).status,403,`cross-host POST to ${origin}`);
   assert.equal((await post(origin)).status,200,`same-host POST to ${origin}`);
  }
 }finally{e.DB.close();}
});
test('the local SQLite default is data/safesweep.sqlite, falling back to an existing data/minesweeper.sqlite',()=>{
 const dir=mkdtempSync(join(tmpdir(),'safesweep-'));
 try{
  assert.equal(defaultDatabasePath({},dir),join(dir,'data/safesweep.sqlite'));
  mkdirSync(join(dir,'data'));writeFileSync(join(dir,'data/minesweeper.sqlite'),'');
  assert.equal(defaultDatabasePath({},dir),join(dir,'data/minesweeper.sqlite'));
  writeFileSync(join(dir,'data/safesweep.sqlite'),'');assert.equal(defaultDatabasePath({},dir),join(dir,'data/safesweep.sqlite'));
  assert.equal(defaultDatabasePath({DATABASE_PATH:'x/y.sqlite'},dir),join(dir,'x/y.sqlite'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
