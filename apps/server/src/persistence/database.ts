/**
 * Open the durable store.
 *
 * This file used to hold the `node:sqlite` connection and promised that swapping the
 * driver meant rewriting it and nothing else. That is what happened: the two drivers are
 * `localDriver.ts` and `d1Driver.ts`, the interface between them is `driver.ts`, and
 * this file is now only the choice between them.
 *
 * The choice is a deployment's, not a build's. A configuration that names a D1 database
 * gets D1; one that does not gets a local SQLite file, which is what a development run
 * and the test suite use. Both satisfy the same interface, so nothing above this file
 * knows which one it has.
 */
import type { ServerConfig } from '../config.js';
import { D1HttpDriver } from './d1Driver.js';
import type { SqlDriver } from './driver.js';
import { LocalSqliteDriver } from './localDriver.js';

export type { SqlDriver, SqlRow, SqlStatement, SqlValue } from './driver.js';

/** Kept as the name the rest of the server already imports. */
export type Database = SqlDriver;

export function openDatabase(config: ServerConfig): Database {
  if (config.d1 !== null) {
    return new D1HttpDriver({
      accountId: config.d1.accountId,
      databaseId: config.d1.databaseId,
      apiToken: config.d1.apiToken,
      timeoutMs: config.d1.timeoutMs,
      maxAttempts: config.d1.maxAttempts,
    });
  }
  return new LocalSqliteDriver(config.databasePath);
}
