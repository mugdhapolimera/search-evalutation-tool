import { useCallback, useSyncExternalStore } from 'react';

// Per-browser conveniences only: the discipline preference (as on SciX), the
// rater's name and the keyboard-shortcut switch. One shared store, so setting
// a name in the rating form updates the nav bar at once. Storage can be
// unavailable, so every access is guarded and values also live in memory.
const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; the in-memory value still holds for this page.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function useStoredValue(key: string, fallback: string | null = null) {
  const value = useSyncExternalStore(subscribe, () => read(key) ?? fallback);
  const update = useCallback((next: string | null) => write(key, next), [key]);
  return [value, update] as const;
}

export const useDiscipline = () => useStoredValue('search-eval:discipline', 'general');
export const useRater = () => useStoredValue('search-eval:rater');
