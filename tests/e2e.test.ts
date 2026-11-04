import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { Chrome, sleep, until, type Page, type Pixel } from '../scripts/chrome.ts';

const EXTENSION_DIR = resolve('.output/chrome-mv3-e2e');
const RED_IMAGE = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='rgb(200,30,30)'/></svg>`;

const PAGE = `<!doctype html>
<title>fixture</title>
<script>window.filterAtFirstScript = getComputedStyle(document.documentElement).filter</script>
<body style="margin:0">
  <div class="site-fix" style="height:40px"></div>
  <img src="${RED_IMAGE}" style="display:block">
</body>`;

const WHITE_IMAGE = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='white'/></svg>`;

const LAYERS_PAGE = `<!doctype html>
<title>layers</title>
<style>
  body { margin: 0; height: 2000px; }
  .box { position: fixed; left: 100px; top: 100px; margin: 0; padding: 0; border: 0; width: 200px; height: 200px; background: #fff; }
  dialog::backdrop { background: #fff; }
  #dimmed::backdrop { background: rgba(0, 0, 0, .5); }
  #full { background: #fff; width: 100px; height: 100px; }
</style>
<dialog id="dialog" class="box"><img src="${RED_IMAGE}" style="display:block"></dialog>
<dialog id="dimmed" class="box"></dialog>
<div id="popover" class="box" popover><img src="${RED_IMAGE}" style="display:block"></div>
<div style="position:absolute; left:0; top:320px; width:100px; height:100px; background-image:url(&quot;${RED_IMAGE}&quot;)"></div>
<div id="full"><img src="${RED_IMAGE}" style="display:block"></div>
<img id="full-image" src="${RED_IMAGE}">
<img src="${WHITE_IMAGE}" style="position:absolute; left:400px; top:320px; display:block">
<video id="clip" width="100" height="100"></video>
<dialog id="dark-dialog" class="box" style="background: rgb(12, 13, 18)"></dialog>
<div id="dark-full" style="background: rgb(12, 13, 18); width: 100px; height: 100px"></div>`;

const SECTIONS_PAGE = `<!doctype html>
<title>sections</title>
<style>
  body { margin: 0; }
  #dark { position: absolute; left: 0; top: 0; width: 600px; height: 300px; background: rgb(12, 13, 18); color: #fff; }
  #light-card { position: absolute; left: 300px; top: 150px; width: 250px; height: 120px; background: #fff; color: #111; }
  #dark-image { position: absolute; left: 20px; top: 180px; display: block; }
  #overlay { position: fixed; left: 20px; top: 20px; margin: 0; color: #fff; }
  #small { position: absolute; left: 650px; top: 20px; width: 100px; height: 30px; background: #000; color: #fff; }
  #holder { position: absolute; left: 0; top: 320px; width: 600px; height: 200px; background: rgb(12, 13, 18); }
  #pinned { position: fixed; right: 0; bottom: 0; width: 10px; height: 10px; }
</style>
<div id="dark">
  <p style="margin: 0; padding: 80px 20px 0">Light text the site drew on its dark section</p>
  <img id="dark-image" src="${RED_IMAGE}">
  <div id="light-card">A light card inside the dark section</div>
</div>
<p id="overlay">Fixed text over the dark section</p>
<div id="small">Small</div>
<div id="holder"><div id="pinned"></div></div>`;

const NATIVE_DARK_PAGE = `<!doctype html>
<title>native dark</title>
<body style="margin: 0; background: #111; color: #eee">
  <p>Already dark</p>
  <img src="${RED_IMAGE}" style="position: absolute; left: 0; top: 200px; display: block">
</body>`;

const DARK_ROOT_PAGE = `<!doctype html>
<html style="background: #111">
<title>dark root</title>
<body style="margin: 0; color: #eee"><p>Dark root</p></body>
</html>`;

const FRAMES_PAGE = `<!doctype html>
<title>frames</title>
<style>
  body { margin: 0; }
  iframe { position: absolute; border: 0; }
</style>
<iframe id="widget" src="/frame-light" style="left: 0; top: 0; width: 400px; height: 200px"></iframe>
<iframe id="player" src="/frame-light" allowfullscreen style="left: 400px; top: 0; width: 400px; height: 200px"></iframe>
<iframe id="ad" src="/frame-light" style="left: 0; top: 220px; width: 300px; height: 250px"></iframe>
<iframe id="dark-frame" src="/frame-dark" style="left: 320px; top: 220px; width: 400px; height: 200px"></iframe>`;

const LIGHT_FRAME_PAGE = `<!doctype html><title>light frame</title><body style="margin: 0; background: #fff"></body>`;
const DARK_FRAME_PAGE = `<!doctype html><title>dark frame</title><body style="margin: 0; background: #111"></body>`;

const SCHEME_PAGE = `<!doctype html>
<title>scheme</title>
<style>
  body { margin: 0; }
  @media (prefers-color-scheme: dark) { body { background: rgb(17, 17, 17); } }
</style>
<p>Follows the system</p>`;

const PAGES: Record<string, string> = {
  '/scheme': SCHEME_PAGE,
  '/layers': LAYERS_PAGE,
  '/sections': SECTIONS_PAGE,
  '/native-dark': NATIVE_DARK_PAGE,
  '/dark-root': DARK_ROOT_PAGE,
  '/frames': FRAMES_PAGE,
  '/frame-light': LIGHT_FRAME_PAGE,
  '/frame-dark': DARK_FRAME_PAGE,
};

const isRed = ([r, g, b]: Pixel) => r > 120 && g < 80 && b < 80;
const isDark = ([r, g, b]: Pixel) => r < 40 && g < 40 && b < 40;
const isLight = ([r, g, b]: Pixel) => r > 200 && g > 200 && b > 200;
const isWhite = ([r, g, b]: Pixel) => r === 255 && g === 255 && b === 255;
const PAGE_BACKGROUND = [790, 590] as const;

let chrome: Chrome;
let extensionId: string;
let baseUrl: string;
let localhostUrl: string;
let subdomainUrl: string;

const SLOW_PAGE_MS = 1500;

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  if (request.url === '/slow') {
    response.write('<!doctype html><title>slow</title><body style="margin:0"><p>first chunk</p>');
    setTimeout(() => response.end('<p>rest</p></body>'), SLOW_PAGE_MS);
    return;
  }
  response.end(PAGES[request.url!] ?? PAGE);
});

async function click(page: Page) {
  await page.send('Page.bringToFront');
  await chrome.send('Extensions.triggerAction', { id: extensionId, targetId: await chrome.tabTargetId(page) });
}

const background = (page: Page) => page.pixel(...PAGE_BACKGROUND);
const waitForDark = (page: Page) => until(async () => isDark(await background(page)), 'the page to go dark');
const waitForWhite = (page: Page) => until(async () => isWhite(await background(page)), 'the page to go white');

async function storedSites(): Promise<string[]> {
  const worker = await chrome.worker(extensionId);
  return worker.evaluate(`chrome.storage.local.get('sites').then((stored) => stored.sites ?? [])`);
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  localhostUrl = `http://localhost:${port}`;
  subdomainUrl = `http://app.localhost:${port}`;
  chrome = await Chrome.launch();
  ({ id: extensionId } = await chrome.send('Extensions.loadUnpacked', { path: EXTENSION_DIR }));
});

after(async () => {
  await chrome.close();
  server.close();
});

test('site access stays optional and no content script is declared', async () => {
  const manifest = JSON.parse(readFileSync('.output/chrome-mv3-e2e/manifest.json', 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, ['*://*/*']);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'declarativeContent', 'scripting', 'storage']);
  assert.equal(manifest.content_scripts, undefined);
});

test('a site stays light until the icon is clicked', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  assert.ok(isWhite(await background(page)));
  assert.equal(await page.evaluate('getComputedStyle(document.documentElement).filter'), 'none');
  assert.deepEqual(await storedSites(), []);
});

test('clicking darkens every open tab on the site without reloading it', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  const otherTab = await chrome.newPage(`${baseUrl}/other`);
  await page.evaluate('window.notReloaded = true');

  await click(page);
  await waitForDark(page);
  await waitForDark(otherTab);

  assert.equal(await page.evaluate('window.notReloaded'), true);
  assert.deepEqual(await storedSites(), ['127.0.0.1']);
});

test('a rule lights the toolbar icon on dark sites', async () => {
  const worker = await chrome.worker(extensionId);
  const rules = await worker.evaluate(`new Promise((resolve) => chrome.declarativeContent.onPageChanged.getRules(resolve))`);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].conditions.length, 1);
  assert.equal(rules[0].conditions[0].pageUrl.hostEquals, '127.0.0.1');
  assert.equal(rules[0].actions.length, 1);
});

test('images keep their colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  assert.ok(isRed(await page.pixel(50, 90)));
});

test('inline background images keep their colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  assert.ok(isRed(await page.pixel(50, 370)));
});

test('photos are dimmed until hovered', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  const brightness = async () => (await page.pixel(450, 370))[0];

  const dimmed = await brightness();
  assert.ok(dimmed > 180 && dimmed < 205, `dimmed white was ${dimmed}`);

  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 450, y: 370 });
  await until(async () => (await brightness()) > 225, 'the hovered photo to brighten');

  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 });
  await until(async () => (await brightness()) < 205, 'the photo to dim again');
});

test('video is not dimmed', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  const filter = await page.evaluate<string>(`getComputedStyle(document.getElementById('clip')).filter`);
  assert.match(filter, /invert/);
  assert.doesNotMatch(filter, /brightness/);
});

test('dialogs darken with the page', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.evaluate(`document.getElementById('dialog').showModal()`);
  await sleep(100);
  assert.ok(isDark(await page.pixel(200, 250)), 'dialog background');
  assert.ok(isDark(await page.pixel(700, 500)), 'backdrop');
  assert.ok(isRed(await page.pixel(150, 150)), 'image in the dialog');
});

test('a black dialog backdrop dims the page instead of lightening it', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.evaluate(`document.getElementById('dimmed').showModal()`);
  await sleep(100);
  assert.ok(isDark(await page.pixel(700, 500)));
});

test('popovers darken with the page', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.evaluate(`document.getElementById('popover').showPopover()`);
  await sleep(100);
  assert.ok(isDark(await page.pixel(200, 250)), 'popover background');
  assert.ok(isRed(await page.pixel(150, 150)), 'image in the popover');
});

test('a dark dialog keeps its colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.evaluate(`document.getElementById('dark-dialog').showModal()`);
  await waitForFlip(page, '#dark-dialog', 'original');
  assert.ok(isDark(await page.pixel(200, 250)));
});

test('a dark element shown fullscreen keeps its colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.send('Page.bringToFront');
  await page.send('Runtime.evaluate', {
    expression: `document.getElementById('dark-full').requestFullscreen()`,
    awaitPromise: true,
    userGesture: true,
  });
  await waitForFlip(page, '#dark-full', 'original');
  assert.ok(isDark(await page.pixel(400, 400)));
});

test('fullscreen content darkens with the page', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.send('Page.bringToFront');
  await page.send('Runtime.evaluate', {
    expression: `document.getElementById('full').requestFullscreen()`,
    awaitPromise: true,
    userGesture: true,
  });
  await sleep(200);
  assert.ok(isDark(await page.pixel(400, 400)), 'fullscreen background');
  assert.ok(isRed(await page.pixel(50, 50)), 'image in the fullscreen element');
});

test('an image shown fullscreen by itself keeps its colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/layers`);
  await page.send('Page.bringToFront');
  await page.send('Runtime.evaluate', {
    expression: `document.getElementById('full-image').requestFullscreen()`,
    awaitPromise: true,
    userGesture: true,
  });
  await sleep(200);
  assert.ok(isRed(await page.pixel(400, 300)));
  assert.ok(isDark(await page.pixel(20, 300)), 'letterbox');

  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
  await sleep(100);
  assert.ok(isRed(await page.pixel(400, 300)), 'hovered');
});

test('a site file loads with the page', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  const color = await page.evaluate(`getComputedStyle(document.querySelector('.site-fix')).backgroundColor`);
  assert.equal(color, 'rgb(0, 128, 0)');
});

test('dark styles are in place before the page runs any script', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  assert.match(await page.evaluate('window.filterAtFirstScript'), /invert/);
});

test('printing shows the page as the site drew it', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  assert.equal(await page.evaluate('getComputedStyle(document.documentElement).filter'), 'none');
  await page.send('Emulation.setEmulatedMedia', { media: '' });
  assert.match(await page.evaluate('getComputedStyle(document.documentElement).filter'), /invert/);
});

test('a dark theme added in a stylesheet is found', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  await sleep(300);
  await until(async () => !(await page.evaluate(`document.documentElement.hasAttribute('data-dusk-page')`)), 'a scan');
  await page.evaluate(`{
    const style = document.createElement('style');
    style.textContent = 'body { background: rgb(17, 17, 17) }';
    document.head.append(style);
  }`);
  await waitForDarkPage(page);
});

test('a dark theme that follows the system is found', async () => {
  const page = await chrome.newPage(`${baseUrl}/scheme`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await until(async () => !(await page.evaluate(`document.documentElement.hasAttribute('data-dusk-page')`)), 'the page to be unmarked');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await waitForDarkPage(page);
});

test('a slow page is dark while it is still loading', async () => {
  const page = await chrome.newPage('about:blank');
  await page.send('Page.navigate', { url: `${baseUrl}/slow` });
  await until(() => page.evaluate(`document.body?.innerText.includes('first chunk')`), 'the first chunk');
  await sleep(200);
  assert.equal(await page.evaluate('document.readyState'), 'loading');
  assert.ok(isDark(await background(page)));
});

const flip = (page: Page, selector: string) =>
  page.evaluate<string | null>(`document.querySelector('${selector}').getAttribute('data-dusk-flip')`);
const waitForFlip = (page: Page, selector: string, mark: string) =>
  until(async () => (await flip(page, selector)) === mark, `${selector} to be marked ${mark}`);
const waitForDarkPage = (page: Page) =>
  until(
    async () => (await page.evaluate(`document.documentElement.getAttribute('data-dusk-page')`)) === 'dark',
    'the page to be marked dark',
  );

test('a section the site drew dark keeps its colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/sections`);
  await waitForFlip(page, '#dark', 'original');
  assert.ok(isDark(await page.pixel(580, 100)), 'section');
  assert.equal(await flip(page, '#light-card'), 'inverted');
  assert.ok(isDark(await page.pixel(540, 260)), 'light card');
  assert.ok(isRed(await page.pixel(70, 230)), 'image in the section');
});

test('text drawn over a dark section keeps its light color', async () => {
  const page = await chrome.newPage(`${baseUrl}/sections`);
  await waitForFlip(page, '#overlay', 'original');
});

test('small dark elements and sections holding fixed elements are left flipped', async () => {
  const page = await chrome.newPage(`${baseUrl}/sections`);
  await waitForFlip(page, '#dark', 'original');
  assert.equal(await flip(page, '#small'), null);
  assert.equal(await flip(page, '#holder'), null);
});

test('a dark section added later is found', async () => {
  const page = await chrome.newPage(`${baseUrl}/sections`);
  await waitForFlip(page, '#dark', 'original');
  await page.evaluate(`{
    const late = document.createElement('div');
    late.id = 'late';
    late.style.cssText = 'position:absolute; left:0; top:540px; width:600px; height:50px; background:rgb(12,13,18)';
    document.body.append(late);
  }`);
  await waitForFlip(page, '#late', 'original');
});

test('a page that is already dark is not inverted', async () => {
  const page = await chrome.newPage(`${baseUrl}/native-dark`);
  await waitForDarkPage(page);
  assert.equal(await page.evaluate('getComputedStyle(document.documentElement).filter'), 'none');
  assert.ok(isDark(await background(page)));
  assert.ok(isRed(await page.pixel(50, 250)));
});

test('a dark background on the root counts as a dark page', async () => {
  const page = await chrome.newPage(`${baseUrl}/dark-root`);
  await waitForDarkPage(page);
  assert.equal(await page.evaluate('getComputedStyle(document.documentElement).filter'), 'none');
});

const frameMark = (page: Page, selector: string) =>
  page.evaluate<string | null>(`document.querySelector('${selector}').getAttribute('data-dusk-frame')`);
const waitForFrameMark = (page: Page, selector: string, mark: string | null) =>
  until(async () => (await frameMark(page, selector)) === mark, `${selector} to be marked ${mark}`);

test('a frame holding a page darkens with it', async () => {
  const page = await chrome.newPage(`${baseUrl}/frames`);
  await waitForFrameMark(page, '#widget', 'page');
  assert.ok(isDark(await page.pixel(200, 100)));
});

test('video players and ads keep their colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/frames`);
  await waitForFrameMark(page, '#widget', 'page');
  assert.equal(await frameMark(page, '#player'), null);
  assert.equal(await frameMark(page, '#ad'), null);
  assert.ok(isLight(await page.pixel(600, 100)), 'player');
  assert.ok(isLight(await page.pixel(150, 345)), 'ad');
});

test('a frame from the same site that is already dark keeps its colors', async () => {
  const page = await chrome.newPage(`${baseUrl}/frames`);
  await until(
    () =>
      page.evaluate(`{
        const frame = document.getElementById('dark-frame').contentDocument;
        frame?.title === 'dark frame' && frame.readyState === 'complete';
      }`),
    'the dark frame to load',
  );
  await waitForFrameMark(page, '#dark-frame', null);
  assert.ok(isDark(await page.pixel(520, 320)));
});

test('other sites are left alone', async () => {
  const page = await chrome.newPage(`${localhostUrl}/`);
  assert.ok(isWhite(await background(page)));
  assert.equal(await page.evaluate('getComputedStyle(document.documentElement).filter'), 'none');
});

test('dark sites survive reloading the extension', async () => {
  await chrome.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  await sleep(500);

  const page = await chrome.newPage(`${baseUrl}/`);
  await waitForDark(page);
  assert.deepEqual(await storedSites(), ['127.0.0.1']);
});

test('clicking again restores the page without reloading it', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  await waitForDark(page);
  await page.evaluate('window.notReloaded = true');

  await click(page);
  await waitForWhite(page);

  assert.equal(await page.evaluate('window.notReloaded'), true);
  const color = await page.evaluate(`getComputedStyle(document.querySelector('.site-fix')).backgroundColor`);
  assert.equal(color, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(await storedSites(), []);

  const worker = await chrome.worker(extensionId);
  const rules = await worker.evaluate(`new Promise((resolve) => chrome.declarativeContent.onPageChanged.getRules(resolve))`);
  assert.deepEqual(rules, []);
});

test('a site that was turned off stays off on the next load', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  assert.ok(isWhite(await background(page)));
  assert.equal(await page.evaluate('window.filterAtFirstScript'), 'none');
});

test('turning a site on finds dark sections in a page that is already open', async () => {
  const page = await chrome.newPage(`${baseUrl}/sections`);
  assert.equal(await flip(page, '#dark'), null);
  await click(page);
  await waitForDark(page);
  await waitForFlip(page, '#dark', 'original');
  await click(page);
  await waitForWhite(page);
});

test('clicking a third time darkens a page that was turned off', async () => {
  const page = await chrome.newPage(`${baseUrl}/`);
  await click(page);
  await waitForDark(page);
  await click(page);
  await waitForWhite(page);
  await click(page);
  await waitForDark(page);
  await click(page);
  await waitForWhite(page);
});

test('clicking a subdomain of a dark site turns the whole site off', async () => {
  const site = await chrome.newPage(`${localhostUrl}/`);
  await click(site);
  await waitForDark(site);
  const subdomain = await chrome.newPage(`${subdomainUrl}/`);
  await waitForDark(subdomain);

  await click(subdomain);
  await waitForWhite(subdomain);
  await waitForWhite(site);
  assert.deepEqual(await storedSites(), []);

  await subdomain.goto(`${subdomainUrl}/`);
  assert.ok(isWhite(await background(subdomain)));
});

test('turning a site on replaces its subdomains that were already on', async () => {
  const subdomain = await chrome.newPage(`${subdomainUrl}/`);
  await click(subdomain);
  await waitForDark(subdomain);
  const site = await chrome.newPage(`${localhostUrl}/`);
  await click(site);
  await waitForDark(site);
  assert.deepEqual(await storedSites(), ['localhost']);

  await click(site);
  await waitForWhite(site);
  await waitForWhite(subdomain);
  assert.deepEqual(await storedSites(), []);
});

const siteFix = (page: Page, property: string) =>
  page.evaluate<string>(`getComputedStyle(document.querySelector('.site-fix')).${property}`);

test('a site file also loads on its subdomains', async () => {
  const page = await chrome.newPage(`${subdomainUrl}/`);
  await click(page);
  await waitForDark(page);
  assert.equal(await siteFix(page, 'outlineColor'), 'rgb(255, 0, 0)');
  assert.equal(await siteFix(page, 'borderTopColor'), 'rgb(0, 0, 255)');

  const next = await chrome.newPage(`${subdomainUrl}/`);
  assert.equal(await siteFix(next, 'outlineColor'), 'rgb(255, 0, 0)');
  assert.equal(await siteFix(next, 'borderTopColor'), 'rgb(0, 0, 255)');

  await click(page);
  await waitForWhite(page);
});

test('a subdomain file loads when its parent site is on', async () => {
  const page = await chrome.newPage(`${localhostUrl}/`);
  await click(page);
  await waitForDark(page);
  assert.equal(await siteFix(page, 'outlineColor'), 'rgb(255, 0, 0)');
  assert.equal(await siteFix(page, 'borderTopStyle'), 'none');

  const subdomain = await chrome.newPage(`${subdomainUrl}/`);
  assert.equal(await siteFix(subdomain, 'outlineColor'), 'rgb(255, 0, 0)');
  assert.equal(await siteFix(subdomain, 'borderTopColor'), 'rgb(0, 0, 255)');

  await click(page);
  await waitForWhite(page);
});

test('the extension cannot reach the network', async () => {
  const worker = await chrome.worker(extensionId);
  const result = await worker.evaluate(
    `fetch(${JSON.stringify(`${baseUrl}/`)}).then(() => 'reached the network', (error) => error.name)`,
  );
  assert.equal(result, 'TypeError');
});
