import { covers, matchPattern, OFF_ATTRIBUTE, siteFilesFor, siteFromUrl, urlConditions } from '@/lib/site';

declare const __SITE_CSS__: string[];

const SITES_KEY = 'sites';
const ICON_COLOR = '#f5b301';
// Finds parts of the page that were already dark, which CSS alone cannot see.
const TONE_SCRIPT = '/tone.js';

let queue: Promise<unknown> = Promise.resolve();

function enqueue(task: () => Promise<void>) {
  queue = queue.then(task).catch(console.error);
}

async function loadSites(): Promise<string[]> {
  const stored = await browser.storage.local.get(SITES_KEY);
  return (stored[SITES_KEY] as string[] | undefined) ?? [];
}

const saveSites = (sites: string[]) => browser.storage.local.set({ [SITES_KEY]: sites });

const siteCss = (site: string) => `sites/${site}.css`;
const cssFiles = (host: string) => ['dark.css', ...siteFilesFor(host, __SITE_CSS__).map(siteCss)];
// Parents come first, so a deeper subdomain's file loads after the ones above it.
const subdomainFiles = (site: string) =>
  __SITE_CSS__.filter((file) => file !== site && covers(site, file)).sort((a, b) => a.length - b.length);

function moonIcon(size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d')!;
  context.fillStyle = ICON_COLOR;
  context.beginPath();
  context.arc(size * 0.5, size * 0.5, size * 0.44, 0, Math.PI * 2);
  context.fill();
  context.globalCompositeOperation = 'destination-out';
  context.beginPath();
  context.arc(size * 0.68, size * 0.38, size * 0.36, 0, Math.PI * 2);
  context.fill();
  return context.getImageData(0, 0, size, size);
}

// Page rules light the icon without waking this worker on every navigation.
async function syncIconRules(sites: string[]) {
  const pageChanged = browser.declarativeContent.onPageChanged;
  await new Promise<void>((resolve) => pageChanged.removeRules(undefined, () => resolve()));
  if (sites.length === 0) return;
  const conditions = sites
    .flatMap(urlConditions)
    .map((pageUrl) => new browser.declarativeContent.PageStateMatcher({ pageUrl }));
  const actions = [new browser.declarativeContent.SetIcon({ imageData: { 16: moonIcon(16), 32: moonIcon(32) } })];
  await new Promise<void>((resolve, reject) =>
    pageChanged.addRules([{ conditions, actions }], () => {
      const error = browser.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    }),
  );
}

async function syncRegistrations() {
  const sites = await loadSites();
  const access = await Promise.all(sites.map((site) => browser.permissions.contains({ origins: [matchPattern(site)] })));
  const enabled = sites.filter((_, index) => access[index]);
  if (enabled.length !== sites.length) await saveSites(enabled);

  await browser.scripting.unregisterContentScripts();
  await browser.scripting.registerContentScripts(
    enabled.flatMap((site) => [
      { id: `site-${site}`, matches: [matchPattern(site)], css: cssFiles(site), js: [TONE_SCRIPT], runAt: 'document_start' as const },
      // A file for one of the site's subdomains loads there on top of the site's own files.
      ...subdomainFiles(site).map((file) => ({
        id: `site-${site}-${file}`,
        matches: [matchPattern(file)],
        css: [siteCss(file)],
        runAt: 'document_start' as const,
      })),
    ]),
  );
  await syncIconRules(enabled);
}

function setOffMarker(attribute: string, off: boolean) {
  document.documentElement.toggleAttribute(attribute, off);
}

// Chrome cannot remove CSS that a registered content script applied, so turning a loaded page
// off relies on the marker that all of the stylesheets are scoped to.
async function setTabDark(tabId: number, host: string, dark: boolean) {
  const target = { tabId };
  if (dark) {
    await browser.scripting.removeCSS({ target, files: cssFiles(host) });
    await browser.scripting.insertCSS({ target, files: cssFiles(host) });
  }
  await browser.scripting.executeScript({ target, func: setOffMarker, args: [OFF_ATTRIBUTE, !dark] });
  if (dark) await browser.scripting.executeScript({ target, files: [TONE_SCRIPT] });
}

async function toggleSite(clicked: string) {
  const sites = await loadSites();
  // A dark site reaches its subdomains, so a click on one toggles that site, and a site replaces
  // any subdomains stored on their own.
  const enabled = sites.find((site) => covers(site, clicked));
  const site = enabled ?? clicked;
  const dark = !enabled;
  const others = sites.filter((other) => !covers(site, other));
  await saveSites(dark ? [...others, site] : others);
  await syncRegistrations();

  const origins = [matchPattern(site)];
  const tabs = await browser.tabs.query({ url: origins });
  const results = await Promise.allSettled(tabs.map((tab) => setTabDark(tab.id!, siteFromUrl(tab.url) ?? site, dark)));
  for (const result of results) if (result.status === 'rejected') console.warn(result.reason);

  if (!dark) await browser.permissions.remove({ origins }).catch(console.warn);
}

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    const site = siteFromUrl(tab.url);
    if (!site) return;
    // Chrome only allows this during the click, so nothing asynchronous can come first. It
    // resolves without a prompt once a site has been approved.
    const access = browser.permissions.request({ origins: [matchPattern(site)] });
    enqueue(async () => {
      if (await access) await toggleSite(site);
    });
  });
  browser.runtime.onInstalled.addListener(() => enqueue(syncRegistrations));
  browser.permissions.onRemoved.addListener(() => enqueue(syncRegistrations));
});
