import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { matchPattern, siteFilesFor, siteFromUrl } from '../src/lib/site.ts';
import { Chrome, sleep, type Page } from './chrome.ts';

const BUILD_DIR = resolve('.output/chrome-mv3');
const VIEWPORT = { width: 1366, height: 900 };
const LOAD_TIMEOUT_MS = 20000;
const SETTLE_MS = 2000;
const MIN_REAL_PAGE_ELEMENTS = 100;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { scroll: { type: 'string', default: '0' } },
});

const url = positionals[0];
const site = siteFromUrl(url);
if (!url || !site) throw new Error('Usage: node scripts/shot.ts <http(s) url> [--scroll=<px>]');
if (!existsSync(join(BUILD_DIR, 'manifest.json'))) throw new Error('Run pnpm build first.');

const outDir = resolve('.output/shots', site);
mkdirSync(outDir, { recursive: true });

async function load(page: Page) {
  await page.send('Page.navigate', { url });
  await page.waitForLoad(LOAD_TIMEOUT_MS).catch(() => console.warn(`${url} was still loading, capturing anyway`));
  await sleep(SETTLE_MS);
}

async function capture(page: Page, file: string) {
  await page.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await load(page);
  // Sites often answer a first visit from a new browser with a tiny check page.
  if ((await page.evaluate<number>(`document.querySelectorAll('*').length`)) < MIN_REAL_PAGE_ELEMENTS) await load(page);
  await page.evaluate(`window.scrollTo(0, ${Number(values.scroll)})`);
  await sleep(500);
  await page.send('Page.bringToFront');
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, file), Buffer.from(data, 'base64'));
  console.log(join(outDir, file));
}

// Static content scripts inject the same way as the ones the extension registers, without a permission prompt.
function buildWithSiteAccess(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dusk-shot-'));
  cpSync(BUILD_DIR, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const sitesDir = join(dir, 'sites');
  const files = existsSync(sitesDir) ? readdirSync(sitesDir).map((file) => file.slice(0, -'.css'.length)) : [];
  // The same files the extension loads on this host, so a screenshot matches the browser.
  const css = ['dark.css', ...siteFilesFor(site!, files).map((file) => `sites/${file}.css`)];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts = [{ matches: [matchPattern(site!)], css, js: ['tone.js'], run_at: 'document_start' }];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return dir;
}

async function withBrowser(task: (chrome: Chrome) => Promise<void>) {
  const chrome = await Chrome.launch();
  try {
    await task(chrome);
  } finally {
    await chrome.close();
  }
}

await withBrowser(async (chrome) => capture(await chrome.newPage('about:blank'), 'light.png'));

const extensionDir = buildWithSiteAccess();
try {
  await withBrowser(async (chrome) => {
    await chrome.send('Extensions.loadUnpacked', { path: extensionDir });
    await capture(await chrome.newPage('about:blank'), 'dark.png');
  });
} finally {
  rmSync(extensionDir, { recursive: true, force: true });
}
