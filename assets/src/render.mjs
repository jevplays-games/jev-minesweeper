// Usage: PLAYWRIGHT_FROM=/path/to/playwright/package.json node assets/src/render.mjs [repo-root]
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url);
const { chromium } = require('playwright');
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url)));
const browser = await chromium.launch({ headless: true });
try {
  for (const [source, output, width, height, scale] of [
    ['banner.html', 'assets/banner.png', 1280, 420, 2],
    ['social.html', 'assets/social-preview.png', 1280, 640, 1],
    ['og.html', 'public/brand/og.png', 1200, 630, 1],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(resolve(root, 'assets/src', source)).href);
    await page.evaluate(() => document.fonts.ready);
    await mkdir(dirname(resolve(root, output)), { recursive: true });
    await page.screenshot({ path: resolve(root, output) });
    await page.close();
    console.log(`Rendered ${output} (${width * scale}x${height * scale})`);
  }
  const icon = await readFile(resolve(root, 'public/brand/icon.svg'), 'utf8');
  for (const [output, size, inset, background] of [
    ['favicon-32.png', 32, 0, 'transparent'],
    ['apple-touch-icon.png', 180, 18, '#F386A1'],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    // Remove only the icon's full-field pink rectangle for the transparent favicon.
    const artwork = inset ? icon : icon.replace(/<rect\b(?=[^>]*width="64")(?=[^>]*height="64")(?=[^>]*fill="#F386A1")[^>]*\/>/, '');
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:${background}}svg{position:absolute;left:${inset}px;top:${inset}px;width:${size - inset * 2}px;height:${size - inset * 2}px}</style>${artwork}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(root, 'public/brand', output), omitBackground: !inset });
    await page.close();
    console.log(`Rendered public/brand/${output} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
