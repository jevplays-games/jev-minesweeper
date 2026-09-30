import test,{before,after}from'node:test';import assert from'node:assert/strict';
import {createApp}from'../server/main.js';import {loadConfig}from'../server/config.js';import {Store}from'../server/db.js';import {ACTIVITY_FRAME_ANCESTORS,hash}from'../server/security.js';
const APP='123456789012345678',ACTIVITY=`https://${APP}.discordsays.com`,calls=[];let discordFails=false,app,base;
async function discordFetch(url,options){
 calls.push({url:String(url),body:options?.body?String(options.body):null});
 if(String(url).endsWith('/oauth2/token'))return discordFails?new Response('no',{status:400}):new Response(JSON.stringify({access_token:'fixture-access'}),{headers:{'Content-Type':'application/json'}});
 if(String(url).endsWith('/users/@me'))return new Response(JSON.stringify({id:'223344556677889900',username:'player',global_name:'Player One',avatar:null}),{headers:{'Content-Type':'application/json'}});
 throw new Error(`unexpected fetch ${url}`);
}
before(async()=>{const config={...loadConfig({PORT:'0',HOST:'127.0.0.1'}),disableScheduler:true,discordClientId:APP,discordClientSecret:'fixture-secret'};app=await createApp({config,store:new Store(':memory:'),fetchImpl:discordFetch});base=await app.listen();});
after(async()=>await app.close());
const post=(path,{origin=ACTIVITY,body={},headers={}}={})=>fetch(base+path,{method:'POST',headers:{...(origin?{origin}:{}),'content-type':'application/json',...headers},body:JSON.stringify(body)});
async function signIn(){const r=await post('/api/activity/session',{body:{code:'sdk-code'}});assert.equal(r.status,200);return r.json();}
const bearer=s=>({authorization:`Bearer ${s.token}`});
test('activity config exposes only the public client id',async()=>{const r=await fetch(base+'/api/activity/config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{clientId:APP});});
test('activity config needs Discord configured',async()=>{const bare=await createApp({config:{...loadConfig({PORT:'0',HOST:'127.0.0.1'}),disableScheduler:true},store:new Store(':memory:')}),origin=await bare.listen();try{assert.equal((await fetch(origin+'/api/activity/config')).status,503);}finally{await bare.close();}});
test('an SDK code becomes a bearer session: exchanged without a redirect uri, raw token not stored',async()=>{
 calls.length=0;const r=await post('/api/activity/session',{body:{code:'sdk-code'}});assert.equal(r.status,200);const s=await r.json();
 assert.match(s.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(s.accessToken,'fixture-access');assert.equal(s.user.displayName,'Player One');assert.ok(s.csrfToken);
 const exchange=new URLSearchParams(calls[0].body);assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('code'),'sdk-code');assert.equal(exchange.has('redirect_uri'),false);
 assert.equal(r.headers.get('set-cookie'),null,'no cookie is set inside an Activity');
 assert.equal(app.store.get('SELECT 1 AS x FROM sessions WHERE token_hash=?',s.token),undefined,'the raw token must not be stored');
 assert.ok(app.store.get('SELECT 1 AS x FROM sessions WHERE token_hash=?',hash(s.token)));
 assert.ok(!JSON.stringify(app.store.all('SELECT * FROM sessions')).includes('fixture-access'),'the Discord access token is not stored');
});
test('the bearer session works for reads and for mutations from the activity origin',async()=>{
 const s=await signIn(),me=await (await fetch(base+'/api/me',{headers:bearer(s)})).json();assert.equal(me.user.displayName,'Player One');assert.equal(me.csrfToken,s.csrfToken);
 const created=await post('/api/matches',{headers:{...bearer(s),'x-csrf-token':s.csrfToken},body:{requestId:crypto.randomUUID(),boardPreset:'beginner',aiDifficulty:'normal',mode:'practice',context:'world'}});assert.equal(created.status,201);
 assert.equal((await fetch(base+`/api/matches/${(await created.json()).id}`,{headers:bearer(s)})).status,200);
 const out=await post('/api/logout',{headers:{...bearer(s),'x-csrf-token':s.csrfToken}});assert.equal(out.status,200);
 assert.equal((await (await fetch(base+'/api/me',{headers:bearer(s)})).json()).user,null,'logout removed the session');
});
test('the activity origin is accepted only together with a bearer session',async()=>{
 const s=await signIn(),guest=await fetch(base+'/api/me'),cookie=guest.headers.get('set-cookie').split(';')[0],me=await guest.json();
 assert.equal((await post('/api/logout',{headers:{cookie,'x-csrf-token':me.csrfToken}})).status,403,'a cookie session must not be usable from the discordsays origin');
 const good={...bearer(s),'x-csrf-token':s.csrfToken};
 assert.equal((await post('/api/logout',{origin:'https://evil.example',headers:good})).status,403);
 assert.equal((await post('/api/logout',{origin:'https://999999999999999999.discordsays.com',headers:good})).status,403,'another application discordsays origin is not ours');
 assert.equal((await post('/api/logout',{origin:null,headers:good})).status,403);
 assert.equal((await post('/api/logout',{headers:bearer(s)})).status,403,'missing csrf');
 assert.equal((await post('/api/logout',{headers:{...bearer(s),'x-csrf-token':'wrong'}})).status,403);
});
test('session creation rejects foreign origins, missing codes, extra fields and Discord failures',async()=>{
 assert.equal((await post('/api/activity/session',{origin:'https://evil.example',body:{code:'c'}})).status,403);
 assert.equal((await post('/api/activity/session',{origin:null,body:{code:'c'}})).status,403);
 assert.equal((await post('/api/activity/session',{origin:'https://999999999999999999.discordsays.com',body:{code:'c'}})).status,403);
 assert.equal((await post('/api/activity/session',{body:{}})).status,400);
 assert.equal((await post('/api/activity/session',{body:{code:'x'.repeat(3000)}})).status,400);
 assert.equal((await post('/api/activity/session',{body:{code:'c',admin:true}})).status,422);
 discordFails=true;try{assert.equal((await post('/api/activity/session',{body:{code:'c'}})).status,502);}finally{discordFails=false;}
});
test('a malformed bearer is ignored and a fresh anonymous session is created',async()=>{const r=await fetch(base+'/api/me',{headers:{authorization:'Bearer nothex'}});assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie'));assert.equal((await r.json()).user,null);});
test('only the document loaded with frame_id may be framed, and only by Discord',async()=>{
 const plain=await fetch(base+'/'),framed=await fetch(base+'/?frame_id=1&instance_id=2&platform=desktop');
 assert.match(plain.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(plain.headers.get('x-frame-options'),null);
 assert.equal(framed.headers.get('x-frame-options'),null);const csp=framed.headers.get('content-security-policy');assert.ok(csp.includes(ACTIVITY_FRAME_ANCESTORS));assert.ok(!csp.includes("frame-ancestors 'none'"));
 assert.match(csp,/script-src 'self'/,'the rest of the policy is unchanged');assert.match(csp,/connect-src 'self'/);assert.match(csp,/form-action 'self'/);
 assert.ok(!/frame-ancestors[^;]*\*/.test(csp));
 for(const path of['/api/me?frame_id=1','/api/health?frame_id=1','/game.js?frame_id=1','/nope?frame_id=1']){const r=await fetch(base+path);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/,path);}
});
test('the vendored SDK and activity module are served same-origin',async()=>{for(const path of['/activity.js','/vendor/discord-embedded-app-sdk.js']){const r=await fetch(base+path);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith('text/javascript'));}});
