/**
 * The WebSocket transport, over the real route.
 *
 * Three claims this suite exists to hold, all of them from section 14:
 *
 * 1. **Two seats on two connections are told different things.** Every frame that
 *    carries a projection carries one seat's, produced by `projectGame` for that seat.
 *    There is no shared broadcast, so there is nothing for a seat to read that was
 *    computed for somebody else.
 * 2. **Commands serialize per match.** Two clients acting on the same revision are
 *    decided one after the other: the first changes the match, and the second is told
 *    the revision moved rather than being applied to a state it never saw.
 * 3. **A disconnection loses nothing.** A pending decision is in the stored state, not
 *    in a connection, so it survives both a dropped socket and a server restart, and a
 *    reconnecting client is given a fresh authorized projection rather than being asked
 *    for its own.
 *
 * The connection refusals — origin, frame size, frame rate, the authentication deadline
 * — are here too, because each of them has to be unreachable rather than merely unused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResponse, SeatView } from '@gerrymander/protocol';

import { bearer, openSocket, startHarness, type Harness, type TestSocket } from './harness';

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

interface Claim {
  matchId: string;
  roomCode: string;
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  credential: string;
}

async function createRoom(seatCount = 3): Promise<Claim> {
  const response = await harness.server.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { seatCount, displayName: 'Asha', partyId: 'kite' },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Claim>();
}

async function claimSeat(roomCode: string, displayName: string, partyId: string): Promise<Claim> {
  const response = await harness.server.app.inject({
    method: 'POST',
    url: `/api/rooms/${roomCode}/seats`,
    payload: { displayName, partyId },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Claim>();
}

/** A three-seat room with every seat claimed, and no match started yet. */
async function seatedRoom(): Promise<readonly Claim[]> {
  const host = await createRoom(3);
  const second = await claimSeat(host.roomCode, 'Bikram', 'cog');
  const third = await claimSeat(host.roomCode, 'Chandni', 'sprout');
  return [host, second, third];
}

async function startMatch(host: Claim): Promise<void> {
  const started = await harness.server.app.inject({
    method: 'POST',
    url: `/api/matches/${host.matchId}/start`,
    headers: bearer(host.credential),
  });
  expect(started.statusCode).toBe(200);
}

async function seatedMatch(): Promise<readonly Claim[]> {
  const seats = await seatedRoom();
  await startMatch(seats[0] as Claim);
  return seats;
}

async function readState(seat: Claim): Promise<SeatView> {
  const response = await harness.server.app.inject({
    method: 'GET',
    url: `/api/matches/${seat.matchId}/state`,
    headers: bearer(seat.credential),
  });
  expect(response.statusCode).toBe(200);
  return response.json<SeatView>();
}

/** Open a connection and take a seat, returning the socket and its welcome. */
async function connect(
  seat: Claim,
  sinceEventCursor?: number,
): Promise<{ socket: TestSocket; welcome: Extract<
  Awaited<ReturnType<TestSocket['next']>>, { type: 'welcome' }
> }> {
  const socket = await openSocket(harness);
  socket.send({
    type: 'authenticate',
    matchId: seat.matchId,
    credential: seat.credential,
    ...(sinceEventCursor === undefined ? {} : { sinceEventCursor }),
  });
  const welcome = await socket.next('welcome');
  return { socket, welcome };
}

let nextCommandId = 0;

/** Submit over the socket and wait for this request's own answer. */
async function submit(
  socket: TestSocket,
  seat: Claim,
  expectedRevision: number,
  command: Record<string, unknown>,
  commandId = `socket-${(nextCommandId += 1)}`,
): Promise<{ response: CommandResponse; duplicate: boolean }> {
  const requestId = `req-${commandId}`;
  socket.send({
    type: 'submit',
    requestId,
    envelope: { matchId: seat.matchId, commandId, expectedRevision, command },
  });
  const result = await socket.next('commandResult');
  expect(result.requestId).toBe(requestId);
  return { response: result.response, duplicate: result.duplicate };
}

/**
 * Drive a started match to the first policy answer.
 *
 * That is the first point where the seats genuinely differ: exactly one of them is
 * holding a drawn Policy Card, and the other two have nothing to do. The engine
 * decides the election and the resource counts; this only sends what it asks for.
 */
async function reachPolicyAnswer(seats: readonly Claim[]): Promise<void> {
  const app = harness.server.app;
  const send = async (
    seat: Claim,
    commandId: string,
    expectedRevision: number,
    command: Record<string, unknown>,
  ): Promise<CommandResponse & { duplicate: boolean }> => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/matches/${seat.matchId}/commands`,
      headers: bearer(seat.credential),
      payload: { matchId: seat.matchId, commandId, expectedRevision, command },
    });
    return response.json<CommandResponse & { duplicate: boolean }>();
  };

  let revision = (await readState(seats[0] as Claim)).view.revision;
  for (const [index, candidateId] of [[0, 'p2'], [1, 'p1'], [2, 'p2']] as [number, string][]) {
    const seat = seats[index] as Claim;
    const result = await send(seat, `vote-${index}`, revision, {
      type: 'VoteForFirstPlayer',
      candidateId,
    });
    expect(result.ok).toBe(true);
    revision = result.revision;
  }

  // Turn order decides how many resources each seat takes, so the count is read off the
  // engine's refusal rather than assumed here.
  for (let step = 0; step < seats.length; step += 1) {
    const table = await readState(seats[0] as Claim);
    const responsible = table.view.pendingDecision?.responsiblePlayerIds[0];
    const seat = seats.find((claim) => claim.playerId === responsible);
    if (seat === undefined) throw new Error(`No seat holds ${String(responsible)}.`);
    for (const cash of [1, 2, 3, 4, 5]) {
      const result = await send(seat, `resources-${seat.playerId}-${cash}`, table.view.revision, {
        type: 'ChooseStartingResources',
        resources: { cash, influence: 0, press: 0, faith: 0 },
      });
      if (result.ok) break;
      expect(result.code).toBe('INVALID_TARGET_SET');
    }
  }

  const reached = await readState(seats[0] as Claim);
  expect(reached.view.phase).toBe('policyAnswer');
}

describe('the upgrade', () => {
  it('refuses an origin the operator did not list', async () => {
    await expect(openSocket(harness, { origin: 'https://not-this.example' })).rejects.toThrow(
      /403/u,
    );
  });

  it('accepts a request that carries no origin, because it is not a browser', async () => {
    const socket = await openSocket(harness, { origin: null });
    socket.send({ type: 'ping', requestId: 'p1' });
    expect((await socket.next('pong')).requestId).toBe('p1');
    socket.close();
  });

  it('accepts an origin an operator added', async () => {
    await harness.dispose();
    harness = await startHarness({ env: { GERRYMANDER_ALLOWED_ORIGINS: 'https://gerrymander.example' } });
    await expect(openSocket(harness, { origin: 'http://localhost:5173' })).rejects.toThrow(/403/u);
    const socket = await openSocket(harness, { origin: 'https://gerrymander.example' });
    socket.send({ type: 'ping' });
    await socket.next('pong');
    socket.close();
  });
});

describe('an unauthenticated connection', () => {
  it('may ping and nothing else', async () => {
    const seats = await seatedMatch();
    const socket = await openSocket(harness);
    socket.send({
      type: 'submit',
      requestId: 'r1',
      envelope: {
        matchId: (seats[0] as Claim).matchId,
        commandId: 'c1',
        expectedRevision: 0,
        command: { type: 'RequestEndTurn' },
      },
    });
    const refusal = await socket.next('error');
    expect(refusal.code).toBe('NOT_AUTHENTICATED');
    expect(refusal.requestId).toBe('r1');
    socket.close();
  });

  it('is closed when it never presents a credential', async () => {
    await harness.dispose();
    harness = await startHarness({ env: { GERRYMANDER_SOCKET_AUTH_TIMEOUT_SECONDS: '1' } });
    const socket = await openSocket(harness);
    expect((await socket.next('error', 3000)).code).toBe('AUTHENTICATION_TIMEOUT');
    expect((await socket.closed(3000)).code).toBe(4408);
  });

  it('is closed when the credential holds no seat in the match it names', async () => {
    const seats = await seatedMatch();
    const socket = await openSocket(harness);
    socket.send({
      type: 'authenticate',
      matchId: (seats[0] as Claim).matchId,
      credential: 'not-a-credential',
    });
    expect((await socket.next('error')).code).toBe('BAD_CREDENTIAL');
    expect((await socket.closed()).code).toBe(4401);
  });

  it('does not accept a room code in place of a seat credential', async () => {
    const seats = await seatedMatch();
    const host = seats[0] as Claim;
    const socket = await openSocket(harness);
    socket.send({ type: 'authenticate', matchId: host.matchId, credential: host.roomCode });
    expect((await socket.next('error')).code).toBe('BAD_CREDENTIAL');
  });
});

describe('two seats on two connections', () => {
  it('are welcomed with distinct authorized projections', async () => {
    const seats = await seatedMatch();
    await reachPolicyAnswer(seats);

    const answering = seats.find((seat) => seat.playerId === 'p2') as Claim;
    const waiting = seats.find((seat) => seat.playerId === 'p1') as Claim;

    const first = await connect(answering);
    const second = await connect(waiting);

    const mine = first.welcome.sync.state;
    const theirs = second.welcome.sync.state;
    if (mine === null || theirs === null) throw new Error('Both seats should have a state.');

    // The same match, at the same revision, projected twice.
    expect(mine.view.matchId).toBe(theirs.view.matchId);
    expect(mine.view.revision).toBe(theirs.view.revision);

    // The seat being asked holds the drawn card's question. The other is not told there
    // is a question, let alone what it says, and has nothing it may legally do.
    expect(mine.view.prompt?.kind).toBe('policyAnswer');
    expect(mine.legalActions).toContain('CommitPolicyAnswer');
    expect(theirs.view.prompt).toBeUndefined();
    expect(theirs.legalActions).toEqual([]);

    // Both are told, publicly, who the match is waiting on. That is what everyone at a
    // physical table can see; the card in that player's hand is not.
    expect(mine.view.pendingDecision?.responsiblePlayerIds).toEqual(['p2']);
    expect(theirs.view.pendingDecision?.responsiblePlayerIds).toEqual(['p2']);
    expect(JSON.stringify(theirs)).not.toContain('SHOULD');

    first.socket.close();
    second.socket.close();
  });

  it('are each sent their own projection when the other acts', async () => {
    const seats = await seatedMatch();
    const first = await connect(seats[0] as Claim);
    const second = await connect(seats[1] as Claim);
    const third = await connect(seats[2] as Claim);

    const opening = (first.welcome.sync.state as SeatView).view.revision;
    const result = await submit(first.socket, seats[0] as Claim, opening, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(result.response.ok).toBe(true);

    // Every attached seat is told, including the one that acted, and each is told in a
    // frame projected for itself: the view inside carries that seat's own player ID.
    for (const [seat, socket] of [
      [seats[0] as Claim, first.socket],
      [seats[1] as Claim, second.socket],
      [seats[2] as Claim, third.socket],
    ] as const) {
      const broadcast = await socket.next('state');
      expect(broadcast.state.view.revision).toBe(opening + 1);
      expect(broadcast.state.view.players.some((player) => player.id === seat.playerId)).toBe(true);
      expect(broadcast.state.legalActions).toEqual(
        (await readState(seat)).legalActions,
      );
    }

    first.socket.close();
    second.socket.close();
    third.socket.close();
  });

  it('is not told anything by a refused command', async () => {
    const seats = await seatedMatch();
    const first = await connect(seats[0] as Claim);
    const second = await connect(seats[1] as Claim);
    const opening = (first.welcome.sync.state as SeatView).view.revision;

    const refused = await submit(first.socket, seats[0] as Claim, opening, {
      type: 'VoteForFirstPlayer',
      candidateId: 'nobody',
    });
    expect(refused.response.ok).toBe(false);

    // Nothing changed, so nothing is announced. A `state` frame here would be a
    // repaint that says a refusal moved the match.
    await expect(second.socket.next('state', 150)).rejects.toThrow(/Waited/u);
    first.socket.close();
    second.socket.close();
  });
});

describe('commands competing for one revision', () => {
  it('serialize: one is applied and the other is told the revision moved', async () => {
    const seats = await seatedMatch();
    const first = await connect(seats[0] as Claim);
    const second = await connect(seats[1] as Claim);
    const opening = (first.welcome.sync.state as SeatView).view.revision;

    // Both frames are put on the wire before either answer is read, so the server, not
    // the test, decides the order. Whatever that order is, exactly one may be applied.
    const both = await Promise.all([
      submit(first.socket, seats[0] as Claim, opening, {
        type: 'VoteForFirstPlayer',
        candidateId: 'p2',
      }, 'race-a'),
      submit(second.socket, seats[1] as Claim, opening, {
        type: 'VoteForFirstPlayer',
        candidateId: 'p3',
      }, 'race-b'),
    ] as const);

    const accepted = both.filter((result) => result.response.ok);
    const refused = both.filter((result) => !result.response.ok);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const failure = refused[0]?.response;
    if (failure === undefined || failure.ok) throw new Error('One command had to be refused.');
    expect(failure.code).toBe('STALE_REVISION');
    // The refusal names the revision to read from, which is the one the winner produced.
    expect(failure.revision).toBe(opening + 1);

    // One ballot was recorded, not two.
    expect((await readState(seats[0] as Claim)).view.revision).toBe(opening + 1);
    first.socket.close();
    second.socket.close();
  });

  it('serialize across transports, so an HTTP command and a socket command cannot collide', async () => {
    const seats = await seatedMatch();
    const first = await connect(seats[0] as Claim);
    const opening = (first.welcome.sync.state as SeatView).view.revision;

    const overSocket = submit(first.socket, seats[0] as Claim, opening, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    }, 'mixed-socket');
    const overHttp = harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${(seats[1] as Claim).matchId}/commands`,
      headers: bearer((seats[1] as Claim).credential),
      payload: {
        matchId: (seats[1] as Claim).matchId,
        commandId: 'mixed-http',
        expectedRevision: opening,
        command: { type: 'VoteForFirstPlayer', candidateId: 'p3' },
      },
    });
    const [socketResult, httpResponse] = await Promise.all([overSocket, overHttp]);
    const httpResult = httpResponse.json<CommandResponse>();

    expect([socketResult.response.ok, httpResult.ok].filter(Boolean)).toHaveLength(1);
    expect((await readState(seats[0] as Claim)).view.revision).toBe(opening + 1);
    first.socket.close();
  });
});

describe('reconnecting', () => {
  it('is given a fresh projection and the same filtered catch-up the HTTP route gives', async () => {
    const seats = await seatedMatch();
    const host = seats[0] as Claim;
    const first = await connect(host);
    const opening = (first.welcome.sync.state as SeatView).view.revision;

    await submit(first.socket, host, opening, { type: 'VoteForFirstPlayer', candidateId: 'p2' });
    first.socket.close();

    // From the beginning, the socket's catch-up is the events route's answer, filtered
    // by the same `projectEvents` call. Neither transport decides visibility itself, so
    // there is nothing for them to disagree about.
    const fromScratch = await connect(host, 0);
    const overHttp = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${host.matchId}/events?since=0`,
      headers: bearer(host.credential),
    });
    const httpCatchUp = overHttp.json<{ events: unknown[]; cursor: number }>();
    expect(fromScratch.welcome.sync.events).toEqual(httpCatchUp.events);
    expect(fromScratch.welcome.sync.cursor).toBe(httpCatchUp.cursor);

    // The projection is the current one, not the one this client last held.
    const state = fromScratch.welcome.sync.state as SeatView;
    expect(state.view.revision).toBe(opening + 1);

    // Asking again from the cursor just given replays nothing.
    fromScratch.socket.send({
      type: 'resync',
      requestId: 's1',
      sinceEventCursor: fromScratch.welcome.sync.cursor,
    });
    const resynced = await fromScratch.socket.next('sync');
    expect(resynced.requestId).toBe('s1');
    expect(resynced.sync.events).toEqual([]);
    expect((resynced.sync.state as SeatView).view.revision).toBe(opening + 1);
    fromScratch.socket.close();
  });

  it('keeps the pending decision through a disconnection and a server restart', async () => {
    const seats = await seatedMatch();
    await reachPolicyAnswer(seats);

    const answering = seats.find((seat) => seat.playerId === 'p2') as Claim;
    const before = await connect(answering);
    const pendingBefore = (before.welcome.sync.state as SeatView).view.pendingDecision;
    expect(pendingBefore?.kind).toBe('policyAnswer');
    before.socket.close();

    await harness.restart();

    const after = await connect(answering);
    const state = after.welcome.sync.state as SeatView;
    // The same interaction, not a restarted one: the identifier is what proves it.
    expect(state.view.pendingDecision).toEqual(pendingBefore);
    expect(state.view.prompt?.interactionId).toBe(pendingBefore?.interactionId);
    expect(state.legalActions).toContain('CommitPolicyAnswer');

    // And it can still be answered, on the connection that came back.
    const answered = await submit(after.socket, answering, state.view.revision, {
      type: 'CommitPolicyAnswer',
      answerIndex: 0,
    });
    expect(answered.response.ok).toBe(true);
    after.socket.close();
  });

  it('replays the stored answer when a lost command is sent again', async () => {
    const seats = await seatedMatch();
    const first = await connect(seats[0] as Claim);
    const opening = (first.welcome.sync.state as SeatView).view.revision;

    const once = await submit(first.socket, seats[0] as Claim, opening, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    }, 'lost-answer');
    expect(once.duplicate).toBe(false);
    first.socket.close();

    const again = await connect(seats[0] as Claim);
    const replayed = await submit(again.socket, seats[0] as Claim, opening, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    }, 'lost-answer');
    expect(replayed.duplicate).toBe(true);
    expect(replayed.response).toEqual(once.response);
    expect((await readState(seats[0] as Claim)).view.revision).toBe(opening + 1);
    again.socket.close();
  });

  it('is told when the host starts a match it joined as a lobby', async () => {
    const seats = await seatedRoom();
    const watcher = await connect(seats[1] as Claim);
    expect(watcher.welcome.sync.state).toBeNull();

    await startMatch(seats[0] as Claim);

    const started = await watcher.socket.next('state');
    expect(started.state.view.status).toBe('setup');
    expect(started.state.legalActions).toContain('VoteForFirstPlayer');
    watcher.socket.close();
  });
});

describe('frame limits', () => {
  it('refuses a frame this server does not read, without closing the connection', async () => {
    const seats = await seatedMatch();
    const { socket } = await connect(seats[0] as Claim);
    socket.send({ type: 'nonsense' });
    expect((await socket.next('error')).code).toBe('BAD_FRAME');

    socket.send({ type: 'ping', requestId: 'still-here' });
    expect((await socket.next('pong')).requestId).toBe('still-here');
    socket.close();
  });

  it('closes a connection that sends something other than JSON', async () => {
    const seats = await seatedMatch();
    const { socket } = await connect(seats[0] as Claim);
    socket.sendRaw('not json at all');
    expect((await socket.next('error')).code).toBe('BAD_FRAME');
    expect((await socket.closed()).code).toBe(4400);
  });

  it('refuses frames arriving faster than the seat’s budget', async () => {
    await harness.dispose();
    harness = await startHarness({
      env: { GERRYMANDER_SOCKET_BURST_FRAMES: '3', GERRYMANDER_SOCKET_FRAMES_PER_SECOND: '1' },
    });
    const seats = await seatedMatch();
    const { socket } = await connect(seats[0] as Claim);

    // The welcome spent one token; three more pings exhaust the rest of the budget.
    for (let index = 0; index < 4; index += 1) socket.send({ type: 'ping', requestId: `p${index}` });
    const refusal = await socket.next('error');
    expect(refusal.code).toBe('RATE_LIMITED');

    // Refused, not disconnected: the seat is still holding its place.
    socket.send({ type: 'ping', requestId: 'later' });
    const answer = await Promise.race([
      socket.next('pong').then(() => 'pong' as const),
      socket.next('error').then(() => 'error' as const),
    ]);
    expect(['pong', 'error']).toContain(answer);
    socket.close();
  });

  it('closes a connection that sends a frame over the size ceiling', async () => {
    await harness.dispose();
    harness = await startHarness({ env: { GERRYMANDER_MAX_BODY_BYTES: '2048' } });
    const seats = await seatedMatch();
    const { socket } = await connect(seats[0] as Claim);
    socket.send({ type: 'ping', requestId: 'x'.repeat(4096) });
    // `ws` refuses an oversized frame itself, with the protocol's own 1009, so the frame
    // never reaches a handler at all.
    expect((await socket.closed()).code).toBe(1009);
  });
});

describe('a seat credential presented on the upgrade', () => {
  it('takes the seat without a frame, for a client that is not a browser', async () => {
    const seats = await seatedMatch();
    const host = seats[0] as Claim;
    const socket = await openSocket(harness, {
      origin: null,
      headers: { authorization: `Bearer ${host.credential}` },
      query: `matchId=${host.matchId}`,
    });
    const welcome = await socket.next('welcome');
    expect(welcome.seat.playerId).toBe('p1');
    expect(welcome.seat.isHost).toBe(true);
    expect(JSON.stringify(welcome)).not.toContain(host.credential);
    socket.close();
  });
});
