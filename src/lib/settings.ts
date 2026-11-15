export const SETTINGS_KEY = 'settings';

/**
 * The levels the options page sets, in percent. Each value has its own small stylesheet, because a registered
 * content script can only load files, and a file is in place before the page draws anything.
 */
export const LEVELS = {
  /** How bright a page comes out once Dusk darkens it. */
  brightness: { min: 50, max: 150, step: 5, initial: 100, property: '--dusk-brightness' },
  /** How bright photos show until hovered. */
  photos: { min: 30, max: 100, step: 5, initial: 80, property: '--dusk-photo-dim' },
  /** How bright a photo shows while hovered. */
  hover: { min: 30, max: 100, step: 5, initial: 100, property: '--dusk-photo-hover' },
} as const;

export type LevelName = keyof typeof LEVELS;
export type Settings = Record<LevelName, number>;

export const LEVEL_NAMES = Object.keys(LEVELS) as LevelName[];

export function levelValues(name: LevelName): number[] {
  const { min, max, step } = LEVELS[name];
  const values: number[] = [];
  for (let value = min; value <= max; value += step) values.push(value);
  return values;
}

// A value from an older range, or one set by hand, moves to the nearest one that has a file.
function nearestLevel(name: LevelName, value: unknown): number {
  const { min, max, step, initial } = LEVELS[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) return initial;
  const clamped = Math.min(max, Math.max(min, value));
  return min + Math.round((clamped - min) / step) * step;
}

export function readSettings(stored: unknown): Settings {
  const source = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, unknown>;
  return Object.fromEntries(LEVEL_NAMES.map((name) => [name, nearestLevel(name, source[name])])) as Settings;
}

export const defaultSettings = (): Settings => readSettings(undefined);

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return readSettings(stored[SETTINGS_KEY]);
}

export const saveSettings = (settings: Settings) => browser.storage.local.set({ [SETTINGS_KEY]: settings });

export const levelFile = (name: LevelName, value: number) => `levels/${name}-${value}.css`;

export const levelFiles = (settings: Settings) => LEVEL_NAMES.map((name) => levelFile(name, settings[name]));
