/**
 * Every SQL statement the server runs.
 *
 * The repository stores and returns rows. It does not decide whether a command is legal,
 * who may send it, or what the next state is — the engine decides all of that, and the
 * room service calls it. Keeping the SQL here means the one transaction that matters,
 * `commitCommand`, is readable in one place.
 *
 * Section 14.3 requires the accepted command, its new snapshot and its events to be
 * durable in one transaction before the command is acknowledged. That is `commitCommand`,
 * and it is synchronous from the first read to the commit so no other request can run
 * against a half-applied match.
 */
import {
  isComputerDifficulty,
  type ComputerDifficulty,
  type SeatController,
} from '@gerrymander/protocol';

import { inTransaction, type Database } from './database.js';

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

type Row = Record<string, unknown>;

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

export class MatchRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /** Create the room and its unclaimed seats together. */
  createMatch(match: NewMatch): MatchRow {
    try {
      return inTransaction(this.#database, () => {
        this.#database
          .prepare(
            `INSERT INTO matches (
               match_id, room_code, status, seat_count, content_advisories, tie_policy, revision,
               content_pack_id, content_version, ruleset_id, ruleset_version, board_id, board_version,
               snapshot, created_at, updated_at
             ) VALUES (?, ?, 'lobby', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
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
          );
        const insertSeat = this.#database.prepare(
          `INSERT INTO seats (match_id, seat_index, player_id, is_host) VALUES (?, ?, ?, ?)`,
        );
        for (const seat of match.seats) {
          insertSeat.run(match.matchId, seat.seatIndex, seat.playerId, seat.isHost ? 1 : 0);
        }
        const created = this.findMatch(match.matchId);
        if (created === null) throw new Error('The new room did not persist.');
        return created;
      });
    } catch (error) {
      if (error instanceof Error && /room_code/u.test(error.message)) {
        throw new RoomCodeTakenError(match.roomCode);
      }
      throw error;
    }
  }

  findMatch(matchId: string): MatchRow | null {
    const row = this.#database.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId) as Row | undefined;
    return row === undefined ? null : toMatch(row);
  }

  findMatchByRoomCode(roomCode: string): MatchRow | null {
    const row = this.#database.prepare('SELECT * FROM matches WHERE room_code = ?').get(roomCode) as Row | undefined;
    return row === undefined ? null : toMatch(row);
  }

  listSeats(matchId: string): readonly SeatRow[] {
    const rows = this.#database
      .prepare('SELECT * FROM seats WHERE match_id = ? ORDER BY seat_index')
      .all(matchId) as Row[];
    return rows.map(toSeat);
  }

  /**
   * The seat a credential hash belongs to, or `null`.
   *
   * The hash is the lookup key, so a wrong credential finds no row at all rather than
   * finding a seat and then failing a comparison against it.
   */
  findSeatByCredentialHash(credentialHash: string): SeatRow | null {
    const row = this.#database
      .prepare('SELECT * FROM seats WHERE credential_hash = ?')
      .get(credentialHash) as Row | undefined;
    return row === undefined ? null : toSeat(row);
  }

  /**
   * Write a credential onto a seat that has none, returning whether it was free.
   *
   * The `credential_hash IS NULL` clause is the guard, and it is in the statement rather
   * than in a preceding read: two claims arriving for the same free seat both see it
   * free, and only the one whose UPDATE matches a row wins.
   */
  claimSeat(
    matchId: string,
    seatIndex: number,
    claim: { displayName: string; partyId: string; credentialHash: string; claimedAt: string },
  ): boolean {
    return inTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `UPDATE seats SET display_name = ?, party_id = ?, credential_hash = ?, claimed_at = ?
             WHERE match_id = ? AND seat_index = ? AND credential_hash IS NULL`,
        )
        .run(claim.displayName, claim.partyId, claim.credentialHash, claim.claimedAt, matchId, seatIndex);
      return Number(result.changes) === 1;
    });
  }

  /**
   * Hold a free seat with a computer, returning whether it was free.
   *
   * The guard is the same shape as `claimSeat`'s: a seat is free only while it holds
   * neither a credential nor a computer, and the test is in the statement, so two
   * requests for one seat leave exactly one winner.
   */
  seatComputer(
    matchId: string,
    seatIndex: number,
    seat: { displayName: string; partyId: string; difficulty: ComputerDifficulty; claimedAt: string },
  ): boolean {
    return inTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `UPDATE seats SET display_name = ?, party_id = ?, controller = 'computer',
                            difficulty = ?, claimed_at = ?
             WHERE match_id = ? AND seat_index = ? AND credential_hash IS NULL
               AND controller = 'human'`,
        )
        .run(seat.displayName, seat.partyId, seat.difficulty, seat.claimedAt, matchId, seatIndex);
      return Number(result.changes) === 1;
    });
  }

  /** Every match in one of the given statuses that seats at least one computer. */
  listMatchesWithComputers(statuses: readonly MatchRow['status'][]): readonly MatchRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.#database
      .prepare(
        `SELECT m.* FROM matches m
           WHERE m.status IN (${placeholders})
             AND EXISTS (SELECT 1 FROM seats s
                           WHERE s.match_id = m.match_id AND s.controller = 'computer')
           ORDER BY m.created_at`,
      )
      .all(...statuses) as Row[];
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
   * authenticating the moment this commits. There is no way back to it: a credential is
   * stored only as its hash, and the plaintext was returned once to the browser that
   * claimed it.
   */
  releaseSeat(matchId: string, seatIndex: number): boolean {
    return inTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `UPDATE seats SET display_name = NULL, party_id = NULL, credential_hash = NULL,
                            claimed_at = NULL, controller = 'human', difficulty = NULL
             WHERE match_id = ? AND seat_index = ?
               AND (credential_hash IS NOT NULL OR controller = 'computer')`,
        )
        .run(matchId, seatIndex);
      return Number(result.changes) === 1;
    });
  }

  findCommand(matchId: string, commandId: string): StoredCommand | null {
    const row = this.#database
      .prepare('SELECT * FROM commands WHERE match_id = ? AND command_id = ?')
      .get(matchId, commandId) as Row | undefined;
    return row === undefined ? null : toCommand(row);
  }

  /**
   * Store an accepted command, the snapshot it produced and the events it emitted, in
   * one transaction.
   *
   * Nothing is acknowledged before this returns. If the process dies part-way the
   * transaction is rolled back whole, so a restart never finds a snapshot without its
   * idempotency record, or an idempotency record for a command whose state was lost.
   */
  commitCommand(input: {
    matchId: string;
    commandId: string;
    actorPlayerId: string;
    revisionBefore: number;
    revisionAfter: number;
    status: MatchStatus;
    schemaVersion: number;
    engineVersion: string;
    snapshot: string;
    command: string;
    response: string;
    events: readonly Omit<StoredEvent, 'sequence'>[];
    at: string;
  }): void {
    inTransaction(this.#database, () => {
      this.#database
        .prepare(
          `UPDATE matches SET snapshot = ?, revision = ?, status = ?, schema_version = ?,
             engine_version = ?, updated_at = ? WHERE match_id = ?`,
        )
        .run(
          input.snapshot,
          input.revisionAfter,
          input.status,
          input.schemaVersion,
          input.engineVersion,
          input.at,
          input.matchId,
        );
      this.#appendEvents(input.matchId, input.revisionAfter, input.events);
      this.#recordCommand(input, true);
    });
  }

  /**
   * Store the outcome of a command the engine refused.
   *
   * A refusal changes no state, so there is no snapshot to write; the row exists so a
   * client that retries the same command ID after a lost response gets the same refusal
   * back instead of a second, possibly different, adjudication of a stale intent.
   */
  recordRejection(input: {
    matchId: string;
    commandId: string;
    actorPlayerId: string;
    revisionBefore: number;
    command: string;
    response: string;
    at: string;
  }): void {
    inTransaction(this.#database, () => {
      this.#recordCommand({ ...input, revisionAfter: input.revisionBefore }, false);
    });
  }

  /** Write the opening snapshot when the host starts the match. */
  startMatch(input: {
    matchId: string;
    status: MatchStatus;
    revision: number;
    schemaVersion: number;
    engineVersion: string;
    snapshot: string;
    events: readonly Omit<StoredEvent, 'sequence'>[];
    at: string;
  }): boolean {
    return inTransaction(this.#database, () => {
      const result = this.#database
        .prepare(
          `UPDATE matches SET snapshot = ?, revision = ?, status = ?, schema_version = ?,
             engine_version = ?, updated_at = ? WHERE match_id = ? AND status = 'lobby'`,
        )
        .run(
          input.snapshot,
          input.revision,
          input.status,
          input.schemaVersion,
          input.engineVersion,
          input.at,
          input.matchId,
        );
      if (Number(result.changes) !== 1) return false;
      this.#appendEvents(input.matchId, input.revision, input.events);
      return true;
    });
  }

  /** Stored events after `sinceSequence`, oldest first, still carrying visibility. */
  readEvents(matchId: string, sinceSequence: number, limit: number): readonly StoredEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM events WHERE match_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(matchId, sinceSequence, limit) as Row[];
    return rows.map(toEvent);
  }

  countEvents(matchId: string): number {
    const row = this.#database
      .prepare('SELECT COUNT(*) AS total FROM events WHERE match_id = ?')
      .get(matchId) as Row | undefined;
    return row === undefined ? 0 : integer(row, 'total');
  }

  #appendEvents(
    matchId: string,
    revision: number,
    events: readonly Omit<StoredEvent, 'sequence'>[],
  ): void {
    if (events.length === 0) return;
    const nextRow = this.#database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS highest FROM events WHERE match_id = ?')
      .get(matchId) as Row | undefined;
    let sequence = nextRow === undefined ? 0 : integer(nextRow, 'highest');
    const insert = this.#database.prepare(
      `INSERT INTO events (match_id, sequence, event_id, revision, type, message, actor_player_id, visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      sequence += 1;
      insert.run(
        matchId,
        sequence,
        event.eventId,
        revision,
        event.type,
        event.message,
        event.actorPlayerId,
        event.visibility,
      );
    }
  }

  #recordCommand(
    input: {
      matchId: string;
      commandId: string;
      actorPlayerId: string;
      revisionBefore: number;
      revisionAfter: number;
      command: string;
      response: string;
      at: string;
    },
    accepted: boolean,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO commands (
           match_id, command_id, actor_player_id, accepted, revision_before, revision_after,
           command, response, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.matchId,
        input.commandId,
        input.actorPlayerId,
        accepted ? 1 : 0,
        input.revisionBefore,
        input.revisionAfter,
        input.command,
        input.response,
        input.at,
      );
  }
}
