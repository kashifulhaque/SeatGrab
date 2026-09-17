/**
 * Everything the online screens decide, and the two modules they decide it with.
 *
 * `remote-match.test.ts` proves what the adapter does with a connection. This file is the
 * layer above it: the room client that opens and reads a room, the store that keeps the
 * one credential the server will ever issue for a seat, and the model the host, join and
 * room screens draw from. None of it needs a DOM, which is the point of keeping it out of
 * React in the first place.
 *
 * The rules being pinned here are the ones that are easy to lose later:
 *
 * - A credential is written before a screen moves, and a store that cannot write says so
 *   rather than pretending. Losing one is unrecoverable, so this is correctness.
 * - A refusal the server wrote is carried through unchanged; a request that never reached
 *   the server is a different thing and says so.
 * - The four connection states are all distinguishable, and `rejected` offers no retry.
 */
import { describe, expect, it } from 'vitest';

import { PARTY_IDENTITIES } from '../src/assets/parties';
import {
  RoomRequestError,
  claimSeat,
  createRoom,
  foldRoomCode,
  openSeatStore,
  readLobby,
  startMatch,
  storedSeatFrom,
  type LobbyView,
  type SeatStorage,
} from '../src/remote';
import {
  defaultHostDraft,
  defaultJoinDraft,
  describeConnection,
  describeLobbyFill,
  describeSubmit,
  describeUnheard,
  freeParties,
  freeSeats,
  hostStartState,
  lobbySeatRows,
  problemsFor,
  validateHostDraft,
  validateJoinDraft,
} from '../src/app/online';
import { ROUTES, onlineRouteFrom } from '../src/app/routes';

const [KITE, COG, SPROUT] = PARTY_IDENTITIES;
if (KITE === undefined || COG === undefined || SPROUT === undefined) {
  throw new Error('This edition ships fewer than three party identities.');
}

/** A lobby as `GET /api/rooms/:roomCode` answers, with `claimed` seats filled in. */
function lobbyOf(claims: readonly (null | { name: string; partyId: string })[]): LobbyView {
  return {
    roomCode: 'ABCD2345',
    matchId: 'match-1',
    status: 'lobby',
    seatCount: claims.length,
    contentAdvisories: [],
    seats: claims.map((claim, seatIndex) => ({
      seatIndex,
      playerId: `p${seatIndex + 1}`,
      isHost: seatIndex === 0,
      claimed: claim !== null,
      displayName: claim?.name ?? null,
      partyId: claim?.partyId ?? null,
      controller: 'human' as const,
    })),
    ready: claims.every((claim) => claim !== null),
    contentPackId: 'core-set',
    contentVersion: '1.0.0',
    boardId: 'other-nine-zone',
    boardVersion: '1.0.0',
  };
}

/** A storage that records what was written, or refuses on demand. */
function memoryStorage(options: { failWrites?: boolean; failReads?: boolean } = {}): SeatStorage {
  const held = new Map<string, string>();
  return {
    getItem(key) {
      if (options.failReads === true) throw new Error('Storage is blocked in this browser.');
      return held.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.failWrites === true) throw new Error('The storage quota is exhausted.');
      held.set(key, value);
    },
    removeItem(key) {
      held.delete(key);
    },
  };
}

/** A `fetch` that records its calls and answers from a script. */
function fakeFetch(
  answer: (url: string, init: RequestInit) => { status: number; body: unknown } | Error,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const call: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const next = answer(url, init);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { call, calls };
}

const CLAIM = {
  matchId: 'match-1',
  roomCode: 'ABCD2345',
  seatIndex: 0,
  playerId: 'p1',
  isHost: true,
  credential: 'a-very-secret-token',
};

describe('the room code a player types', () => {
  it('forgives case, spacing and dashes, and repairs nothing else', () => {
    expect(foldRoomCode('  abcd-2345 ')).toBe('ABCD2345');
    expect(foldRoomCode('AB CD 23 45')).toBe('ABCD2345');
    // Not a code this server would mint, and deliberately not corrected into one: what a
    // room code is, is the server's ruling and is decided in exactly one place.
    expect(foldRoomCode('oops!')).toBe('OOPS!');
    expect(foldRoomCode('   ')).toBe('');
  });
});

describe('the room client', () => {
  it('opens a room and returns the one credential the server will ever issue', async () => {
    const { call, calls } = fakeFetch(() => ({ status: 201, body: CLAIM }));
    const claim = await createRoom(
      { fetch: call },
      { seatCount: 3, displayName: 'Asha', partyId: KITE.partyId, contentAdvisories: ['trigger'] },
    );

    expect(claim.credential).toBe('a-very-secret-token');
    const [sent] = calls;
    expect(sent?.url).toBe('/api/rooms');
    expect(JSON.parse(String(sent?.init.body))).toEqual({
      seatCount: 3,
      displayName: 'Asha',
      partyId: KITE.partyId,
      contentAdvisories: ['trigger'],
    });
  });

  it('folds a typed room code into the path it reads and claims on', async () => {
    const { call, calls } = fakeFetch((url) =>
      url.endsWith('/seats') ? { status: 201, body: CLAIM } : { status: 200, body: lobbyOf([null]) });

    await readLobby({ fetch: call }, ' abcd-2345 ');
    await claimSeat({ fetch: call }, { roomCode: 'abcd 2345', displayName: 'Bela', partyId: COG.partyId });

    expect(calls.map((entry) => entry.url)).toEqual([
      '/api/rooms/ABCD2345',
      '/api/rooms/ABCD2345/seats',
    ]);
  });

  it('leaves the seat index out when any free seat will do, and sends it when one is chosen', async () => {
    const { call, calls } = fakeFetch(() => ({ status: 201, body: CLAIM }));
    await claimSeat({ fetch: call }, { roomCode: 'ABCD2345', displayName: 'A', partyId: COG.partyId });
    await claimSeat(
      { fetch: call },
      { roomCode: 'ABCD2345', displayName: 'B', partyId: SPROUT.partyId, seatIndex: 2 },
    );

    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('seatIndex');
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ seatIndex: 2 });
  });

  it('carries the seat credential as a bearer header and never in the URL', async () => {
    const { call, calls } = fakeFetch(() => ({
      status: 200,
      body: { view: {}, legalActions: [], eventCursor: 0, promptProblem: null },
    }));
    await startMatch({ fetch: call }, { matchId: 'match-1', credential: 'a-very-secret-token' });

    const [sent] = calls;
    expect(sent?.url).toBe('/api/matches/match-1/start');
    expect(sent?.url).not.toContain('a-very-secret-token');
    expect((sent?.init.headers as Record<string, string>).authorization)
      .toBe('Bearer a-very-secret-token');
  });

  it('carries the server’s own refusal through unchanged', async () => {
    const { call } = fakeFetch(() => ({
      status: 409,
      body: { ok: false, code: 'PARTY_TAKEN', message: 'Another seat already holds the cog identity.' },
    }));

    const failure = await claimSeat(
      { fetch: call },
      { roomCode: 'ABCD2345', displayName: 'Bela', partyId: COG.partyId },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RoomRequestError);
    const error = failure as RoomRequestError;
    expect(error.code).toBe('PARTY_TAKEN');
    expect(error.message).toBe('Another seat already holds the cog identity.');
    expect(error.status).toBe(409);
    // A ruling about the room, not a broken request: the server was reached and answered.
    expect(error.unreached).toBe(false);
  });

  it('tells a server that refused apart from a server that was never reached', async () => {
    const { call } = fakeFetch(() => new TypeError('Failed to fetch'));
    const failure = (await readLobby({ fetch: call }, 'ABCD2345').catch(
      (error: unknown) => error,
    )) as RoomRequestError;

    expect(failure.unreached).toBe(true);
    expect(failure.code).toBe('UNREACHABLE');
    expect(failure.message).toContain('Nothing was sent to the table.');
  });

  it('refuses a claim it cannot read rather than saving half a credential', async () => {
    const { call } = fakeFetch(() => ({ status: 201, body: { matchId: 'match-1' } }));
    const failure = (await createRoom(
      { fetch: call },
      { seatCount: 3, displayName: 'Asha', partyId: KITE.partyId, contentAdvisories: [] },
    ).catch((error: unknown) => error)) as RoomRequestError;

    expect(failure.code).toBe('UNREADABLE_CLAIM');
  });

  it('sends every request to the named server when one is given', async () => {
    const { call, calls } = fakeFetch(() => ({ status: 200, body: lobbyOf([null]) }));
    await readLobby({ fetch: call, serverUrl: 'https://rooms.example/' }, 'ABCD2345');
    expect(calls[0]?.url).toBe('https://rooms.example/api/rooms/ABCD2345');
  });
});

describe('the seat credential store', () => {
  it('keeps a claim, finds it by match, and forgets it for good', () => {
    const seats = openSeatStore(memoryStorage());
    seats.save(storedSeatFrom(CLAIM, { displayName: 'Asha', partyId: KITE.partyId }, new Date()));

    const held = seats.read('match-1');
    expect(held?.credential).toBe('a-very-secret-token');
    expect(held?.displayName).toBe('Asha');
    expect(seats.list()).toHaveLength(1);

    seats.forget('match-1');
    expect(seats.read('match-1')).toBeNull();
    expect(seats.list()).toHaveLength(0);
  });

  it('replaces an earlier claim on the same match rather than keeping both', () => {
    const seats = openSeatStore(memoryStorage());
    seats.save(storedSeatFrom(CLAIM, { displayName: 'Asha', partyId: KITE.partyId }, new Date()));
    seats.save(
      storedSeatFrom(
        { ...CLAIM, credential: 'a-newer-token' },
        { displayName: 'Asha', partyId: KITE.partyId },
        new Date(),
      ),
    );

    expect(seats.list()).toHaveLength(1);
    expect(seats.read('match-1')?.credential).toBe('a-newer-token');
  });

  it('lists the most recently claimed seat first', () => {
    const seats = openSeatStore(memoryStorage());
    seats.save(storedSeatFrom(
      { ...CLAIM, matchId: 'older' },
      { displayName: 'Asha', partyId: KITE.partyId },
      new Date('2026-01-01T00:00:00.000Z'),
    ));
    seats.save(storedSeatFrom(
      { ...CLAIM, matchId: 'newer' },
      { displayName: 'Bela', partyId: COG.partyId },
      new Date('2026-02-01T00:00:00.000Z'),
    ));

    expect(seats.list().map((seat) => seat.matchId)).toEqual(['newer', 'older']);
  });

  it('reports a browser that will not keep a credential instead of throwing on one', () => {
    const blocked = openSeatStore(memoryStorage({ failReads: true }));
    expect(blocked.list()).toEqual([]);
    expect(blocked.available).toBe(false);
    expect(blocked.unavailableReason).toContain('refused to read');

    const noStorage = openSeatStore(null);
    expect(noStorage.available).toBe(false);
    expect(noStorage.read('match-1')).toBeNull();
  });

  it('reports a write that did not happen, so a screen never claims a seat it lost', () => {
    const seats = openSeatStore(memoryStorage({ failWrites: true }));
    expect(seats.available).toBe(true);
    seats.save(storedSeatFrom(CLAIM, { displayName: 'Asha', partyId: KITE.partyId }, new Date()));
    expect(seats.available).toBe(false);
    expect(seats.unavailableReason).toContain('refused to write');
  });

  it('drops a stored record it cannot use rather than repairing one', () => {
    const storage = memoryStorage();
    storage.setItem('gerrymander.online.seats.v1', JSON.stringify([{ matchId: 'match-1' }, 'nonsense']));
    expect(openSeatStore(storage).list()).toEqual([]);

    const unparseable = memoryStorage();
    unparseable.setItem('gerrymander.online.seats.v1', '{not json');
    expect(openSeatStore(unparseable).list()).toEqual([]);
  });
});

describe('hosting a room', () => {
  it('opens on the smallest legal table and asks for the one thing it cannot guess', () => {
    const draft = defaultHostDraft();
    expect(draft.seatCount).toBe(3);
    expect(problemsFor(validateHostDraft(draft), 'displayName')).toHaveLength(1);
    expect(validateHostDraft({ ...draft, displayName: 'Asha' })).toEqual([]);
  });

  it('refuses a table this edition does not seat', () => {
    const draft = { ...defaultHostDraft(), displayName: 'Asha' };
    expect(problemsFor(validateHostDraft({ ...draft, seatCount: 2 }), 'seatCount')).toHaveLength(1);
    expect(problemsFor(validateHostDraft({ ...draft, seatCount: 6 }), 'seatCount')).toHaveLength(1);
    expect(validateHostDraft({ ...draft, seatCount: 5 })).toEqual([]);
  });

  it('refuses a party no server would seat', () => {
    const draft = { ...defaultHostDraft(), displayName: 'Asha', partyId: 'tiger' };
    expect(problemsFor(validateHostDraft(draft), 'partyId')).toHaveLength(1);
  });
});

describe('joining a room', () => {
  const filled = lobbyOf([{ name: 'Asha', partyId: KITE.partyId }, null, null]);

  it('asks for a room code before it asks for anything else', () => {
    const problems = validateJoinDraft(defaultJoinDraft(), null);
    expect(problemsFor(problems, 'roomCode')).toHaveLength(1);
    expect(problemsFor(validateJoinDraft(defaultJoinDraft('abcd 2345'), null), 'roomCode')).toEqual([]);
  });

  it('refuses a party a claimed seat already holds, naming who holds it', () => {
    const draft = { ...defaultJoinDraft('ABCD2345'), displayName: 'Bela', partyId: KITE.partyId };
    const [problem] = problemsFor(validateJoinDraft(draft, filled), 'partyId');
    expect(problem?.message).toContain('Asha');
    expect(validateJoinDraft({ ...draft, partyId: COG.partyId }, filled)).toEqual([]);
  });

  it('refuses a seat somebody is already in, and accepts a free one', () => {
    const draft = {
      ...defaultJoinDraft('ABCD2345'),
      displayName: 'Bela',
      partyId: COG.partyId,
      seatIndex: 0,
    };
    expect(problemsFor(validateJoinDraft(draft, filled), 'seatIndex')).toHaveLength(1);
    expect(validateJoinDraft({ ...draft, seatIndex: 1 }, filled)).toEqual([]);
  });

  it('refuses a room with no seat left, and a match that has already started', () => {
    const full = lobbyOf([
      { name: 'Asha', partyId: KITE.partyId },
      { name: 'Bela', partyId: COG.partyId },
      { name: 'Chandra', partyId: SPROUT.partyId },
    ]);
    const draft = { ...defaultJoinDraft('ABCD2345'), displayName: 'Dev', partyId: 'lantern' };
    expect(problemsFor(validateJoinDraft(draft, full), 'seatIndex')).toHaveLength(1);

    const started = { ...full, status: 'active' as const };
    expect(problemsFor(validateJoinDraft(draft, started), 'roomCode')).toHaveLength(1);
  });

  it('says nothing about the table until the table has answered', () => {
    // Before a lookup there is no lobby, so only the seat's own fields are judged: the
    // server is the authority for whether a party or a seat is free, and two players
    // pressing Join at once is precisely the case no client can settle.
    const draft = { ...defaultJoinDraft('ABCD2345'), displayName: 'Bela', partyId: KITE.partyId };
    expect(validateJoinDraft(draft, null)).toEqual([]);
  });
});

/**
 * Freeing a seat, as the lobby roster offers it.
 *
 * The server decides every one of these rules and refuses anything else; this mirrors
 * them so a host is not offered a button that will certainly be refused. The reason a
 * release exists at all is a hole a real table reaches: a seat credential is issued once,
 * to one browser, and a player who clears their site data cannot rejoin — which, since a
 * room cannot start with an empty seat, strands the whole table.
 */
describe('offering to free a seat', () => {
  const full = lobbyOf([
    { name: 'Asha', partyId: KITE.partyId },
    { name: 'Bela', partyId: COG.partyId },
    { name: 'Chandra', partyId: SPROUT.partyId },
  ]);

  it('offers it to the host, for every seat but their own', () => {
    const rows = lobbySeatRows(full, { seatIndex: 0, isHost: true });
    expect(rows[0]?.release).toEqual({ can: false });
    expect(rows[1]?.release).toEqual({ can: true });
    expect(rows[2]?.release).toEqual({ can: true });
  });

  it('offers it to nobody else, and says nothing to them about it', () => {
    // A guest is not told why they cannot free a seat, because they were never offered
    // it: the row is an ordinary row, and a note there would be an answer to a question
    // nobody asked.
    for (const row of lobbySeatRows(full, { seatIndex: 1, isHost: false })) {
      expect(row.release).toEqual({ can: false });
    }
  });

  it('never offers a free seat, which has nothing to give up', () => {
    const partial = lobbyOf([{ name: 'Asha', partyId: KITE.partyId }, null, null]);
    const rows = lobbySeatRows(partial, { seatIndex: 0, isHost: true });
    expect(rows[1]?.release).toEqual({ can: false });
    expect(rows[2]?.release).toEqual({ can: false });
  });

  it('withdraws it once the table is dealt, and says why', () => {
    const dealt: LobbyView = { ...full, status: 'active' };
    const rows = lobbySeatRows(dealt, { seatIndex: 0, isHost: true });
    expect(rows[1]?.release.can).toBe(false);
    // A seat holds private cards and committed answers once play begins, so freeing one
    // would hand them to whoever claimed it next.
    expect(rows[1]?.release.reason).toContain('private cards');
  });
});

describe('reading an online lobby', () => {
  const lobby = lobbyOf([{ name: 'Asha', partyId: KITE.partyId }, null, null]);

  it('draws every seat in clockwise order, free ones included', () => {
    const rows = lobbySeatRows(lobby, { seatIndex: 0 });
    expect(rows.map((row) => row.seatIndex)).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({ label: 'Asha', isHost: true, isMine: true, claimed: true });
    expect(rows[1]).toMatchObject({ label: 'Waiting for a player', claimed: false, isMine: false });
    expect(rows[0]?.party?.partyId).toBe(KITE.partyId);
    expect(rows[1]?.party).toBeNull();
  });

  it('marks no seat as mine when this browser holds none', () => {
    expect(lobbySeatRows(lobby, null).some((row) => row.isMine)).toBe(false);
  });

  it('offers the seats and the parties that are actually free', () => {
    expect(freeSeats(lobby).map((seat) => seat.seatIndex)).toEqual([1, 2]);
    expect(freeParties(lobby).map((party) => party.partyId)).not.toContain(KITE.partyId);
    expect(freeParties(null)).toEqual(PARTY_IDENTITIES);
  });

  it('says how many the room is still waiting for', () => {
    expect(describeLobbyFill(lobby)).toContain('Waiting for 2 more players');
    expect(describeLobbyFill(lobbyOf([{ name: 'A', partyId: KITE.partyId }, null])))
      .toContain('Waiting for 1 more player to join');
    expect(describeLobbyFill(lobbyOf([
      { name: 'A', partyId: KITE.partyId },
      { name: 'B', partyId: COG.partyId },
      { name: 'C', partyId: SPROUT.partyId },
    ]))).toBe('All 3 seats are taken.');
  });
});

describe('who may deal the table', () => {
  const host = storedSeatFrom(CLAIM, { displayName: 'Asha', partyId: KITE.partyId }, new Date());
  const guest = storedSeatFrom(
    { ...CLAIM, seatIndex: 1, playerId: 'p2', isHost: false },
    { displayName: 'Bela', partyId: COG.partyId },
    new Date(),
  );
  const full = lobbyOf([
    { name: 'Asha', partyId: KITE.partyId },
    { name: 'Bela', partyId: COG.partyId },
    { name: 'Chandra', partyId: SPROUT.partyId },
  ]);

  it('lets the host start a full room', () => {
    expect(hostStartState(full, host)).toMatchObject({ canStart: true });
  });

  it('refuses a seat that is not the host, and names who is', () => {
    const state = hostStartState(full, guest);
    expect(state.canStart).toBe(false);
    expect(state.reason).toContain('Asha');
  });

  it('refuses a room with a seat still empty, and says why it cannot wait', () => {
    const waiting = lobbyOf([{ name: 'Asha', partyId: KITE.partyId }, null, null]);
    const state = hostStartState(waiting, host);
    expect(state.canStart).toBe(false);
    expect(state.reason).toContain('claimed');
  });

  it('refuses a browser that holds no seat, and a match already started', () => {
    expect(hostStartState(full, null).canStart).toBe(false);
    expect(hostStartState({ ...full, status: 'active' }, host).canStart).toBe(false);
  });
});

describe('the connection banner', () => {
  const states = [
    describeConnection({ kind: 'connecting', attempt: 1 }),
    describeConnection({ kind: 'synchronized', since: 0 }),
    describeConnection({ kind: 'reconnecting', attempt: 2, retryInMs: 500, reason: 'The connection closed (1006).' }),
    describeConnection({ kind: 'disconnected', reason: 'This client closed the connection.' }),
    describeConnection({ kind: 'rejected', code: 'BAD_CREDENTIAL', message: 'That credential does not hold a seat here.' }),
  ];

  it('gives every state its own heading and its own tone', () => {
    expect(new Set(states.map((state) => state.news)).size).toBe(states.length);
    // Four states, four tones: `connecting` and `reconnecting` are the same work and read
    // the same, which is why they are told apart by their headings rather than by colour.
    expect(new Set(states.map((state) => state.tone)).size).toBe(4);
  });

  it('says the table is current only when it is', () => {
    expect(states.map((state) => state.stale)).toEqual([true, false, true, true, true]);
  });

  it('carries the reason a connection was lost through to the player', () => {
    const reconnecting = describeConnection({
      kind: 'reconnecting',
      attempt: 3,
      retryInMs: 2000,
      reason: 'The server closed this connection as unauthorized.',
    });
    expect(reconnecting.detail).toContain('The server closed this connection as unauthorized.');
    expect(reconnecting.detail).toContain('2s');
    expect(reconnecting.offerRetry).toBe(true);
  });

  it('offers no retry once the seat is refused, and offers the room code instead', () => {
    const rejected = states[4];
    expect(rejected?.offerRetry).toBe(false);
    expect(rejected?.offerRoomCode).toBe(true);
    expect(rejected?.detail).toContain('never reissued');
    // Since Session 16 there is a way back before the deal, and the wording says so: the
    // host frees the seat and it is claimed again with the room code.
    expect(rejected?.detail).toContain('free your seat');
    // Nothing else sends a player back to the room code: the other four are recoverable.
    expect(states.filter((state) => state.offerRoomCode)).toHaveLength(1);
  });
});

describe('what came of a command', () => {
  it('shows the engine’s ruling exactly as the engine wrote it', () => {
    const said = describeSubmit({
      ok: false,
      code: 'INSUFFICIENT_RESOURCES',
      message: 'You cannot pay 3 cash; you hold 1.',
      revision: 7,
    });
    expect(said).toEqual({ kind: 'ruling', message: 'You cannot pay 3 cash; you hold 1.' });
  });

  it('says nothing at all about an accepted command', () => {
    expect(describeSubmit({ ok: true, revision: 8, events: [] })).toEqual({ kind: 'accepted' });
  });

  it('keeps a silence apart from a refusal, and does not tell a player to resend', () => {
    const unheard = describeUnheard(new Error('The server has not answered this command.'));
    expect(unheard.kind).toBe('unheard');
    expect(unheard.message).toContain('The table did not hear that.');
  });
});

describe('the online routes', () => {
  it('reads every screen of the family, and nothing outside it', () => {
    expect(onlineRouteFrom('/online')).toEqual({ kind: 'home' });
    expect(onlineRouteFrom('/online/new')).toEqual({ kind: 'host' });
    expect(onlineRouteFrom('/online/join')).toEqual({ kind: 'join', roomCode: '' });
    expect(onlineRouteFrom('/online/join/ABCD2345')).toEqual({ kind: 'join', roomCode: 'ABCD2345' });
    expect(onlineRouteFrom('/online/room/match-1')).toEqual({ kind: 'room', matchId: 'match-1' });

    expect(onlineRouteFrom('/')).toBeNull();
    expect(onlineRouteFrom('/match/local-1')).toBeNull();
    expect(onlineRouteFrom('/onlineish')).toBeNull();
  });

  it('lands an unknown address in the family on its home rather than on nothing', () => {
    expect(onlineRouteFrom('/online/elsewhere')).toEqual({ kind: 'home' });
    expect(onlineRouteFrom('/online/room/')).toEqual({ kind: 'home' });
  });

  it('builds the routes it parses, escaping what a path segment would otherwise eat', () => {
    expect(onlineRouteFrom(ROUTES.onlineRoom('match-1')))
      .toEqual({ kind: 'room', matchId: 'match-1' });
    expect(onlineRouteFrom(ROUTES.onlineJoin('ABCD2345')))
      .toEqual({ kind: 'join', roomCode: 'ABCD2345' });
    expect(ROUTES.onlineJoin()).toBe('/online/join');
    expect(onlineRouteFrom(ROUTES.onlineRoom('a/b c')))
      .toEqual({ kind: 'room', matchId: 'a/b c' });
  });
});
