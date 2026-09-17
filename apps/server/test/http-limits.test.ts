/**
 * The per-address budget in front of the HTTP routes.
 *
 * Before this existed, `POST /api/rooms` was an unbounded room-creation endpoint and
 * `POST /api/matches/:id/commands` an unbounded command endpoint for anyone holding a
 * credential: the frame budget added in Session 14 counts frames on a socket, and
 * neither of those arrives on one. The server binds to loopback by default, which is
 * what stood between that and the open internet.
 *
 * What these tests hold is the shape of the limit rather than its numbers, which are
 * configuration: `/api` is counted, `/health` is not, an exhausted budget answers 429
 * with a code a client can read, and the budget refills.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bearer, startHarness, type Harness } from './harness';

let harness: Harness;

afterEach(async () => {
  await harness.dispose();
});

/** A server whose whole budget is `burst` requests, so a test can exhaust it. */
async function limitedHarness(burst: number, perSecond = 1): Promise<Harness> {
  harness = await startHarness({
    env: {
      GERRYMANDER_HTTP_BURST_REQUESTS: String(burst),
      GERRYMANDER_HTTP_REQUESTS_PER_SECOND: String(perSecond),
    },
  });
  return harness;
}

function createRoom() {
  return harness.server.app.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { seatCount: 3, displayName: 'Asha', partyId: 'kite' },
  });
}

describe('the HTTP request budget', () => {
  it('refuses room creation past the burst, naming the reason', async () => {
    await limitedHarness(3);

    const allowed = [await createRoom(), await createRoom(), await createRoom()];
    for (const response of allowed) expect(response.statusCode).toBe(201);

    const refused = await createRoom();
    expect(refused.statusCode).toBe(429);
    const body = refused.json<{ ok: boolean; code: string; message: string }>();
    expect(body).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    // The message is read by a player, so it has to say what to do about it.
    expect(body.message).toContain('Wait a moment');
  });

  it('leaves /health outside the budget', async () => {
    await limitedHarness(1);

    expect((await createRoom()).statusCode).toBe(201);
    expect((await createRoom()).statusCode).toBe(429);

    // A monitor polls health on a schedule. A health check that starts failing because
    // the server is busy reports the opposite of what it is for.
    for (let poll = 0; poll < 5; poll += 1) {
      const health = await harness.server.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json<{ status: string }>().status).toBe('ok');
    }
  });

  it('counts a command endpoint too, and refuses it without applying the command', async () => {
    // Four requests: create the room, claim two seats, start. The fifth is a command.
    await limitedHarness(4);
    const host = (await createRoom()).json<{ matchId: string; roomCode: string; credential: string }>();
    for (const name of [['Bikram', 'cog'], ['Chandni', 'sprout']] as const) {
      const claim = await harness.server.app.inject({
        method: 'POST',
        url: `/api/rooms/${host.roomCode}/seats`,
        payload: { displayName: name[0], partyId: name[1] },
      });
      expect(claim.statusCode).toBe(201);
    }
    const started = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/start`,
      headers: bearer(host.credential),
    });
    expect(started.statusCode).toBe(200);

    const seat = await harness.server.rooms.authenticate(host.matchId, host.credential);
    const before = (await harness.server.rooms.viewFor(seat)).view.revision;

    const refused = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${host.matchId}/commands`,
      headers: bearer(host.credential),
      payload: {
        matchId: host.matchId,
        commandId: 'over-budget',
        expectedRevision: before,
        command: { type: 'VoteForFirstPlayer', candidateId: 'seat-2' },
      },
    });
    expect(refused.statusCode).toBe(429);

    // The command must not have been applied on the way to being refused: the budget is
    // spent before the route runs, so nothing reached the hub.
    expect((await harness.server.rooms.viewFor(seat)).view.revision).toBe(before);
  });

  it('refills, so a table that waits can carry on', async () => {
    // One request per burst, refilling at ten a second: the second request is refused
    // and one that arrives a moment later is not.
    await limitedHarness(1, 10);

    expect((await createRoom()).statusCode).toBe(201);
    expect((await createRoom()).statusCode).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await createRoom()).statusCode).toBe(201);
  });
});
