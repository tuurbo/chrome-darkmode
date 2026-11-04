import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findExternalReferences, scopeCss, usesRootSelector } from './site-css.ts';

test('plain rules and embedded data pass', () => {
  const svg = `.a { color: red; background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>") }`;
  assert.deepEqual(findExternalReferences(svg), []);
  assert.deepEqual(findExternalReferences('.a { fill: url(#gradient); background-image: none }'), []);
  assert.deepEqual(findExternalReferences('[style*="background-image"] { filter: none }'), []);
});

test('comments are checked too, so nothing that only looks like one can hide a rule', () => {
  assert.deepEqual(findExternalReferences('/* see url(https://example.com) */ .a { color: red }'), ['url(https://example.com)']);
  const disguises = [
    '.a { content: "/*" } .b { background: url(https://evil.test/x) } .c { content: "*/" }',
    '.a\\" { } .b { content: "/*" } .c { background: url(https://evil.test/x) } .d { content: "*/" }',
    '.a { --x: \\/*; background: url(https://evil.test/x); --y: */ }',
    `.a { content: "x\n" /* ' \n } .b { background: url(https://evil.test/x) } /* */`,
    '.a { background: url(data:,/*) } .b { background: url(https://evil.test/x) } .c { content: "*/" }',
    '.a { --x: url(data:,/*); background: url(https://evil.test/x); --y: */ }',
    '.a { content: "x\\\r\n /* " } .b { background: url(https://evil.test/x) } .c { content: "*/" }',
  ];
  for (const css of disguises) assert.deepEqual(findExternalReferences(css), ['url(https://evil.test/x)'], css);
});

test('anything that can fetch is rejected', () => {
  const cases: [string, string][] = [
    ['.a { background: url(https://evil.test/x.png) }', 'url(https://evil.test/x.png)'],
    ['.a { background: url("//evil.test/x.png") }', 'url(//evil.test/x.png)'],
    ['.a { background: url(local.png) }', 'url(local.png)'],
    ['@import "https://evil.test/a.css";', '@import'],
    ['.a { background: image-set("https://evil.test/x.png" 1x) }', 'image-set()'],
    ['.a { background: -webkit-image-set("x.png" 1x) }', '-webkit-image-set()'],
    ['.a { background: src("https://evil.test/x.png") }', 'src()'],
    ['.a { background: cross-fade(url(a.png), url(b.png)) }', 'url(a.png)'],
  ];
  for (const [css, expected] of cases) assert.ok(findExternalReferences(css).includes(expected), css);
});

test('escaped spellings are rejected too', () => {
  assert.deepEqual(findExternalReferences('.a { background: \\75rl(https://evil.test/x) }'), ['url(https://evil.test/x)']);
  assert.deepEqual(findExternalReferences('.a { background: u\\72 l(https://evil.test/x) }'), ['url(https://evil.test/x)']);
  assert.deepEqual(findExternalReferences('\\@import "x.css";'), ['@import']);
});

test('selectors that start at the root element are flagged', () => {
  for (const css of ['html { color: red }', ':root { --a: 1 }', '.a { color: red } html.dark .b { color: red }', '.a, :root { color: red }']) {
    assert.equal(usesRootSelector(css), true, css);
  }
});

test('selectors that only mention the root in passing are fine', () => {
  const allowed = [
    ':scope { --a: 1 }',
    ':scope.dark .b { color: red }',
    'body { color: red }',
    '.html { color: red }',
    '.a { content: "html { }" }',
    '/* html { } */ .a { color: red }',
    'html-block { color: red }',
  ];
  for (const css of allowed) assert.equal(usesRootSelector(css), false, css);
});

test('scopeCss gates every rule on the off marker and the screen', () => {
  assert.equal(
    scopeCss('.a { color: red }'),
    '@media screen {\n@scope (html:not([data-dusk-off])) {\n.a { color: red }\n}\n}\n',
  );
});
