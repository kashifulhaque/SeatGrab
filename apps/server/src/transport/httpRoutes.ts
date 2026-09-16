/**
 * The HTTP surface.
 *
 * Routes do three things and nothing else: read the request, hand it to the room
 * service, and turn the answer into a status code. Every rule decision and every
 * authorization decision happens in the service, which is how the WebSocket transport in
 * `socketRoutes.ts` reaches the same behavior without repeating any of it.
 *
 * The two routes that change a match go through `MatchHub` rather than calling the
 * service directly, so they are sequenced against socket commands to the same match and
 * so a player watching over a socket is told what they did.
 *
 * Two routes carry the room code and are readable by anyone holding it. Every route that
 * reads or changes a match needs the seat credential, in an `Authorization: Bearer`
 * header. No route answers with a credential except the two that mint one.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { readBearer } from '../credentials.js';
import type { MatchHub } from '../rooms/matchHub.js';
import { RoomError, type RoomService, type SeatIdentity } from '../rooms/roomService.js';
import { TokenBucketLimiter } from './rateLimiter.js';

const CreateRoomSchema = z.object({
  seatCount: z.int(),
  displayName: z.string(),
  partyId: z.string(),
  contentAdvisories: z.array(z.string()).max(4).optional(),
});

const ClaimSeatSchema = z.object({
  seatIndex: z.int().nonnegative().max(4).optional(),
  displayName: z.string(),
  partyId: z.string(),
});

function badBody(error: z.ZodError): never {
  throw new RoomError(400, 'INVALID_BODY', `This request body is not usable: ${error.message}`);
}

export interface RouteOptions {
  rooms: RoomService;
  /**
   * Sequences the two routes that change a match, and announces the result.
   *
   * Both transports change a match through the same hub, so an HTTP command and a
   * socket command to one match are decided one after the other rather than at once,
   * and a player watching over a socket sees an HTTP command's result.
   */
  hub: MatchHub;
  /** Reported by the health route so an operator can tell which build is running. */
  version: { schemaVersion: number; contentPackId: string; contentVersion: string; boardId: string };
  /** Whether the database answered a trivial read. */
  databaseReady: () => boolean;
  startedAt: Date;
  now?: () => Date;
  /**
   * The per-address budget for `/api/*`, or nothing to leave the surface unlimited.
   *
   * Left out, every `/api` route is unbounded — which is what the server did before, and
   * is only safe on loopback. `app.ts` always supplies one; the option exists so a test
   * can pin the clock rather than wait for a real second to pass.
   */
  limiter?: TokenBucketLimiter;
}

export function registerRoutes(app: FastifyInstance, options: RouteOptions): void {
  const { rooms, hub } = options;
  const now = options.now ?? (() => new Date());
  const limiter = options.limiter;

  /**
   * The per-address budget, applied before a route runs.
   *
   * `/health` is deliberately outside it: a monitor polls health on a fixed schedule, and
   * a health check that starts failing because the server is busy reports the opposite of
   * what it is for.
   *
   * The key is `request.ip`, which is the socket address unless the server was configured
   * to trust a proxy header. Behind a proxy that is not trusted, every request shares one
   * bucket — see `trustProxy` in `config.ts`, which says what to do about it.
   */
  if (limiter !== undefined) {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.url.startsWith('/api/')) return;
      if (limiter.take(request.ip)) return;
      await reply.status(429).send({
        ok: false,
        code: 'RATE_LIMITED',
        message: 'This client is sending requests faster than the server accepts them. Wait a moment and try again.',
      });
    });
  }

  function seatOf(request: FastifyRequest, matchId: string): SeatIdentity {
    return rooms.authenticate(matchId, readBearer(request.headers.authorization));
  }

  /**
   * Liveness and readiness in one.
   *
   * It names the build and the content pack so a deployment mismatch is visible, and
   * nothing else: no room code, no seat, no count of who is playing.
   */
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const ready = options.databaseReady();
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'degraded',
      database: ready ? 'ok' : 'unavailable',
      uptimeSeconds: Math.floor((now().getTime() - options.startedAt.getTime()) / 1000),
      ...options.version,
    });
  });

  app.post('/api/rooms', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateRoomSchema.safeParse(request.body);
    if (!parsed.success) badBody(parsed.error);
    const claim = rooms.createRoom({
      seatCount: parsed.data.seatCount,
      displayName: parsed.data.displayName,
      partyId: parsed.data.partyId,
      contentAdvisories: parsed.data.contentAdvisories ?? [],
    });
    return reply.status(201).send(claim);
  });

  app.get('/api/rooms/:roomCode', async (request: FastifyRequest, reply: FastifyReply) => {
    const { roomCode } = request.params as { roomCode: string };
    return reply.send(rooms.lobby(roomCode));
  });

  app.post('/api/rooms/:roomCode/seats', async (request: FastifyRequest, reply: FastifyReply) => {
    const { roomCode } = request.params as { roomCode: string };
    const parsed = ClaimSeatSchema.safeParse(request.body);
    if (!parsed.success) badBody(parsed.error);
    const claim = rooms.claimSeat({
      roomCode,
      displayName: parsed.data.displayName,
      partyId: parsed.data.partyId,
      ...(parsed.data.seatIndex === undefined ? {} : { seatIndex: parsed.data.seatIndex }),
    });
    return reply.status(201).send(claim);
  });

  /**
   * The host frees a seat, so a player who lost their credential can claim it again.
   *
   * It takes the host's credential rather than the room code, and the service refuses it
   * once the match has started — see `RoomService.releaseSeat`, which decides all of it.
   * The answer is the lobby, so the host's screen repaints from the same shape it polls.
   */
  app.delete('/api/matches/:matchId/seats/:seatIndex', async (request: FastifyRequest, reply: FastifyReply) => {
    const { matchId, seatIndex } = request.params as { matchId: string; seatIndex: string };
    const index = Number(seatIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new RoomError(400, 'NO_SUCH_SEAT', 'A seat is named by its whole-number index.');
    }
    return reply.send(rooms.releaseSeat(seatOf(request, matchId), index));
  });

  app.post('/api/matches/:matchId/start', async (request: FastifyRequest, reply: FastifyReply) => {
    const { matchId } = request.params as { matchId: string };
    return reply.send(await hub.start(seatOf(request, matchId)));
  });

  /**
   * The seat's own fresh projection.
   *
   * This is also the reconnect path: a client that lost its connection asks for this and
   * gets the current authorized view, not its own remembered state. Section 14.4 is
   * explicit that a reconnecting client's snapshot is never the authority.
   */
  app.get('/api/matches/:matchId/state', async (request: FastifyRequest, reply: FastifyReply) => {
    const { matchId } = request.params as { matchId: string };
    return reply.send(rooms.viewFor(seatOf(request, matchId)));
  });

  app.get('/api/matches/:matchId/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const { matchId } = request.params as { matchId: string };
    const query = request.query as { since?: string };
    const since = query.since === undefined ? 0 : Number(query.since);
    if (!Number.isInteger(since) || since < 0) {
      throw new RoomError(400, 'INVALID_CURSOR', '"since" must be a whole event cursor, or be left out.');
    }
    return reply.send(rooms.events(seatOf(request, matchId), since));
  });

  app.post('/api/matches/:matchId/commands', async (request: FastifyRequest, reply: FastifyReply) => {
    const { matchId } = request.params as { matchId: string };
    const seat = seatOf(request, matchId);
    const { response, duplicate } = await hub.submit(seat, request.body);
    // A refused command is a legitimate answer about the game, not a broken request, so
    // it is 200 with `ok: false` and the engine's own code. The client reads the body.
    return reply.status(200).send({ ...response, duplicate });
  });
}
