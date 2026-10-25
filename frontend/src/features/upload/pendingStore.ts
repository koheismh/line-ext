// 保留中アップロードの記録（メモ型・IndexedDB）。requirements 要件9 準拠。
// ファイル本体(Blob)は保存せず、メタ情報のみ記録する（案A）。
// 再開時は同名・同サイズ・同更新日時で照合してファイルを選び直してもらう。

export interface PendingUpload {
  /** ローカル一意ID */
  id: string;
  albumId: string;
  fileName: string;
  byteSize: number;
  /** File.lastModified（同一ファイル照合用） */
  lastModified: number;
  mimeType: string;
  /** ブロック理由 */
  reason: 'cellular' | 'unknown';
  createdAt: string;
}

const DB_NAME = 'photo-album';
const STORE = 'pending-uploads';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** 保留を追加する。 */
export async function addPending(item: PendingUpload): Promise<void> {
  await tx('readwrite', (s) => s.put(item));
}

/** 保留を全件取得する。 */
export async function listPending(): Promise<PendingUpload[]> {
  const all = await tx<PendingUpload[]>('readonly', (s) => s.getAll() as IDBRequest<PendingUpload[]>);
  return all ?? [];
}

/** 保留件数。 */
export async function countPending(): Promise<number> {
  return tx<number>('readonly', (s) => s.count());
}

/** 保留を取り消す（削除）。 */
export async function removePending(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id) as unknown as IDBRequest<undefined>);
}

/**
 * 選び直されたファイルが保留と同一か照合する。
 * 名前・サイズ・更新日時で判定（メモ型のため本体は保持していない）。
 */
export function matchesPending(pending: PendingUpload, file: File): boolean {
  return (
    pending.fileName === file.name &&
    pending.byteSize === file.size &&
    pending.lastModified === file.lastModified
  );
}
