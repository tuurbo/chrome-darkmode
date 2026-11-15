import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, LEVEL_NAMES, levelFiles, levelValues, readSettings } from './settings.ts';

test('nothing stored means the defaults', () => {
  assert.deepEqual(defaultSettings(), { brightness: 100, photos: 80, hover: 100 });
  assert.deepEqual(readSettings(undefined), defaultSettings());
  assert.deepEqual(readSettings('bright'), defaultSettings());
  assert.deepEqual(readSettings({ brightness: '70', photos: Number.NaN }), defaultSettings());
});

test('stored levels are kept', () => {
  assert.deepEqual(readSettings({ brightness: 70, photos: 100, hover: 90 }), { brightness: 70, photos: 100, hover: 90 });
  assert.deepEqual(readSettings({ photos: 50 }), { brightness: 100, photos: 50, hover: 100 });
});

test('a level outside the range or between steps moves to the nearest one that has a file', () => {
  assert.deepEqual(readSettings({ brightness: 10, photos: 120, hover: 0 }), { brightness: 50, photos: 100, hover: 30 });
  assert.deepEqual(readSettings({ brightness: 73, photos: 81, hover: 88 }), { brightness: 75, photos: 80, hover: 90 });
  for (const value of [-5, 0, 33.3, 99, 1e9]) {
    const settings = readSettings({ brightness: value, photos: value, hover: value });
    for (const name of LEVEL_NAMES) assert.ok(levelValues(name).includes(settings[name]), `${name} ${value}`);
  }
});

test('each level loads the file for its value', () => {
  assert.deepEqual(levelFiles({ brightness: 70, photos: 100, hover: 90 }), [
    'levels/brightness-70.css',
    'levels/photos-100.css',
    'levels/hover-90.css',
  ]);
});
