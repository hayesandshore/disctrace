// Saved throws. The phone or computer owns the permanent history: the pod
// holds only one capture, in RAM. Uses IndexedDB, falling back to memory when
// the browser has no usable storage (some private modes).

const DATABASE = "disctrace";
const STORE = "throws";

export class ThrowStore {
  constructor() {
    this.db = null;
    this.memory = new Map();
    this.persistent = false;
  }

  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      this.persistent = true;
    } catch {
      this.db = null;
      this.persistent = false;
    }
  }

  run(mode, work) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  /** All saved throws, newest first. */
  async list() {
    const records = this.db ? await this.run("readonly", (store) => store.getAll()) : [...this.memory.values()];
    return records.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }

  async put(record) {
    if (this.db) await this.run("readwrite", (store) => store.put(record));
    else this.memory.set(record.id, record);
  }

  async remove(id) {
    if (this.db) await this.run("readwrite", (store) => store.delete(id));
    else this.memory.delete(id);
  }
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
