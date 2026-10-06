/**
 * Local development shim (`npm start`) and test harness. It is NOT the production runtime: it adapts Node's http server to the Worker's
 * `handle(request, env, ctx)` and builds the same `env` the Worker gets (DB = node:sqlite through the D1-compatible wrapper, ASSETS = public/).
 * Node >= 22.16 (built-in node:sqlite; Node prints an experimental-SQLite warning). Production is Cloudflare: see docs/DEPLOYMENT.md.
 */
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
import {localDatabase} from './local-db.js';
import worker from './worker.js';
export {weekStart, leaderboard} from './worker.js';
const root = resolve(fileURLToPath(new URL('..', import.meta.url))), publicRoot = resolve(root, 'public');
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'};
/** Static assets from public/ only; the resolved path must stay inside it (compared against path.sep, which is `\` on Windows). */
export const assets = {
  async fetch(request) {
    let pathname; try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad path', {status: 400}); }
    if (pathname === '/') pathname = '/index.html';
    const path = resolve(publicRoot, '.' + pathname);
    if (!path.startsWith(publicRoot + sep) || path.endsWith(`${sep}_headers`)) return new Response('Not found', {status: 404});
    try { return new Response(await readFile(path), {headers: {'Content-Type': mime[extname(path)] || 'application/octet-stream'}}); }
    catch { return new Response('Not found', {status: 404}); }
  }
};
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
// `env` is used as given (never merged with process.env), so tests cannot pick up a developer's real secrets.
export async function createApp({env: source = {}, dbPath = ':memory:', host = '127.0.0.1'} = {}) {
  const port = Number(source.PORT ?? 3000), database = localDatabase(dbPath);
  const env = {...source, DEV_LOCAL: '1', DB: database, ASSETS: assets, APP_ORIGIN: source.APP_ORIGIN || `http://${port === 0 ? host : 'localhost'}:${port}`};
  if (!LOOPBACK.includes(new URL(env.APP_ORIGIN).hostname)) throw new Error('The local shim binds to loopback only. Deploy the Worker (npm run deploy) to host the game.');
  const pending = new Set();
  const ctx = {waitUntil(promise) { const p = Promise.resolve(promise).catch(() => {}).finally(() => pending.delete(p)); pending.add(p); }};
  const server = createServer(async (req, res) => {
    try {
      // The Worker trusts cf-connecting-ip only in production; here the peer address stands in and a caller-supplied value is discarded.
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      headers.delete('cf-connecting-ip'); headers.set('x-local-address', req.socket.remoteAddress || 'unknown');
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(new URL(req.url, env.APP_ORIGIN), {method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half'});
      const response = await worker.fetch(request, env, ctx);
      const out = {}; for (const [k, v] of response.headers) if (k !== 'set-cookie') out[k] = v;
      const cookies = response.headers.getSetCookie(); if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(response.status, out); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) { console.error('Local transport error:', e.message); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return {server, env, database, ctx,
    /** Resolves when every background task (waitUntil) has finished. */
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
    async listen() {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
      if (port === 0) { const url = new URL(env.APP_ORIGIN); url.port = String(server.address().port); env.APP_ORIGIN = url.origin; }
      return env.APP_ORIGIN;
    },
    async close() { await this.idle(); server.closeAllConnections(); await new Promise(ok => server.close(ok)); database.close(); }};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp({env: process.env, dbPath: resolve(process.env.DATABASE_PATH || 'data/minesweeper.sqlite')});
  const origin = await app.listen();
  console.log(JSON.stringify({event: 'server_started', origin, opponent: app.env.TYPESAFE_API_KEY ? 'JEV' : 'local heuristic (not JEV)', discordConfigured: Boolean(app.env.DISCORD_CLIENT_ID && app.env.DISCORD_CLIENT_SECRET)}));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
