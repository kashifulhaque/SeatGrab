/**
 * The online transport adapter, against a socket that is entirely under the test's
 * control.
 *
 * The server's own suite proves what the server decides. This one proves what the
 * browser does with the answers: that it adopts a projection rather than keeping its
 * own, that it never assembles a projection it was not sent, that a dropped connection
 * comes back, and that a command whose answer was lost is asked again with the same
 * command ID rather than as a second command.
 *
 * Nothing here runs a clock or a real socket, so the whole file is deterministic.
 */
import { describe, expect, it } from 'vitest';

import type {
  CommandEnvelope,
  ClientFrame,
  PlayerView,
  SeatView,
  ServerFrame,
  SocketSeatIdentity,
} from '@seatgrab/protocol';
import { SEATABLE_PARTY_IDS } from '@seatgrab/protocol';

import { PARTY_IDENTITIES, PARTY_IDENTITY_BY_ID } from '../src/assets/parties';
import { openRemoteMatch, socketUrl, type RemoteMatch } from '../src/remote';
import type { MatchSurface } from '../src/transport';
import type { LocalMatch } from '../src/local';
import type { RemoteSocket, Scheduler, SocketHandlers } from '../src/remote';

/**
 * A socket the test opens, drops and answers by hand.
 *
 * It records what the client sent and lets the test deliver frames and closures, which
 * is the whole of what the adapter's reconnection behaviour depends on.
 */
class FakeSocket implements RemoteSocket {
  readonly sent: ClientFrame[] = [];
  closed = false;

  constructor(readonly url: string, readonly handlers: SocketHandlers) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    this.closed = true;
  }

  /** Complete the handshake, so the adapter sends its `authenticate` frame. */
  open(): void {
    this.handlers.onOpen();
  }

  deliver(frame: ServerFrame): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }

  drop(code = 1006, reason = ''): void {
    this.closed = true;
    this.handlers.onClose(code, reason);
  }

  /** The `authenticate` frame this connection sent, if it has. */
  authentication(): Extract<ClientFrame, { type: 'authenticate' }> | undefined {
    return this.sent.find((frame) => frame.type === 'authenticate');
  }

  submissions(): Extract<ClientFrame, { type: 'submit' }>[] {
    return this.sent.filter((frame) => frame.type === 'submit');
  }
}

/** Every socket the adapter opened, newest last, plus a scheduler the test drives. */
function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];

  const schedule: Scheduler = (callback, delayMs) => {
    const timer = { callback, delayMs, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  return {
    sockets,
    timers,
    schedule,
    socketFactory: (url: string, handlers: SocketHandlers): RemoteSocket => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    latest(): FakeSocket {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error('No socket has been opened.');
      return socket;
    },
    /**
     * Fire every live timer due within `ms`, oldest first.
     *
     * A bound rather than "everything pending" because the adapter schedules two very
     * different things: reconnection backoffs, measured in hundreds of milliseconds, and
     * the twenty-second deadline on an unanswered command. Firing both at once would
     * make a reconnection test also assert that the command gave up.
     */
    advance(ms: number): void {
      const due = timers.filter((timer) => timer.delayMs <= ms);
      for (const timer of due) timers.splice(timers.indexOf(timer), 1);
      for (const timer of due) if (!timer.cancelled) timer.callback();
    },
  };
}

function playerView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    matchId: 'm-1',
    revision: 7,
    status: 'active',
    phase: 'action',
    activePlayerId: 'p1',
    setup: {
      matchId: 'm-1',
      playerCount: 3,
      tiePolicy: 'jointWinners',
      contentAdvisories: [],
      contentPackId: 'core-set',
      contentVersion: '1.0.0',
      rulesetId: 'other-ruleset',
      rulesetVersion: '1.0.0',
      boardId: 'other-board',
      boardVersion: '1.0.0',
      engineVersion: '1.0.0',
      schemaVersion: 1,
    },
    players: [],
    turnOrdinal: 1,
    publicReserve: { cash: 20, influence: 20, press: 20, faith: 20 },
    zones: [],
    slots: [],
    voterMarket: [],
    pendingVoterGroups: [],
    voterCards: [],
    activeEffects: [],
    turncoatHoldings: [],
    deckCounts: { policy: 10, voter: 10, news: 10, trick: 10 },
    turnUsage: {
      arbitrage: 0,
      shakedown: 0,
      groundswell: 0,
      volunteers: 0,
      demolition: 0,
      crackdown: 0,
      outreach: 0,
      gerrymandersByZoneId: {},
    },
    legalActions: ['RequestEndTurn'],
    history: [],
    ...overrides,
  };
}

function seatView(overrides: Partial<SeatView> = {}, view: Partial<PlayerView> = {}): SeatView {
  return {
    view: playerView(view),
    legalActions: ['RequestEndTurn'],
    eventCursor: 4,
    promptProblem: null,
    ...overrides,
  };
}

const SEAT: SocketSeatIdentity = {
  matchId: 'm-1',
  seatIndex: 0,
  playerId: 'p1',
  isHost: true,
  displayName: 'Asha',
  partyId: 'kite',
};

let minted = 0;

function open(options: Partial<Parameters<typeof openRemoteMatch>[0]> = {}) {
  const table = harness();
  const match = openRemoteMatch({
    matchId: 'm-1',
    credential: 'seat-credential',
    socketFactory: table.socketFactory,
    schedule: table.schedule,
    newCommandId: () => `cmd-${(minted += 1)}`,
    now: () => 1_000,
    backoffMs: [250, 500],
    ...options,
  });
  return { table, match };
}

/** Bring a fresh adapter all the way to `synchronized`. */
function synchronized(state: SeatView = seatView()) {
  const { table, match } = open();
  const socket = table.latest();
  socket.open();
  socket.deliver({ type: 'welcome', seat: SEAT, sync: { state, events: [], cursor: 4 } });
  return { table, match, socket };
}

describe('the surface', () => {
  it('is the one the local adapter already presents', () => {
    // These two assignments are the assertion, and the browser typecheck is what runs
    // it. If either adapter stops satisfying `MatchSurface` — a renamed method, a
    // narrowed return, a changed argument — this file stops compiling, and it stops
    // compiling before a screen written against the surface stops working with one of
    // them. The runtime expectations below only keep the test honest about running.
    const local: MatchSurface = null as unknown as LocalMatch;
    const remote: MatchSurface = null as unknown as RemoteMatch;
    expect(local).toBeNull();
    expect(remote).toBeNull();

    // And the live adapter really does answer every member of it.
    const { match } = synchronized();
    const surface: MatchSurface = match;
    expect(surface.matchId).toBe('m-1');
    expect(surface.revision()).toBe(7);
    expect(surface.viewFor({ kind: 'player', playerId: 'p1' }).ok).toBe(true);
    expect(surface.subscribe(() => undefined)).toBeTypeOf('function');
    expect(surface.submit).toBeTypeOf('function');
  });
});

describe('opening a connection', () => {
  it('presents the credential and the cursor it wants catching up from', () => {
    const { table } = open();
    const socket = table.latest();
    socket.open();
    const authentication = socket.authentication();
    expect(authentication?.matchId).toBe('m-1');
    expect(authentication?.credential).toBe('seat-credential');
    expect(authentication?.sinceEventCursor).toBe(0);
  });

  it('reports connecting, then synchronized, and notifies the screen each time', () => {
    const { table, match } = open();
    const seen: string[] = [];
    match.subscribe(() => seen.push(match.status().kind));
    expect(match.status().kind).toBe('connecting');

    const socket = table.latest();
    socket.open();
    socket.deliver({ type: 'welcome', seat: SEAT, sync: { state: seatView(), events: [], cursor: 4 } });

    expect(match.status()).toEqual({ kind: 'synchronized', since: 1_000 });
    expect(seen).toContain('synchronized');
    expect(match.revision()).toBe(7);
    expect(match.seat()?.playerId).toBe('p1');
  });

  it('turns an http server URL into a ws one, and https into wss', () => {
    expect(socketUrl('', 'http://localhost:5173')).toBe('ws://localhost:5173/ws');
    expect(socketUrl('https://seatgrab.example', 'http://localhost:5173'))
      .toBe('wss://seatgrab.example/ws');
  });
});

describe('the projection', () => {
  it('is only ever the one the server sent for this seat', () => {
    const { match } = synchronized();
    const mine = match.viewFor({ kind: 'player', playerId: 'p1' });
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.view.revision).toBe(7);

    // No public view and no other seat's: the server produced neither, and this adapter
    // will not manufacture one by deleting fields from its own.
    for (const viewer of [{ kind: 'public' } as const, { kind: 'player', playerId: 'p2' } as const]) {
      const refused = match.viewFor(viewer);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe('NO_PROJECTION');
        expect(refused.view).toBeNull();
      }
    }
  });

  it('refuses a prompt the server says this build cannot describe', () => {
    const { match } = synchronized(seatView({ promptProblem: 'Do not act on it.' }));
    const result = match.viewFor({ kind: 'player', playerId: 'p1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNSUPPORTED_PROMPT');
      expect(result.message).toBe('Do not act on it.');
      // The view still comes with it, so the table can show the board and the refusal.
      expect(result.view).not.toBeNull();
    }
  });

  it('refuses everything until the first projection arrives', () => {
    const { match } = open();
    const result = match.viewFor({ kind: 'player', playerId: 'p1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_PROJECTION');
    expect(match.revision()).toBe(0);
  });

  it('is replaced outright by whatever the server sends next', () => {
    const { match, socket } = synchronized();
    socket.deliver({ type: 'state', state: seatView({ eventCursor: 9 }, { revision: 8 }) });
    expect(match.revision()).toBe(8);
    socket.deliver({ type: 'state', state: seatView({ eventCursor: 12 }, { revision: 9 }) });
    expect(match.revision()).toBe(9);
  });
});

describe('submitting a command', () => {
  it('sends the seat’s current revision and resolves with the server’s answer', async () => {
    const { match, socket } = synchronized();
    const pending = match.submit('p1', { type: 'RequestEndTurn' });

    const submission = socket.submissions().at(-1);
    expect(submission?.envelope.expectedRevision).toBe(7);
    expect(submission?.envelope.matchId).toBe('m-1');

    socket.deliver({
      type: 'commandResult',
      requestId: submission?.requestId ?? '',
      response: { ok: true, revision: 8, events: [] },
      duplicate: false,
    });
    await expect(pending).resolves.toEqual({ ok: true, revision: 8, events: [] });
  });

  it('resolves a refusal rather than throwing, because it is a ruling about the game', async () => {
    const { match, socket } = synchronized();
    const pending = match.submit('p1', { type: 'RequestEndTurn' });
    const submission = socket.submissions().at(-1);
    socket.deliver({
      type: 'commandResult',
      requestId: submission?.requestId ?? '',
      response: {
        ok: false,
        code: 'STALE_REVISION',
        message: 'Read the match again.',
        revision: 9,
      },
      duplicate: false,
    });
    const response = await pending;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe('STALE_REVISION');
  });

  it('refuses to act for a seat this connection does not hold', async () => {
    const { match } = synchronized();
    await expect(match.submit('p2', { type: 'RequestEndTurn' })).rejects.toThrow(/cannot act for p2/u);
  });

  it('refuses to act before there is any state to act on', async () => {
    const { match } = open();
    await expect(match.submit('p1', { type: 'RequestEndTurn' })).rejects.toThrow(/no state/u);
  });
});

describe('losing the connection', () => {
  it('reports reconnecting with the delay, then opens again', () => {
    const { table, match, socket } = synchronized();
    socket.drop();

    const status = match.status();
    expect(status.kind).toBe('reconnecting');
    if (status.kind === 'reconnecting') expect(status.retryInMs).toBe(250);
    expect(table.sockets).toHaveLength(1);

    table.advance(1_000);
    expect(table.sockets).toHaveLength(2);
    table.latest().open();
    expect(table.latest().authentication()?.credential).toBe('seat-credential');
  });

  it('catches up from the cursor it last held, not from the beginning', () => {
    const { table, socket } = synchronized(seatView({ eventCursor: 11 }));
    socket.drop();
    table.advance(1_000);
    table.latest().open();
    expect(table.latest().authentication()?.sinceEventCursor).toBe(11);
  });

  it('lengthens the wait between attempts and keeps trying', () => {
    const { table, match, socket } = synchronized();
    socket.drop();
    table.advance(1_000);

    table.latest().drop();
    const second = match.status();
    expect(second.kind).toBe('reconnecting');
    if (second.kind === 'reconnecting') expect(second.retryInMs).toBe(500);
  });

  it('re-asks an unanswered command with the same command ID, so it applies once', async () => {
    const { table, match, socket } = synchronized();
    const pending = match.submit('p1', { type: 'RequestEndTurn' });
    const first = socket.submissions().at(-1) as Extract<ClientFrame, { type: 'submit' }>;

    socket.drop();
    table.advance(1_000);
    const reopened = table.latest();
    reopened.open();
    reopened.deliver({ type: 'welcome', seat: SEAT, sync: { state: seatView(), events: [], cursor: 4 } });

    const resent = reopened.submissions().at(-1) as Extract<ClientFrame, { type: 'submit' }>;
    const sameCommand: CommandEnvelope = resent.envelope;
    expect(sameCommand.commandId).toBe(first.envelope.commandId);
    expect(sameCommand.expectedRevision).toBe(first.envelope.expectedRevision);

    // The server recognises the command ID and replays the answer it already decided.
    reopened.deliver({
      type: 'commandResult',
      requestId: resent.requestId,
      response: { ok: true, revision: 8, events: [] },
      duplicate: true,
    });
    await expect(pending).resolves.toEqual({ ok: true, revision: 8, events: [] });
  });
});

describe('a refusal the connection cannot recover from', () => {
  it('stops retrying, says why, and fails everything still waiting', async () => {
    const { table, match, socket } = synchronized();
    const pending = match.submit('p1', { type: 'RequestEndTurn' });

    socket.deliver({
      type: 'error',
      code: 'BAD_CREDENTIAL',
      message: 'That credential does not hold a seat in this match.',
    });

    const status = match.status();
    expect(status.kind).toBe('rejected');
    if (status.kind === 'rejected') expect(status.code).toBe('BAD_CREDENTIAL');
    await expect(pending).rejects.toThrow(/does not hold a seat/u);

    // No further attempt, however long the screen leaves it open.
    table.advance(1_000);
    expect(table.sockets).toHaveLength(1);
  });

  it('is not what an ordinary drop does', () => {
    const { match, socket } = synchronized();
    socket.deliver({ type: 'error', code: 'RATE_LIMITED', message: 'Wait a moment.' });
    expect(match.status().kind).toBe('synchronized');
  });
});

describe('closing the match', () => {
  it('stops reconnecting and rejects anything unanswered', async () => {
    const { table, match, socket } = synchronized();
    const pending = match.submit('p1', { type: 'RequestEndTurn' });
    expect(socket.submissions()).toHaveLength(1);

    match.close();
    await expect(pending).rejects.toThrow(/closed before the server answered/u);
    expect(match.status().kind).toBe('disconnected');

    table.advance(1_000);
    expect(table.sockets).toHaveLength(1);
  });
});

describe('the party roster', () => {
  it('draws exactly the identities the protocol seats', () => {
    expect(PARTY_IDENTITIES.map((party) => party.partyId).sort())
      .toEqual([...SEATABLE_PARTY_IDS].sort());
    for (const partyId of SEATABLE_PARTY_IDS) {
      expect(PARTY_IDENTITY_BY_ID.get(partyId)?.displayName).toBeTypeOf('string');
    }
  });
});
