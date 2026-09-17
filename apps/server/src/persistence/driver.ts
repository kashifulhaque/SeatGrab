/**
 * The SQL driver seam.
 *
 * `database.ts` used to open `node:sqlite` directly and its own comment promised that
 * swapping the driver meant rewriting that file and nothing else. Moving the durable
 * store to Cloudflare D1 is that swap, and this is the seam it needed: an interface with
 * two implementations, chosen by configuration.
 *
 * Every method is asynchronous, including the local one, which returns settled promises.
 * A driver that is synchronous in development and asynchronous in production would be a
 * server whose concurrency is only tested in the shape it does not deploy.
 *
 * There is no interactive transaction here, and that is deliberate rather than a gap.
 * D1 has none to expose: a caller cannot hold a transaction open across a network round
 * trip, read a row, decide, and then write. `batch` is what both drivers can honestly
 * offer — a list of statements decided in advance, submitted together. The repository is
 * written to that shape, and `rooms/matchStore.ts` is what makes it possible, because it
 * decides against in-memory state rather than against a row it has to re-read.
 */

/** The value types a bound parameter may carry. SQLite's own set, minus blobs. */
export type SqlValue = string | number | null;

/** One statement and its bound parameters. Only anonymous `?` binds: D1 allows no other. */
export interface SqlStatement {
  sql: string;
  params?: readonly SqlValue[];
}

/** A row as the driver returns it, before the repository names its columns. */
export type SqlRow = Record<string, unknown>;

/** What a write reports. `changes` is what the guarded updates test. */
export interface SqlResult {
  changes: number;
}

export interface SqlDriver {
  /**
   * How this driver is reached, for the startup log and the health route.
   *
   * It names the file or the database, never a token.
   */
  readonly describe: string;

  all(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  get(sql: string, params?: readonly SqlValue[]): Promise<SqlRow | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;

  /**
   * Submit several statements together, in order.
   *
   * Both drivers run them as one transaction where they can. Callers must not depend on
   * it: see `rooms/checkpoint.ts`, which orders every batch so that the last statement
   * is the one that makes the rest visible, and so a partial batch is recoverable by
   * being sent again.
   */
  batch(statements: readonly SqlStatement[]): Promise<SqlResult[]>;

  /** A trivial read, for the health route. Throws when the store cannot be reached. */
  ping(): Promise<void>;

  close(): Promise<void>;
}
