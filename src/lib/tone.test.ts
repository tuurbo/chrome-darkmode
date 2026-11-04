import assert from 'node:assert/strict';
import { test } from 'node:test';
import { average, composite, contrast, gradientColors, inversions, looksLikePage, luminance, parseRgb, toneOf } from './tone.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('parseRgb reads the rgb forms Chrome computes', () => {
  assert.deepEqual(parseRgb('rgb(12, 13, 18)'), [12, 13, 18, 1]);
  assert.deepEqual(parseRgb('rgba(0, 0, 0, 0.55)'), [0, 0, 0, 0.55]);
  assert.deepEqual(parseRgb('rgb(0 0 0 / 50%)'), [0, 0, 0, 0.5]);
  assert.equal(parseRgb('oklch(0.2 0.03 264)'), null);
  assert.equal(parseRgb('transparent'), null);
});

test('gradientColors lists the colors of a gradient without images', () => {
  assert.deepEqual(gradientColors('linear-gradient(rgb(0, 0, 0), rgba(255, 255, 255, 0.5))'), [
    'rgb(0, 0, 0)',
    'rgba(255, 255, 255, 0.5)',
  ]);
  assert.deepEqual(gradientColors('linear-gradient(rgb(0, 0, 0), rgb(1, 1, 1)), url("a.png")'), []);
  assert.deepEqual(gradientColors('none'), []);
});

test('average mixes colors evenly', () => {
  assert.equal(average([]), null);
  assert.deepEqual(average([[0, 0, 0, 1], [255, 255, 255, 1]]), [127.5, 127.5, 127.5, 1]);
});

test('composite paints a color over a backdrop', () => {
  assert.deepEqual(composite([10, 20, 30, 1], [255, 255, 255, 1]), [10, 20, 30, 1]);
  assert.deepEqual(composite([0, 0, 0, 0.5], [255, 255, 255, 1]), [127.5, 127.5, 127.5, 1]);
});

test('luminance runs from black to white', () => {
  near(luminance([255, 255, 255, 1]), 1);
  near(luminance([0, 0, 0, 1]), 0);
});

test('toneOf sorts colors into dark, mid and light', () => {
  assert.equal(toneOf([0, 0, 0, 1]), 'dark');
  assert.equal(toneOf([255, 255, 255, 1]), 'light');
  assert.equal(toneOf([12, 13, 18, 1]), 'dark');
  assert.equal(toneOf([119, 119, 119, 1]), 'mid');
});

test('contrast compares two colors', () => {
  near(contrast([0, 0, 0, 1], [255, 255, 255, 1]), 21);
  near(contrast([255, 255, 255, 1], [255, 255, 255, 1]), 1);
});

test('inversions counts the inverting filters', () => {
  assert.equal(inversions('none'), 0);
  assert.equal(inversions('invert(1) hue-rotate(180deg)'), 1);
  assert.equal(inversions('invert(0)'), 0);
  assert.equal(inversions('invert(0.93) hue-rotate(180deg)'), 1);
  assert.equal(inversions('brightness(0.8) invert(1) hue-rotate(180deg)'), 1);
  assert.equal(inversions('invert(100%)'), 1);
  assert.equal(inversions('invert(1) invert(1)'), 2);
});

test('looksLikePage tells pages from players and ads', () => {
  const base = { identity: 'https://keepa.com/keepaBox.html keepa ', allow: '', allowFullscreen: false, width: 1000, height: 500 };
  assert.equal(looksLikePage(base), true);
  assert.equal(looksLikePage({ ...base, allowFullscreen: true }), false);
  assert.equal(looksLikePage({ ...base, allow: 'accelerometer; autoplay; encrypted-media' }), false);
  assert.equal(looksLikePage({ ...base, identity: 'https://tpc.googlesyndication.com/safeframe/1-0-45/ x ' }), false);
  assert.equal(looksLikePage({ ...base, identity: ' google_ads_iframe_/4817/top_0 ' }), false);
  assert.equal(looksLikePage({ ...base, identity: 'https://www.google.com/recaptcha/api2/bframe  ' }), false);
  assert.equal(looksLikePage({ ...base, width: 300, height: 250 }), false);
  assert.equal(looksLikePage({ ...base, width: 301, height: 250 }), false);
  assert.equal(looksLikePage({ ...base, width: 310, height: 250 }), true);
});
