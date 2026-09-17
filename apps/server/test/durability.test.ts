/**
 * What survives a restart, and what a repeated command ID does.
 *
 * These are the two exit criteria of the first server session, and both are about the
 * same transaction. Section 14.3 requires an accepted command, its new snapshot and its
 * events to be durable together before the command is acknowledged; section 14.4
 * requires a duplicate submission to be idempotent. The suite drives the real routes
 * against a real file and then closes and reopens the process, because a restart is the
 * thing worth proving and an in-memory database cannot prove it.
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
  credential: string;
}

interface StateBody {
  view: {
    revision: number;
    status: string;
    phase: string;
    pendingDecision?: { kind: string; responsiblePlayerIds: readonly string[] };
  };
  legalActions: readonly string[];
  eventCursor: number;
}

async function seatedMatch(): Promise<readonly Claim[]> {
  const host = (
    await harness.server.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { seatCount: 3, displayName: 'Asha', partyId: 'kite' },
    })
  ).json<Claim>();
  const seats = [host];
  for (const [displayName, partyId] of [['Bikram', 'cog'], ['Chandni', 'sprout']] as const) {
    seats.push(
      (
        await harness.server.app.inject({
          method: 'POST',
          url: `/api/rooms/${host.roomCode}/seats`,
          payload: { displayName, partyId },
        })
      ).json<Claim>(),
    );
  }
  const started = await harness.server.app.inject({
    method: 'POST',
    url: `/api/matches/${host.matchId}/start`,
    headers: bearer(host.credential),
  });
  expect(started.statusCode).toBe(200);
  return seats;
}

async function readState(seat: Claim): Promise<StateBody> {
  const response = await harness.server.app.inject({
    method: 'GET',
    url: `/api/matches/${seat.matchId}/state`,
    headers: bearer(seat.credential),
  });
  expect(response.statusCode).toBe(200);
  return response.json<StateBody>();
}

interface SubmitBody {
  ok: boolean;
  revision: number;
  code?: string;
  duplicate: boolean;
  events?: readonly { id: string; type: string }[];
}

async function submit(
  seat: Claim,
  commandId: string,
  expectedRevision: number,
  command: Record<string, unknown>,
): Promise<SubmitBody> {
  const response = await harness.server.app.inject({
    method: 'POST',
    url: `/api/matches/${seat.matchId}/commands`,
    headers: bearer(seat.credential),
    payload: { matchId: seat.matchId, commandId, expectedRevision, command },
  });
  expect(response.statusCode).toBe(200);
  return response.json<SubmitBody>();
}

/** Elect p2 first player, leaving the match on the starting-resources interaction. */
async function electFirstPlayer(seats: readonly Claim[]): Promise<number> {
  const ballots: readonly [number, string][] = [[0, 'p2'], [1, 'p1'], [2, 'p2']];
  let revision = (await readState(seats[0] as Claim)).view.revision;
  for (const [index, candidateId] of ballots) {
    const seat = seats[index];
    if (seat === undefined) throw new Error(`The table has no seat ${index}.`);
    const result = await submit(seat, `vote-${index}`, revision, {
      type: 'VoteForFirstPlayer',
      candidateId,
    });
    expect(result.ok).toBe(true);
    revision = result.revision;
  }
  return revision;
}

describe('a restart resumes the same match', () => {
  it('restores the same snapshot, revision and pending choice', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    await electFirstPlayer(seats);

    const before = await readState(first);
    expect(before.view.status).toBe('setup');
    expect(before.view.pendingDecision?.kind).toBe('startingResources');
    const snapshotBefore = (
      await harness.server.database.get('SELECT snapshot FROM matches WHERE match_id = ?', [first.matchId]) as { snapshot: string }
    ).snapshot;

    await harness.restart();

    const after = await readState(first);
    expect(after.view.revision).toBe(before.view.revision);
    expect(after.view.status).toBe(before.view.status);
    expect(after.view.phase).toBe(before.view.phase);
    expect(after.view.pendingDecision).toEqual(before.view.pendingDecision);
    expect(after.legalActions).toEqual(before.legalActions);
    const snapshotAfter = (
      await harness.server.database.get('SELECT snapshot FROM matches WHERE match_id = ?', [first.matchId]) as { snapshot: string }
    ).snapshot;
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it('accepts the next command against the restored revision', async () => {
    const seats = await seatedMatch();
    const revision = await electFirstPlayer(seats);
    await harness.restart();

    // p2 was elected first player, so it sits at order index 0 and takes exactly one
    // resource. The engine, not this test, decides that count.
    const second = seats[1] as Claim;
    const chosen = await submit(second, 'resources-p2', revision, {
      type: 'ChooseStartingResources',
      resources: { cash: 1, influence: 0, press: 0, faith: 0 },
    });
    expect(chosen.ok).toBe(true);
    expect(chosen.revision).toBe(revision + 1);
  });

  it('keeps the credentials it issued before the restart', async () => {
    const seats = await seatedMatch();
    await harness.restart();
    const response = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${(seats[2] as Claim).matchId}/state`,
      headers: bearer((seats[2] as Claim).credential),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('a repeated command ID', () => {
  it('returns the prior result without applying twice', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    const opening = await readState(first);

    const once = await submit(first, 'ballot-1', opening.view.revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(once.ok).toBe(true);
    expect(once.duplicate).toBe(false);

    const again = await submit(first, 'ballot-1', opening.view.revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(again.duplicate).toBe(true);
    expect(again.ok).toBe(true);
    expect(again.revision).toBe(once.revision);
    expect(again.events).toEqual(once.events);

    // The proof that it was not applied twice: one revision step, and one row each in
    // the command log and the ballot the engine recorded.
    expect((await readState(first)).view.revision).toBe(once.revision);
    const rows = await harness.server.database.get('SELECT COUNT(*) AS total FROM commands WHERE match_id = ? AND command_id = ?', [first.matchId, 'ballot-1']) as { total: number };
    expect(rows.total).toBe(1);
  });

  it('replays a refusal rather than adjudicating the same intent twice', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    const opening = await readState(first);

    const stale = await submit(first, 'stale-1', opening.view.revision + 5, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('STALE_REVISION');

    const replayed = await submit(first, 'stale-1', opening.view.revision + 5, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(replayed.duplicate).toBe(true);
    expect(replayed.code).toBe('STALE_REVISION');
    expect((await readState(first)).view.revision).toBe(opening.view.revision);
  });

  it('survives a restart, so a retry after a crash is still idempotent', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    const opening = await readState(first);
    const once = await submit(first, 'ballot-1', opening.view.revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });

    await harness.restart();

    const again = await submit(first, 'ballot-1', opening.view.revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(again.duplicate).toBe(true);
    expect(again.revision).toBe(once.revision);
  });

  it('refuses a command ID another seat already used', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    const second = seats[1] as Claim;
    const opening = await readState(first);
    await submit(first, 'shared-id', opening.view.revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    const response = await harness.server.app.inject({
      method: 'POST',
      url: `/api/matches/${second.matchId}/commands`,
      headers: bearer(second.credential),
      payload: {
        matchId: second.matchId,
        commandId: 'shared-id',
        expectedRevision: opening.view.revision + 1,
        command: { type: 'VoteForFirstPlayer', candidateId: 'p1' },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('COMMAND_ID_REUSED');
  });
});

describe('a command is applied for the seat that sent it', () => {
  it('cannot be sent on another seat’s behalf', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    const second = seats[1] as Claim;
    const opening = await readState(first);

    // p2's credential, p1's ballot slot. The engine attributes the command to the
    // authenticated seat, so this records p2's vote, never p1's.
    const result = await submit(second, 'by-p2', opening.view.revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p3',
    });
    expect(result.ok).toBe(true);
    const row = await harness.server.database.get('SELECT actor_player_id FROM commands WHERE match_id = ? AND command_id = ?', [first.matchId, 'by-p2']) as { actor_player_id: string };
    expect(row.actor_player_id).toBe('p2');

    // p1 has not voted, so its ballot is still open.
    expect((await readState(first)).legalActions).toEqual(['VoteForFirstPlayer']);
  });
});

describe('the stored event log', () => {
  it('is written in the same transaction as the snapshot', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    await electFirstPlayer(seats);

    const match = await harness.server.database.get('SELECT revision FROM matches WHERE match_id = ?', [first.matchId]) as { revision: number };
    const highest = await harness.server.database.get('SELECT MAX(revision) AS revision FROM events WHERE match_id = ?', [first.matchId]) as { revision: number };
    expect(highest.revision).toBe(match.revision);
  });

  it('answers a catch-up read with only what the seat may see', async () => {
    const seats = await seatedMatch();
    const first = seats[0] as Claim;
    await electFirstPlayer(seats);

    const response = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${first.matchId}/events?since=0`,
      headers: bearer(first.credential),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: { id: string; message: string }[]; cursor: number }>();
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.cursor).toBeGreaterThanOrEqual(body.events.length);

    // No stored event reaches a seat carrying the engine's server-only visibility.
    const serverOnly = await harness.server.database.all("SELECT event_id FROM events WHERE match_id = ? AND visibility = 'server'", [first.matchId]) as { event_id: string }[];
    for (const hidden of serverOnly) {
      expect(body.events.some((event) => event.id === hidden.event_id)).toBe(false);
    }

    const later = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${first.matchId}/events?since=${body.cursor}`,
      headers: bearer(first.credential),
    });
    expect(later.json<{ events: unknown[] }>().events).toEqual([]);
  });
});
