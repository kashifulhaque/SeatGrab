/**
 * The WebSocket frame contracts.
 *
 * The socket carries the same three things the HTTP routes do — a fresh authorized
 * projection, a filtered event catch-up, and the answer to one submitted command — and
 * it carries them in the same shapes. `SeatView` is `GET /api/matches/:id/state`,
 * `SyncPayload` is that plus `GET /api/matches/:id/events?since=`, and `CommandResponse`
 * is what `POST /api/matches/:id/commands` answers. Section 14.4 asks a reconnecting
 * client to send a last-known cursor and receive an authorized fresh projection, not a
 * third shape invented for the socket.
 *
 * Frames a client sends are validated here, because the server must never trust them.
 * Frames the server sends are typed but not schema-checked on arrival: the server is the
 * authority for a projection's contents, and re-validating `PlayerView` in the browser
 * would be a second copy of the view contract that could only drift from this one.
 */
import { z } from 'zod';

import { CommandEnvelopeSchema } from './commands.js';
import type { CommandResponse, SeatView, VisibleEvent } from './views.js';

/** The path both transports agree on. The Vite dev server proxies it to the server. */
export const SOCKET_PATH = '/ws';

const id = z.string().min(1);

/**
 * Take this seat, with the credential issued when the seat was claimed.
 *
 * `sinceEventCursor` is the reconnect half: a client that already held a connection
 * sends the last cursor it saw and is told what it missed. It is a hint for the catch-up
 * only. The projection that comes back is always freshly authorized, and section 14.4 is
 * explicit that a reconnecting client's own snapshot is never the authority.
 */
export const AuthenticateFrameSchema = z.object({
  type: z.literal('authenticate'),
  matchId: id,
  credential: id,
  sinceEventCursor: z.int().nonnegative().optional(),
});

/**
 * Submit one command.
 *
 * `requestId` correlates the answer on a multiplexed connection and is the client's
 * own bookkeeping; the server echoes it and reads nothing else from it. Idempotency is
 * `envelope.commandId`, exactly as over HTTP: mint a fresh one per intent, and resend a
 * lost one unchanged.
 */
export const SubmitFrameSchema = z.object({
  type: z.literal('submit'),
  requestId: id,
  envelope: CommandEnvelopeSchema,
});

/** Ask for a fresh projection and everything after a cursor, without reconnecting. */
export const ResyncFrameSchema = z.object({
  type: z.literal('resync'),
  requestId: id.optional(),
  sinceEventCursor: z.int().nonnegative().optional(),
});

/** A liveness check. Answered with `pong` and nothing else. */
export const PingFrameSchema = z.object({
  type: z.literal('ping'),
  requestId: id.optional(),
});

export const ClientFrameSchema = z.discriminatedUnion('type', [
  AuthenticateFrameSchema,
  SubmitFrameSchema,
  ResyncFrameSchema,
  PingFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/** Who the connection is, as the server resolved it from the credential. */
export interface SocketSeatIdentity {
  matchId: string;
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  displayName: string;
  partyId: string;
}

/**
 * A fresh projection and the events after the requested cursor.
 *
 * `state` is `null` only while the room is still a lobby and has no state to project.
 * The host's start is broadcast, so a client that connects early is told when it begins
 * rather than having to poll for it.
 */
export interface SyncPayload {
  state: SeatView | null;
  events: readonly VisibleEvent[];
  cursor: number;
}

/**
 * Why the server closed or refused a connection.
 *
 * `BAD_CREDENTIAL`, `NO_SUCH_MATCH` and `SEAT_INCOMPLETE` are permanent for the
 * credential presented, so a client must stop retrying and say so. Everything else is
 * worth retrying.
 */
export const PERMANENT_SOCKET_ERRORS: readonly string[] = [
  'BAD_CREDENTIAL',
  'NO_CREDENTIAL',
  'NO_SUCH_MATCH',
  'SEAT_INCOMPLETE',
  'WRONG_MATCH',
];

export type ServerFrame =
  /** The connection is authenticated. Carries the seat and its first projection. */
  | { type: 'welcome'; seat: SocketSeatIdentity; sync: SyncPayload }
  /** The answer to a `resync`. */
  | { type: 'sync'; requestId?: string; sync: SyncPayload }
  /**
   * A fresh projection for this seat, after the match changed.
   *
   * One of these is produced per connected seat, by `projectGame` for that seat. The
   * server never broadcasts one state to every socket.
   */
  | { type: 'state'; state: SeatView }
  /** The answer to a `submit`. `duplicate` replays an already-decided command ID. */
  | { type: 'commandResult'; requestId: string; response: CommandResponse; duplicate: boolean }
  /** A refusal of the request itself, not a ruling about the game. */
  | { type: 'error'; code: string; message: string; requestId?: string }
  | { type: 'pong'; requestId?: string };

/** Close codes this server uses, in the private range WebSocket reserves for apps. */
export const SOCKET_CLOSE = {
  /** No `authenticate` frame arrived in time. */
  authenticationTimeout: 4408,
  /** The credential does not hold a seat in this match. Do not retry it. */
  unauthorized: 4401,
  /** Frames arrived faster than the seat's budget allows. */
  rateLimited: 4429,
  /** The frame was not readable as JSON, or not a frame this server knows. */
  badFrame: 4400,
} as const;

/*
 * A shutdown is not in this list on purpose. `@fastify/websocket` closes every client
 * itself when the server stops, without a status code, so a client sees a plain
 * connection loss and reconnects — which is the right behaviour, and naming a code here
 * that the server never sends would only claim otherwise.
 */
