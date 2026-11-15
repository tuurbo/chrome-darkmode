import { OFF_ATTRIBUTE } from '@/lib/site';
import {
  average,
  BARE_ROOT_COLOR,
  BARE_ROOT_IMAGE,
  composite,
  contrast,
  FLIP_ATTRIBUTE,
  FRAME_ATTRIBUTE,
  gradientColors,
  hasInlinePicture,
  inversions,
  looksLikePage,
  OFF_WHITE,
  OWN_ROOT_ATTRIBUTE,
  PAGE_ATTRIBUTE,
  parseRgb,
  PHOTO_ATTRIBUTE,
  toneOf,
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
// Work runs in slices this long, so even a very large page never holds up a frame for long.
const SLICE_MS = 6;
// After a frame that used a whole slice, new changes wait this long, so a page that changes all the time
// can't keep the main thread busy with checks.
const BUSY_DELAY_MS = 150;
// Work that fills this many frames in a row then rests three slices between slices, so a part that keeps
// changing and restarting its check takes at most a quarter of the main thread.
const BUSY_FRAMES = 4;
const REST_MS = SLICE_MS * 3;
// An element whose class or style keeps changing, such as a wrapper toggled while scrolling, is checked again
// at most this often, since each check covers everything inside it.
const CHURN_GAP_MS = 250;
// A full check waits this many times its own length after the last one, so it stays a small share of the time.
const FULL_SCAN_SPACING = 10;
const MIN_FULL_SCAN_GAP_MS = 500;
const RESIZE_DELAY_MS = 200;
const MAX_CACHED_COLORS = 1000;

const LEAVES = new Set([
  'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'embed', 'object', 'svg', 'math',
  'script', 'style', 'template', 'noscript', 'link', 'meta',
]);
const TOP_LAYER = ':modal, :popover-open, :fullscreen';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const COLOR_STYLES = /(?:^|;)\s*(?:background(?:-color|-image)?|color|filter|display|position|-webkit-text-fill-color)\s*:[^;]*/gi;
const COLOR_TRANSITIONS = /color|background|filter/;
const OWN_ATTRIBUTES = new Set([FLIP_ATTRIBUTE, PAGE_ATTRIBUTE, FRAME_ATTRIBUTE, PHOTO_ATTRIBUTE, OWN_ROOT_ATTRIBUTE]);

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

interface Task {
  element: Element;
  region: Region;
  ticket: number;
  /** Only the element's own text changed, so its children need a look only if its mark changes. */
  shallow: boolean;
  /** A changed element whose check is timed, so if it keeps changing it waits in proportion to what that costs. */
  timed: boolean;
  /** Set on the task that marks the end of a timed check, to the work clock when the check began. */
  began?: number;
}

const colors = new Map<string, Color | null>();
let painter: OffscreenCanvasRenderingContext2D | null = null;
// Fixed menus are often hidden when the page is read, so a container stays unfiltered once one shows up in it.
const holdsFixed = new WeakSet<Element>();
// The browser skips laying out a content-visibility section until it nears the window, and reading it would undo that.
const shownSections = new WeakSet<Element>();
// The last inline style and class seen on each element, so changes that can't affect colors are skipped.
const seenStyles = new WeakMap<Element, string>();
const seenClasses = new WeakMap<Element, string>();

// Computed colors in other spaces, such as oklch(), are converted by drawing them.
function readColor(value: string): Color | null {
  if (value === TRANSPARENT) return null;
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
  // Animated colors would otherwise add an entry for every frame.
  if (colors.size >= MAX_CACHED_COLORS) colors.clear();
  colors.set(value, color);
  return color;
}

function surfaceOf(style: CSSStyleDeclaration): Color | 'image' | null {
  const image = style.backgroundImage;
  const fill = style.backgroundColor;
  if (image === 'none' && fill === TRANSPARENT) return null;
  if (style.backgroundClip === 'text' || style.getPropertyValue('-webkit-background-clip') === 'text') return null;
  if (image.includes('url(')) return 'image';
  const color = readColor(fill);
  if (image === 'none') return color;
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

const isText = (node: Node) => node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue!);

function hasOwnText(element: Element): boolean {
  for (let node = element.firstChild; node; node = node.nextSibling) if (isText(node)) return true;
  return false;
}

// Read once per frame rather than once per element.
let fullscreen: Element | null = null;

function isTopLayer(element: Element): boolean {
  const candidate = element.localName === 'dialog' || element === fullscreen || element.hasAttribute('popover');
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
  const ink = readColor(style.color);
  if (!ink || ink[3] < MIN_INK_ALPHA) return null;
  const text = composite(ink, backdrop);
  if (contrast(text, backdrop) >= UNREADABLE_CONTRAST) return null;
  if (!readColor(style.getPropertyValue('-webkit-text-fill-color'))) return null;
  const tone = toneOf(text);
  return tone === 'mid' ? null : tone === 'dark';
}

/*
 * Writing a mark changes a filter, which makes the browser redo style and layout before the next read. Marks
 * and other attributes are kept here and written together at the end of each slice instead.
 */
const marks = new Map<Element, Mark | null>();
const flags: [Element, string, string | null][] = [];
// The region inside each element during one frame, so nearby changes don't each walk up to the body.
const regions = new Map<Element, Region | null>();

const markOf = (element: Element) =>
  marks.has(element) ? marks.get(element)! : (element.getAttribute(FLIP_ATTRIBUTE) as Mark | null);

function setMark(element: Element, mark: Mark | null) {
  if (mark === markOf(element)) return;
  marks.set(element, mark);
  regions.clear();
}

function setFlag(element: Element, name: string, value: string | null) {
  if (element.getAttribute(name) !== value) flags.push([element, name, value]);
}

function writeMarks() {
  for (const [element, mark] of marks) {
    if (element.getAttribute(FLIP_ATTRIBUTE) === mark) continue;
    if (mark) element.setAttribute(FLIP_ATTRIBUTE, mark);
    else element.removeAttribute(FLIP_ATTRIBUTE);
  }
  for (const [element, name, value] of flags) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
  marks.clear();
  flags.length = 0;
}

/*
 * The filter an element has once the marks decided so far are written. A site file's filter can use Dusk's
 * variables, which depend on the marks above it, and a mark on the element itself replaces its filter, so
 * those are written first when there are any.
 */
function currentFilter(element: Element, style: CSSStyleDeclaration): string {
  if (marks.size) {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (marks.has(node)) {
        writeMarks();
        break;
      }
    }
  }
  return style.filter;
}

const isPhoto = (element: Element) => hasInlinePicture(element.getAttribute('style'));
// The elements marked as photos, so the rest need no attribute read to stay unmarked.
const photos = new WeakSet<Element>();

/** The region an element's children are in, given the marks already on the page. */
function regionAfter(element: Element, style: CSSStyleDeclaration, outer: Region, page: Page): Region {
  if (page.layers.has(element)) return outer;
  const mark = markOf(element);
  let inverted: boolean;
  if (mark) inverted = mark === 'inverted';
  // Dusk's photo rule shows a photo's own colors wherever it sits.
  else if (isPhoto(element)) inverted = false;
  else inverted = outer.inverted !== inversions(currentFilter(element, style)) % 2 > 0;
  return { inverted, backdrop: backdropInside(surfaceOf(style), outer.backdrop) };
}

function decide(element: Element, style: CSSStyleDeclaration, outer: Region, page: Page, topLayer: boolean) {
  if (page.layers.has(element)) return { inner: outer, mark: null };
  const photo = isPhoto(element);
  if (photo !== photos.has(element)) {
    if (photo) photos.add(element);
    else photos.delete(element);
    setFlag(element, PHOTO_ATTRIBUTE, photo ? '' : null);
  }
  // Dusk's photo rule, site files and the site itself filter some elements already, and their choice stands.
  // The top layer's filter is Dusk's stand-in for the page's, so an element there starts as the page does.
  let filtered = photo;
  let inherited = outer.inverted;
  if (topLayer) inherited = page.region.inverted;
  else if (photo) inherited = false;
  else if (!markOf(element) && style.filter !== 'none') {
    const filter = currentFilter(element, style);
    filtered = filter !== 'none';
    inherited = outer.inverted !== inversions(filter) % 2 > 0;
  }
  const surface = surfaceOf(style);
  const backdrop = backdropInside(surface, outer.backdrop);
  let want: boolean | null = null;
  if (!filtered && !holdsFixed.has(element) && backdrop) {
    if (surface && surface !== 'image' && surface[3] >= SOLID_ALPHA && isLarge(element)) want = wantForSurface(backdrop);
    if (want === null && hasOwnText(element)) want = wantForInk(style, backdrop);
  }
  const mark: Mark | null = want === null || want === inherited ? null : want ? 'inverted' : 'original';
  return { inner: { inverted: mark ? want! : inherited, backdrop }, mark };
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
  setFlag(frame, FRAME_ATTRIBUTE, page ? 'page' : null);
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
  const rootStyle = getComputedStyle(root);
  const ownImage = rootStyle.backgroundImage !== 'none' && rootStyle.backgroundImage !== BARE_ROOT_IMAGE;
  const ownColor = ![TRANSPARENT, BARE_ROOT_COLOR, OFF_WHITE].includes(rootStyle.backgroundColor);
  // When the site sets only one of the two, the other dark.css part has to make way, which the mark tells it.
  const own = ownColor === ownImage ? null : ownColor ? 'color' : 'image';
  if (root.getAttribute(OWN_ROOT_ATTRIBUTE) !== own) {
    if (own) root.setAttribute(OWN_ROOT_ATTRIBUTE, own);
    else root.removeAttribute(OWN_ROOT_ATTRIBUTE);
  }
  // The off-white dark.css draws over a site's own color goes once the mark is in.
  const fill = own === 'color' ? readColor(rootStyle.backgroundColor) : null;
  if (fill) color = composite(fill, color);
  else if (ownImage) paint(root);
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

/** The region an element's children are in, or null when they aren't drawn. */
function regionOf(element: Element, page: Page): Region | null {
  if (element === document.body) return page.region;
  let region = regions.get(element);
  if (region !== undefined) return region;
  const parent = element.parentElement;
  const outer = parent && regionOf(parent, page);
  region = null;
  if (outer) {
    const style = getComputedStyle(element);
    if (style.display !== 'none' && !LEAVES.has(element.localName)) {
      region = regionAfter(element, style, isTopLayer(element) ? topLayerRegion(page) : outer, page);
    }
  }
  regions.set(element, region);
  return region;
}

/*
 * The work left to do, newest last. A part of the page that changes while it waits is queued again, and the
 * ticket shows which of its tasks is current, so an older one left lower down is skipped.
 */
const work: Task[] = [];
const tickets = new WeakMap<Element, number>();
let lastTicket = 0;

function queue(element: Element, region: Region, shallow: boolean, timed = false) {
  const ticket = ++lastTicket;
  tickets.set(element, ticket);
  work.push({ element, region, ticket, shallow, timed });
}

// Time spent checking, which only moves while a slice runs.
let workDone = 0;
let sliceStart = 0;
const workClock = () => workDone + performance.now() - sliceStart;
const checkCosts = new WeakMap<Element, number>();
// Timed checks still under way. Starting one again would throw away the work and never learn what it costs.
const checking = new Set<Element>();

// A filter above an element fixed to the window would pin it to that part instead, so that part gives up its filter.
function unpin(element: Element, page: Page) {
  let pinned: Element | null = null;
  for (let ancestor = element.parentElement; ancestor && !isTopLayer(ancestor); ancestor = ancestor.parentElement) {
    if (markOf(ancestor)) pinned = ancestor;
  }
  if (!pinned) return;
  holdsFixed.add(pinned);
  const region = regionOf(pinned.parentElement!, page);
  if (region) queue(pinned, region, false);
}

function visit({ element, region, ticket, shallow, timed }: Task, page: Page) {
  const style = getComputedStyle(element);
  if (style.position === 'fixed' && !isTopLayer(element)) unpin(element, page);
  if (style.display === 'none') return;
  if (element.localName === 'iframe') return markFrame(element as HTMLIFrameElement);
  if (LEAVES.has(element.localName)) return;
  const topLayer = isTopLayer(element);
  const before = markOf(element);
  const { inner, mark } = decide(element, style, topLayer ? topLayerRegion(page) : region, page, topLayer);
  setMark(element, mark);
  if ((shallow && mark === before) || !element.firstElementChild) return;
  const visibility = style.contentVisibility;
  if (visibility === 'hidden' || (visibility === 'auto' && !shownSections.has(element))) return;
  // Everything inside is taken before this, which is how it shows the check is done.
  if (timed) {
    checking.add(element);
    work.push({ element, region, ticket, shallow: false, timed: false, began: workClock() });
  }
  // Queued last to first, so they're taken in page order.
  for (let child = element.lastElementChild; child; child = child.previousElementSibling) queue(child, inner, false);
}

function drain(page: Page, deadline: number) {
  for (let count = 1; work.length; count++) {
    const task = work.pop()!;
    if (task.began !== undefined) {
      checking.delete(task.element);
      if (tickets.get(task.element) === task.ticket) checkCosts.set(task.element, workClock() - task.began);
      continue;
    }
    if (tickets.get(task.element) !== task.ticket || !task.element.isConnected) continue;
    visit(task, page);
    if (count % 32 === 0 && performance.now() > deadline) break;
  }
  // A check that was started over left its end behind, and nothing else will finish it.
  if (!work.length) checking.clear();
  writeMarks();
}

let page: Page | null = null;
let fullScanDue = true;
let fullScanRunning = false;
let fullScanTime = 0;
let nextFullScan = 0;
let scheduled = false;
let busy = false;
let busyFrames = 0;
let fullScanTimer = 0;
let resizeTimer = 0;
// Changed elements, and whether only their own text changed.
const pending = new Map<Element, boolean>();
const lastChecked = new WeakMap<Element, number>();
const churning = new Set<Element>();
let churnTimer = 0;

function startFullScan() {
  fullScanDue = false;
  fullScanRunning = true;
  fullScanTime = 0;
  pending.clear();
  work.length = 0;
  checking.clear();
  page = measurePage();
  queue(document.body, page.region, false);
}

function queuePending(current: Page, now: number) {
  for (const [element, shallow] of pending) {
    if (!element.isConnected) continue;
    if (current.layers.has(element)) {
      if (!shallow) fullScanDue = true;
      continue;
    }
    if (!shallow) {
      const last = lastChecked.get(element);
      const gap = Math.max(CHURN_GAP_MS, (checkCosts.get(element) ?? 0) * FULL_SCAN_SPACING);
      if (checking.has(element) || (last !== undefined && now - last < gap)) {
        churning.add(element);
        continue;
      }
      lastChecked.set(element, now);
    }
    // A change inside a part that is queued already is covered by it.
    let covered = false;
    for (let ancestor = element.parentElement; ancestor && !covered; ancestor = ancestor.parentElement) {
      covered = pending.get(ancestor) === false;
    }
    const region = !covered && element.parentElement && regionOf(element.parentElement, current);
    if (region) queue(element, region, shallow, !shallow);
  }
  pending.clear();
  if (churning.size && !churnTimer) {
    churnTimer = window.setTimeout(() => {
      churnTimer = 0;
      for (const element of churning) pending.set(element, false);
      churning.clear();
      schedule();
    }, CHURN_GAP_MS);
  }
}

function flush() {
  scheduled = false;
  if (!document.body || document.hidden || document.documentElement.hasAttribute(OFF_ATTRIBUTE)) {
    // Turning Dusk back on or showing the tab again starts over, since the page may look different by then.
    fullScanDue = true;
    fullScanRunning = false;
    pending.clear();
    work.length = 0;
    checking.clear();
    return;
  }
  const started = performance.now();
  fullscreen = document.fullscreenElement;
  regions.clear();
  if (!page || (fullScanDue && !fullScanRunning && started >= nextFullScan)) startFullScan();
  else queuePending(page, started);
  sliceStart = started;
  drain(page!, started + SLICE_MS);
  const finished = performance.now();
  workDone += finished - started;
  busy = finished - started >= SLICE_MS;
  busyFrames = busy ? busyFrames + 1 : 0;
  if (fullScanRunning) {
    fullScanTime += finished - started;
    if (!work.length) {
      fullScanRunning = false;
      nextFullScan = finished + Math.max(MIN_FULL_SCAN_GAP_MS, fullScanTime * FULL_SCAN_SPACING);
    }
  }
  if (work.length) schedule();
  // Changes that call for a full check share the next one, which waits until the last is far enough behind.
  if (fullScanDue && !fullScanRunning && !fullScanTimer) {
    fullScanTimer = window.setTimeout(() => {
      fullScanTimer = 0;
      schedule();
    }, nextFullScan - finished);
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  if (busyFrames >= BUSY_FRAMES) setTimeout(flush, work.length ? REST_MS : BUSY_DELAY_MS);
  else if (busy && !work.length) setTimeout(flush, BUSY_DELAY_MS);
  else requestAnimationFrame(flush);
}

function rescanAll() {
  fullScanDue = true;
  schedule();
}

const colorStyles = (style: string | null) => (style?.match(COLOR_STYLES) ?? []).join(';');
const isStyle = (node: Node) => node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === 'style';

// Whether an attribute changed in a way that could change colors. An element's first change always counts.
function colorsMayChange(element: Element, name: string): boolean {
  if (name !== 'style' && name !== 'class') return true;
  const seen = name === 'style' ? seenStyles : seenClasses;
  const value = name === 'style' ? colorStyles(element.getAttribute('style')) : (element.getAttribute('class') ?? '');
  if (seen.get(element) === value) return false;
  seen.set(element, value);
  return true;
}

function onMutations(records: MutationRecord[]) {
  // A hidden tab never gets a frame to check in, so holding on to its changes would only keep removed nodes alive.
  if (document.hidden) {
    fullScanDue = true;
    return;
  }
  for (const record of records) {
    const target = record.target as Element;
    if (record.type === 'childList') {
      // A stylesheet that is added or rewritten can restyle anything.
      if (isStyle(target)) fullScanDue = true;
      for (const node of record.addedNodes) {
        if (isStyle(node)) fullScanDue = true;
        else if (node.nodeType === Node.ELEMENT_NODE) pending.set(node as Element, false);
        else if (isText(node) && !pending.has(target)) pending.set(target, true);
      }
      continue;
    }
    const name = record.attributeName!;
    if (OWN_ATTRIBUTES.has(name) || !colorsMayChange(target, name)) continue;
    // The root and body carry theme switches, which can change everything below them.
    if (target === document.documentElement || target === document.body) fullScanDue = true;
    else pending.set(target, false);
  }
  schedule();
}

function watchChange(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (event.type === 'transitionend' && !COLOR_TRANSITIONS.test((event as TransitionEvent).propertyName)) return;
  pending.set(target, false);
  schedule();
}

// A stylesheet that arrives late can restyle anything, and a frame that loads a new page may now hold a dark one.
function watchLoad(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.localName === 'link' && /\bstylesheet\b/i.test(target.getAttribute('rel') ?? '')) {
    rescanAll();
  } else if (target.localName === 'iframe') {
    pending.set(target, false);
    schedule();
  }
}

function watchSection(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if ((event as ContentVisibilityAutoStateChangeEvent).skipped) {
    shownSections.delete(target);
  } else {
    shownSections.add(target);
    pending.set(target, false);
    schedule();
  }
}

function start() {
  const root = document.documentElement;
  const observer = new MutationObserver(onMutations);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] });
  // Theme switches often use their own attribute, such as data-theme, on the root or the body.
  const themes = new MutationObserver(onMutations);
  themes.observe(root, { attributes: true });
  const watchBody = () => {
    if (document.body) themes.observe(document.body, { attributes: true });
  };
  watchBody();
  document.addEventListener('DOMContentLoaded', () => (watchBody(), rescanAll()), { once: true });
  addEventListener('load', rescanAll, { once: true });
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(rescanAll, RESIZE_DELAY_MS);
  });
  for (const type of ['transitionend', 'animationend', 'toggle']) {
    document.addEventListener(type, watchChange, { capture: true, passive: true });
  }
  document.addEventListener('load', watchLoad, { capture: true, passive: true });
  document.addEventListener('contentvisibilityautostatechange', watchSection, { capture: true, passive: true });
  // Entering or leaving fullscreen moves an element to or from the top layer, which no filter around it reaches.
  document.addEventListener('fullscreenchange', rescanAll);
  document.addEventListener('visibilitychange', () => document.hidden || schedule());
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
