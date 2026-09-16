/**
 * Build the server without starting it.
 *
 * `index.ts` listens; this file only assembles. Keeping them apart means a test drives
 * the real routes, the real service and a real database file through `app.inject`
 * without binding a port, and means the same assembly runs in both places.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { GameContent } from '@seatgrab/engine';
import { CORE_CONTENT } from '@seatgrab/engine';

import type { ServerConfig } from './config.js';
import { openDatabase, type Database } from './persistence/database.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from './persistence/migrations.js';
import { MatchRepository } from './persistence/repository.js';
import { MatchHub } from './rooms/matchHub.js';
import { RoomError, RoomService } from './rooms/roomService.js';
import { registerRoutes } from './transport/httpRoutes.js';
import { TokenBucketLimiter } from './transport/rateLimiter.js';
import { registerSocketRoutes } from './transport/socketRoutes.js';

export interface BuiltServer {
  app: FastifyInstance;
  database: Database;
  rooms: RoomService;
  /** Sequences every change to a match and announces it to the seats watching. */
  hub: MatchHub;
  /** Closes the HTTP server and then the database, in that order. */
  close: () => Promise<void>;
}

export interface BuildOptions {
  config: ServerConfig;
  content?: GameContent;
  /** Injected so tests can pin timestamps. No rule reads a timestamp. */
  now?: () => Date;
  /** Injected so tests can pin the deal. Production uses the system generator. */
  seed?: () => number;
}

export function buildServer(options: BuildOptions): BuiltServer {
  const { config } = options;
  const content = options.content ?? CORE_CONTENT;
  const database = openDatabase(config.databasePath);
  runMigrations(database);

  const repository = new MatchRepository(database);
  const rooms = new RoomService({
    repository,
    content,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });

  const app = Fastify({
    logger: { level: config.logLevel },
    // Section 14.1 asks for a bounded message size. A command envelope is small; this
    // ceiling refuses a body large enough to be an attack on JSON parsing alone.
    bodyLimit: config.maxBodyBytes,
    // A trailing slash should not be a different route.
    routerOptions: { ignoreTrailingSlash: true },
    // Off unless an operator turns it on. `request.ip` is what the HTTP budget counts,
    // and trusting a forwarding header nobody sets would let a caller pick its own key.
    trustProxy: config.trustProxy,
    disableRequestLogging: config.logLevel !== 'debug' && config.logLevel !== 'trace',
  });

  /**
   * One error shape for every failure.
   *
   * A `RoomError` carries a message written for the player who caused it. Anything else
   * is a bug in this server, and its message is logged rather than returned: an
   * unexpected error message can name a table, a column, or a stored value, and section
   * 14.2 lists error messages among the surfaces to audit for leakage.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof RoomError) {
      return reply.status(error.status).send({ ok: false, code: error.code, message: error.message });
    }
    if (error.statusCode === 413) {
      return reply.status(413).send({
        ok: false,
        code: 'BODY_TOO_LARGE',
        message: `This request body is larger than the ${config.maxBodyBytes}-byte limit.`,
      });
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        ok: false,
        code: 'BAD_REQUEST',
        message: 'This request could not be read.',
      });
    }
    request.log.error({ err: error }, 'Unhandled server error');
    return reply.status(500).send({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'The server failed to handle this request. The failure is in the server log.',
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ ok: false, code: 'NO_SUCH_ROUTE', message: 'No such route.' }),
  );

  const hub = new MatchHub({
    rooms,
    onBroadcastError: (error, seat) => {
      // One seat's projection failing is that seat's problem to surface, not a reason
      // for the rest of the table to stop being told what happened.
      app.log.error({ err: error, matchId: seat.matchId, seatIndex: seat.seatIndex },
        'Failed to project a seat for a broadcast');
    },
  });

  registerSocketRoutes(app, { rooms, hub, config });

  registerRoutes(app, {
    rooms,
    hub,
    version: {
      schemaVersion: LATEST_SCHEMA_VERSION,
      contentPackId: content.contentPackId,
      contentVersion: content.contentVersion,
      boardId: content.board.id,
    },
    databaseReady: () => {
      try {
        database.prepare('SELECT 1 AS ok').get();
        return true;
      } catch {
        return false;
      }
    },
    startedAt: (options.now ?? (() => new Date()))(),
    ...(options.now === undefined ? {} : { now: options.now }),
    limiter: new TokenBucketLimiter({
      burst: config.httpBurstRequests,
      perSecond: config.httpRequestsPerSecond,
    }),
  });

  return {
    app,
    database,
    rooms,
    hub,
    async close() {
      await app.close();
      database.close();
    },
  };
}
