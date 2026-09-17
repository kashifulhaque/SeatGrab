/**
 * The process entry point.
 *
 * It reads the configuration, builds the server, listens, and shuts down cleanly. A
 * shutdown closes the HTTP server first so no new request starts, then checkpoints every
 * live match, then closes the store. That order is what makes a clean stop lossless:
 * between checkpoints the authority is in memory, so a shutdown that skipped the write
 * would discard every command since the last one.
 *
 * `SIGTERM` and `SIGINT` both take that path. A kill that gives the process no chance to
 * run it does lose the commands since the last checkpoint — see `rooms/matchStore.ts`,
 * which says what that window is and how to narrow it.
 */
import { buildServer } from './app.js';
import { ConfigError, readServerConfig } from './config.js';

async function main(): Promise<void> {
  const config = readServerConfig();
  // Awaited: building the server runs the migrations, which reach Cloudflare D1 over
  // HTTP in a deployment. A store this process cannot reach stops it here, before the
  // port is open, rather than on the first player's request.
  const built = await buildServer({ config });
  const { app } = built;

  let shuttingDown = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    const deadline = setTimeout(() => {
      app.log.error(
        { seconds: config.shutdownTimeoutSeconds },
        'Requests did not finish in time; exiting anyway',
      );
      process.exit(1);
    }, config.shutdownTimeoutSeconds * 1000);
    deadline.unref();
    built
      .close()
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      store: built.database.describe,
      checkpointEveryCommands: config.checkpointEveryCommands,
      checkpointMaxDelayMs: config.checkpointMaxDelayMs,
    },
    'Gerrymander room server ready',
  );
  // A match whose computer was mid-decision when the last process stopped has nothing
  // else to wake it: its people are watching a turn that never arrives.
  void built.computers.recover().catch((error: unknown) => {
    app.log.error({ err: error }, 'Could not resume the matches that seat a computer');
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
