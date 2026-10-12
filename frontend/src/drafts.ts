import type { Block } from "./types";
export type Draft = {
  id: string;
  base_revision: number;
  blocks: Block[];
  at: number;
  owner?: string;
};
type StoredDraft = Draft & { transcript_id?: string };
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => {});
  return result;
}
function key(id: string, owner?: string) {
  return owner ? id + ":" + owner : id;
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lectra-drafts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("drafts", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readDrafts(id: string) {
  await tail;
  const db = await database();
  try {
    return await new Promise<Draft[]>((resolve, reject) => {
      const request = db.transaction("drafts").objectStore("drafts").getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as StoredDraft[])
            .filter((d) => (d.transcript_id ?? d.id) === id)
            .map((d) => ({ ...d, id }))
            .sort((a, b) => b.at - a.at),
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export function writeDraft(draft: Draft) {
  return serial(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        tx.objectStore("drafts").put({
          ...draft,
          id: key(draft.id, draft.owner),
          transcript_id: draft.id,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error ?? new Error("Draft transaction aborted."));
      });
    } finally {
      db.close();
    }
  });
}
export function deleteDraft(id: string, owner?: string, throughAt = Infinity) {
  return serial(async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        const recordKey = key(id, owner);
        const read = store.get(recordKey);
        read.onsuccess = () => {
          if (read.result && read.result.at <= throughAt)
            store.delete(recordKey);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error ?? new Error("Draft transaction aborted."));
      });
    } finally {
      db.close();
    }
  });
}
