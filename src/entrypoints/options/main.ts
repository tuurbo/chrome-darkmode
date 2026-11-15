import { defaultSettings, LEVEL_NAMES, LEVELS, loadSettings, saveSettings, type Settings } from '@/lib/settings';

const form = document.querySelector('form')!;
const sliders = LEVEL_NAMES.map((name) => {
  const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const { min, max, step } = LEVELS[name];
  Object.assign(input, { min: String(min), max: String(max), step: String(step) });
  return { name, input, output: form.querySelector<HTMLOutputElement>(`output[for="${name}"]`)! };
});
const reset = form.querySelector<HTMLButtonElement>('#reset')!;

const current = (): Settings =>
  Object.fromEntries(sliders.map(({ name, input }) => [name, input.valueAsNumber])) as Settings;

function showLabels() {
  for (const { input, output } of sliders) output.value = `${input.value}%`;
  const defaults = defaultSettings();
  reset.disabled = sliders.every(({ name, input }) => input.valueAsNumber === defaults[name]);
}

function show(settings: Settings) {
  for (const { name, input } of sliders) input.value = String(settings[name]);
  showLabels();
}

form.addEventListener('input', showLabels);
// Each save updates every dark tab, so a slider saves when it's let go rather than while it moves.
form.addEventListener('change', () => saveSettings(current()));
reset.addEventListener('click', () => {
  const defaults = defaultSettings();
  show(defaults);
  saveSettings(defaults);
});

loadSettings().then(show);
