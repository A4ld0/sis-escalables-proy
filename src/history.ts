export interface Message {
  seq: number;
  senderId?: string;
  text?: string;
  createdAt?: string;
  hidden?: boolean;
}

export interface SavedHistory {
  messages: Message[];
  lastSeq: number;
  older: boolean;
  version: string;
}

export const recentMessageLimit = 50;

async function historyTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => () => T,
): Promise<T | undefined> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('chat-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('conversations');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('conversations', mode);
        const result = operation(tx.objectStore('conversations'));
        tx.oncomplete = () => resolve(result());
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function readHistory(uid: string, cid: string): Promise<SavedHistory | undefined> {
  return historyTransaction('readonly', store => {
    const request = store.get([uid, cid]);
    return () => request.result;
  });
}

export function writeHistory(uid: string, cid: string, history: SavedHistory, previousVersion?: string) {
  return historyTransaction('readwrite', store => {
    const key = [uid, cid];
    const request = store.get(key);
    let savedVersion: string | undefined;
    request.onsuccess = () => {
      const stored: SavedHistory | undefined = request.result;
      if (stored?.version === history.version) {
        if (stored.lastSeq <= history.lastSeq) store.put(history, key);
      } else {
        // Another tab may already have stored a newly validated version.
        if (stored && stored.version !== previousVersion) return;
        store.put(history, key);
      }
      savedVersion = history.version;
    };
    return () => savedVersion;
  });
}

export function clearHistory(uid: string, cid?: string) {
  return historyTransaction('readwrite', store => {
    const request = store.delete(cid === undefined ? IDBKeyRange.bound([uid], [uid, []], false, true) : [uid, cid]);
    return () => request.result;
  });
}
