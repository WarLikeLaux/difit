export type DiffLayoutMode = 'all-files' | 'file-by-file';

export const DEFAULT_DIFF_LAYOUT_MODE: DiffLayoutMode = 'all-files';
export const DIFF_LAYOUT_MODE_STORAGE_KEY = 'difit.diffLayoutMode';

export function normalizeDiffLayoutMode(value: unknown): DiffLayoutMode | null {
  if (value === 'all-files' || value === 'file-by-file') {
    return value;
  }
  return null;
}

export function getStoredDiffLayoutMode(): DiffLayoutMode | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return normalizeDiffLayoutMode(window.localStorage.getItem(DIFF_LAYOUT_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}
