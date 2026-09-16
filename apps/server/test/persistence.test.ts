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

import { ConfigError, DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT, readServerConfig } from '../src/config';
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
import { LATEST_SCHEMA_VERSION, runMigrations } from '../src/persistence/migrations';

let directory: string;
let database: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'seatgrab-persistence-'));
  database = openDatabase(join(directory, 'seatgrab.db'));
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('migrations', () => {
  it('create the four tables section 14.3 names', () => {
    runMigrations(database);
    const names = (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of ['matches', 'seats', 'commands', 'events']) {
      expect(names).toContain(table);
    }
  });

  it('apply once and then do nothing', () => {
    const first = runMigrations(database);
    expect(first.map((migration) => migration.version)).toEqual([LATEST_SCHEMA_VERSION]);
    const second = runMigrations(database);
    expect(second).toEqual([]);
    const applied = database.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as {
      total: number;
    };
    expect(applied.total).toBe(LATEST_SCHEMA_VERSION);
  });

  it('refuse a database written by a newer build rather than writing into it', () => {
    runMigrations(database);
    database
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(LATEST_SCHEMA_VERSION + 1, 'from-the-future', new Date().toISOString());
    expect(() => runMigrations(database)).toThrow(/restore a backup/u);
  });

  it('refuse a match row with a seat count this edition does not seat', () => {
    runMigrations(database);
    const insert = (): void => {
      database
        .prepare(
          `INSERT INTO matches (
             match_id, room_code, status, seat_count, content_advisories, tie_policy, revision,
             content_pack_id, content_version, ruleset_id, ruleset_version, board_id, board_version,
             snapshot, created_at, updated_at
           ) VALUES ('m1', 'AAAAAAAA', 'lobby', 6, '[]', 'jointWinners', 0,
             'c', '1', 'r', '1', 'b', '1', NULL, 'now', 'now')`,
        )
        .run();
    };
    expect(insert).toThrow();
  });

  it('refuse two seats holding the same credential hash', () => {
    runMigrations(database);
    database
      .prepare(
        `INSERT INTO matches (
           match_id, room_code, status, seat_count, content_advisories, tie_policy, revision,
           content_pack_id, content_version, ruleset_id, ruleset_version, board_id, board_version,
           snapshot, created_at, updated_at
         ) VALUES ('m1', 'AAAAAAAA', 'lobby', 3, '[]', 'jointWinners', 0,
           'c', '1', 'r', '1', 'b', '1', NULL, 'now', 'now')`,
      )
      .run();
    const seat = database.prepare(
      'INSERT INTO seats (match_id, seat_index, player_id, credential_hash) VALUES (?, ?, ?, ?)',
    );
    seat.run('m1', 0, 'p1', 'the-same-hash');
    expect(() => seat.run('m1', 1, 'p2', 'the-same-hash')).toThrow();
    // Two unclaimed seats both hold NULL, which the partial index must still allow.
    expect(() => seat.run('m1', 2, 'p3', null)).not.toThrow();
  });
});

describe('room codes', () => {
  it('are drawn from an alphabet with no ambiguous characters in it', () => {
    for (const character of 'ILOU01') {
      expect(ROOM_CODE_ALPHABET).not.toContain(character);
    }
    expect(generateRoomCode()).toHaveLength(ROOM_CODE_LENGTH);
  });

  it('forgive case and spacing but not a character outside the alphabet', () => {
    expect(normalizeRoomCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeRoomCode('ABCDEFG1')).toBeNull();
    expect(normalizeRoomCode('ABCDEFG')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
  });
});

describe('seat credentials', () => {
  it('are stored only as a hash, and a wrong credential does not match', () => {
    const credential = generateCredential();
    const stored = hashCredential(credential);
    expect(stored).not.toBe(credential);
    expect(stored).toMatch(/^[0-9a-f]{64}$/u);
    expect(credentialMatches(credential, stored)).toBe(true);
    expect(credentialMatches(generateCredential(), stored)).toBe(false);
    expect(credentialMatches(`${credential}x`, stored)).toBe(false);
    expect(credentialMatches(credential, 'not-a-hash')).toBe(false);
  });

  it('differ every time one is minted', () => {
    const minted = new Set(Array.from({ length: 64 }, () => generateCredential()));
    expect(minted.size).toBe(64);
  });

  it('are read from the Authorization header and nowhere else', () => {
    expect(readBearer('Bearer abc-123_x')).toBe('abc-123_x');
    expect(readBearer('bearer abc')).toBeNull();
    expect(readBearer('Basic abc')).toBeNull();
    expect(readBearer(undefined)).toBeNull();
  });
});

describe('configuration', () => {
  it('runs on loopback with a data file when nothing is set', () => {
    const config = readServerConfig({} as NodeJS.ProcessEnv);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe('127.0.0.1');
    expect(config.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(config.databasePath.endsWith('/data/seatgrab.db')).toBe(true);
  });

  it('names the setting that is wrong rather than falling back to a default', () => {
    expect(() => readServerConfig({ SEATGRAB_PORT: 'eighty' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => readServerConfig({ SEATGRAB_PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(/SEATGRAB_PORT/u);
    expect(() => readServerConfig({ SEATGRAB_LOG_LEVEL: 'chatty' } as NodeJS.ProcessEnv)).toThrow(
      /SEATGRAB_LOG_LEVEL/u,
    );
  });

  it('resolves a relative database path against the working directory', () => {
    const config = readServerConfig({ SEATGRAB_DB_PATH: 'var/seatgrab.db' } as NodeJS.ProcessEnv);
    expect(config.databasePath).toBe(join(process.cwd(), 'var/seatgrab.db'));
  });
});
