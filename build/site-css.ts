import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEVEL_NAMES, LEVELS, levelFile, levelValues, type LevelName } from '../src/lib/settings.ts';
import { OFF_ATTRIBUTE } from '../src/lib/site.ts';

const BASE_CSS = 'src/dark.css';
const SITE_FILE = /^([a-z0-9-]+\.)*[a-z0-9-]+\.css$/;
const BLOCKED_FUNCTIONS = /(?:^|[^\w-])((?:-webkit-)?image-set|image|cross-fade|src)\s*\(/gi;
const NEWLINE = /[\n\r\f]/;

// Only the root selector check skips comments. That check only catches rules that would never match,
// so a comment Chrome reads differently can only hide a mistake from it, never a fetch.
function withoutComments(css: string): string {
  let result = '';
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    const char = css[i];
    if (char === '\\') {
      result += css.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < css.length && css[end] !== char && !NEWLINE.test(css[end]!)) end += css[end] === '\\' ? 2 : 1;
      result += css.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

function withoutEscapes(css: string): string {
  return css
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/\\(.)/g, '$1');
}

/*
 * Comments are read too. Chrome doesn't see a comment inside an unquoted url(), and it joins a CRLF after a
 * backslash in a string, so a skipped "comment" can hold a live rule. Rejecting a URL that is only mentioned
 * in a comment is the safe side of that.
 */
export function findExternalReferences(css: string): string[] {
  const text = withoutEscapes(css);
  const found: string[] = [];
  if (/@import\b/i.test(text)) found.push('@import');
  for (const match of text.matchAll(/url\(\s*["']?([^"')]*)/gi)) {
    const target = match[1]!.trim();
    if (!/^(data:|#)/i.test(target)) found.push(`url(${target})`);
  }
  for (const match of text.matchAll(BLOCKED_FUNCTIONS)) found.push(`${match[1]!.toLowerCase()}()`);
  return found;
}

// Inside @scope a selector only reaches descendants of the root, so these would silently never match.
export function usesRootSelector(css: string): boolean {
  return withoutComments(css)
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .split(/[{}]/)
    .flatMap((selectors) => selectors.split(','))
    .some((selector) => /^\s*(html|:root)(?![\w-])/i.test(selector));
}

// Printing leaves the page as the site drew it, since paper is light.
export function scopeCss(css: string): string {
  return `@media screen {\n@scope (html:not([${OFF_ATTRIBUTE}])) {\n${css}\n}\n}\n`;
}

function checkedCss(path: string, prefix = ''): string {
  const css = readFileSync(path, 'utf8');
  const found = findExternalReferences(css);
  if (found.length) throw new Error(`${path} may not load anything external: ${found.join(', ')}`);
  if (usesRootSelector(css)) throw new Error(`${path} must use :scope instead of html or :root`);
  return scopeCss(prefix + css);
}

const levelDeclaration = (name: LevelName, value: number) => `  ${LEVELS[name].property}: brightness(${value}%);\n`;

// The defaults sit under :where(), so a level file wins over them whichever loads first.
const LEVEL_DEFAULTS = `:where(:scope) {\n${LEVEL_NAMES.map((name) => levelDeclaration(name, LEVELS[name].initial)).join('')}}\n\n`;

export function listSites(sitesDir: string): string[] {
  if (!existsSync(sitesDir)) return [];
  const files = readdirSync(sitesDir).filter((file) => file.endsWith('.css'));
  const invalid = files.find((file) => !SITE_FILE.test(file));
  if (invalid) throw new Error(`${join(sitesDir, invalid)} must be named after a lowercase site, like amazon.com.css`);
  return files.map((file) => file.slice(0, -'.css'.length));
}

export function styleAssets(sitesDir: string) {
  return [
    { relativeDest: 'dark.css', contents: checkedCss(BASE_CSS, LEVEL_DEFAULTS) },
    ...listSites(sitesDir).map((site) => ({
      relativeDest: `sites/${site}.css`,
      contents: checkedCss(join(sitesDir, `${site}.css`)),
    })),
    ...LEVEL_NAMES.flatMap((name) =>
      levelValues(name).map((value) => ({
        relativeDest: levelFile(name, value),
        contents: scopeCss(`:scope {\n${levelDeclaration(name, value)}}\n`),
      })),
    ),
  ];
}
