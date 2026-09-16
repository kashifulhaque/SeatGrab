/**
 * Where local saves live.
 *
 * The adapter talks to this interface, not to IndexedDB, so the save/list/resume/delete
 * behavior is testable without a browser and a future backend can replace the storage
 * without touching the adapter. `openIndexedDbStore` is the browser implementation;
 * `createMemoryStore` is for tests.
 *
 * Each record holds the exact document text `writeDocument` produced, plus the summary
 * the saved-match list renders. Storing the text rather than a structured clone means a
 * resumed save and an exported file go through the same reader.
 */
import type { LocalMatchSummary } from './snapshot';

export interface LocalMatchRecord {
  summary: LocalMatchSummary;
  /** The save document, exactly as export writes it. */
  document: string;
}

export interface LocalSnapshotStore {
  /** Saved matches, most recently saved first. */
  list(): Promise<readonly LocalMatchSummary[]>;
  read(matchId: string): Promise<LocalMatchRecord | null>;
  write(record: LocalMatchRecord): Promise<void>;
  remove(matchId: string): Promise<void>;
  close(): void;
}

export class LocalStoreError extends Error {
  readonly code: 'STORE_UNAVAILABLE' | 'STORE_FAILED';

  constructor(code: 'STORE_UNAVAILABLE' | 'STORE_FAILED', message: string) {
    super(message);
    this.name = 'LocalStoreError';
    this.code = code;
  }
}

function byNewestSave(a: LocalMatchSummary, b: LocalMatchSummary): number {
  if (a.savedAt === b.savedAt) return a.matchId.localeCompare(b.matchId);
  return a.savedAt < b.savedAt ? 1 : -1;
}

/** An in-memory store with the same semantics as the IndexedDB one. */
export function createMemoryStore(): LocalSnapshotStore {
  const records = new Map<string, LocalMatchRecord>();
  return {
    list: () =>
      Promise.resolve(
        [...records.values()].map((record) => record.summary).sort(byNewestSave),
      ),
    read: (matchId) => Promise.resolve(records.get(matchId) ?? null),
    write: (record) => {
      records.set(record.summary.matchId, structuredClone(record));
      return Promise.resolve();
    },
    remove: (matchId) => {
      records.delete(matchId);
      return Promise.resolve();
    },
    close: () => records.clear(),
  };
}

export const LOCAL_DATABASE_NAME = 'seatgrab-local';
const LOCAL_DATABASE_VERSION = 1;
const MATCH_STORE = 'matches';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new LocalStoreError('STORE_FAILED', request.error?.message ?? 'The browser database rejected the request.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(new LocalStoreError('STORE_FAILED', transaction.error?.message ?? 'The save transaction was aborted.'));
    transaction.onerror = () =>
      reject(new LocalStoreError('STORE_FAILED', transaction.error?.message ?? 'The save transaction failed.'));
  });
}

/**
 * Open the browser database that holds local saves.
 *
 * A browser with IndexedDB blocked or missing fails here with `STORE_UNAVAILABLE`
 * rather than falling back to memory, because a silent fallback would lose a match at
 * the next reload without ever saying so.
 */
export async function openIndexedDbStore(
  databaseName: string = LOCAL_DATABASE_NAME,
): Promise<LocalSnapshotStore> {
  const factory = globalThis.indexedDB as IDBFactory | undefined;
  if (factory === undefined) {
    throw new LocalStoreError(
      'STORE_UNAVAILABLE',
      'This browser does not allow IndexedDB, so a local match cannot be saved. Private '
      + 'browsing and blocked site data are the usual causes.',
    );
  }

  const open = factory.open(databaseName, LOCAL_DATABASE_VERSION);
  open.onupgradeneeded = () => {
    const database = open.result;
    if (!database.objectStoreNames.contains(MATCH_STORE)) {
      database.createObjectStore(MATCH_STORE, { keyPath: 'summary.matchId' });
    }
  };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onblocked = () =>
      reject(new LocalStoreError('STORE_UNAVAILABLE', 'Another tab is holding an older version of the local database open.'));
    open.onerror = () =>
      reject(new LocalStoreError('STORE_UNAVAILABLE', open.error?.message ?? 'The browser refused to open the local database.'));
  });

  return {
    async list() {
      const transaction = database.transaction(MATCH_STORE, 'readonly');
      const records = await requestResult<LocalMatchRecord[]>(
        transaction.objectStore(MATCH_STORE).getAll() as IDBRequest<LocalMatchRecord[]>,
      );
      await transactionDone(transaction);
      return records.map((record) => record.summary).sort(byNewestSave);
    },
    async read(matchId) {
      const transaction = database.transaction(MATCH_STORE, 'readonly');
      const record = await requestResult<LocalMatchRecord | undefined>(
        transaction.objectStore(MATCH_STORE).get(matchId) as IDBRequest<LocalMatchRecord | undefined>,
      );
      await transactionDone(transaction);
      return record ?? null;
    },
    async write(record) {
      const transaction = database.transaction(MATCH_STORE, 'readwrite');
      transaction.objectStore(MATCH_STORE).put(record);
      await transactionDone(transaction);
    },
    async remove(matchId) {
      const transaction = database.transaction(MATCH_STORE, 'readwrite');
      transaction.objectStore(MATCH_STORE).delete(matchId);
      await transactionDone(transaction);
    },
    close() {
      database.close();
    },
  };
}
