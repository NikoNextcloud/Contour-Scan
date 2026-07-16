import type { ScanRecord } from "./types";

const DB_NAME = "contourscan";
const STORE = "scans";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

export const scanDB = {
  save: (record: ScanRecord) => tx("readwrite", (s) => s.put(record)),
  get: (id: string) => tx<ScanRecord | undefined>("readonly", (s) => s.get(id)),
  list: () =>
    tx<ScanRecord[]>("readonly", (s) => s.getAll()).then((all) =>
      all.sort((a, b) => b.createdAt - a.createdAt)
    ),
  remove: (id: string) => tx("readwrite", (s) => s.delete(id)),
};

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `scan-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
