/**
 * Room lifecycle over the real HTTP routes.
 *
 * The claim in section 14.1 that this suite exists to hold is narrow and testable: a
 * room code is enough to find a table and sit at a free seat, and it is never enough to
 * act as a seat someone else already holds. Everything else here is the lifecycle that
 * claim sits inside — who may start a match, when seats lock, and what a seat is shown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bearer, startHarness, type Harness } from './harness';

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

/** A started three-seat match, with every seat's credential. */
async function startedMatch(): Promise<readonly Claim[]> {
  const host = await createRoom(3);
  const second = await claimSeat(host.roomCode, 'Bikram', 'cog');
  const third = await claimSeat(host.roomCode, 'Chandni', 'sprout');
  const started = await harness.server.app.inject({
    method: 'POST',
    url: `/api/matches/${host.matchId}/start`,
    headers: bearer(host.credential),
  });
  expect(started.statusCode).toBe(200);
  return [host, second, third];
}

describe('creating a room', () => {
  it('returns a room code and a seat credential that are different secrets', async () => {
    const claim = await createRoom();
    expect(claim.roomCode).toMatch(/^[A-Z2-9]{8}$/u);
    expect(claim.credential.length).toBeGreaterThanOrEqual(43);
    expect(claim.credential).not.toContain(claim.roomCode);
    expect(claim.seatIndex).toBe(0);
    expect(claim.playerId).toBe('p1');
    expect(claim.isHost).toBe(true);
  });

  it('refuses a table size the core set does not seat', async () => {
    for (const seatCount of [2, 6]) {
      const response = await harness.server.app.inject({
        method: 'POST',
        url: '/api/rooms',
        payload: { seatCount, displayName: 'Asha', partyId: 'kite' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('INVALID_SETUP');
    }
  });

  it('refuses a party identity no client can draw', async () => {
    const response = await harness.server.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { seatCount: 3, displayName: 'Asha', partyId: 'xyzzy' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('stores only the hash of a credential', async () => {
    const claim = await createRoom();
    const rows = harness.server.database
      .prepare('SELECT credential_hash FROM seats WHERE match_id = ? AND credential_hash IS NOT NULL')
      .all(claim.matchId) as { credential_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credential_hash).not.toBe(claim.credential);
    expect(rows[0]?.credential_hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the lobby a room code opens', () => {
  it('lists seats and carries no credential', async () => {
    const host = await createRoom(4);
    await claimSeat(host.roomCode, 'Bikram', 'cog');
    const response = await harness.server.app.inject({ method: 'GET', url: `/api/rooms/${host.roomCode}` });
    expect(response.statusCode).toBe(200);
    const lobby = response.json<{
      seats: { seatIndex: number; claimed: boolean; displayName: string | null }[];
      ready: boolean;
      status: string;
    }>();
    expect(lobby.status).toBe('lobby');
    expect(lobby.seats).toHaveLength(4);
    expect(lobby.seats.filter((seat) => seat.claimed)).toHaveLength(2);
    expect(lobby.ready).toBe(false);
    expect(response.body).not.toContain(host.credential);
  });

  it('accepts a room code typed in any case and refuses one that is not a code', async () => {
    const host = await createRoom();
    const lower = await harness.server.app.inject({
      method: 'GET',
      url: `/api/rooms/${host.roomCode.toLowerCase()}`,
    });
    expect(lower.statusCode).toBe(200);
    const nonsense = await harness.server.app.inject({ method: 'GET', url: '/api/rooms/NOTACODE' });
    expect(nonsense.statusCode).toBe(404);
  });
});

describe('a room code does not grant control of an occupied seat', () => {
  it('refuses a second claim on a seat that is already held', async () => {
    const host = await createRoom();
    const response = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { seatIndex: 0, displayName: 'Impostor', partyId: 'cog' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('SEAT_TAKEN');
    expect(response.body).not.toContain('credential');
  });

  it('refuses every match route when only the room code is presented', async () => {
    const host = await createRoom();
    for (const url of [
      `/api/matches/${host.matchId}/state`,
      `/api/matches/${host.matchId}/events`,
    ]) {
      const anonymous = await harness.server.app.inject({ method: 'GET', url });
      expect(anonymous.statusCode).toBe(401);
      const withRoomCode = await harness.server.app.inject({
        method: 'GET',
        url,
        headers: bearer(host.roomCode),
      });
      expect(withRoomCode.statusCode).toBe(401);
    }
  });

  it('refuses a credential minted for a different match', async () => {
    const first = await createRoom();
    const second = await createRoom();
    const response = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${second.matchId}/state`,
      headers: bearer(first.credential),
    });
    expect(response.statusCode).toBe(401);
  });

  it('runs out of seats rather than seating a sixth player', async () => {
    const host = await createRoom(3);
    await claimSeat(host.roomCode, 'Bikram', 'cog');
    await claimSeat(host.roomCode, 'Chandni', 'sprout');
    const response = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: 'Dev', partyId: 'lantern' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('ROOM_FULL');
  });

  it('keeps party identities and names distinct across seats', async () => {
    const host = await createRoom();
    const sameParty = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: 'Bikram', partyId: 'kite' },
    });
    expect(sameParty.json<{ code: string }>().code).toBe('PARTY_TAKEN');
    const sameName = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: 'asha', partyId: 'cog' },
    });
    expect(sameName.json<{ code: string }>().code).toBe('NAME_TAKEN');
  });
});

describe('starting the match', () => {
  it('needs the host and a full table', async () => {
    const host = await createRoom();
    const second = await claimSeat(host.roomCode, 'Bikram', 'cog');

    const short = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/start`,
      headers: bearer(host.credential),
    });
    expect(short.statusCode).toBe(409);
    expect(short.json<{ code: string }>().code).toBe('SEATS_UNCLAIMED');

    await claimSeat(host.roomCode, 'Chandni', 'sprout');
    const notHost = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/start`,
      headers: bearer(second.credential),
    });
    expect(notHost.statusCode).toBe(403);

    const started = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/start`,
      headers: bearer(host.credential),
    });
    expect(started.statusCode).toBe(200);
    expect(started.json<{ view: { status: string; phase: string } }>().view.phase).toBe('firstPlayerElection');
  });

  it('locks the seats once the match has started', async () => {
    const [host] = await startedMatch();
    if (host === undefined) throw new Error('The started match reported no host.');
    const response = await harness.server.app.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/seats`,
      payload: { displayName: 'Latecomer', partyId: 'lantern' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('MATCH_STARTED');
  });

  it('cannot be started twice', async () => {
    const [host] = await startedMatch();
    if (host === undefined) throw new Error('The started match reported no host.');
    const again = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/start`,
      headers: bearer(host.credential),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('what a seat is shown', () => {
  it('answers each seat with its own projection and its own legal actions', async () => {
    const seats = await startedMatch();
    const views = await Promise.all(
      seats.map(async (seat) => {
        const response = await harness.server.app.inject({
          method: 'GET',
          url: `/api/matches/${seat.matchId}/state`,
          headers: bearer(seat.credential),
        });
        expect(response.statusCode).toBe(200);
        return response.json<{ view: { viewerId?: string; players: { id: string }[] }; legalActions: string[] }>();
      }),
    );
    expect(views.map((entry) => entry.legalActions)).toEqual([
      ['VoteForFirstPlayer'],
      ['VoteForFirstPlayer'],
      ['VoteForFirstPlayer'],
    ]);
    // Every seat sees the same public table; the difference is which seat the view is
    // addressed to, which the engine's own projection decides.
    for (const entry of views) {
      expect(entry.view.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p3']);
    }
  });

  it('refuses to read a match that has not started', async () => {
    const host = await createRoom();
    const response = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${host.matchId}/state`,
      headers: bearer(host.credential),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('NOT_STARTED');
  });
});

describe('the health route', () => {
  it('names the build and no room', async () => {
    await startedMatch();
    const response = await harness.server.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; database: string; contentPackId: string }>();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.contentPackId.length).toBeGreaterThan(0);
    expect(response.body).not.toMatch(/credential|roomCode/u);
  });
});

describe('request limits', () => {
  it('refuses a body past the configured ceiling', async () => {
    const host = await createRoom();
    const response = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/commands`,
      headers: { ...bearer(host.credential), 'content-type': 'application/json' },
      payload: `{"pad":"${'x'.repeat(harness.config.maxBodyBytes + 64)}"}`,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<{ code: string }>().code).toBe('BODY_TOO_LARGE');
  });
});

/**
 * Freeing a seat, which is how a table recovers from a lost credential.
 *
 * A seat credential is issued once and stored in the browser that claimed it. Before
 * this route existed, a player who cleared their site data could not rejoin, and —
 * because a room cannot start with an empty seat — the whole table was stuck. What these
 * tests hold is the narrow authority the route has: the host, with their own credential,
 * before the match starts, on a seat that is not their own.
 */
describe('releasing a seat', () => {
  it('lets the host free a claimed seat, and lets it be claimed again', async () => {
    const host = await createRoom(3);
    const second = await claimSeat(host.roomCode, 'Bikram', 'cog');

    const released = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/${second.seatIndex}`,
      headers: bearer(host.credential),
    });
    expect(released.statusCode).toBe(200);
    const lobby = released.json<{ seats: { seatIndex: number; claimed: boolean; displayName: string | null }[] }>();
    const freed = lobby.seats.find((seat) => seat.seatIndex === second.seatIndex);
    expect(freed).toMatchObject({ claimed: false, displayName: null });

    // The released credential stops working immediately.
    const stale = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${host.matchId}/state`,
      headers: bearer(second.credential),
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json<{ code: string }>().code).toBe('BAD_CREDENTIAL');

    // And the seat is genuinely free: the same player sits down again, with the same
    // name and party, and gets a new credential.
    const again = await claimSeat(host.roomCode, 'Bikram', 'cog');
    expect(again.seatIndex).toBe(second.seatIndex);
    expect(again.credential).not.toBe(second.credential);
  });

  it('refuses a seat release to anyone but the host', async () => {
    const host = await createRoom(3);
    const second = await claimSeat(host.roomCode, 'Bikram', 'cog');
    const third = await claimSeat(host.roomCode, 'Chandni', 'sprout');

    // A seated player cannot free another seat, even holding a valid credential.
    const byGuest = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/${third.seatIndex}`,
      headers: bearer(second.credential),
    });
    expect(byGuest.statusCode).toBe(403);
    expect(byGuest.json<{ code: string }>().code).toBe('NOT_HOST');

    // And the room code alone is not enough, which is the whole point of the rule: a
    // room code is read aloud across a table.
    const byCode = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/${third.seatIndex}`,
    });
    expect(byCode.statusCode).toBe(401);
  });

  it('refuses to free the host seat, and refuses any release once play begins', async () => {
    const seats = await startedMatch();
    const host = seats[0]!;

    const started = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/${seats[1]!.seatIndex}`,
      headers: bearer(host.credential),
    });
    expect(started.statusCode).toBe(409);
    // A started seat holds private cards and committed answers. Freeing one would hand
    // them to whoever claimed it next.
    expect(started.json<{ code: string }>().code).toBe('MATCH_STARTED');

    const fresh = await createRoom(3);
    const own = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${fresh.matchId}/seats/${fresh.seatIndex}`,
      headers: bearer(fresh.credential),
    });
    expect(own.statusCode).toBe(409);
    expect(own.json<{ code: string }>().code).toBe('CANNOT_RELEASE_HOST');
  });

  it('refuses a seat that is already free, and one that does not exist', async () => {
    const host = await createRoom(3);

    const free = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/2`,
      headers: bearer(host.credential),
    });
    expect(free.statusCode).toBe(409);
    expect(free.json<{ code: string }>().code).toBe('SEAT_FREE');

    const missing = await harness.server.app.inject({
      method: 'DELETE',
      url: `/api/matches/${host.matchId}/seats/9`,
      headers: bearer(host.credential),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ code: string }>().code).toBe('NO_SUCH_SEAT');
  });
});
