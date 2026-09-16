/**
 * The SQLite connection.
 *
 * This server uses Node's built-in `node:sqlite`. That keeps the deployment to one Node
 * process and a mounted file with no native build step, which is what section 14.5 asks
 * for. The module is still marked experimental by Node, so the surface used here is
 * deliberately narrow — open, `exec`, `prepare`, `close` — and every call goes through
 * this file, so swapping the driver means rewriting this file and nothing else.
 *
 * `DatabaseSync` is synchronous on purpose. A transaction that never yields cannot be
 * interleaved with another request on the same event loop, which is what serializes
 * command processing per match in a single process. The repository relies on that: the
 * body of a transaction must contain no `await`.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/**
 * Open the database, creating its directory if needed, and apply the connection pragmas.
 *
 * `journal_mode = WAL` keeps a reader from blocking the writer; `synchronous = FULL`
 * means an acknowledged command has reached the disk, which is what section 14.3
 * requires before a command is acknowledged. `foreign_keys` is off by default in SQLite
 * and the schema depends on it.
 */
export function openDatabase(databasePath: string): Database {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

/**
 * Run `work` inside one transaction, rolling back if it throws.
 *
 * `BEGIN IMMEDIATE` takes the write lock at the start rather than on the first write, so
 * two writers fail to start instead of failing to upgrade halfway through. `work` must
 * be synchronous; an `await` inside it would let another request run against a state
 * this transaction is midway through changing.
 */
export function inTransaction<T>(database: Database, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = work();
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  database.exec('COMMIT');
  return result;
}
