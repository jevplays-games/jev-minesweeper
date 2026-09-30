import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';import {resolve,dirname,join,relative,sep} from 'node:path';import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
/** Everything wrangler would bundle: the import graph reachable from the Worker entry. */
function graph(entry){const seen=new Map(),queue=[resolve(root,entry)];
 while(queue.length){const file=queue.pop();if(seen.has(file))continue;const source=readFileSync(file,'utf8');seen.set(file,source);
  for(const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)){const spec=m[1]??m[2]??m[3];
   if(spec.startsWith('.'))queue.push(resolve(dirname(file),spec));else seen.set(`external:${spec}`,'');}}
 return seen;}
const bundled=graph('server/worker.js');
test('the Worker bundle reaches only server/ and public/shared/ files and no node: or package import',()=>{
 const externals=[...bundled.keys()].filter(k=>k.startsWith('external:'));assert.deepEqual(externals,[]);
 for(const file of bundled.keys()){const rel=relative(root,file).split(sep).join('/');assert.ok(rel.startsWith('server/')||rel.startsWith('public/shared/'),rel);}
 for(const forbidden of['server/main.js','server/local-db.js','server/workers.js'])assert.ok(![...bundled.keys()].some(k=>k.endsWith(forbidden)),forbidden);
});
test('the bundled code uses no Node-only globals',()=>{
 for(const [file,source] of bundled){if(file.startsWith('external:'))continue;
  const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"`])\/\/.*$/gm,'$1');
  for(const pattern of[/\bprocess\.(env|argv|cwd|exit|nextTick)\b/,/\bBuffer\b/,/\brequire\(/,/\b__dirname\b/,/\bsetImmediate\b/,/\bnew Worker\(/,/worker_threads/,/node:(?:fs|path|crypto|http|sqlite|child_process|worker_threads)/])
   assert.ok(!pattern.test(code),`${relative(root,file)} uses ${pattern}`);}
});
test('nothing served to the browser is server-side: public/ has no secrets, schema or server code',()=>{
 const files=[];(function walk(dir){for(const name of readdirSync(dir)){const p=join(dir,name);if(statSync(p).isDirectory())walk(p);else files.push(relative(join(root,'public'),p).split(sep).join('/'));}})(join(root,'public'));
 assert.ok(files.includes('index.html')&&files.includes('shared/engine.js')&&files.includes('_headers'));
 for(const f of files)assert.ok(!/\.(sql|sqlite|env|pem|key)$/.test(f)&&!f.startsWith('server/'),f);
});
test('wrangler.jsonc keeps the Free-plan shape: no cron, no cpu limit, D1 placeholder id, worker-first only for the API and the document',()=>{
 const text=readFileSync(join(root,'wrangler.jsonc'),'utf8'),config=JSON.parse(text.replace(/^\s*\/\/.*$/gm,''));
 assert.equal(config.name,'jev-minesweeper');assert.equal(config.main,'server/worker.js');assert.equal(config.triggers,undefined);assert.equal(config.limits,undefined);
 assert.deepEqual(config.routes,[{pattern:'minesweeper.jevplay.games',custom_domain:true}]);assert.equal(config.vars.APP_ORIGIN,'https://minesweeper.jevplay.games');
 assert.equal(config.d1_databases[0].binding,'DB');assert.equal(config.d1_databases[0].database_id,'REPLACE_WITH_D1_ID');assert.equal(config.d1_databases[0].migrations_dir,'migrations');
 assert.equal(config.assets.binding,'ASSETS');assert.deepEqual(config.assets.run_worker_first,['/api/*','/','/index.html']);
 for(const secret of['TYPESAFE_API_KEY','RATE_LIMIT_SALT','DISCORD_CLIENT_SECRET','DISCORD_PUBLIC_KEY','ANALYTICS_ADMIN_TOKEN'])assert.equal(config.vars[secret],undefined,`${secret} must be a secret, not a var`);
});
test('the migration is the schema the code runs on and applies cleanly, once',async()=>{
 const {localDatabase}=await import('../server/local-db.js'),db=localDatabase();
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM d1_migrations').get().n,1);
 for(const table of['users','sessions','launch_tickets','matches','match_events','jev_decisions','audit_events','counters'])assert.ok(db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table),table);
 assert.throws(()=>db.raw.prepare("INSERT INTO matches(id,owner_key,creation_request_id,creation_body_hash,competition_key,board_preset,ai_difficulty,config_json,private_state_json,phase,created_at) VALUES('a','o','r','h','k','beginner','normal','{}','{}','nonsense',0)").run(),/CHECK/);
 db.close();
});
