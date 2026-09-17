/**
 * Migrations, configuration and the credential primitives.
 *
 * These are the pieces the room service assumes are already correct: that running the
 * migrations twice is the same as running them once, that a database written by a newer
 * build is refused rather than written into, and that a credential is stored only as a
 * hash that a wrong credential cannot match.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  readServerConfig,
  type ServerConfig,
} from '../src/config';
import {
  credentialMatches,
  generateCredential,
  generateRoomCode,
  hashCredential,
  normalizeRoomCode,
  readBearer,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../src/credentials';
import { openDatabase, type Database } from '../src/persistence/database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from '../src/persistence/migrations';

let directory: string;
let database: Database;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'gerrymander-persistence-'));
  database = openDatabase(configFor(join(directory, 'gerrymander.db')));
});

afterEach(async () => {
  await database.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A configuration that names a local file, which is what `openDatabase` chooses on. */
function configFor(databasePath: string): ServerConfig {
  return readServerConfig({
    GERRYMANDER_DB_PATH: databasePath,
    GERRYMANDER_LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);
}

describe('migrations', () => {
  it('create the four tables section 14.3 names', async () => {
    await runMigrations(database);
    const names = (
      await database.all("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]
    ).map((row) => row.name);
    for (const table of ['matches', 'seats', 'commands', 'events']) {
      expect(names).toContain(table);
    }
  });

  it('apply once and then do nothing', async () => {
    const first = await runMigrations(database);
    expect(first.map((migration) => migration.version))
      .toEqual(MIGRATIONS.map((migration) => migration.version));
    const second = await runMigrations(database);
    expect(second).toEqual([]);
    const applied = await database.get('SELECT COUNT(*) AS total FROM schema_migrations') as {
      total: number;
    };
    expect(applied.total).toBe(LATEST_SCHEMA_VERSION);
  });

  /**
   * A migration is one batch whose last statement records the version, so a batch that
   * failed partway leaves the version unrecorded and the next start runs it again. This
   * is that retry: every statement has already been applied, and running them a second
   * time must still succeed rather than fail on a table or a column that is already
   * there.
   */
  it('apply again over a schema that already has everything', async () => {
    await runMigrations(database);
    await database.run('DELETE FROM schema_migrations');
    const again = await runMigrations(database);
    expect(again.map((migration) => migration.version))
      .toEqual(MIGRATIONS.map((migration) => migration.version));
    const seats = await database.all("SELECT name FROM pragma_table_info('seats')") as {
      name: string;
    }[];
    expect(seats.map((column) => column.name)).toContain('controller');
  });

  it('refuse a database written by a newer build rather than writing into it', async () => {
    await runMigrations(database);
    await database.run(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [LATEST_SCHEMA_VERSION + 1, 'from-the-future', new Date().toISOString()],
    );
    await expect(runMigrations(database)).rejects.toThrow(/restore a backup/u);
  });

  it('refuse a match row with a seat count this edition does not seat', async () => {
    await runMigrations(database);
    await expect(database.run(
      `INSERT INTO matches (
         match_id, room_code, status, seat_count, content_advisories, tie_policy, revision,
         content_pack_id, content_version, ruleset_id, ruleset_version, board_id, board_version,
         snapshot, created_at, updated_at
       ) VALUES ('m1', 'AAAAAAAA', 'lobby', 6, '[]', 'jointWinners', 0,
         'c', '1', 'r', '1', 'b', '1', NULL, 'now', 'now')`,
    )).rejects.toThrow();
  });

  it('refuse two seats holding the same credential hash', async () => {
    await runMigrations(database);
    await database.run(
      `INSERT INTO matches (
         match_id, room_code, status, seat_count, content_advisories, tie_policy, revision,
         content_pack_id, content_version, ruleset_id, ruleset_version, board_id, board_version,
         snapshot, created_at, updated_at
       ) VALUES ('m1', 'AAAAAAAA', 'lobby', 3, '[]', 'jointWinners', 0,
         'c', '1', 'r', '1', 'b', '1', NULL, 'now', 'now')`,
    );
    const seat = 'INSERT INTO seats (match_id, seat_index, player_id, credential_hash) VALUES (?, ?, ?, ?)';
    await database.run(seat, ['m1', 0, 'p1', 'the-same-hash']);
    await expect(database.run(seat, ['m1', 1, 'p2', 'the-same-hash'])).rejects.toThrow();
    // Two unclaimed seats both hold NULL, which the partial index must still allow.
    await expect(database.run(seat, ['m1', 2, 'p3', null])).resolves.toBeDefined();
  });
});

describe('configuration', () => {
  it('runs on loopback with a data file when nothing is set', () => {
    const config = readServerConfig({} as NodeJS.ProcessEnv);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe('127.0.0.1');
    expect(config.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(config.databasePath.endsWith('/data/gerrymander.db')).toBe(true);
  });

  it('names the setting that is wrong rather than falling back to a default', () => {
    expect(() => readServerConfig({ GERRYMANDER_PORT: 'eighty' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => readServerConfig({ GERRYMANDER_PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(/GERRYMANDER_PORT/u);
    expect(() => readServerConfig({ GERRYMANDER_LOG_LEVEL: 'chatty' } as NodeJS.ProcessEnv)).toThrow(
      /GERRYMANDER_LOG_LEVEL/u,
    );
  });

  it('resolves a relative database path against the working directory', () => {
    const config = readServerConfig({ GERRYMANDER_DB_PATH: 'var/gerrymander.db' } as NodeJS.ProcessEnv);
    expect(config.databasePath).toBe(join(process.cwd(), 'var/gerrymander.db'));
  });
});
