import { OFF_ATTRIBUTE } from '@/lib/site';
import {
  average,
  composite,
  contrast,
  FLIP_ATTRIBUTE,
  FRAME_ATTRIBUTE,
  gradientColors,
  inversions,
  looksLikePage,
  PAGE_ATTRIBUTE,
  parseRgb,
  toneOf,
  UNPAINTED_ROOT,
  WHITE,
  type Color,
} from '@/lib/tone';

/*
 * The page filter flips every color, so a section the site already drew dark comes out light. This finds those
 * sections and flips them again, along with light parts inside them, so every surface ends up dark. Text the
 * site draws over something that isn't its parent, such as a header over a dark section, gets the same check.
 */

// Smaller dark things, such as buttons and badges, read fine turned light.
const MIN_SURFACE_AREA = 20_000;
const MIN_SURFACE_SIDE = 24;
const SOLID_ALPHA = 0.5;
const OPAQUE_ALPHA = 0.9;
const MIN_INK_ALPHA = 0.3;
// Text this close to its parent's color must be drawn over something else.
const UNREADABLE_CONTRAST = 1.5;
// Wrappers this close to the window's size are the page's background rather than a section.
const PAGE_COVERAGE = 0.9;
const MAX_PAGE_LAYERS = 6;
// The canvas Chrome draws for a dark color scheme.
const DARK_CANVAS: Color = [18, 18, 18, 1];
const SLOW_SCAN_MS = 8;
const SLOW_SCAN_DELAY_MS = 150;
const RESIZE_DELAY_MS = 200;

const LEAVES = new Set([
  'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'embed', 'object', 'svg', 'math',
  'script', 'style', 'template', 'noscript', 'link', 'meta',
]);
const TOP_LAYER = ':modal, :popover-open, :fullscreen';
const COLOR_STYLES = /(?:^|;)\s*(?:background(?:-color|-image)?|color|filter|display|position|-webkit-text-fill-color)\s*:[^;]*/gi;
const COLOR_TRANSITIONS = /color|background|filter/;

type Mark = 'original' | 'inverted';

interface Region {
  /** Whether this part of the page currently shows its colors inverted. */
  inverted: boolean;
  /** The site's own color behind this part, or null when an image is behind it. */
  backdrop: Color | null;
}

interface Page {
  region: Region;
  /** The root, the body, and wrappers that fill the page. Their color decides whether the page flips at all. */
  layers: Set<Element>;
}

const colors = new Map<string, Color | null>();
let painter: OffscreenCanvasRenderingContext2D | null = null;
// Fixed menus are often hidden when the page is read, so a container stays unfiltered once one shows up in it.
const holdsFixed = new WeakSet<Element>();

// Computed colors in other spaces, such as oklch(), are converted by drawing them.
function readColor(value: string): Color | null {
  const rgb = parseRgb(value);
  if (rgb) return rgb[3] === 0 ? null : rgb;
  const known = colors.get(value);
  if (known !== undefined) return known;
  painter ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
  painter.clearRect(0, 0, 1, 1);
  painter.fillStyle = 'transparent';
  painter.fillStyle = value;
  painter.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = painter.getImageData(0, 0, 1, 1).data;
  const color: Color | null = a ? [r!, g!, b!, a / 255] : null;
  colors.set(value, color);
  return color;
}

function surfaceOf(style: CSSStyleDeclaration): Color | 'image' | null {
  if (style.backgroundClip === 'text' || style.getPropertyValue('-webkit-background-clip') === 'text') return null;
  const image = style.backgroundImage;
  if (image.includes('url(')) return 'image';
  const color = readColor(style.backgroundColor);
  const stops = gradientColors(image).map(readColor);
  const gradient = average(stops.filter((stop) => stop !== null));
  if (!gradient) return color;
  return color ? composite(gradient, color) : gradient;
}

function backdropInside(surface: Color | 'image' | null, backdrop: Color | null): Color | null {
  if (surface === 'image') return null;
  if (!surface) return backdrop;
  if (backdrop) return composite(surface, backdrop);
  return surface[3] >= OPAQUE_ALPHA ? surface : null;
}

function isLarge(element: Element): boolean {
  const { width, height } = element.getBoundingClientRect();
  return width >= MIN_SURFACE_SIDE && height >= MIN_SURFACE_SIDE && width * height >= MIN_SURFACE_AREA;
}

function hasOwnText(element: Element): boolean {
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue!)) return true;
  }
  return false;
}

function isTopLayer(element: Element): boolean {
  const candidate = element.localName === 'dialog' || element.hasAttribute('popover') || element === document.fullscreenElement;
  return candidate && element.matches(TOP_LAYER);
}

// The top layer draws outside every filter around it, so only its own filter, which Dusk sets, applies.
const topLayerRegion = (page: Page): Region => ({ inverted: false, backdrop: page.region.backdrop });

/** Light surfaces should show inverted and dark ones as they are, so both end up dark. */
function wantForSurface(color: Color): boolean | null {
  const tone = toneOf(color);
  return tone === 'mid' ? null : tone === 'light';
}

/** Light text should show as it is and dark text inverted, so both end up light. */
function wantForInk(style: CSSStyleDeclaration, backdrop: Color): boolean | null {
  const fill = readColor(style.getPropertyValue('-webkit-text-fill-color'));
  const ink = readColor(style.color);
  if (!fill || !ink || ink[3] < MIN_INK_ALPHA) return null;
  const text = composite(ink, backdrop);
  if (contrast(text, backdrop) >= UNREADABLE_CONTRAST) return null;
  const tone = toneOf(text);
  return tone === 'mid' ? null : tone === 'dark';
}

/** The region an element's children are in, given the marks already on the page. */
function regionAfter(element: Element, style: CSSStyleDeclaration, outer: Region, page: Page): Region {
  if (page.layers.has(element)) return outer;
  const mark = element.getAttribute(FLIP_ATTRIBUTE);
  const inverted = mark ? mark === 'inverted' : outer.inverted !== inversions(style.filter) % 2 > 0;
  return { inverted, backdrop: backdropInside(surfaceOf(style), outer.backdrop) };
}

function decide(element: Element, style: CSSStyleDeclaration, outer: Region, page: Page, topLayer: boolean) {
  if (page.layers.has(element)) return { inner: outer, mark: null, inherited: outer.inverted };
  // Dusk's photo rules, site files and the site itself filter some elements already, and their choice stands.
  // The top layer's filter is Dusk's stand-in for the page's, so an element there starts as the page does.
  const filtered = !topLayer && !element.hasAttribute(FLIP_ATTRIBUTE) && style.filter !== 'none';
  const inherited = topLayer ? page.region.inverted : outer.inverted !== (filtered && inversions(style.filter) % 2 > 0);
  const surface = surfaceOf(style);
  const backdrop = backdropInside(surface, outer.backdrop);
  let want: boolean | null = null;
  if (!filtered && !holdsFixed.has(element) && backdrop) {
    if (surface && surface !== 'image' && surface[3] >= SOLID_ALPHA && isLarge(element)) want = wantForSurface(backdrop);
    if (want === null && hasOwnText(element)) want = wantForInk(style, backdrop);
  }
  const mark: Mark | null = want === null || want === inherited ? null : want ? 'inverted' : 'original';
  return { inner: { inverted: mark ? want! : inherited, backdrop }, mark, inherited };
}

function setMark(element: Element, mark: Mark | null) {
  if (mark === element.getAttribute(FLIP_ATTRIBUTE)) return;
  if (mark) element.setAttribute(FLIP_ATTRIBUTE, mark);
  else element.removeAttribute(FLIP_ATTRIBUTE);
}

// A frame from the same site can be read, and one that is already dark keeps its colors.
function holdsDarkPage(frame: HTMLIFrameElement): boolean {
  let inner: Document | null = null;
  try {
    inner = frame.contentDocument;
  } catch {
    return false;
  }
  if (!inner?.body) return false;
  let color = WHITE;
  for (const element of [inner.documentElement, inner.body]) {
    const surface = surfaceOf(getComputedStyle(element));
    if (surface && surface !== 'image') color = composite(surface, color);
  }
  return toneOf(color) === 'dark';
}

// Frames show their own colors like video does, unless they hold a page, which then darkens with this one.
function markFrame(frame: HTMLIFrameElement) {
  const { width, height } = frame.getBoundingClientRect();
  const page =
    isLarge(frame) &&
    looksLikePage({
      identity: `${frame.src} ${frame.id} ${frame.name}`,
      allow: frame.allow,
      allowFullscreen: frame.allowFullscreen || frame.hasAttribute('webkitallowfullscreen'),
      width,
      height,
    }) &&
    !holdsDarkPage(frame);
  if (page) frame.setAttribute(FRAME_ATTRIBUTE, 'page');
  else frame.removeAttribute(FRAME_ATTRIBUTE);
}

/**
 * Marks a subtree, and reports whether it holds anything fixed to the window. Each mark is written before its
 * children are read, because site files filter with variables that depend on the marks above them.
 */
function scan(element: Element, outer: Region, page: Page): boolean {
  const style = getComputedStyle(element);
  const fixed = style.position === 'fixed';
  if (style.display === 'none') return fixed;
  if (element.localName === 'iframe') markFrame(element as HTMLIFrameElement);
  if (LEAVES.has(element.localName)) return fixed;
  const topLayer = isTopLayer(element);
  if (topLayer) outer = topLayerRegion(page);
  const { inner, mark, inherited } = decide(element, style, outer, page, topLayer);
  setMark(element, mark);
  let fixedInside = false;
  for (const child of element.children) if (scan(child, inner, page)) fixedInside = true;
  if (mark && fixedInside) {
    // A filter would pin fixed children, such as menus, to this element instead of the window.
    holdsFixed.add(element);
    setMark(element, null);
    const unflipped = { inverted: inherited, backdrop: inner.backdrop };
    for (const child of element.children) scan(child, unflipped, page);
  }
  return !topLayer && (fixed || fixedInside);
}

// Without a background of its own, the window's canvas follows the page's color scheme.
function canvasColor(): Color {
  const meta = document.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') ?? '';
  const scheme = `${getComputedStyle(document.documentElement).colorScheme} ${meta}`;
  if (!/\bdark\b/.test(scheme)) return WHITE;
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  return !/\blight\b/.test(scheme) || prefersDark ? DARK_CANVAS : WHITE;
}

function measurePage(): Page {
  const root = document.documentElement;
  const layers = new Set<Element>([root, document.body]);
  let color = canvasColor();
  const paint = (element: Element) => {
    const surface = surfaceOf(getComputedStyle(element));
    if (surface && surface !== 'image') color = composite(surface, color);
  };
  if (getComputedStyle(root).backgroundColor !== UNPAINTED_ROOT) paint(root);
  paint(document.body);
  const minWidth = root.clientWidth * PAGE_COVERAGE;
  let parent: Element = document.body;
  for (let depth = 0; depth < MAX_PAGE_LAYERS; depth++) {
    const minHeight = Math.max(parent.getBoundingClientRect().height, innerHeight) * PAGE_COVERAGE;
    const cover = [...parent.children].find((child) => {
      const box = child.getBoundingClientRect();
      return box.width >= minWidth && box.height >= minHeight;
    });
    if (!cover) break;
    paint(cover);
    layers.add(cover);
    parent = cover;
  }
  if (toneOf(color) === 'dark') root.setAttribute(PAGE_ATTRIBUTE, 'dark');
  else root.removeAttribute(PAGE_ATTRIBUTE);
  // Read back rather than assumed, since a site file can also turn the page filter off.
  const inverted = inversions(getComputedStyle(root).filter) % 2 > 0;
  return { region: { inverted, backdrop: color }, layers };
}

function regionOf(parent: Element, page: Page): Region | null {
  const chain: Element[] = [];
  for (let node: Element | null = parent; node !== document.body; node = node.parentElement) {
    if (!node) return null;
    chain.push(node);
  }
  let region = page.region;
  for (const element of chain.reverse()) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || LEAVES.has(element.localName)) return null;
    if (isTopLayer(element)) region = topLayerRegion(page);
    region = regionAfter(element, style, region, page);
  }
  return region;
}

let page: Page | null = null;
let fullScanDue = true;
let slow = false;
let scheduled = false;
let resizeTimer = 0;
const pending = new Set<Element>();

function scanPage() {
  page = measurePage();
  scan(document.body, page.region, page);
}

function outermostPending(): Element[] {
  const roots: Element[] = [];
  for (const element of pending) {
    if (!element.isConnected) continue;
    let covered = false;
    for (let ancestor = element.parentElement; ancestor && !covered; ancestor = ancestor.parentElement) {
      covered = pending.has(ancestor);
    }
    if (!covered) roots.push(element);
  }
  return roots;
}

// A subtree that turned fixed under a flipped section means that section must give up its filter.
function highestMark(element: Element): Element | null {
  let found: Element | null = null;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute(FLIP_ATTRIBUTE)) found = ancestor;
  }
  return found;
}

function scanPending(current: Page) {
  const roots = outermostPending();
  pending.clear();
  for (const root of roots) {
    if (current.layers.has(root)) return scanPage();
    if (!document.body.contains(root)) continue;
    const region = regionOf(root.parentElement!, current);
    if (!region || !scan(root, region, current)) continue;
    const marked = highestMark(root);
    const outer = marked && regionOf(marked.parentElement!, current);
    if (marked && outer) scan(marked, outer, current);
  }
}

function flush() {
  scheduled = false;
  const root = document.documentElement;
  if (!document.body || root.hasAttribute(OFF_ATTRIBUTE)) {
    // Turning Dusk back on changes the page's whole look, so it starts over.
    fullScanDue = true;
    pending.clear();
    return;
  }
  const started = performance.now();
  if (fullScanDue || !page) {
    fullScanDue = false;
    pending.clear();
    scanPage();
  } else if (pending.size) {
    scanPending(page);
  }
  slow = performance.now() - started > SLOW_SCAN_MS;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // Pages that change constantly, such as carousels, get checked less often when checks are slow.
  if (slow) setTimeout(flush, SLOW_SCAN_DELAY_MS);
  else requestAnimationFrame(flush);
}

function rescanAll() {
  fullScanDue = true;
  schedule();
}

const colorStyles = (style: string | null) => (style?.match(COLOR_STYLES) ?? []).join(';');
const isStyle = (node: Node) => node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === 'style';

function onMutations(records: MutationRecord[]) {
  for (const record of records) {
    const target = record.target as Element;
    if (record.type === 'childList') {
      // A stylesheet that is added or rewritten can restyle anything.
      if (isStyle(target) || [...record.addedNodes].some(isStyle)) fullScanDue = true;
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) pending.add(node as Element);
        else if (node.nodeType === Node.TEXT_NODE && target.nodeType === Node.ELEMENT_NODE) pending.add(target);
      }
      continue;
    }
    const name = record.attributeName!;
    if (name === FLIP_ATTRIBUTE || name === PAGE_ATTRIBUTE) continue;
    const value = target.getAttribute(name);
    if (name === 'style' && colorStyles(record.oldValue) === colorStyles(value)) continue;
    if (name === 'class' && record.oldValue === value) continue;
    // The root and body carry theme switches, which can change everything below them.
    if (target === document.documentElement || target === document.body) fullScanDue = true;
    else pending.add(target);
  }
  schedule();
}

// A stylesheet that arrives late can restyle anything, and a frame that loads a new page may now hold a dark one.
function watchLoad(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.localName === 'link' && /\bstylesheet\b/i.test(target.getAttribute('rel') ?? '')) {
    rescanAll();
  } else if (target.localName === 'iframe') {
    pending.add(target);
    schedule();
  }
}

function watchColorChange(event: Event) {
  const property = event instanceof TransitionEvent ? event.propertyName : '';
  if (event.target instanceof Element && (event.type !== 'transitionend' || COLOR_TRANSITIONS.test(property))) {
    pending.add(event.target);
    schedule();
  }
}

function start() {
  const root = document.documentElement;
  const observer = new MutationObserver(onMutations);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class', 'style', 'open', 'hidden'],
  });
  // Theme switches often use their own attribute, such as data-theme, on the root or the body.
  const themes = new MutationObserver(onMutations);
  themes.observe(root, { attributes: true, attributeOldValue: true });
  const watchBody = () => {
    if (document.body) themes.observe(document.body, { attributes: true, attributeOldValue: true });
  };
  watchBody();
  document.addEventListener('DOMContentLoaded', () => (watchBody(), rescanAll()), { once: true });
  addEventListener('load', rescanAll, { once: true });
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(rescanAll, RESIZE_DELAY_MS);
  });
  for (const type of ['transitionend', 'animationend', 'toggle']) {
    document.addEventListener(type, watchColorChange, { capture: true, passive: true });
  }
  document.addEventListener('load', watchLoad, { capture: true, passive: true });
  // Entering or leaving fullscreen moves an element to or from the top layer, which no filter around it reaches.
  document.addEventListener('fullscreenchange', rescanAll);
  // A site's own dark theme can follow the system's, which changes no attribute.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rescanAll);
  rescanAll();
}

export default defineUnlistedScript(() => {
  const shared = globalThis as typeof globalThis & { duskRescan?: () => void };
  // Turning a site on injects this into tabs that may already run it.
  if (shared.duskRescan) return shared.duskRescan();
  shared.duskRescan = rescanAll;
  start();
});
