/**
 * Schema migrations.
 *
 * Migrations are an ordered list applied inside one transaction each, with the highest
 * applied version recorded in `schema_migrations`. Running them again on a current
 * database does nothing. A migration that has shipped is never edited: a change to the
 * schema is a new entry, because an existing deployment has already run the old one.
 *
 * The four tables are the conventional ones named in section 14.3. Nothing here knows a
 * game rule; the snapshot column holds whatever `serializeGame` produced and the server
 * never reads inside it with SQL.
 */
import { inTransaction, type Database } from './database.js';

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'rooms-seats-commands-events',
    statements: [
      `CREATE TABLE matches (
         match_id           TEXT PRIMARY KEY,
         room_code          TEXT NOT NULL UNIQUE,
         status             TEXT NOT NULL CHECK (status IN ('lobby', 'setup', 'active', 'finished')),
         seat_count         INTEGER NOT NULL CHECK (seat_count BETWEEN 3 AND 5),
         content_advisories TEXT NOT NULL,
         tie_policy         TEXT NOT NULL,
         revision           INTEGER NOT NULL DEFAULT 0,
         schema_version     INTEGER,
         engine_version     TEXT,
         content_pack_id    TEXT NOT NULL,
         content_version    TEXT NOT NULL,
         ruleset_id         TEXT NOT NULL,
         ruleset_version    TEXT NOT NULL,
         board_id           TEXT NOT NULL,
         board_version      TEXT NOT NULL,
         snapshot           TEXT,
         created_at         TEXT NOT NULL,
         updated_at         TEXT NOT NULL
       )`,
      `CREATE TABLE seats (
         match_id        TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
         seat_index      INTEGER NOT NULL,
         player_id       TEXT NOT NULL,
         is_host         INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1)),
         display_name    TEXT,
         party_id        TEXT,
         credential_hash TEXT,
         claimed_at      TEXT,
         PRIMARY KEY (match_id, seat_index)
       )`,
      // A credential must identify exactly one seat across the whole server, so the
      // lookup is one indexed read rather than a scan with a comparison per seat.
      `CREATE UNIQUE INDEX seats_credential_hash ON seats(credential_hash)
         WHERE credential_hash IS NOT NULL`,
      `CREATE UNIQUE INDEX seats_player_id ON seats(match_id, player_id)`,
      // The idempotency record. The primary key is what makes a repeated command ID a
      // read of the stored response instead of a second application.
      `CREATE TABLE commands (
         match_id        TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
         command_id      TEXT NOT NULL,
         actor_player_id TEXT NOT NULL,
         accepted        INTEGER NOT NULL CHECK (accepted IN (0, 1)),
         revision_before INTEGER NOT NULL,
         revision_after  INTEGER NOT NULL,
         command         TEXT NOT NULL,
         response        TEXT NOT NULL,
         created_at      TEXT NOT NULL,
         PRIMARY KEY (match_id, command_id)
       )`,
      // Events are stored canonically, with the engine's own visibility metadata, and
      // projected on read. Storing a per-seat copy would mean deciding visibility at
      // write time and having no way to correct it.
      `CREATE TABLE events (
         match_id        TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
         sequence        INTEGER NOT NULL,
         event_id        TEXT NOT NULL,
         revision        INTEGER NOT NULL,
         type            TEXT NOT NULL,
         message         TEXT NOT NULL,
         actor_player_id TEXT,
         visibility      TEXT NOT NULL,
         PRIMARY KEY (match_id, sequence)
       )`,
      `CREATE INDEX events_revision ON events(match_id, revision)`,
    ],
  },
  {
    version: 2,
    name: 'seat-controller',
    statements: [
      // Who plays a seat. A computer seat is claimed and holds no credential, so the
      // "claimed" test widens from "has a credential" to "has a credential or is a
      // computer". The default keeps every seat written before this migration human.
      `ALTER TABLE seats ADD COLUMN controller TEXT NOT NULL DEFAULT 'human'
         CHECK (controller IN ('human', 'computer'))`,
      `ALTER TABLE seats ADD COLUMN difficulty TEXT`,
    ],
  },
];

/** The highest migration version this build ships. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

function appliedVersion(database: Database): number {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Bring the database up to the current schema, returning the migrations applied now.
 *
 * A database ahead of this build is refused rather than downgraded: an older binary
 * writing into a newer schema is how a deployment loses data during a rollback.
 */
export function runMigrations(database: Database): readonly Migration[] {
  const current = appliedVersion(database);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `This database is at schema version ${current}, but this build knows version `
      + `${LATEST_SCHEMA_VERSION}. Run the newer build, or restore a backup taken before the upgrade.`,
    );
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > current)
    .toSorted((left, right) => left.version - right.version);
  for (const migration of pending) {
    inTransaction(database, () => {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    });
  }
  return pending;
}
