import type { ScanRecord } from "./types";

/**
 * The "current" scan travels between pages via sessionStorage:
 * Scanner → Editor, History → Editor. Records themselves persist in IndexedDB.
 */
const KEY = "contourscan.current";

export function setCurrent(record: ScanRecord) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    /* quota exceeded — the editor will show its empty state */
  }
}

export function getCurrent(): ScanRecord | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ScanRecord) : null;
  } catch {
    return null;
  }
}

export function clearCurrent() {
  sessionStorage.removeItem(KEY);
}
