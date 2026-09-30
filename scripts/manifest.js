/** Regenerates MANIFEST.json (file list with sizes and SHA-256) and its test counts from reports/tests.tap. Run after `npm test` output is refreshed. */
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
const skip = new Set(['.git', 'node_modules', 'data', 'backups', '.wrangler', '__pycache__', 'MANIFEST.json']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (skip.has(name) || (name.startsWith('.env') && name !== '.env.example') || name === '.dev.vars' || name.endsWith('.woff2') || name.endsWith('.pyc')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else { const bytes = readFileSync(path); files.push({path: relative('.', path).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}); }
  }
})('.');
const manifest = JSON.parse(readFileSync('MANIFEST.json', 'utf8'));
const tap = existsSync('reports/tests.tap') ? readFileSync('reports/tests.tap', 'utf8') : '', count = key => Number(new RegExp('^# ' + key + ' ([0-9]+)', 'm').exec(tap)?.[1] ?? 0);
manifest.builtAt = new Date().toISOString().slice(0, 10);
manifest.files = files;
manifest.validation = {...manifest.validation, nodeTests: count('tests'), passed: count('pass'), failed: count('fail'), browserMode: 'not re-run for the Cloudflare Workers port (see docs/TESTING.md)', cpuBenchmark: 'reports/cpu'};
writeFileSync('MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({files: files.length, tests: manifest.validation.nodeTests, passed: manifest.validation.passed}));
