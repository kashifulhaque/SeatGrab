/**
 * The WebSocket surface.
 *
 * This transport sits beside the HTTP one rather than replacing it, and it has the same
 * shape: a frame is read, handed to the room service — through the hub, which sequences
 * it and announces the result — and turned into an answer. Every rule decision and every
 * authorization decision still happens in `RoomService`. No frame reaches `applyCommand`
 * or `projectGame`, and nothing here decides what a seat may see.
 *
 * What the socket adds over polling `GET /api/matches/:id/state` is only that the server
 * says when the answer changed. The answer itself is the same `SeatView`, from the same
 * `projectGame` call, one per seat.
 *
 * Three refusals live in the connection rather than in a handler, because a caller must
 * not be able to reach a handler to trip them: the origin allowlist runs before the
 * upgrade, the frame-size ceiling is the socket's own `maxPayload`, and a connection that
 * never authenticates is closed on a timer.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';

import {
  ClientFrameSchema,
  SOCKET_CLOSE,
  SOCKET_PATH,
  type ServerFrame,
  type SocketSeatIdentity,
  type SyncPayload,
} from '@seatgrab/protocol';

import type { ServerConfig } from '../config.js';
import { readBearer } from '../credentials.js';
import type { MatchHub } from '../rooms/matchHub.js';
import { RoomError, type RoomService, type SeatIdentity } from '../rooms/roomService.js';

import { isOriginAllowed, readOrigin } from './origin.js';
import { SeatRateLimiter } from './rateLimiter.js';

/**
 * The half of a WebSocket this transport uses.
 *
 * `@fastify/websocket` re-exports the `ws` socket type, but `ws` ships no type
 * declarations and `@types/ws` is not a dependency of this workspace, so that type
 * resolves to `any` and would silently switch off checking for every call made on a
 * socket. Naming the four members used here keeps the checking, and documents the whole
 * of this file's dependency on the WebSocket implementation.
 */
export interface SocketLike {
  readonly readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: 'message' | 'close' | 'error', listener: (...args: never[]) => void) => void;
}

/** `WebSocket.OPEN`. Spelled out so this file needs no import from `ws`. */
const OPEN = 1;

export interface SocketRouteOptions {
  rooms: RoomService;
  hub: MatchHub;
  config: ServerConfig;
  /** Injected so tests do not wait on real time. Milliseconds, monotonic. */
  clock?: () => number;
}

interface ConnectionContext {
  rooms: RoomService;
  hub: MatchHub;
  config: ServerConfig;
  limiter: SeatRateLimiter;
}

/**
 * One connection's state machine, which has exactly two states.
 *
 * Before `authenticate` succeeds, a connection may do nothing but authenticate or ping.
 * After it, the seat is fixed for the life of the connection: no frame changes which seat
 * a connection speaks for, so no sequence of frames walks from one seat's projection to
 * another's.
 */
interface ConnectionState {
  seat: SeatIdentity | null;
  detach: (() => void) | null;
  closed: boolean;
}

/**
 * Drive one connection.
 *
 * Every refusal here answers with an `error` frame naming a code, and closes only when
 * the connection cannot usefully continue — a bad credential, an unreadable frame, a
 * missed deadline. A refused *command* is not one of those: it is an answer about the
 * game and arrives as an ordinary `commandResult`.
 */
function openConnection(
  socket: SocketLike,
  request: FastifyRequest,
  context: ConnectionContext,
): void {
  const { rooms, hub, config, limiter } = context;
  const state: ConnectionState = { seat: null, detach: null, closed: false };

  /** Send one frame, if the socket is still able to take it. */
  const send = (frame: ServerFrame): void => {
    if (state.closed || socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      request.log.warn({ err: error }, 'Failed to write a socket frame');
    }
  };

  const fail = (code: string, message: string, requestId?: string): void => {
    send({ type: 'error', code, message, ...(requestId === undefined ? {} : { requestId }) });
  };

  const shut = (code: number, reason: string): void => {
    if (state.closed) return;
    state.closed = true;
    try {
      socket.close(code, reason);
    } catch (error) {
      request.log.warn({ err: error }, 'Failed to close a socket');
    }
  };

  /**
   * A fresh projection, and whatever this seat missed.
   *
   * A room that is still a lobby has no state to project, which `RoomService` reports by
   * refusing the read. That is an answer about the match rather than a failure, so it
   * becomes `state: null` and the connection stays open: the host's start is broadcast,
   * so a client that connected early is told when the match begins.
   */
  const syncFor = (seat: SeatIdentity, since: number): SyncPayload => {
    const caughtUp = rooms.events(seat, since);
    try {
      return { state: rooms.viewFor(seat), events: caughtUp.events, cursor: caughtUp.cursor };
    } catch (error) {
      if (error instanceof RoomError && error.code === 'NOT_STARTED') {
        return { state: null, events: caughtUp.events, cursor: caughtUp.cursor };
      }
      throw error;
    }
  };

  // Section 14.1 keeps an unauthenticated connection from being a way to hold a server
  // resource. A socket that says nothing is closed on this timer.
  const deadline = setTimeout(() => {
    if (state.seat !== null) return;
    fail('AUTHENTICATION_TIMEOUT', 'This connection did not present a seat credential in time.');
    shut(SOCKET_CLOSE.authenticationTimeout, 'authentication timeout');
  }, config.socketAuthenticationTimeoutSeconds * 1000);
  deadline.unref();

  /**
   * Take a seat.
   *
   * `RoomService.authenticate` is the whole of the decision, exactly as it is for an
   * HTTP request. The credential is never echoed back and never logged, and a refusal
   * says only that it does not hold a seat here — not which of the several ways it
   * failed to.
   */
  const authenticate = (matchId: string, credential: string, since: number): void => {
    if (state.seat !== null) {
      fail('ALREADY_AUTHENTICATED', 'This connection already holds a seat.');
      return;
    }
    let seat: SeatIdentity;
    try {
      seat = rooms.authenticate(matchId, credential);
    } catch (error) {
      if (error instanceof RoomError) {
        fail(error.code, error.message);
        shut(SOCKET_CLOSE.unauthorized, error.code);
        return;
      }
      request.log.error({ err: error }, 'Socket authentication failed');
      fail('INTERNAL_ERROR', 'This connection could not be authenticated.');
      shut(SOCKET_CLOSE.unauthorized, 'INTERNAL_ERROR');
      return;
    }

    clearTimeout(deadline);
    state.seat = seat;
    const identity: SocketSeatIdentity = {
      matchId: seat.matchId,
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      isHost: seat.isHost,
      displayName: seat.displayName,
      partyId: seat.partyId,
    };
    state.detach = hub.attach({ seat, send });
    send({ type: 'welcome', seat: identity, sync: syncFor(seat, since) });
  };

  const handle = async (raw: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('BAD_FRAME', 'This frame is not JSON.');
      shut(SOCKET_CLOSE.badFrame, 'bad frame');
      return;
    }

    const frame = ClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      fail('BAD_FRAME', `This is not a frame this server reads: ${frame.error.message}`);
      return;
    }
    const requestId = 'requestId' in frame.data ? frame.data.requestId : undefined;

    // The budget belongs to the seat once there is one, and to the connection before
    // that, so an unauthenticated flood is bounded too.
    const budgetKey = state.seat === null
      ? `anon:${request.id}`
      : `${state.seat.matchId}:${state.seat.playerId}`;
    if (!limiter.take(budgetKey)) {
      fail(
        'RATE_LIMITED',
        'Frames are arriving faster than this seat’s budget allows. Wait a moment and send it again.',
        requestId,
      );
      return;
    }

    if (frame.data.type === 'ping') {
      send({ type: 'pong', ...(requestId === undefined ? {} : { requestId }) });
      return;
    }

    if (frame.data.type === 'authenticate') {
      authenticate(frame.data.matchId, frame.data.credential, frame.data.sinceEventCursor ?? 0);
      return;
    }

    const seat = state.seat;
    if (seat === null) {
      fail(
        'NOT_AUTHENTICATED',
        'Present the seat credential issued when the seat was claimed before sending anything else.',
        requestId,
      );
      return;
    }

    if (frame.data.type === 'resync') {
      send({
        type: 'sync',
        ...(requestId === undefined ? {} : { requestId }),
        sync: syncFor(seat, frame.data.sinceEventCursor ?? 0),
      });
      return;
    }

    // A submit. The hub sequences it against every other change to this match and sends
    // each attached seat its own fresh projection; this handler forwards the answer to
    // the seat that asked, and nothing else.
    try {
      const { response, duplicate } = await hub.submit(seat, frame.data.envelope);
      send({ type: 'commandResult', requestId: frame.data.requestId, response, duplicate });
    } catch (error) {
      if (error instanceof RoomError) {
        fail(error.code, error.message, frame.data.requestId);
        return;
      }
      request.log.error({ err: error }, 'Unhandled failure applying a socket command');
      fail(
        'INTERNAL_ERROR',
        'The server failed to decide this command. The failure is in the server log.',
        frame.data.requestId,
      );
    }
  };

  socket.on('message', ((data: { toString: () => string }) => {
    void handle(data.toString()).catch((error: unknown) => {
      request.log.error({ err: error }, 'Unhandled failure reading a socket frame');
    });
  }) as (...args: never[]) => void);

  socket.on('close', ((() => {
    state.closed = true;
    clearTimeout(deadline);
    state.detach?.();
    state.detach = null;
    // Section 14.1's default disconnection behaviour: the seat keeps whatever it was
    // being asked for. Nothing here answers on its behalf, skips its turn or forfeits it
    // — the pending interaction is in the stored state and is still waiting.
    const seat = state.seat;
    if (seat !== null && hub.connectionCount(seat.matchId) === 0) {
      limiter.forget(`${seat.matchId}:${seat.playerId}`);
    }
  }) as unknown) as (...args: never[]) => void);

  socket.on('error', ((error: unknown) => {
    request.log.warn({ err: error }, 'Socket error');
  }) as (...args: never[]) => void);

  // A credential presented on the upgrade request authenticates immediately, so a
  // non-browser client need not send a frame to take its seat. A browser cannot set that
  // header on a WebSocket, so the `authenticate` frame is the path a player actually
  // uses, and putting the credential in the query string is not offered: section 14.2
  // rules that out for a stored secret, which a query string writes to every access log.
  const presented = readBearer(request.headers.authorization);
  const matchId = (request.query as { matchId?: string } | undefined)?.matchId;
  if (presented !== null && typeof matchId === 'string' && matchId.length > 0) {
    authenticate(matchId, presented, 0);
  }
}

export function registerSocketRoutes(app: FastifyInstance, options: SocketRouteOptions): void {
  const { rooms, hub, config } = options;
  const limiter = new SeatRateLimiter({
    burst: config.socketBurstFrames,
    perSecond: config.socketFramesPerSecond,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  void app.register(websocketPlugin, {
    options: {
      // Section 14.1's message-size rule, enforced by the socket itself: a frame larger
      // than this is never delivered to a handler, and `ws` closes the connection with
      // the protocol's own 1009. It is the same ceiling the HTTP body limit uses,
      // because the largest legitimate frame carries the same command envelope.
      maxPayload: config.maxBodyBytes,
      // No compression. A shared-context deflate stream between a server and clients
      // holding different secrets is a class of leak this application has no reason to
      // take on, and a command envelope is far too small for it to save anything worth
      // having.
      perMessageDeflate: false,
    },
  });

  // The route goes inside its own registration rather than beside the plugin's. A route
  // added at the root while the plugin is still queued misses the `onRoute` hook that
  // turns its handler into a socket handler, and is then called with a request where it
  // expects a socket. Nesting is what orders the two.
  void app.register(async (instance: FastifyInstance) => {
    instance.get(
      SOCKET_PATH,
      {
        websocket: true,
        onRequest: (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void) => {
          const origin = readOrigin(request.headers.origin);
          if (!isOriginAllowed(origin, config.allowedOrigins)) {
            request.log.warn({ origin }, 'Refused a socket upgrade from an unlisted origin');
            void reply.status(403).send({
              ok: false,
              code: 'ORIGIN_NOT_ALLOWED',
              message: 'This server does not accept socket connections from that origin.',
            });
            return;
          }
          done();
        },
      },
      (socket: SocketLike, request: FastifyRequest) =>
        openConnection(socket, request, { rooms, hub, config, limiter }),
    );
  });
}
