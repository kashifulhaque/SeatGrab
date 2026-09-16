/**
 * The online transport adapter.
 *
 * This is the remote counterpart of `local/localMatch.ts`, and it is deliberately the
 * same shape: `revision`, `submit`, `viewFor`, `subscribe`. A screen written against
 * `MatchSurface` does not know which of the two it holds, so every composer built for
 * pass-and-play works online unchanged.
 *
 * What differs is where the authority is, and that difference is the whole design:
 *
 * - The local adapter *computes* a projection. This one *receives* one. There is no
 *   `projectGame` call in the browser's online path, so nothing here can widen what a
 *   seat sees. `projection-privacy.test.ts` proves the server's projection is authorized;
 *   this adapter renders it and adds nothing to it.
 * - The local adapter answers any viewer. This one holds exactly one seat's projection
 *   and refuses every other viewer with `NO_PROJECTION`, because the server produced no
 *   other projection for it. It never assembles a public view by deleting fields from its
 *   own — that would be a second copy of the privacy rules, in the least trustworthy
 *   place to keep one.
 * - The local adapter's `submit` is decided in the same process. This one's is decided by
 *   the server and may outlive the connection that carried it. An answer that is lost is
 *   re-asked with the same command ID, which the server answers from its idempotency
 *   record, so a reconnection never applies a command twice.
 *
 * Section 14.4's four states — disconnected, reconnecting, synchronized, rejected — are
 * `status()`, and every change to them notifies `subscribe`, so a screen can draw the
 * connection beside the table without a second subscription.
 */
import type {
  CommandEnvelope,
  CommandResponse,
  GameCommand,
  SeatView,
  ServerFrame,
  SocketSeatIdentity,
} from '@seatgrab/protocol';
import type { Viewer } from '@seatgrab/engine';

import type { MatchSurface, MatchViewResult } from '../transport/surface';

import {
  RemoteConnection,
  type ConnectionStatus,
  type RemoteSocketFactory,
  type Scheduler,
} from './socket';

/**
 * The wording every online screen uses where the local one uses `LOCAL_MODE_NOTICE`.
 *
 * It says the two things a player at an online table has to know and cannot see: the
 * server holds the cards, and a dropped connection does not lose the seat.
 */
export const ONLINE_MODE_NOTICE =
  'The server holds this match. Your cards and answers are sent to your seat alone, and '
  + 'nobody else’s reach this device. If you drop out, the table waits: your seat keeps '
  + 'whatever it was being asked for until you come back.';

export interface RemoteMatchOptions {
  matchId: string;
  /** The credential issued when this seat was claimed. Never sent anywhere else. */
  credential: string;
  /** Base URL of the room server. Empty means the page's own origin. */
  serverUrl?: string;
  /** How long to wait for one command's answer before giving up on it. */
  commandTimeoutMs?: number;
  /** Mints a command ID per intent. Injected so a test can pin them. */
  newCommandId?: () => string;
  socketFactory?: RemoteSocketFactory;
  schedule?: Scheduler;
  now?: () => number;
  backoffMs?: readonly number[];
}

export interface RemoteMatch extends MatchSurface {
  /** The seat this connection speaks for, once the server has said which it is. */
  seat(): SocketSeatIdentity | null;
  /** The connection state, for the banner section 14.4 requires. */
  status(): ConnectionStatus;
  /** The last projection the server sent, or `null` before the first arrives. */
  seatView(): SeatView | null;
  /** Ask for a fresh projection without waiting for one to be pushed. */
  resync(): void;
  /** Close the connection for good. Every command still waiting is rejected. */
  close(): void;
}

/** A command that has been sent and not yet answered. */
interface Pending {
  envelope: CommandEnvelope;
  requestId: string;
  resolve: (response: CommandResponse) => void;
  reject: (error: Error) => void;
  cancelTimeout: () => void;
}

function browserCommandId(): string {
  const source = globalThis.crypto;
  if (source?.randomUUID !== undefined) return source.randomUUID();
  throw new Error('This browser has no way to mint a unique command ID, so it cannot play online.');
}

/**
 * Open a seat's connection to a match on the room server.
 *
 * Returns immediately, before the first projection arrives: `status()` is `connecting`
 * and `viewFor` refuses until the server's welcome lands. A screen shows the connection
 * state rather than a blank table, which is what section 14.4 asks for.
 */
export function openRemoteMatch(options: RemoteMatchOptions): RemoteMatch {
  const commandTimeoutMs = options.commandTimeoutMs ?? 20_000;
  const newCommandId = options.newCommandId ?? browserCommandId;
  const schedule: Scheduler = options.schedule
    ?? ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    });

  let seat: SocketSeatIdentity | null = null;
  let view: SeatView | null = null;
  let cursor = 0;
  const pending = new Map<string, Pending>();
  const listeners = new Set<() => void>();

  const announce = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /**
   * Adopt a projection the server sent.
   *
   * Whatever this client believed is replaced outright. Section 14.4 is explicit that a
   * reconnecting client's own snapshot is never the authority, and the simplest way to
   * hold to that is to keep nothing that could compete with what just arrived.
   */
  const adopt = (state: SeatView | null): void => {
    if (state === null) return;
    view = state;
    cursor = Math.max(cursor, state.eventCursor);
  };

  const settle = (requestId: string, response: CommandResponse): void => {
    const waiting = pending.get(requestId);
    if (waiting === undefined) return;
    pending.delete(requestId);
    waiting.cancelTimeout();
    waiting.resolve(response);
  };

  const abandon = (reason: string): void => {
    for (const [requestId, waiting] of [...pending]) {
      pending.delete(requestId);
      waiting.cancelTimeout();
      waiting.reject(new Error(reason));
    }
  };

  const connection = new RemoteConnection({
    matchId: options.matchId,
    credential: options.credential,
    cursor: () => cursor,
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
    onStatus: (status) => {
      if (status.kind === 'rejected') {
        abandon(`${status.message} Nothing you sent was applied on this connection.`);
      }
      announce();
    },
    onFrame: (frame: ServerFrame) => {
      switch (frame.type) {
        case 'welcome': {
          seat = frame.seat;
          adopt(frame.sync.state);
          cursor = Math.max(cursor, frame.sync.cursor);
          // Anything still unanswered is re-asked on the new connection, with the same
          // command ID. The server either replays the answer it already decided or
          // decides it now; either way it is applied exactly once. A command written
          // against a revision that has since moved comes back as `STALE_REVISION`,
          // which is what section 14.4 requires instead of replaying an old target.
          for (const waiting of pending.values()) {
            connection.send({ type: 'submit', requestId: waiting.requestId, envelope: waiting.envelope });
          }
          announce();
          return;
        }
        case 'sync': {
          adopt(frame.sync.state);
          cursor = Math.max(cursor, frame.sync.cursor);
          announce();
          return;
        }
        case 'state': {
          adopt(frame.state);
          announce();
          return;
        }
        case 'commandResult': {
          settle(frame.requestId, frame.response);
          return;
        }
        case 'error': {
          // An error naming a request is that command's answer; the transport could not
          // put it to the engine, so it rejects rather than inventing an engine refusal.
          if (frame.requestId !== undefined) {
            const waiting = pending.get(frame.requestId);
            if (waiting !== undefined) {
              pending.delete(frame.requestId);
              waiting.cancelTimeout();
              waiting.reject(new Error(`${frame.message} (${frame.code})`));
            }
          }
          announce();
          return;
        }
        case 'pong':
          return;
        default:
          return;
      }
    },
  });
  connection.open();

  const match: RemoteMatch = {
    matchId: options.matchId,
    seat: () => seat,
    status: () => connection.status(),
    seatView: () => view,
    revision: () => view?.view.revision ?? 0,

    async submit(playerId, command: GameCommand) {
      const current = view;
      if (current === null) {
        throw new Error(
          'This seat has no state from the server yet, so there is nothing to act on. '
          + 'Wait for the table to appear.',
        );
      }
      // The seat is fixed by the credential; the server attributes a command to the
      // authenticated seat and would ignore any other name. Refusing here means a screen
      // bug says so rather than quietly acting as the wrong player.
      if (seat !== null && playerId !== seat.playerId) {
        throw new Error(
          `This connection holds seat ${seat.playerId}, so it cannot act for ${playerId}.`,
        );
      }

      const envelope: CommandEnvelope = {
        matchId: options.matchId,
        commandId: newCommandId(),
        expectedRevision: current.view.revision,
        command,
      };
      const requestId = envelope.commandId;

      return new Promise<CommandResponse>((resolve, reject) => {
        const cancelTimeout = schedule(() => {
          pending.delete(requestId);
          reject(new Error(
            'The server has not answered this command. It may or may not have been applied: '
            + 'read the table again and choose from what it says now rather than sending it again.',
          ));
        }, commandTimeoutMs);

        pending.set(requestId, { envelope, requestId, resolve, reject, cancelTimeout });
        // A command sent while the connection is down stays pending and is sent on the
        // next welcome. The status already tells the player the table is out of reach.
        connection.send({ type: 'submit', requestId, envelope });
      });
    },

    viewFor(viewer: Viewer): MatchViewResult {
      const current = view;
      if (viewer.kind !== 'player' || (seat !== null && viewer.playerId !== seat.playerId)) {
        return {
          ok: false,
          code: 'NO_PROJECTION',
          message:
            'The server projects this match for one seat at a time, and this connection holds '
            + `${seat?.playerId ?? 'no seat yet'}. There is no other projection in this browser to show.`,
          view: null,
        };
      }
      if (current === null) {
        return {
          ok: false,
          code: 'NO_PROJECTION',
          message: 'The server has not sent this seat’s view of the match yet.',
          view: null,
        };
      }
      if (current.promptProblem !== null) {
        return {
          ok: false,
          code: 'UNSUPPORTED_PROMPT',
          message: current.promptProblem,
          view: current.view,
        };
      }
      return { ok: true, view: current.view };
    },

    resync() {
      connection.send({ type: 'resync', sinceEventCursor: cursor });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close() {
      connection.close();
      abandon('This connection was closed before the server answered.');
      announce();
    },
  };

  return match;
}
