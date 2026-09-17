/**
 * The local SQLite driver, over Node's built-in `node:sqlite`.
 *
 * This is what a development run, the test suite and a pass-and-play-only deployment
 * use, and it is still the driver the durability suite proves a restart against: a file
 * on disk that a second process opens and finds what the first one wrote.
 *
 * The surface used is deliberately narrow — open, `exec`, `prepare`, `close` — because
 * Node still marks the module experimental. `DatabaseSync` is synchronous; the promises
 * returned here are already settled. Nothing awaits a disk here, so nothing interleaves,
 * and the local driver keeps the stronger guarantee for free.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SqlDriver, SqlResult, SqlRow, SqlStatement, SqlValue } from './driver.js';

export class LocalSqliteDriver implements SqlDriver {
  readonly describe: string;
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath);
    // `journal_mode = WAL` keeps a reader from blocking the writer; `synchronous = FULL`
    // means an acknowledged write has reached the disk. `foreign_keys` is off by default
    // in SQLite and the schema depends on it. None of the four have a D1 equivalent, and
    // none need one: D1 makes its own durability guarantee.
    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = FULL');
    this.#database.exec('PRAGMA foreign_keys = ON');
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.describe = `sqlite ${databasePath}`;
  }

  async all(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    return this.#database.prepare(sql).all(...params) as SqlRow[];
  }

  async get(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow | undefined> {
    return this.#database.prepare(sql).get(...params) as SqlRow | undefined;
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
    const result = this.#database.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  /**
   * Run every statement inside one transaction, rolling back if any of them throws.
   *
   * `BEGIN IMMEDIATE` takes the write lock at the start rather than on the first write,
   * so two writers fail to start instead of failing to upgrade halfway through.
   */
  async batch(statements: readonly SqlStatement[]): Promise<SqlResult[]> {
    if (statements.length === 0) return [];
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        const result = this.#database.prepare(statement.sql).run(...(statement.params ?? []));
        return { changes: Number(result.changes) };
      });
      this.#database.exec('COMMIT');
      return results;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async ping(): Promise<void> {
    this.#database.prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.#database.close();
  }
}
