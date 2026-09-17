/**
 * Build the server without starting it.
 *
 * `index.ts` listens; this file only assembles. Keeping them apart means a test drives
 * the real routes, the real service and a real database file through `app.inject`
 * without binding a port, and means the same assembly runs in both places.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { GameContent } from '@gerrymander/engine';
import { CORE_CONTENT } from '@gerrymander/engine';

import type { ServerConfig } from './config.js';
import { openDatabase, type Database } from './persistence/database.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from './persistence/migrations.js';
import { MatchRepository } from './persistence/repository.js';
import { ComputerDriver } from './rooms/computerDriver.js';
import { MatchStore } from './rooms/matchStore.js';
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
  /** The authoritative state of every live match, and its checkpoints to the store. */
  store: MatchStore;
  /** Plays the computer seats. `index.ts` calls `recover()` once the port is open. */
  computers: ComputerDriver;
  /**
   * Closes the HTTP server, checkpoints every live match, then closes the store.
   *
   * The order matters more than it used to. State is authoritative in memory between
   * checkpoints, so a shutdown that closed the store without writing first would throw
   * away every command since the last one. `close` writes them, and reports rather than
   * swallows a write it could not do.
   */
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

/**
 * Assemble the server.
 *
 * Asynchronous because opening the store is: the migrations run against Cloudflare D1
 * over HTTP in a deployment, and against a local SQLite file otherwise. `index.ts`
 * awaits this before it listens, so a server that cannot reach its store fails to start
 * rather than failing on the first player's request.
 */
export async function buildServer(options: BuildOptions): Promise<BuiltServer> {
  const { config } = options;
  const content = options.content ?? CORE_CONTENT;
  const database = openDatabase(config);
  await runMigrations(database);

  const repository = new MatchRepository(database);
  const store = new MatchStore({
    repository,
    content,
    checkpointEveryCommands: config.checkpointEveryCommands,
    checkpointMaxDelayMs: config.checkpointMaxDelayMs,
    onCheckpointFailed: (matchId, error, pendingCommands) => {
      // Logged at error level with the match ID, like a refused computer move, and for
      // the same reason: the commands are still only in memory, and an operator has to
      // know before the process stops. The health route answers `database: degraded`
      // until a later checkpoint for that match succeeds.
      app.log.error(
        { err: error, matchId, pendingCommands },
        'Checkpoint to the store failed; these commands are held in memory only',
      );
    },
  });
  const rooms = new RoomService({
    repository,
    store,
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

  const computers = new ComputerDriver({
    rooms,
    hub,
    delayMs: config.computerDelayMs,
    log: {
      info: (details, message) => app.log.info(details, message),
      error: (details, message) => app.log.error(details, message),
    },
  });
  computers.attach();

  /**
   * Whether the store answered a trivial read recently.
   *
   * Deliberately separate from whether checkpoints are landing, which is
   * `store.healthy` and is reported on its own. Failing to reach the store is a reason
   * to answer 503 and be taken out of rotation; failing to write a checkpoint is not,
   * and conflating them would be actively harmful — a container marked unhealthy for a
   * failed checkpoint is a container something will restart, and the restart is what
   * discards the unwritten commands the degraded state exists to warn about.
   *
   * The ping is cached. `/health` is deliberately outside the request budget, so an
   * uncached check would let anyone turn health polling into traffic against D1, which
   * is billed and rate-limited. A few seconds of staleness is the right trade for a
   * route whose whole job is to keep answering while the server is busy.
   */
  const PING_CACHE_MS = 5000;
  let lastPingAt = 0;
  let lastPingOk = true;
  const databaseReady = async (): Promise<boolean> => {
    const at = (options.now ?? (() => new Date()))().getTime();
    if (at - lastPingAt < PING_CACHE_MS) return lastPingOk;
    lastPingAt = at;
    try {
      await database.ping();
      lastPingOk = true;
    } catch (error) {
      app.log.error({ err: error }, 'The store did not answer a health read');
      lastPingOk = false;
    }
    return lastPingOk;
  };

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
    databaseReady,
    checkpointsReady: () => store.healthy,
    computersReady: () => computers.healthy(),
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
    store,
    computers,
    async close() {
      computers.stop();
      await app.close();
      // Everything accepted and not yet checkpointed is written here. A failure is
      // logged rather than raised: the caller is a shutdown, and there is nothing left
      // to retry with, but an operator must be told which match lost commands.
      try {
        await store.flushAll();
      } catch (error) {
        app.log.error({ err: error }, 'Some matches could not be checkpointed during shutdown');
      }
      store.dispose();
      await database.close();
    },
  };
}
