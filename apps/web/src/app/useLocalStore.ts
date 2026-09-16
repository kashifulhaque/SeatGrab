/**
 * The one connection this tab holds to the local save database.
 *
 * `openIndexedDbStore` fails loudly when a browser blocks storage, and it must: an
 * in-memory fallback would accept a match and then lose it at the next reload. The shell
 * opens the store once and hands it to every screen, so a screen never has to decide
 * whether storage works — it either has a store or it has the reason it does not.
 */
import { useEffect, useState } from 'react';

import { openIndexedDbStore, type LocalSnapshotStore } from '../local';

export interface LocalStoreHandle {
  /** `null` until the database opens, and permanently when `error` is set. */
  store: LocalSnapshotStore | null;
  error: string | null;
}

/** A readable one-line description of anything thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useLocalStore(): LocalStoreHandle {
  const [store, setStore] = useState<LocalSnapshotStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: LocalSnapshotStore | null = null;
    void (async () => {
      try {
        const open = await openIndexedDbStore();
        opened = open;
        if (cancelled) {
          open.close();
          return;
        }
        setStore(open);
      } catch (failure) {
        if (!cancelled) setError(describeError(failure));
      }
    })();
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, []);

  return { store, error };
}
