/**
 * The window between checkpoints.
 *
 * The store used to hold every accepted command before that command was acknowledged.
 * It does not any more: the authority is `MatchStore`, in memory, and Cloudflare D1 holds
 * a checkpoint of it written every `GERRYMANDER_CHECKPOINT_EVERY_COMMANDS` commands or
 * `GERRYMANDER_CHECKPOINT_MAX_DELAY_MS` after the first unwritten change. That trade is
 * what keeps a turn off the network, and this suite is what says exactly what it costs.
 *
 * Three things have to be true for the trade to be worth making, and each is a test here:
 * a player must never see the lag, a clean stop must lose nothing, and the loss from an
 * unclean stop must be bounded by the setting rather than open-ended.
 *
 * Every other server suite runs with the bound at 1, which is write-through and is what
 * those suites were written to prove. This one sets it deliberately.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bearer, startHarness, type Harness } from './harness';

let harness: Harness;

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
  view: { revision: number; status: string };
  legalActions: readonly string[];
  eventCursor: number;
}

/** A dealt three-player match on a harness with the given checkpoint settings. */
async function dealtMatch(env: Record<string, string>): Promise<readonly Claim[]> {
  harness = await startHarness({ env });
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

async function submit(
  seat: Claim,
  commandId: string,
  expectedRevision: number,
  command: Record<string, unknown>,
): Promise<{ ok: boolean; revision: number; duplicate: boolean }> {
  const response = await harness.server.app.inject({
    method: 'POST',
    url: `/api/matches/${seat.matchId}/commands`,
    headers: bearer(seat.credential),
    payload: { matchId: seat.matchId, commandId, expectedRevision, command },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ ok: boolean; revision: number; duplicate: boolean }>();
}

/** The revision the store holds, which lags the match between checkpoints. */
async function storedRevision(matchId: string): Promise<number> {
  const row = await harness.server.database.get(
    'SELECT revision FROM matches WHERE match_id = ?',
    [matchId],
  );
  return Number(row?.['revision'] ?? -1);
}

async function storedCommandCount(matchId: string): Promise<number> {
  const row = await harness.server.database.get(
    'SELECT COUNT(*) AS total FROM commands WHERE match_id = ?',
    [matchId],
  );
  return Number(row?.['total'] ?? 0);
}

/** Cast one ballot per seat, leaving the match on the starting-resources interaction. */
async function electFirstPlayer(seats: readonly Claim[]): Promise<number> {
  const ballots: readonly [number, string][] = [[0, 'p2'], [1, 'p1'], [2, 'p2']];
  let revision = (await readState(seats[0] as Claim)).view.revision;
  for (const [index, candidateId] of ballots) {
    const seat = seats[index] as Claim;
    const result = await submit(seat, `vote-${index}`, revision, {
      type: 'VoteForFirstPlayer',
      candidateId,
    });
    expect(result.ok).toBe(true);
    revision = result.revision;
  }
  return revision;
}

describe('a checkpoint every few commands', () => {
  it('holds commands back from the store and then writes them together', async () => {
    // The bound is above the three ballots, so none of them is written on its own.
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '4',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const dealt = await storedRevision(first.matchId);

    const revision = await electFirstPlayer(seats);

    // Three commands accepted, none of them written: the match moved on and the store
    // is still at the revision the deal left it at.
    expect(revision).toBeGreaterThan(dealt);
    expect(await storedRevision(first.matchId)).toBe(dealt);
    expect(await storedCommandCount(first.matchId)).toBe(0);

    // The fourth reaches the bound, and everything held back goes out with it.
    const fourth = await submit(first, 'vote-again', revision, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(await storedCommandCount(first.matchId)).toBe(4);
    expect(await storedRevision(first.matchId)).toBe(
      fourth.ok ? fourth.revision : revision,
    );
  });

  it('shows a seat its own move before that move is written', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '50',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const revision = await electFirstPlayer(seats);

    // Nothing has been written, and every read still answers from the live match: the
    // lag is the store's, and a player must never be shown it.
    expect(await storedCommandCount(first.matchId)).toBe(0);
    expect((await readState(first)).view.revision).toBe(revision);

    const events = await harness.server.app.inject({
      method: 'GET',
      url: `/api/matches/${first.matchId}/events?since=0`,
      headers: bearer(first.credential),
    });
    expect(events.statusCode).toBe(200);
    const body = events.json<{ events: readonly { id: string }[]; cursor: number }>();
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.cursor).toBeGreaterThanOrEqual(body.events.length);
  });

  it('answers a duplicate from the unwritten record rather than applying it twice', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '50',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const before = (await readState(first)).view.revision;

    const once = await submit(first, 'vote-0', before, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(once.ok).toBe(true);
    expect(await storedCommandCount(first.matchId)).toBe(0);

    // The idempotency record is only in memory at this point. It still has to answer,
    // or a client retrying a lost response would have its command applied a second time.
    const again = await submit(first, 'vote-0', before, {
      type: 'VoteForFirstPlayer',
      candidateId: 'p2',
    });
    expect(again.duplicate).toBe(true);
    expect((await readState(first)).view.revision).toBe(once.revision);
  });

  it('writes everything held back when the process stops cleanly', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '50',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const revision = await electFirstPlayer(seats);
    expect(await storedCommandCount(first.matchId)).toBe(0);

    // `restart` closes the server, which checkpoints before it closes the store. This is
    // the guarantee a deployment relies on: a `SIGTERM` loses nothing.
    await harness.restart();

    expect(await storedRevision(first.matchId)).toBe(revision);
    expect(await storedCommandCount(first.matchId)).toBe(3);
    expect((await readState(first)).view.revision).toBe(revision);
  });

  it('loses only the commands since the last checkpoint when the process does not', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '50',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const dealt = await storedRevision(first.matchId);
    await electFirstPlayer(seats);

    // A kill gives the process no chance to checkpoint. `dispose` on the store is that:
    // it drops what is in memory without writing it, which is the whole of the exposure
    // this design accepts.
    harness.server.store.dispose();
    await harness.restart();

    // The match comes back at the last checkpoint — the deal — rather than at a revision
    // half way through the ballots. That is the property that matters: the loss is a
    // whole number of checkpoints, never a partly-applied command.
    expect(await storedRevision(first.matchId)).toBe(dealt);
    expect((await readState(first)).view.revision).toBe(dealt);
    expect((await readState(first)).legalActions).toEqual(['VoteForFirstPlayer']);
  });

  it('writes on a delay even when the command bound is never reached', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '1000',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '60',
    });
    const first = seats[0] as Claim;
    const revision = await electFirstPlayer(seats);
    expect(await storedCommandCount(first.matchId)).toBe(0);

    // A table that acts once and then stops for the night must not leave that action in
    // memory only, however far it is from the command bound.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await storedRevision(first.matchId)).toBe(revision);
    expect(await storedCommandCount(first.matchId)).toBe(3);
  });
});

describe('the matches held in memory', () => {
  it('drops the least recently touched once it is written, and reads it back', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '1',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const revision = await electFirstPlayer(seats);

    const store = harness.server.store;
    expect(store.liveMatchCount).toBe(1);

    // A match is held from the first touch, so without a bound a process that ran for
    // weeks would hold every match it had ever served.
    store.evictClean(0);
    expect(store.liveMatchCount).toBe(0);

    // Dropping it loses nothing: it is read back from the store on the next request, at
    // the revision it was written at.
    expect((await readState(first)).view.revision).toBe(revision);
    expect(store.liveMatchCount).toBe(1);
  });

  it('never drops a match that still has unwritten commands', async () => {
    const seats = await dealtMatch({
      GERRYMANDER_CHECKPOINT_EVERY_COMMANDS: '50',
      GERRYMANDER_CHECKPOINT_MAX_DELAY_MS: '0',
    });
    const first = seats[0] as Claim;
    const revision = await electFirstPlayer(seats);
    expect(await storedCommandCount(first.matchId)).toBe(0);

    // Evicting this one would discard three accepted commands, so it is held however
    // far over the bound the process is.
    harness.server.store.evictClean(0);
    expect(harness.server.store.liveMatchCount).toBe(1);
    expect((await readState(first)).view.revision).toBe(revision);
  });
});
