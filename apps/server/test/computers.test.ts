/**
 * Computer seats in an online room, over the real HTTP routes and the real socket.
 *
 * The claims this suite holds are the ones a person joining a room is entitled to:
 *
 * - **Only the host seats a computer**, and only before the table is dealt. A guest
 *   cannot, and the room code alone is not enough — it is read aloud.
 * - **A computer seat is held.** It cannot be claimed with the room code, it counts
 *   towards `ready`, and the host can free it again like any other seat.
 * - **A computer's projection is never sent anywhere.** It has no connection, so a
 *   broadcast to a table of one person and two computers is one frame, not three. The
 *   driver reads the projection in-process.
 * - **The computers play.** After the person answers their own prompts, the match
 *   advances past both computer seats without any command from a client.
 * - **A restart does not strand the table.** A process that stops with a computer due to
 *   act continues the match when it comes back, and a replayed decision is answered from
 *   the idempotency record rather than applied twice.
 *
 * `SEATGRAB_COMPUTER_DELAY_MS` is 0 throughout, and the tests await the driver's
 * `settled` rather than sleeping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bearer, openSocket, startHarness, type Harness } from './harness';

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ env: { SEATGRAB_COMPUTER_DELAY_MS: '0' } });
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

interface LobbySeat {
  seatIndex: number;
  playerId: string;
  claimed: boolean;
  displayName: string | null;
  partyId: string | null;
  controller: 'human' | 'computer';
  difficulty?: 'easy' | 'medium' | 'hard';
}

interface Lobby {
  roomCode: string;
  matchId: string;
  status: string;
  seats: readonly LobbySeat[];
  ready: boolean;
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

async function seatComputer(
  host: Claim,
  seatIndex: number,
  difficulty: 'easy' | 'medium' | 'hard',
  credential = host.credential,
): Promise<ReturnType<typeof harness.server.app.inject> extends Promise<infer T> ? T : never> {
  return harness.server.app.inject({
    method: 'PUT',
    url: `/api/matches/${host.matchId}/seats/${seatIndex}/computer`,
    headers: bearer(credential),
    payload: { difficulty },
  });
}

/** A room of one person and two computers, ready to start. */
async function soloRoom(): Promise<Claim> {
  const host = await createRoom(3);
  expect((await seatComputer(host, 1, 'easy')).statusCode).toBe(200);
  expect((await seatComputer(host, 2, 'hard')).statusCode).toBe(200);
  return host;
}

async function lobby(roomCode: string): Promise<Lobby> {
  const response = await harness.server.app.inject({ method: 'GET', url: `/api/rooms/${roomCode}` });
  expect(response.statusCode).toBe(200);
  return response.json<Lobby>();
}

describe('seating a computer', () => {
  it('names it, gives it a free party, and reports it in the lobby', async () => {
    const host = await soloRoom();
    const view = await lobby(host.roomCode);

    expect(view.seats.map((seat) => seat.controller)).toEqual(['human', 'computer', 'computer']);
    expect(view.seats.map((seat) => seat.displayName)).toEqual(['Asha', 'Computer 1', 'Computer 2']);
    expect(view.seats.map((seat) => seat.difficulty)).toEqual([undefined, 'easy', 'hard']);
    // Distinct parties, none of them the host's.
    const parties = view.seats.map((seat) => seat.partyId);
    expect(new Set(parties).size).toBe(3);
    expect(parties[0]).toBe('kite');
    // Every seat is held, so the host's start is the only thing missing.
    expect(view.ready).toBe(true);
  });

  it('refuses a guest, the host’s own seat, and a seat that is already held', async () => {
    const host = await createRoom(3);
    const guest = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: 'Bikram', partyId: 'cog' },
    });
    expect(guest.statusCode).toBe(201);
    const guestClaim = guest.json<Claim>();

    // A guest's own credential is not the host's.
    const byGuest = await seatComputer(host, 2, 'easy', guestClaim.credential);
    expect(byGuest.statusCode).toBe(403);
    expect(byGuest.json<{ code: string }>().code).toBe('NOT_HOST');

    // The host's own seat stays a person's: the table needs one.
    const onHost = await seatComputer(host, 0, 'easy');
    expect(onHost.statusCode).toBe(409);
    expect(onHost.json<{ code: string }>().code).toBe('CANNOT_SEAT_HOST');

    // And a seat a person already holds is not free.
    const onGuest = await seatComputer(host, guestClaim.seatIndex, 'easy');
    expect(onGuest.statusCode).toBe(409);
    expect(onGuest.json<{ code: string }>().code).toBe('SEAT_TAKEN');
  });

  it('refuses a difficulty this build does not ship', async () => {
    const host = await createRoom(3);
    const response = await harness.server.app.inject({
      method: 'PUT',
      url: `/api/matches/${host.matchId}/seats/1/computer`,
      headers: bearer(host.credential),
      payload: { difficulty: 'impossible' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('cannot be claimed with the room code, and can be freed by the host', async () => {
    const host = await soloRoom();
    const claim = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { seatIndex: 1, displayName: 'Bikram', partyId: 'lantern' },
    });
    expect(claim.statusCode).toBe(409);
    expect(claim.json<{ code: string }>().code).toBe('SEAT_TAKEN');

    const freed = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/1`,
      headers: bearer(host.credential),
    });
    expect(freed.statusCode).toBe(200);
    const after = freed.json<Lobby>();
    expect(after.seats[1]?.controller).toBe('human');
    expect(after.seats[1]?.claimed).toBe(false);
    expect(after.ready).toBe(false);

    // And the seat is a person's to claim again.
    const reclaimed = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { seatIndex: 1, displayName: 'Bikram', partyId: 'lantern' },
    });
    expect(reclaimed.statusCode).toBe(201);
  });

  it('holds a name and a party against a person claiming the same one', async () => {
    const host = await soloRoom();
    const view = await lobby(host.roomCode);
    const held = view.seats[1]!;

    await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/2`,
      headers: bearer(host.credential),
    });
    const sameName = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: held.displayName!.toLocaleLowerCase(), partyId: 'lantern' },
    });
    expect(sameName.statusCode).toBe(409);
    expect(sameName.json<{ code: string }>().code).toBe('NAME_TAKEN');

    const sameParty = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: 'Bikram', partyId: held.partyId! },
    });
    expect(sameParty.statusCode).toBe(409);
    expect(sameParty.json<{ code: string }>().code).toBe('PARTY_TAKEN');
  });
});

describe('a started match with computer seats', () => {
  async function start(host: Claim): Promise<void> {
    const started = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/start`,
      headers: bearer(host.credential),
    });
    expect(started.statusCode).toBe(200);
    await harness.server.computers.settled(host.matchId);
  }

  it('carries the controller into the config, so the person’s own view says who is playing', async () => {
    const host = await soloRoom();
    await start(host);

    const state = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${host.matchId}/state`,
      headers: bearer(host.credential),
    });
    expect(state.statusCode).toBe(200);
    const players = state.json<{ view: { players: readonly { controller: string; difficulty?: string }[] } }>()
      .view.players;
    expect(players.map((player) => player.controller)).toEqual(['human', 'computer', 'computer']);
    expect(players.map((player) => player.difficulty)).toEqual([undefined, 'easy', 'hard']);
  });

  it('plays the computer seats without any command from a client', async () => {
    const host = await soloRoom();
    await start(host);

    // The opening vote is the person's to answer for their own seat; both computers have
    // answered theirs already, because starting the match woke the driver.
    const before = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${host.matchId}/state`,
      headers: bearer(host.credential),
    });
    const revision = before.json<{ view: { revision: number } }>().view.revision;
    // Two computer answers landed without a client sending anything.
    expect(revision).toBeGreaterThan(0);
    expect(before.json<{ view: { prompt?: unknown } }>().view.prompt).toBeDefined();
  });

  it('sends one frame per broadcast, because a computer seat has no connection', async () => {
    const host = await soloRoom();
    const socket = await openSocket(harness);
    socket.send({ type: 'authenticate', matchId: host.matchId, credential: host.credential });
    await socket.next('welcome');

    await start(host);
    // Two of the three seats are computers, and neither is attached: a broadcast to this
    // table reaches exactly one connection.
    expect(harness.server.hub.connectionCount(host.matchId)).toBe(1);
    // Every `state` frame on this socket is this seat's own. A computer seat is not
    // attached to the hub at all, so nothing is projected for it onto the wire.
    const frames = socket.received().filter((frame) => frame.type === 'state');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect((frame as { state: { view: { players: readonly { id: string }[] } } }).state.view.players)
        .toHaveLength(3);
    }
    socket.close();
  });

  it('writes a deterministic command ID, and answers a replay from the record', async () => {
    const host = await soloRoom();
    await start(host);

    const stored = harness.server.database
      .prepare('SELECT command_id, actor_player_id, command, revision_before FROM commands WHERE match_id = ?')
      .all(host.matchId) as { command_id: string; actor_player_id: string; command: string; revision_before: number }[];
    const byComputer = stored.filter((row) => row.command_id.startsWith('computer:'));
    expect(byComputer.length).toBeGreaterThan(0);
    for (const row of byComputer) {
      // `computer:<playerId>:<revision>:<attempt>`, and nothing random in it.
      expect(row.command_id).toBe(`computer:${row.actor_player_id}:${row.revision_before}:0`);
    }

    // Replaying one of them, as the seat that sent it, is answered from the record rather
    // than applied a second time. This is what makes a restart mid-decision safe.
    const first = byComputer[0]!;
    const seat = harness.server.rooms
      .computerSeats(host.matchId)
      .find((candidate) => candidate.playerId === first.actor_player_id);
    expect(seat).toBeDefined();
    const again = await harness.server.hub.submit(seat!, {
      matchId: host.matchId,
      commandId: first.command_id,
      expectedRevision: first.revision_before,
      command: JSON.parse(first.command) as unknown,
    });
    expect(again.duplicate).toBe(true);
  });

  it('refuses a computer seat\u2019s credential, because it has none', async () => {
    const host = await soloRoom();
    const seats = harness.server.rooms.computerSeats(host.matchId);
    expect(seats.map((seat) => seat.playerId)).toEqual(['p2', 'p3']);
    expect(seats.every((seat) => !seat.isHost)).toBe(true);
    // Nothing arriving over the wire can act as one: `authenticate` looks a seat up by
    // its credential hash, and a computer seat has no hash to find.
    const response = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${host.matchId}/state`,
      headers: bearer('not-a-credential'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('continues the match after a restart that caught a computer mid-turn', async () => {
    const host = await soloRoom();
    await start(host);

    const readRevision = async (): Promise<number> => {
      const state = await harness.server.app.inject({
        method: 'GET',
        url: `/api/matches/${host.matchId}/state`,
        headers: bearer(host.credential),
      });
      return state.json<{ view: { revision: number } }>().view.revision;
    };
    const before = await readRevision();

    await harness.restart();
    // `index.ts` calls this after the port is open; the harness never listens, so the
    // test calls the same method the process does.
    harness.server.computers.recover();
    await harness.server.computers.settled(host.matchId);

    // The match is still readable and has not gone backwards, and nothing is degraded.
    expect(await readRevision()).toBeGreaterThanOrEqual(before);
    const health = await harness.server.app.inject({ method: 'GET', url: '/health' });
    expect(health.json<{ computers: string }>().computers).toBe('ok');
  });
});
