// Table density is a per-person display preference, remembered in this browser. Comfortable is the default; compact
// tightens table rows (see --row-h in tokens.css). These helpers take the storage and element as arguments so they can be
// tested without a browser.
export const DENSITY_STORAGE_KEY = "sigma-density";
export const DENSITIES = ["comfortable", "compact"];
export const DEFAULT_DENSITY = "comfortable";

export const normalizeDensity = (value) => (DENSITIES.includes(value) ? value : DEFAULT_DENSITY);

export const readDensity = (storage) => {
  try {
    return normalizeDensity(storage?.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return DEFAULT_DENSITY;
  }
};

export const writeDensity = (storage, value) => {
  try {
    storage?.setItem(DENSITY_STORAGE_KEY, normalizeDensity(value));
  } catch {
    // Storage can be blocked (private mode); the choice then lasts for this visit only.
  }
};

export const applyDensity = (root, value) => {
  if (root) root.dataset.density = normalizeDensity(value);
};
