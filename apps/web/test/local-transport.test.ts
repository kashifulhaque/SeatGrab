/**
 * Local transport: saving, listing, resuming, deleting, and refusing a stale save.
 *
 * These run against the in-memory store, which has the same semantics as the IndexedDB
 * one. The IndexedDB implementation itself is exercised in the browser through the
 * development-only transport check route, because a reload is the thing worth proving
 * and a unit test cannot reload a page.
 */
import { describe, expect, it } from 'vitest';

import { CONTENT_PACK_VERSION } from '@seatgrab/content';
import { CORE_CONTENT, type GameConfig, type GameState } from '@seatgrab/engine';

import {
  LocalSnapshotError,
  createLocalMatch,
  createMemoryStore,
  deleteLocalMatch,
  importLocalMatch,
  listLocalMatches,
  readDocument,
  resumeLocalMatch,
  type LocalMatch,
  type LocalMatchOptions,
  type LocalSnapshotStore,
} from '../src/local';

function config(matchId: string): GameConfig {
  return {
    matchId,
    players: [
      { id: 'p1', displayName: 'Asha', partyId: 'purple' },
      { id: 'p2', displayName: 'Bikram', partyId: 'green' },
      { id: 'p3', displayName: 'Chandni', partyId: 'pink' },
    ],
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

/** A fixed clock keeps the saved-match order deterministic. */
function options(store: LocalSnapshotStore, startMs = Date.UTC(2026, 0, 1)): LocalMatchOptions {
  let tick = 0;
  return {
    store,
    content: CORE_CONTENT,
    now: () => new Date(startMs + tick++ * 1000),
  };
}

/**
 * Elect p2 first player, then take p2's starting resources.
 *
 * That leaves the match on the starting-resources interaction with p3 and p1 still to
 * choose, which is the pending interaction the resume tests compare.
 */
async function intoSetup(match: LocalMatch): Promise<void> {
  const votes: readonly [string, string][] = [['p1', 'p2'], ['p2', 'p1'], ['p3', 'p2']];
  for (const [voter, candidate] of votes) {
    const response = await match.submit(voter, { type: 'VoteForFirstPlayer', candidateId: candidate });
    expect(response.ok).toBe(true);
  }
  const response = await match.submit('p2', {
    type: 'ChooseStartingResources',
    resources: { cash: 1, influence: 0, press: 0, faith: 0 },
  });
  expect(response.ok).toBe(true);
}

describe('local snapshot lifecycle', () => {
  it('saves the opening revision and every accepted command', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-save'), 17);

    const created = await store.read('m-save');
    expect(created?.summary.revision).toBe(0);

    await intoSetup(match);

    const saved = await store.read('m-save');
    expect(saved?.summary.revision).toBe(match.revision());
    expect(match.revision()).toBe(4);
  });

  it('does not save a rejected command', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-reject'), 17);

    const response = await match.submit('p1', { type: 'VoteForFirstPlayer', candidateId: 'nobody' });
    expect(response.ok).toBe(false);
    expect(match.revision()).toBe(0);
    expect((await store.read('m-reject'))?.summary.revision).toBe(0);
  });

  it('lists saved matches newest first, with seats and revision', async () => {
    const store = createMemoryStore();
    const shared = options(store);
    await createLocalMatch(shared, config('m-older'), 5);
    const newer = await createLocalMatch(shared, config('m-newer'), 6);
    await intoSetup(newer);

    const listed = await listLocalMatches(store);
    expect(listed.map((summary) => summary.matchId)).toEqual(['m-newer', 'm-older']);
    const [first] = listed;
    expect(first?.revision).toBe(4);
    expect(first?.status).toBe('setup');
    expect(first?.players.map((player) => player.displayName)).toEqual(['Asha', 'Bikram', 'Chandni']);
    expect(first?.unreadableReason).toBeNull();
  });

  it('resumes the exact revision, pending interaction, deck order and random state', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-resume'), 23);
    await intoSetup(match);
    const before: GameState = match.state();

    const resumed = await resumeLocalMatch(options(store), 'm-resume');
    expect(resumed).not.toBeNull();
    const after = resumed?.state();

    expect(after).toEqual(before);
    expect(after?.revision).toBe(before.revision);
    expect(after?.pendingInteraction).toEqual(before.pendingInteraction);
    expect(after?.random).toEqual(before.random);
    expect(after?.voterDeck).toEqual(before.voterDeck);
    expect(after?.turn).toEqual(before.turn);
  });

  it('resumes into the same authorized view and accepts the next command', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-continue'), 23);
    await intoSetup(match);
    const before = match.viewFor({ kind: 'player', playerId: 'p3' });

    const resumed = await resumeLocalMatch(options(store), 'm-continue');
    const after = resumed?.viewFor({ kind: 'player', playerId: 'p3' });
    expect(after).toEqual(before);
    expect(after?.ok).toBe(true);

    const response = await resumed?.submit('p3', {
      type: 'ChooseStartingResources',
      resources: { cash: 0, influence: 1, press: 1, faith: 0 },
    });
    expect(response?.ok).toBe(true);
    expect((await store.read('m-continue'))?.summary.revision).toBe(5);
  });

  it('answers null for a match that was never saved', async () => {
    const store = createMemoryStore();
    expect(await resumeLocalMatch(options(store), 'm-absent')).toBeNull();
  });

  it('lists a save from an older build as unreadable, whatever its stored summary says', async () => {
    const store = createMemoryStore();
    const shared = options(store);
    await createLocalMatch(shared, config('m-was-readable'), 7);

    // What a build that shipped an earlier content pack would have written: a summary
    // that called itself readable, because it was readable then.
    const stored = await store.read('m-was-readable');
    if (stored === null) throw new Error('the fixture did not save');
    await store.write({
      ...stored,
      summary: { ...stored.summary, contentVersion: '0.8.0', unreadableReason: null },
    });

    const [listed] = await listLocalMatches(store);
    expect(listed?.unreadableReason).toContain('0.8.0');
    expect(listed?.unreadableReason).toContain(CONTENT_PACK_VERSION);
  });

  it('lists a save that does not record its versions as unreadable', async () => {
    const store = createMemoryStore();
    const shared = options(store);
    await createLocalMatch(shared, config('m-no-versions'), 8);
    const stored = await store.read('m-no-versions');
    if (stored === null) throw new Error('the fixture did not save');
    const { boardVersion: _dropped, ...withoutBoardVersion } = stored.summary;
    await store.write({
      ...stored,
      summary: { ...withoutBoardVersion, unreadableReason: null } as typeof stored.summary,
    });

    const [listed] = await listLocalMatches(store);
    expect(listed?.unreadableReason).toContain('save format this build cannot read');
    expect(listed?.unreadableReason).not.toContain('undefined');
  });

  it('deletes one match and leaves the others', async () => {
    const store = createMemoryStore();
    const shared = options(store);
    await createLocalMatch(shared, config('m-keep'), 5);
    await createLocalMatch(shared, config('m-drop'), 6);

    await deleteLocalMatch(store, 'm-drop');

    expect((await listLocalMatches(store)).map((summary) => summary.matchId)).toEqual(['m-keep']);
    expect(await resumeLocalMatch(shared, 'm-drop')).toBeNull();
  });
});

describe('export and import', () => {
  it('round-trips an exported document into the same state', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-export'), 31);
    await intoSetup(match);

    const imported = await importLocalMatch(options(createMemoryStore()), match.exportDocument());
    expect(imported.state()).toEqual(match.state());
  });

  it('rejects a document that is not a save', async () => {
    const shared = options(createMemoryStore());
    await expect(importLocalMatch(shared, 'not json at all')).rejects.toMatchObject({
      code: 'NOT_A_SNAPSHOT',
    });
    await expect(importLocalMatch(shared, '{"format":"other-game"}')).rejects.toMatchObject({
      code: 'NOT_A_SNAPSHOT',
    });
  });

  it('names the content pack when the document is from another one', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-stale-content'), 41);
    const stale = JSON.parse(match.exportDocument()) as Record<string, unknown>;
    stale['contentVersion'] = '0.0.1-older';

    const attempt = importLocalMatch(options(createMemoryStore()), JSON.stringify(stale));
    await expect(attempt).rejects.toBeInstanceOf(LocalSnapshotError);
    await expect(attempt).rejects.toMatchObject({ code: 'CONTENT_MISMATCH' });
    await expect(attempt).rejects.toThrow('0.0.1-older');
    await expect(attempt).rejects.toThrow(CONTENT_PACK_VERSION);
  });

  it('names the schema version when the document is from another schema', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-stale-schema'), 42);
    const stale = JSON.parse(match.exportDocument()) as Record<string, unknown>;
    stale['schemaVersion'] = 99;

    const attempt = importLocalMatch(options(createMemoryStore()), JSON.stringify(stale));
    await expect(attempt).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    await expect(attempt).rejects.toThrow('99');
  });

  it('names the board when the document is from another board version', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-stale-board'), 43);
    const stale = JSON.parse(match.exportDocument()) as Record<string, unknown>;
    stale['boardVersion'] = '0.1.0-older';

    const attempt = importLocalMatch(options(createMemoryStore()), JSON.stringify(stale));
    await expect(attempt).rejects.toMatchObject({ code: 'BOARD_MISMATCH' });
    await expect(attempt).rejects.toThrow('0.1.0-older');
  });

  it('rejects a document whose state fails the engine invariants', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-corrupt'), 44);
    const corrupt = JSON.parse(match.exportDocument()) as { state: { publicReserve: { cash: number } } };
    corrupt.state.publicReserve.cash += 5;

    await expect(
      importLocalMatch(options(createMemoryStore()), JSON.stringify(corrupt)),
    ).rejects.toMatchObject({ code: 'UNREADABLE_STATE' });
  });

  it('rejects a document whose header disagrees with the state inside it', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-header'), 45);
    const mismatched = JSON.parse(match.exportDocument()) as Record<string, unknown>;
    mismatched['revision'] = 7;

    await expect(
      importLocalMatch(options(createMemoryStore()), JSON.stringify(mismatched)),
    ).rejects.toMatchObject({ code: 'UNREADABLE_STATE' });
  });

  it('leaves the store untouched when an import is rejected', async () => {
    const store = createMemoryStore();
    const shared = options(store);
    await createLocalMatch(shared, config('m-only'), 46);
    const stale = JSON.parse((await store.read('m-only'))?.document ?? '{}') as Record<string, unknown>;
    stale['matchId'] = 'm-imported';
    stale['boardVersion'] = '0.0.0';

    await expect(importLocalMatch(shared, JSON.stringify(stale))).rejects.toBeInstanceOf(LocalSnapshotError);
    expect((await listLocalMatches(store)).map((summary) => summary.matchId)).toEqual(['m-only']);
  });
});

describe('unsupported prompts', () => {
  it('refuses to render a choice the view contract does not describe', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-unsupported'), 47);
    await intoSetup(match);

    // Only a hand-edited save can reach this state: the engine's own continuations are
    // typed against `ChoicePromptOp`, so an undescribed one does not compile.
    const edited = JSON.parse(match.exportDocument()) as {
      state: { pendingInteraction: Record<string, unknown> };
    };
    edited.state.pendingInteraction = {
      id: 'interaction-99',
      kind: 'choice',
      responsiblePlayerIds: ['p1'],
      explanation: 'A choice from a build this one does not know.',
      allowed: [],
      allowPass: false,
      continuation: { op: 'fromTheFuture', ownerId: 'p1' },
    };

    const loaded = await importLocalMatch(options(createMemoryStore()), JSON.stringify(edited));
    const result = loaded.viewFor({ kind: 'player', playerId: 'p1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNSUPPORTED_PROMPT');
      expect(result.message).toContain('interaction-99');
    }
  });
});

describe('the save document', () => {
  it('records the versions that decide whether a build can read it', async () => {
    const store = createMemoryStore();
    const match = await createLocalMatch(options(store), config('m-header-fields'), 48);
    const { envelope } = readDocument(match.exportDocument(), CORE_CONTENT);

    expect(envelope.contentVersion).toBe(CONTENT_PACK_VERSION);
    expect(envelope.schemaVersion).toBe(match.state().schemaVersion);
    expect(envelope.boardVersion).toBe(match.state().content.boardVersion);
    expect(envelope.matchId).toBe('m-header-fields');
    expect(Date.parse(envelope.savedAt)).not.toBeNaN();
  });
});
