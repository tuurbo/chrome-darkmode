import assert from 'node:assert/strict';
import { test } from 'node:test';
import { covers, matchPattern, siteFilesFor, siteFromUrl, urlConditions } from './site.ts';

test('siteFromUrl reduces a page URL to its site', () => {
  assert.equal(siteFromUrl('https://www.amazon.com/gp/cart?x=1'), 'amazon.com');
  assert.equal(siteFromUrl('https://mail.google.com/mail/u/0/'), 'mail.google.com');
  assert.equal(siteFromUrl('http://localhost:3000/'), 'localhost');
  assert.equal(siteFromUrl('http://127.0.0.1:8080/'), '127.0.0.1');
  assert.equal(siteFromUrl('https://www.com/'), 'www.com');
  assert.equal(siteFromUrl('HTTPS://WWW.Example.COM/'), 'example.com');
});

test('siteFromUrl rejects pages an extension cannot darken', () => {
  const urls = ['chrome://settings', 'chrome-extension://abc/page.html', 'file:///c:/a.html', 'about:blank', 'nonsense', undefined];
  for (const url of urls) assert.equal(siteFromUrl(url), null);
});

test('matchPattern covers subdomains for names but not for IP addresses', () => {
  assert.equal(matchPattern('amazon.com'), '*://*.amazon.com/*');
  assert.equal(matchPattern('127.0.0.1'), '*://127.0.0.1/*');
  assert.equal(matchPattern('[::1]'), '*://[::1]/*');
});

test('covers matches a site and its subdomains only', () => {
  assert.equal(covers('amazon.com', 'amazon.com'), true);
  assert.equal(covers('amazon.com', 'music.amazon.com'), true);
  assert.equal(covers('amazon.com', 'notamazon.com'), false);
  assert.equal(covers('music.amazon.com', 'amazon.com'), false);
});

test('siteFilesFor returns the files covering a host, parents first', () => {
  assert.deepEqual(siteFilesFor('mail.google.com', ['google.com', 'mail.google.com', 'amazon.com']), ['google.com', 'mail.google.com']);
  assert.deepEqual(siteFilesFor('google.com', ['mail.google.com', 'google.com']), ['google.com']);
  assert.deepEqual(siteFilesFor('notgoogle.com', ['google.com']), []);
  assert.deepEqual(siteFilesFor('a.b.example.com', ['a.b.example.com', 'example.com', 'b.example.com']), [
    'example.com',
    'b.example.com',
    'a.b.example.com',
  ]);
});

test('urlConditions do not match a longer host with the same ending', () => {
  assert.deepEqual(urlConditions('amazon.com'), [{ hostEquals: 'amazon.com' }, { hostSuffix: '.amazon.com' }]);
  assert.deepEqual(urlConditions('127.0.0.1'), [{ hostEquals: '127.0.0.1' }]);
});
