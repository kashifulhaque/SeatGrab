/**
 * Where a command is sequenced and where its result is announced.
 *
 * `RoomService` decides everything: whether a credential holds a seat, whether a command
 * is legal, what the next state is, and what each seat may see. This hub decides none of
 * that. It adds the two things a room needs once more than one transport and more than
 * one connection exist, and neither is a rule:
 *
 * 1. **Order.** Every change to a match runs inside `MatchQueue`, so two clients acting
 *    on the same revision are decided one after the other rather than at once. Both
 *    transports go through here, so a WebSocket command and an HTTP command to the same
 *    match serialize against each other too.
 * 2. **Announcement.** After a change, every connection attached to that match is sent a
 *    fresh projection *for its own seat*, produced by `projectGame` through
 *    `RoomService.viewFor`. There is no shared state patch and no shared frame: a seat is
 *    only ever sent what `projection-privacy.test.ts` proves it may see.
 *
 * Connections register themselves and are the only thing here that knows about sockets,
 * and even that is through a two-method interface, so nothing in this file depends on a
 * WebSocket implementation.
 */
import type { CommandResponse, SeatView, ServerFrame } from '@seatgrab/protocol';

import { MatchQueue } from './matchQueue.js';
import type { RoomService, SeatIdentity } from './roomService.js';

/**
 * A live connection, as the hub needs to see one.
 *
 * Deliberately not a WebSocket: the hub sends frames and drops connections, and a test
 * can be a connection by implementing two methods.
 */
export interface MatchConnection {
  readonly seat: SeatIdentity;
  /** Deliver one frame. Must not throw; a dead connection swallows and closes itself. */
  send: (frame: ServerFrame) => void;
}

export interface MatchHubOptions {
  rooms: RoomService;
  /** Injected so a failure to project one seat does not silence the rest. */
  onBroadcastError?: (error: unknown, seat: SeatIdentity) => void;
}

export class MatchHub {
  readonly #rooms: RoomService;
  readonly #queue = new MatchQueue();
  readonly #connections = new Map<string, Set<MatchConnection>>();
  readonly #onBroadcastError: (error: unknown, seat: SeatIdentity) => void;

  constructor(options: MatchHubOptions) {
    this.#rooms = options.rooms;
    this.#onBroadcastError = options.onBroadcastError ?? (() => undefined);
  }

  /** Attach a connection to its match. Returns the function that detaches it. */
  attach(connection: MatchConnection): () => void {
    const matchId = connection.seat.matchId;
    let attached = this.#connections.get(matchId);
    if (attached === undefined) {
      attached = new Set();
      this.#connections.set(matchId, attached);
    }
    attached.add(connection);
    return () => {
      const current = this.#connections.get(matchId);
      if (current === undefined) return;
      current.delete(connection);
      if (current.size === 0) this.#connections.delete(matchId);
    };
  }

  /** Connections currently attached to a match. Diagnostics and tests only. */
  connectionCount(matchId: string): number {
    return this.#connections.get(matchId)?.size ?? 0;
  }

  /**
   * Start a match, then tell everyone watching it.
   *
   * The start is queued like a command because it is one in every way that matters: it
   * writes the first snapshot, and two hosts' clicks must not both deal a table.
   */
  async start(seat: SeatIdentity): Promise<SeatView> {
    const view = await this.#queue.run(seat.matchId, () => this.#rooms.start(seat));
    this.broadcast(seat.matchId);
    return view;
  }

  /**
   * Apply one command, then tell everyone watching the match what it did to their seat.
   *
   * The queued task is `RoomService.submit` alone, and that is still synchronous from
   * the read to the commit. The queue is what makes that irrelevant: even if the task
   * yielded, nothing else for this match could run inside it.
   */
  async submit(
    seat: SeatIdentity,
    body: unknown,
  ): Promise<{ response: CommandResponse; duplicate: boolean }> {
    const result = await this.#queue.run(seat.matchId, () => this.#rooms.submit(seat, body));
    // A refused command changes no state, so there is nothing to announce. A duplicate
    // replays an answer that was already broadcast when it was first decided.
    if (result.response.ok && !result.duplicate) this.broadcast(seat.matchId);
    return result;
  }

  /**
   * Send every attached connection its own seat's fresh projection.
   *
   * One `projectGame` per seat, never one payload shared between seats. A seat whose
   * projection throws is skipped and reported rather than allowed to stop the others:
   * an unreadable snapshot is one seat's problem to surface, not a reason for the rest
   * of the table to go quiet.
   */
  broadcast(matchId: string): void {
    const attached = this.#connections.get(matchId);
    if (attached === undefined) return;
    for (const connection of [...attached]) {
      try {
        connection.send({ type: 'state', state: this.#rooms.viewFor(connection.seat) });
      } catch (error) {
        this.#onBroadcastError(error, connection.seat);
      }
    }
  }
}
