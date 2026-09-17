// @vitest-environment jsdom
/**
 * `OnlineRoom` itself, rendered.
 *
 * Session 18 took the DOM test decision that sessions 16 and 17 deferred. The question
 * the brief set was what a render test asserts that `online-model.test.ts` does not, and
 * it has an answer, which is why the dependency was taken:
 *
 * - **The effect that opens the connection.** `openRemoteMatch` is called from an effect
 *   keyed on the seat and a generation counter, and its cleanup closes the socket. A
 *   derivation test cannot see any of that. React invokes an effect twice in development,
 *   so a connection opened during render — or a cleanup that does not close — leaks one
 *   socket per mount, against a server that counts connections per seat.
 * - **The narrowing that hides a `NO_PROJECTION`.** `viewFor` refuses every viewer but
 *   this seat, and the screen turns that refusal into "draw the lobby instead". The
 *   refusal is covered by `remote-match.test.ts`; that it reaches a lobby rather than an
 *   empty table is a rendering fact and is covered only here.
 * - **The lobby poll's stop condition.** It runs on a four-second interval until a
 *   projection arrives, and nothing outside the component decides that. A poll that
 *   outlived the deal would keep asking a started room for a lobby for the rest of the
 *   match.
 * - **`rejected` suppressing the roster.** Two independent pieces of state — the
 *   connection status and the lobby — meet in one conditional, and the rule is that a
 *   refused seat is the whole story. `describeConnection` knows the banner; only the
 *   screen knows what is drawn beside it.
 *
 * The dependency taken is `jsdom` and nothing else. There is no Testing Library here on
 * purpose: `react-dom/client` and React's own `act` are enough for mount, unmount and
 * events, and a second dependency would have to earn itself against assertions this file
 * makes in one line of `textContent`.
 *
 * What this does not do is prove appearance. It asserts which panel is on screen and
 * which control exists, never how either looks; section 13 work is still owed browser
 * evidence, and a render test is not it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobbyView, PlayerView, SeatView, ServerFrame } from '@gerrymander/protocol';

import { OnlineRoom } from '../src/app/OnlineRoom';
import {
  SEAT_STORE_KEY,
  openSeatStore,
  type OpenSeatStore,
  type StoredSeat,
} from '../src/remote';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const MATCH_ID = 'm-1';

const SEAT: StoredSeat = {
  matchId: MATCH_ID,
  roomCode: 'PANEER',
  seatIndex: 0,
  playerId: 'p1',
  isHost: true,
  displayName: 'Asha',
  partyId: 'kite',
  credential: 'seat-credential',
  claimedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * The half of a browser `WebSocket` that `defaultSocketFactory` uses.
 *
 * The point of driving the real factory rather than injecting one is that the effect
 * under test calls `openRemoteMatch` with no injection point at all — that is exactly the
 * wiring nothing else covers — so the seam has to be the global the factory reaches for.
 */
class FakeBrowserSocket {
  static live: FakeBrowserSocket[] = [];

  readonly sent: string[] = [];
  closed = false;
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeBrowserSocket.live.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.#emit('open', {});
  }

  deliver(frame: ServerFrame): void {
    this.#emit('message', { data: JSON.stringify(frame) });
  }

  drop(code = 4401, reason = 'BAD_CREDENTIAL'): void {
    this.closed = true;
    this.#emit('close', { code, reason });
  }

  /** The number of sockets that are still open, which is what a leak shows up as. */
  static openCount(): number {
    return FakeBrowserSocket.live.filter((socket) => !socket.closed).length;
  }

  static latest(): FakeBrowserSocket {
    const socket = FakeBrowserSocket.live.at(-1);
    if (socket === undefined) throw new Error('No socket was opened.');
    return socket;
  }
}

function lobbyView(overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    roomCode: 'PANEER',
    matchId: MATCH_ID,
    status: 'lobby',
    seatCount: 3,
    contentAdvisories: [],
    seats: [
      { seatIndex: 0, playerId: 'p1', isHost: true, claimed: true, displayName: 'Asha', partyId: 'kite', controller: 'human' },
      { seatIndex: 1, playerId: 'p2', isHost: false, claimed: true, displayName: 'Bikram', partyId: 'sprout', controller: 'human' },
      { seatIndex: 2, playerId: 'p3', isHost: false, claimed: false, displayName: null, partyId: null, controller: 'human' },
    ],
    ready: false,
    contentPackId: 'core-set',
    contentVersion: '0.9.0',
    boardId: 'grid-nine',
    boardVersion: '1.0.0',
    ...overrides,
  };
}

function playerView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    matchId: MATCH_ID,
    revision: 3,
    status: 'active',
    phase: 'action',
    activePlayerId: 'p1',
    setup: {
      matchId: MATCH_ID,
      playerCount: 3,
      tiePolicy: 'jointWinners',
      contentAdvisories: [],
      contentPackId: 'core-set',
      contentVersion: '0.9.0',
      rulesetId: 'gerrymander-photo',
      rulesetVersion: '1.0.0',
      boardId: 'grid-nine',
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

function seatView(view: Partial<PlayerView> = {}): SeatView {
  return {
    view: playerView(view),
    legalActions: ['RequestEndTurn'],
    eventCursor: 0,
    promptProblem: null,
  };
}

/** A welcome frame for this seat, with or without a dealt table behind it. */
function welcome(state: SeatView | null): ServerFrame {
  return {
    type: 'welcome',
    seat: {
      matchId: MATCH_ID,
      seatIndex: 0,
      playerId: 'p1',
      isHost: true,
      displayName: 'Asha',
      partyId: 'kite',
    },
    sync: { state, events: [], cursor: 0 },
  };
}

let container: HTMLDivElement;
let root: Root;
let lobbyReads = 0;

/** A seat store backed by a plain map, so nothing reaches the real `localStorage`. */
function seatStoreHolding(seat: StoredSeat | null): OpenSeatStore {
  const values = new Map<string, string>();
  if (seat !== null) values.set(SEAT_STORE_KEY, JSON.stringify([seat]));
  return openSeatStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  });
}

function render(seats: OpenSeatStore): void {
  act(() => {
    root.render(<OnlineRoom seats={seats} matchId={MATCH_ID} />);
  });
}

function text(): string {
  return container.textContent ?? '';
}

function buttonLabelled(label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '').includes(label)) ?? null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeBrowserSocket.live = [];
  lobbyReads = 0;
  // @ts-expect-error — the factory reaches for the global, so the global is the seam.
  globalThis.WebSocket = FakeBrowserSocket;
  globalThis.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/api/rooms/')) {
      lobbyReads += 1;
      return Promise.resolve(new Response(JSON.stringify(lobbyView()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  }) as typeof globalThis.fetch;

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let the stubbed `fetch` settle without letting the four-second poll fire. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('OnlineRoom', () => {
  it('opens exactly one connection and closes it on unmount', async () => {
    render(seatStoreHolding(SEAT));
    await settle();

    expect(FakeBrowserSocket.live).toHaveLength(1);
    expect(FakeBrowserSocket.openCount()).toBe(1);
    expect(FakeBrowserSocket.latest().url).toMatch(/^ws:\/\/[^/]+\/ws$/);

    act(() => root.unmount());
    expect(FakeBrowserSocket.openCount()).toBe(0);

    // `afterEach` unmounts again; a root that is already unmounted tolerates it.
    root = createRoot(container);
  });

  it('sends the seat credential only over its own socket, never in the URL', async () => {
    render(seatStoreHolding(SEAT));
    await settle();
    const socket = FakeBrowserSocket.latest();
    act(() => socket.open());

    expect(socket.url).not.toContain(SEAT.credential);
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'authenticate',
      matchId: MATCH_ID,
      credential: SEAT.credential,
    });
    // The lobby is read over HTTP and must not carry it either.
    for (const call of vi.mocked(globalThis.fetch).mock.calls) {
      expect(String(call[0])).not.toContain(SEAT.credential);
      expect(JSON.stringify(call[1] ?? {})).not.toContain(SEAT.credential);
    }
  });

  it('draws the lobby while the room has no projection to draw instead', async () => {
    render(seatStoreHolding(SEAT));
    await settle();
    act(() => FakeBrowserSocket.latest().open());
    act(() => FakeBrowserSocket.latest().deliver(welcome(null)));
    await settle();

    expect(text()).toContain('Room PANEER');
    expect(text()).toContain('Seat 3');
    expect(buttonLabelled('Start the match')).not.toBeNull();
    // `sync.state === null` is a lobby, not an empty table: nothing below is drawn.
    expect(container.querySelector('.board--live')).toBeNull();
  });

  it('offers the host a computer on the free seat, with a difficulty beside it', async () => {
    render(seatStoreHolding(SEAT));
    await settle();
    act(() => FakeBrowserSocket.latest().open());
    act(() => FakeBrowserSocket.latest().deliver(welcome(null)));
    await settle();

    // Seat 3 is the only free one, and this browser holds the host seat.
    expect(buttonLabelled('Seat a computer')).not.toBeNull();
    const difficulty = container.querySelector<HTMLSelectElement>('#seat-2-difficulty');
    expect(difficulty).not.toBeNull();
    expect([...(difficulty?.options ?? [])].map((option) => option.value))
      .toEqual(['easy', 'medium', 'hard']);
    expect(difficulty?.value).toBe('medium');
    // The two held seats offer no such control: a computer goes on a free seat only.
    expect(container.querySelectorAll('select[id$="-difficulty"]')).toHaveLength(1);
  });

  it('stops polling the lobby the moment a projection arrives', async () => {
    render(seatStoreHolding(SEAT));
    await settle();
    act(() => FakeBrowserSocket.latest().open());
    act(() => FakeBrowserSocket.latest().deliver(welcome(null)));
    await settle();

    const beforeDeal = lobbyReads;
    expect(beforeDeal).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(lobbyReads).toBeGreaterThan(beforeDeal);

    act(() => FakeBrowserSocket.latest().deliver({ type: 'state', state: seatView() }));
    await settle();
    const afterDeal = lobbyReads;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(lobbyReads).toBe(afterDeal);
    // And the other half of the same conditional: the lobby is gone and the table is
    // drawn from this seat's own view, which is the only projection a remote adapter has.
    expect(text()).not.toContain('Start the match');
    expect(container.querySelector('.board--live')).not.toBeNull();
  });

  it('says nothing about the room once the server has refused this seat', async () => {
    render(seatStoreHolding(SEAT));
    await settle();
    act(() => FakeBrowserSocket.latest().open());
    // The terminal state comes from an `error` frame carrying a permanent code, not from
    // the close that follows it: a 4401 close on its own is retried, because a server
    // that drops a connection has not necessarily ruled on the credential.
    act(() => FakeBrowserSocket.latest().deliver({
      type: 'error',
      code: 'BAD_CREDENTIAL',
      message: 'That credential does not hold a seat in this match.',
    }));
    act(() => FakeBrowserSocket.latest().drop(4401, 'BAD_CREDENTIAL'));
    await settle();

    // A refused seat is the whole story: the roster would invite a player to act on a
    // table this browser has just been told it has no claim on.
    expect(text()).not.toContain('Start the match');
    expect(text()).not.toContain('Share this code with the other players');
    // And the way back is the room code, not a retry, because nothing is ever reissued.
    expect(buttonLabelled('Reconnect now')).toBeNull();
    expect([...container.querySelectorAll('a')].some(
      (link) => (link.textContent ?? '').includes('Join with a room code'),
    )).toBe(true);
  });

  it('opens no connection at all for a match this browser holds no seat in', async () => {
    render(seatStoreHolding(null));
    await settle();

    expect(FakeBrowserSocket.live).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(text()).toContain('This browser holds no seat in that room');
  });
});
