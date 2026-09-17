/**
 * The process entry point.
 *
 * It reads the configuration, builds the server, listens, and shuts down cleanly. A
 * shutdown closes the HTTP server first so no new request starts, then closes the
 * database, so an accepted command is never left half-written; `commitCommand` is one
 * transaction, so a signal that arrives mid-command either commits it or rolls it back
 * whole.
 */
import { buildServer } from './app.js';
import { ConfigError, readServerConfig } from './config.js';

async function main(): Promise<void> {
  const config = readServerConfig();
  const built = buildServer({ config });
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
  app.log.info({ database: config.databasePath }, 'SeatGrab room server ready');
  // A match whose computer was mid-decision when the last process stopped has nothing
  // else to wake it: its people are watching a turn that never arrives.
  built.computers.recover();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
