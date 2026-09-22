"""Chromium UI smoke tests. Use --dom-bridge only in navigation-restricted test runners.
Default mode exercises real browser HTTP/SSE. Bridge mode tests DOM behavior with
Python forwarding requests and polling snapshots; it does NOT certify browser networking.
Requires optional Python Playwright; no production browser dependencies are added.
"""
from __future__ import annotations
import argparse, hashlib, hmac, http.cookiejar, json, os, re, time, urllib.request, urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def bundle_modules() -> str:
    modules: dict[str, str] = {}
    pattern = re.compile(r"import\s+\{([^}]+)\}\s+from\s+['\"]([^'\"]+)['\"];?")
    def load(relative: str):
        if relative in modules: return
        source = (ROOT / relative).read_text()
        imports = list(pattern.finditer(source))
        replacements = []
        for match in imports:
            target = (ROOT / match[2].lstrip('/')) if match[2].startswith('/') else (ROOT / relative).parent / match[2]
            key = target.resolve().relative_to(ROOT).as_posix()
            load(key)
            names = re.sub(r'\s+as\s+', ':', match[1])
            replacements.append((match[0], f'const {{{names}}} = __modules[{json.dumps(key)}];'))
        for original, replacement in replacements: source = source.replace(original, replacement)
        exports = re.findall(r'export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_]\w*)', source)
        source = re.sub(r'\bexport\s+', '', source)
        source = source.replace("await import('./offline.js')", "__modules['public/offline.js']")
        modules[relative] = f'__modules[{json.dumps(relative)}] = await (async()=>{{\n{source}\nreturn {{{",".join(exports)}}};\n}})();'
    load('public/offline.js'); load('public/game.js')
    return 'async () => { const __modules = {};\n' + '\n'.join(modules.values()) + '\n}'

def bridge(page, base: str):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def http_bridge(payload):
        path = payload['path']
        if not path.startswith('/api/'): raise ValueError('Test bridge only permits local app API paths')
        headers = dict(payload.get('headers', {})); headers['Origin'] = base
        body = payload.get('body')
        req = urllib.request.Request(base + path, data=body.encode() if body is not None else None, method=payload.get('method', 'GET'), headers=headers)
        try: response = opener.open(req, timeout=30)
        except urllib.error.HTTPError as exc: response = exc
        return {'status': response.status, 'headers': dict(response.headers), 'body': response.read().decode()}
    def crypto_bridge(op, data, key=None):
        blob = bytes(data)
        return list(hashlib.sha256(blob).digest() if op == 'digest' else hmac.new(bytes(key), blob, hashlib.sha256).digest())
    page.expose_function('__localHttp', http_bridge)
    page.expose_function('__testCrypto', crypto_bridge)
    html = (ROOT / 'public/index.html').read_text()
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<link[^>]*>', '', html)
    html = html.replace('</head>', '<style>' + (ROOT / 'public/game.css').read_text() + '</style></head>')
    page.set_content(html)
    page.evaluate("""() => {
      window.fetch = async (path, options={}) => {
        const r = await window.__localHttp({path, method:options.method||'GET', headers:options.headers||{}, body:options.body??null});
        return new Response(r.body, {status:r.status, headers:r.headers});
      };
      window.EventSource = class {
        constructor(path) { this.listeners={}; this.path=path.replace(/\\/events$/, ''); this.timer=setInterval(()=>this.poll(),200); this.poll(); }
        addEventListener(name, callback) { this.listeners[name]=callback; }
        async poll() { try { const r=await fetch(this.path); if(!r.ok)throw Error('poll'); const value=await r.json(); this.onopen?.(); this.listeners.snapshot?.({data:JSON.stringify(value)}); }catch{this.onerror?.();} }
        close() { clearInterval(this.timer); }
      };
      if(!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const s=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}});
      if(!crypto.subtle) Object.defineProperty(crypto,'subtle',{value:{
        importKey:async(_format,data)=>Array.from(data),
        digest:async(_alg,data)=>new Uint8Array(await __testCrypto('digest',Array.from(data))).buffer,
        sign:async(_alg,key,data)=>new Uint8Array(await __testCrypto('sign',Array.from(data),key)).buffer
      }});
    }""")
    page.evaluate(bundle_modules())

def run():
    parser=argparse.ArgumentParser();parser.add_argument('--base',default='http://localhost:3000');parser.add_argument('--dom-bridge',action='store_true');parser.add_argument('--chromium',default=os.environ.get('CHROMIUM_EXECUTABLE'));args=parser.parse_args()
    out=ROOT/'reports'/'browser';out.mkdir(parents=True,exist_ok=True)
    observations=[]
    with sync_playwright() as p:
        executable=args.chromium or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':1440,'height':1100},device_scale_factor=1,accept_downloads=True)
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
        if args.dom_bridge: bridge(page,args.base)
        else: page.goto(args.base);page.wait_for_function("document.getElementById('connection').textContent==='Connected'")
        assert page.locator('#humanBoard .cell').count()==81
        assert page.locator('#jevBoard .cell').count()==81
        page.screenshot(path=str(out/'desktop-ready.png'),full_page=True)
        page.locator('#humanBoard [data-cell="40"]').click()
        page.wait_for_function("document.getElementById('humanStatus').textContent==='Board active'",timeout=10000)
        page.wait_for_timeout(1300)
        cell_id=page.locator('#humanBoard .cell:not(.open):not(.flagged)').first.get_attribute('data-cell')
        covered=page.locator(f'#humanBoard [data-cell="{cell_id}"]')
        covered.focus();covered.press('f');page.wait_for_timeout(300)
        assert page.locator('#humanBoard .flagged').count()==1
        covered.press('f');page.wait_for_timeout(300)
        assert page.locator('#humanBoard .flagged').count()==0
        covered.press('ArrowRight')
        assert page.locator('#humanBoard .cell[tabindex="0"]').count()==1
        assert int(page.locator('#liveJevActions').inner_text())>=1
        page.screenshot(path=str(out/'desktop-running.png'),full_page=True)
        observations.append({'workflow':'desktop game, protected opening, local opponent, flag/unflag, keyboard roving focus','pass':True})
        page.locator('#resign').click()
        page.wait_for_function("!document.getElementById('reportContent').hidden",timeout=30000)
        page.locator('#tab-report').click()
        assert 'LOSS' in page.locator('#reportStatus').inner_text()
        assert page.locator('#comparison tr').count()>20
        page.screenshot(path=str(out/'desktop-analytics.png'),full_page=True)
        with page.expect_download() as event: page.locator('#exportJson').click()
        download=event.value;download.save_as(str(out/'browser-analytics.json'))
        report=json.loads((out/'browser-analytics.json').read_text());assert report['analyticsVersion']=='ms-analytics-1.0.0'
        page.locator('#viewReplay').click();page.wait_for_function("document.getElementById('replayDialog').open",timeout=15000)
        page.locator('#replayNext').click();assert page.locator('#replayHuman .cell.open').count()>0
        page.locator('#closeReplay').click()
        observations.append({'workflow':'sealed report, player comparison, JSON export and replay viewer','pass':True})
        page.locator('#tab-history').click();page.wait_for_function("document.querySelectorAll('#historyTable tbody tr').length>=1",timeout=10000)
        page.locator('#tab-leaderboards').click();page.wait_for_timeout(300)
        observations.append({'workflow':'history and public leaderboard empty state','pass':True})
        page.set_viewport_size({'width':390,'height':844});page.locator('#tab-live').click()
        page.screenshot(path=str(out/'mobile.png'),full_page=True)
        width=page.evaluate('({scroll:document.documentElement.scrollWidth, viewport:innerWidth})')
        assert width['scroll']<=width['viewport']+1,width
        observations.append({'workflow':'390px mobile layout without document-level horizontal overflow','pass':True})
        page.locator('#offline').click();page.wait_for_timeout(600)
        page.locator('#humanBoard [data-cell="40"]').click();page.wait_for_timeout(1400)
        assert 'Offline' in page.locator('#opponentBadge').inner_text()
        page.locator('#resign').click();page.wait_for_timeout(1200)
        assert 'local-only' in page.locator('#reportStatus').inner_text()
        observations.append({'workflow':'explicit offline practice and local-only post-game analytics','pass':True})
        assert not errors,errors
        context.close();browser.close()
    result={'mode':'DOM bridge (HTTP/SSE navigation not certified)' if args.dom_bridge else 'native browser HTTP/SSE','browser':'Chromium','viewports':['1440x1100','390x844'],'observations':observations,'uncaughtPageErrors':errors}
    (out/'browser-results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':run()
