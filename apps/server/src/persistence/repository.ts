/**
 * Every SQL statement the server runs.
 *
 * The repository stores and returns rows. It does not decide whether a command is legal,
 * who may send it, or what the next state is — the engine decides all of that, and the
 * room service calls it. Keeping the SQL here means the one write that matters,
 * `writeCheckpoint`, is readable in one place.
 *
 * The durable store is Cloudflare D1 in a deployment and a local SQLite file otherwise,
 * behind the driver in `driver.ts`. Neither the repository nor anything above it knows
 * which. What both have to live with is that D1 offers no interactive transaction: a
 * caller cannot hold one open across a network round trip, read, decide and then write.
 *
 * So the durability story changed, and changed deliberately. It used to be that an
 * accepted command was in one synchronous transaction before it was acknowledged. Now
 * the authority for a live match is the in-memory state in `rooms/matchStore.ts`, and
 * this file writes checkpoints of it — every `checkpointEveryCommands` commands, or
 * after `checkpointMaxDelayMs`, whichever comes first, and always at a clean boundary:
 * a lobby change, a match start, a match finish, or a shutdown. An unclean crash loses
 * the commands since the last checkpoint. `writeCheckpoint` is what makes that bounded
 * rather than arbitrary, and it is written so that sending it twice is the same as
 * sending it once.
 */
import {
  isComputerDifficulty,
  type ComputerDifficulty,
  type SeatController,
} from '@gerrymander/protocol';

import type { Database, SqlRow, SqlStatement } from './database.js';

export type MatchStatus = 'lobby' | 'setup' | 'active' | 'finished';

export interface MatchRow {
  matchId: string;
  roomCode: string;
  status: MatchStatus;
  seatCount: number;
  contentAdvisories: readonly string[];
  tiePolicy: string;
  revision: number;
  contentPackId: string;
  contentVersion: string;
  rulesetId: string;
  rulesetVersion: string;
  boardId: string;
  boardVersion: string;
  /** The serialized engine state, or `null` while the room is still a lobby. */
  snapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeatRow {
  matchId: string;
  seatIndex: number;
  /** The engine's player ID for this seat, fixed when the room was created. */
  playerId: string;
  isHost: boolean;
  displayName: string | null;
  partyId: string | null;
  claimed: boolean;
  claimedAt: string | null;
  /** The stored hash, so a caller can compare in constant time. Never the credential. */
  credentialHash: string | null;
  /** Who plays the seat. A row written before migration 2 reads `human`. */
  controller: SeatController;
  /** Present exactly when `controller` is `computer`. */
  difficulty: ComputerDifficulty | null;
}

export interface StoredCommand {
  matchId: string;
  commandId: string;
  actorPlayerId: string;
  accepted: boolean;
  revisionBefore: number;
  revisionAfter: number;
  response: string;
}

export interface StoredEvent {
  sequence: number;
  eventId: string;
  revision: number;
  type: string;
  message: string;
  actorPlayerId: string | null;
  /** The engine's own visibility, serialized: `public`, `server`, or a JSON seat list. */
  visibility: string;
}

export interface NewMatch {
  matchId: string;
  roomCode: string;
  seatCount: number;
  contentAdvisories: readonly string[];
  tiePolicy: string;
  contentPackId: string;
  contentVersion: string;
  rulesetId: string;
  rulesetVersion: string;
  boardId: string;
  boardVersion: string;
  /** One entry per seat, in clockwise order. Seat 0 is the host's. */
  seats: readonly { seatIndex: number; playerId: string; isHost: boolean }[];
  createdAt: string;
}

type Row = SqlRow;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} was expected to hold text but holds ${typeof value}.`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} was expected to hold text or null but holds ${typeof value}.`);
  }
  return value;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') {
    throw new Error(`Column ${column} was expected to hold a number but holds ${typeof value}.`);
  }
  return value;
}

function statusOf(row: Row): MatchStatus {
  const value = text(row, 'status');
  if (value !== 'lobby' && value !== 'setup' && value !== 'active' && value !== 'finished') {
    throw new Error(`Match ${text(row, 'match_id')} holds the unknown status "${value}".`);
  }
  return value;
}

function toMatch(row: Row): MatchRow {
  const advisories: unknown = JSON.parse(text(row, 'content_advisories'));
  return {
    matchId: text(row, 'match_id'),
    roomCode: text(row, 'room_code'),
    status: statusOf(row),
    seatCount: integer(row, 'seat_count'),
    contentAdvisories: Array.isArray(advisories) ? (advisories as string[]) : [],
    tiePolicy: text(row, 'tie_policy'),
    revision: integer(row, 'revision'),
    contentPackId: text(row, 'content_pack_id'),
    contentVersion: text(row, 'content_version'),
    rulesetId: text(row, 'ruleset_id'),
    rulesetVersion: text(row, 'ruleset_version'),
    boardId: text(row, 'board_id'),
    boardVersion: text(row, 'board_version'),
    snapshot: optionalText(row, 'snapshot'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function toSeat(row: Row): SeatRow {
  const controller: SeatController = optionalText(row, 'controller') === 'computer' ? 'computer' : 'human';
  const difficulty = optionalText(row, 'difficulty');
  return {
    matchId: text(row, 'match_id'),
    seatIndex: integer(row, 'seat_index'),
    playerId: text(row, 'player_id'),
    isHost: integer(row, 'is_host') === 1,
    displayName: optionalText(row, 'display_name'),
    partyId: optionalText(row, 'party_id'),
    claimed: optionalText(row, 'credential_hash') !== null || controller === 'computer',
    claimedAt: optionalText(row, 'claimed_at'),
    credentialHash: optionalText(row, 'credential_hash'),
    controller,
    difficulty: isComputerDifficulty(difficulty) ? difficulty : null,
  };
}

function toCommand(row: Row): StoredCommand {
  return {
    matchId: text(row, 'match_id'),
    commandId: text(row, 'command_id'),
    actorPlayerId: text(row, 'actor_player_id'),
    accepted: integer(row, 'accepted') === 1,
    revisionBefore: integer(row, 'revision_before'),
    revisionAfter: integer(row, 'revision_after'),
    response: text(row, 'response'),
  };
}

function toEvent(row: Row): StoredEvent {
  return {
    sequence: integer(row, 'sequence'),
    eventId: text(row, 'event_id'),
    revision: integer(row, 'revision'),
    type: text(row, 'type'),
    message: text(row, 'message'),
    actorPlayerId: optionalText(row, 'actor_player_id'),
    visibility: text(row, 'visibility'),
  };
}

/** Raised when a room code collides with a live room, so the caller can mint another. */
export class RoomCodeTakenError extends Error {
  constructor(roomCode: string) {
    super(`Room code ${roomCode} is already in use.`);
    this.name = 'RoomCodeTakenError';
  }
}

/**
 * Everything one match has changed since its last checkpoint.
 *
 * `rooms/matchStore.ts` accumulates this and hands it over whole. Sequence numbers are
 * already allocated, because allocating them here would mean a `SELECT MAX(sequence)`
 * before the insert — a read inside a write that D1 gives no way to make atomic.
 */
export interface MatchCheckpoint {
  matchId: string;
  /**
   * The match row's new values, or null when only commands were refused.
   *
   * A refusal changes no state, so there is a command row to write and no snapshot.
   */
  match: {
    revision: number;
    status: MatchStatus;
    schemaVersion: number;
    engineVersion: string;
    snapshot: string;
    updatedAt: string;
  } | null;
  /** Events emitted since the last checkpoint, with their sequence numbers. */
  events: readonly StoredEvent[];
  /** Command records since the last checkpoint, accepted and refused alike. */
  commands: readonly CheckpointCommand[];
}

export interface CheckpointCommand {
  commandId: string;
  actorPlayerId: string;
  accepted: boolean;
  revisionBefore: number;
  revisionAfter: number;
  command: string;
  response: string;
  createdAt: string;
}

export class MatchRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /** Create the room and its unclaimed seats together. */
  async createMatch(match: NewMatch): Promise<MatchRow> {
    const created: MatchRow = {
      matchId: match.matchId,
      roomCode: match.roomCode,
      status: 'lobby',
      seatCount: match.seatCount,
      contentAdvisories: match.contentAdvisories,
      tiePolicy: match.tiePolicy,
      revision: 0,
      contentPackId: match.contentPackId,
      contentVersion: match.contentVersion,
      rulesetId: match.rulesetId,
      rulesetVersion: match.rulesetVersion,
      boardId: match.boardId,
      boardVersion: match.boardVersion,
      snapshot: null,
      createdAt: match.createdAt,
      updatedAt: match.createdAt,
    };

    try {
      await this.#database.batch([
        {
          sql: `INSERT INTO matches (
                  match_id, room_code, status, seat_count, content_advisories, tie_policy, revision,
                  content_pack_id, content_version, ruleset_id, ruleset_version, board_id, board_version,
                  snapshot, created_at, updated_at
                ) VALUES (?, ?, 'lobby', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          params: [
            match.matchId,
            match.roomCode,
            match.seatCount,
            JSON.stringify(match.contentAdvisories),
            match.tiePolicy,
            match.contentPackId,
            match.contentVersion,
            match.rulesetId,
            match.rulesetVersion,
            match.boardId,
            match.boardVersion,
            match.createdAt,
            match.createdAt,
          ],
        },
        ...match.seats.map((seat) => ({
          sql: 'INSERT INTO seats (match_id, seat_index, player_id, is_host) VALUES (?, ?, ?, ?)',
          params: [match.matchId, seat.seatIndex, seat.playerId, seat.isHost ? 1 : 0],
        })),
      ]);
    } catch (error) {
      // The room code is unique in the schema, so a collision surfaces here rather than
      // in a preceding read that another request could have raced. The caller mints
      // another code and tries again.
      if (isUniqueViolation(error, 'room_code')) throw new RoomCodeTakenError(match.roomCode);
      throw error;
    }

    // The row is returned as it was written rather than read back, which saves a round
    // trip on the one path that would otherwise pay two. Every column above is either a
    // literal in the statement or a value from `match`.
    return created;
  }

  async findMatch(matchId: string): Promise<MatchRow | null> {
    const row = await this.#database.get('SELECT * FROM matches WHERE match_id = ?', [matchId]);
    return row === undefined ? null : toMatch(row);
  }

  async findMatchByRoomCode(roomCode: string): Promise<MatchRow | null> {
    const row = await this.#database.get('SELECT * FROM matches WHERE room_code = ?', [roomCode]);
    return row === undefined ? null : toMatch(row);
  }

  async listSeats(matchId: string): Promise<readonly SeatRow[]> {
    const rows = await this.#database.all(
      'SELECT * FROM seats WHERE match_id = ? ORDER BY seat_index',
      [matchId],
    );
    return rows.map(toSeat);
  }

  /**
   * The seat a credential hash belongs to, or `null`.
   *
   * The hash is the lookup key, so a wrong credential finds no row at all rather than
   * finding a seat and then failing a comparison against it.
   */
  async findSeatByCredentialHash(credentialHash: string): Promise<SeatRow | null> {
    const row = await this.#database.get('SELECT * FROM seats WHERE credential_hash = ?', [
      credentialHash,
    ]);
    return row === undefined ? null : toSeat(row);
  }

  /**
   * Write a credential onto a seat that has none, returning whether it was free.
   *
   * The `credential_hash IS NULL` clause is the guard, and it is in the statement rather
   * than in a preceding read: two claims arriving for the same free seat both see it
   * free, and only the one whose UPDATE matches a row wins. That is the same trick the
   * checkpoint's revision guard uses, and it is what replaces the transaction this
   * method used to hold.
   *
   * Seat changes are written immediately rather than checkpointed. They are rare, they
   * happen only in a lobby, and a credential a player has already been handed must not
   * be one the store has never heard of.
   */
  async claimSeat(
    matchId: string,
    seatIndex: number,
    claim: { displayName: string; partyId: string; credentialHash: string; claimedAt: string },
  ): Promise<boolean> {
    const result = await this.#database.run(
      `UPDATE seats SET display_name = ?, party_id = ?, credential_hash = ?, claimed_at = ?
         WHERE match_id = ? AND seat_index = ? AND credential_hash IS NULL`,
      [claim.displayName, claim.partyId, claim.credentialHash, claim.claimedAt, matchId, seatIndex],
    );
    return result.changes === 1;
  }

  /**
   * Hold a free seat with a computer, returning whether it was free.
   *
   * The guard is the same shape as `claimSeat`'s: a seat is free only while it holds
   * neither a credential nor a computer, and the test is in the statement, so two
   * requests for one seat leave exactly one winner.
   */
  async seatComputer(
    matchId: string,
    seatIndex: number,
    seat: { displayName: string; partyId: string; difficulty: ComputerDifficulty; claimedAt: string },
  ): Promise<boolean> {
    const result = await this.#database.run(
      `UPDATE seats SET display_name = ?, party_id = ?, controller = 'computer',
                        difficulty = ?, claimed_at = ?
         WHERE match_id = ? AND seat_index = ? AND credential_hash IS NULL
           AND controller = 'human'`,
      [seat.displayName, seat.partyId, seat.difficulty, seat.claimedAt, matchId, seatIndex],
    );
    return result.changes === 1;
  }

  /** Every match in one of the given statuses that seats at least one computer. */
  async listMatchesWithComputers(
    statuses: readonly MatchRow['status'][],
  ): Promise<readonly MatchRow[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = await this.#database.all(
      `SELECT m.* FROM matches m
         WHERE m.status IN (${placeholders})
           AND EXISTS (SELECT 1 FROM seats s
                         WHERE s.match_id = m.match_id AND s.controller = 'computer')
         ORDER BY m.created_at`,
      [...statuses],
    );
    return rows.map(toMatch);
  }

  /**
   * Take a seat's claim back, returning whether there was one to take.
   *
   * The inverse of `claimSeat`, and guarded the same way: `credential_hash IS NOT NULL`
   * is in the statement rather than in a preceding read, so two releases racing for one
   * seat leave it free once and only one of them reports having done it.
   *
   * The old hash is overwritten rather than kept, so the released credential stops
   * authenticating the moment this returns. There is no way back to it: a credential is
   * stored only as its hash, and the plaintext was returned once to the browser that
   * claimed it.
   */
  async releaseSeat(matchId: string, seatIndex: number): Promise<boolean> {
    const result = await this.#database.run(
      `UPDATE seats SET display_name = NULL, party_id = NULL, credential_hash = NULL,
                        claimed_at = NULL, controller = 'human', difficulty = NULL
         WHERE match_id = ? AND seat_index = ?
           AND (credential_hash IS NOT NULL OR controller = 'computer')`,
      [matchId, seatIndex],
    );
    return result.changes === 1;
  }

  async findCommand(matchId: string, commandId: string): Promise<StoredCommand | null> {
    const row = await this.#database.get(
      'SELECT * FROM commands WHERE match_id = ? AND command_id = ?',
      [matchId, commandId],
    );
    return row === undefined ? null : toCommand(row);
  }

  /**
   * Write the opening snapshot when the host starts the match.
   *
   * Immediate rather than checkpointed, and guarded on `status = 'lobby'` so two hosts
   * pressing start leave one match started once. This is the boundary where seats lock:
   * a start that is only in memory would be a table whose seats are locked in this
   * process and free in the store.
   */
  async startMatch(input: {
    matchId: string;
    status: MatchStatus;
    revision: number;
    schemaVersion: number;
    engineVersion: string;
    snapshot: string;
    events: readonly StoredEvent[];
    at: string;
  }): Promise<boolean> {
    const result = await this.#database.run(
      `UPDATE matches SET snapshot = ?, revision = ?, status = ?, schema_version = ?,
         engine_version = ?, updated_at = ? WHERE match_id = ? AND status = 'lobby'`,
      [
        input.snapshot,
        input.revision,
        input.status,
        input.schemaVersion,
        input.engineVersion,
        input.at,
        input.matchId,
      ],
    );
    if (result.changes !== 1) return false;
    if (input.events.length > 0) {
      await this.#database.batch(input.events.map((event) => insertEvent(input.matchId, event)));
    }
    return true;
  }

  /**
   * Write everything one match has changed since its last checkpoint.
   *
   * The order is the whole design. Events and command records go first and are
   * `INSERT OR IGNORE` against their primary keys, so a second attempt writes nothing
   * new. The match row goes last, guarded on `revision <= ?`, and it is what makes the
   * rest reachable: a reader follows the match row's revision, so a batch that failed
   * after the events but before the match row leaves rows that nothing reads yet and a
   * match at the revision it was already at.
   *
   * That means this method may be called again after a failure with the same argument,
   * and the store does exactly that. It is why no transaction is needed for it to be
   * correct, which matters because D1 offers none worth depending on.
   */
  async writeCheckpoint(checkpoint: MatchCheckpoint): Promise<void> {
    const statements: SqlStatement[] = [];

    for (const event of checkpoint.events) {
      statements.push(insertEvent(checkpoint.matchId, event));
    }

    for (const command of checkpoint.commands) {
      statements.push({
        sql: `INSERT OR IGNORE INTO commands (
                match_id, command_id, actor_player_id, accepted, revision_before, revision_after,
                command, response, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          checkpoint.matchId,
          command.commandId,
          command.actorPlayerId,
          command.accepted ? 1 : 0,
          command.revisionBefore,
          command.revisionAfter,
          command.command,
          command.response,
          command.createdAt,
        ],
      });
    }

    if (checkpoint.match !== null) {
      statements.push({
        sql: `UPDATE matches SET snapshot = ?, revision = ?, status = ?, schema_version = ?,
                engine_version = ?, updated_at = ?
                WHERE match_id = ? AND revision <= ?`,
        params: [
          checkpoint.match.snapshot,
          checkpoint.match.revision,
          checkpoint.match.status,
          checkpoint.match.schemaVersion,
          checkpoint.match.engineVersion,
          checkpoint.match.updatedAt,
          checkpoint.matchId,
          checkpoint.match.revision,
        ],
      });
    }

    if (statements.length === 0) return;
    await this.#database.batch(statements);
  }

  /** Stored events after `sinceSequence`, oldest first, still carrying visibility. */
  async readEvents(
    matchId: string,
    sinceSequence: number,
    limit: number,
  ): Promise<readonly StoredEvent[]> {
    const rows = await this.#database.all(
      'SELECT * FROM events WHERE match_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      [matchId, sinceSequence, limit],
    );
    return rows.map(toEvent);
  }

  async countEvents(matchId: string): Promise<number> {
    const row = await this.#database.get(
      'SELECT COUNT(*) AS total FROM events WHERE match_id = ?',
      [matchId],
    );
    return row === undefined ? 0 : integer(row, 'total');
  }

  /** The highest sequence the store holds for a match, so the store can carry on from it. */
  async highestEventSequence(matchId: string): Promise<number> {
    const row = await this.#database.get(
      'SELECT COALESCE(MAX(sequence), 0) AS highest FROM events WHERE match_id = ?',
      [matchId],
    );
    return row === undefined ? 0 : integer(row, 'highest');
  }
}

/** One event insert, written so that re-sending a checkpoint writes nothing new. */
function insertEvent(matchId: string, event: StoredEvent): SqlStatement {
  return {
    sql: `INSERT OR IGNORE INTO events (
            match_id, sequence, event_id, revision, type, message, actor_player_id, visibility
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      matchId,
      event.sequence,
      event.eventId,
      event.revision,
      event.type,
      event.message,
      event.actorPlayerId,
      event.visibility,
    ],
  };
}

/**
 * Whether a failure is a uniqueness violation on the named column.
 *
 * Both drivers report it in the message rather than in a code — SQLite as
 * "UNIQUE constraint failed: matches.room_code", D1 as the same text inside its error
 * list — so the column name is what this matches on.
 */
function isUniqueViolation(error: unknown, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') && message.includes(column);
}
