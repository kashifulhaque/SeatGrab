/**
 * The browser store itself, rather than the in-memory stand-in for it.
 *
 * `local-transport.test.ts` drives the adapter against `createMemoryStore`, which has the
 * same semantics, so everything the adapter decides is already covered. What was not
 * covered until Session 18 was `openIndexedDbStore`: the upgrade that creates the object
 * store, the `summary.matchId` key path a `put` is keyed by, the newest-first ordering
 * `list` imposes on `getAll`, and the two failure branches that must never fall back to
 * memory. A defect confined to any of those would have passed the whole suite.
 *
 * Session 18 took the `fake-indexeddb` dependency to close it. The argument for it is
 * that the alternative is not "a cheaper test" but "no test": every one of those four
 * behaviors is IndexedDB's own asynchronous API, and a hand-written double for that API
 * would be a second implementation with the same defects, asserted against itself. The
 * argument against — one more dependency — is real but small: it is a development
 * dependency, it never reaches either build, and the checks in
 * `scripts/check_build_privacy.mjs` prove that independently.
 *
 * What this still does not prove is the thing the transport-check route is for: that a
 * save survives a real page reload in a real browser. `fake-indexeddb` is an in-process
 * implementation of the API, so it outlives nothing. Durability across a reload stays a
 * browser exercise, and 0.2 records it as one.
 */
import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LOCAL_DATABASE_NAME,
  LocalStoreError,
  openIndexedDbStore,
  type LocalMatchRecord,
  type LocalSnapshotStore,
} from '../src/local';

let databaseCount = 0;
const opened: LocalSnapshotStore[] = [];

/** A database per test, so ordering and deletion cannot leak between them. */
async function freshStore(): Promise<LocalSnapshotStore> {
  databaseCount += 1;
  const store = await openIndexedDbStore(`seatgrab-test-${databaseCount}`);
  opened.push(store);
  return store;
}

function record(matchId: string, savedAt: string, revision = 1): LocalMatchRecord {
  return {
    summary: {
      matchId,
      revision,
      status: 'active',
      players: [
        { id: 'p1', displayName: 'Asha', partyId: 'purple' },
        { id: 'p2', displayName: 'Bikram', partyId: 'green' },
      ],
      savedAt,
      formatVersion: 1,
      schemaVersion: 1,
      contentPackId: 'core-set',
      contentVersion: '0.9.0',
      boardId: 'grid-nine',
      boardVersion: '1.0.0',
      unreadableReason: null,
    },
    document: `{"matchId":"${matchId}"}`,
  };
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

describe('openIndexedDbStore', () => {
  it('creates its object store on first open and round-trips a record', async () => {
    const store = await freshStore();
    expect(await store.list()).toEqual([]);
    expect(await store.read('m1')).toBeNull();

    const written = record('m1', '2026-01-01T00:00:00.000Z');
    await store.write(written);
    expect(await store.read('m1')).toEqual(written);
    expect(await store.list()).toEqual([written.summary]);
  });

  it('keys a record by summary.matchId, so a later save replaces the earlier one', async () => {
    const store = await freshStore();
    await store.write(record('m1', '2026-01-01T00:00:00.000Z', 4));
    await store.write(record('m1', '2026-01-01T00:05:00.000Z', 9));

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.revision).toBe(9);
    expect((await store.read('m1'))?.summary.revision).toBe(9);
  });

  it('lists newest first, and breaks an identical timestamp by match ID', async () => {
    const store = await freshStore();
    await store.write(record('older', '2026-01-01T00:00:00.000Z'));
    await store.write(record('newest', '2026-03-01T00:00:00.000Z'));
    await store.write(record('middle', '2026-02-01T00:00:00.000Z'));
    expect((await store.list()).map((summary) => summary.matchId))
      .toEqual(['newest', 'middle', 'older']);

    const tied = await freshStore();
    await tied.write(record('b', '2026-01-01T00:00:00.000Z'));
    await tied.write(record('a', '2026-01-01T00:00:00.000Z'));
    expect((await tied.list()).map((summary) => summary.matchId)).toEqual(['a', 'b']);
  });

  it('removes one record and leaves the rest, and forgives a match that is not there', async () => {
    const store = await freshStore();
    await store.write(record('keep', '2026-01-01T00:00:00.000Z'));
    await store.write(record('drop', '2026-02-01T00:00:00.000Z'));

    await store.remove('drop');
    expect((await store.list()).map((summary) => summary.matchId)).toEqual(['keep']);
    expect(await store.read('drop')).toBeNull();

    // Deleting a save the list no longer shows is the ordinary double-click, not an error.
    await expect(store.remove('never-existed')).resolves.toBeUndefined();
    expect((await store.list()).map((summary) => summary.matchId)).toEqual(['keep']);
  });

  it('reopens the same database and finds what an earlier handle wrote', async () => {
    const name = `seatgrab-reopen-${(databaseCount += 1)}`;
    const first = await openIndexedDbStore(name);
    await first.write(record('m1', '2026-01-01T00:00:00.000Z', 12));
    first.close();

    const second = await openIndexedDbStore(name);
    opened.push(second);
    expect((await second.read('m1'))?.summary.revision).toBe(12);
  });

  it('refuses rather than falling back to memory when the browser has no IndexedDB', async () => {
    // A silent fallback would lose a match at the next reload without ever saying so,
    // which is why `openIndexedDbStore` throws here instead.
    const factory = globalThis.indexedDB;
    // @ts-expect-error — modelling a browser that does not provide the global at all.
    delete globalThis.indexedDB;
    try {
      await expect(openIndexedDbStore(LOCAL_DATABASE_NAME)).rejects.toThrow(LocalStoreError);
      await expect(openIndexedDbStore(LOCAL_DATABASE_NAME)).rejects.toMatchObject({
        code: 'STORE_UNAVAILABLE',
      });
    } finally {
      globalThis.indexedDB = factory;
    }
  });

  it('reports a refused open as STORE_UNAVAILABLE rather than as a save failure', async () => {
    const name = `seatgrab-refused-${(databaseCount += 1)}`;
    // A database already at a higher version is the browser's own reason to refuse: the
    // open request errors, and the distinction that matters to a player is that nothing
    // was saved, not that a transaction failed.
    const ahead = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await expect(openIndexedDbStore(name)).rejects.toMatchObject({
        name: 'LocalStoreError',
        code: 'STORE_UNAVAILABLE',
      });
    } finally {
      ahead.close();
    }
  });
});
