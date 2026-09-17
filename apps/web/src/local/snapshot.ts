/**
 * The versioned local save document.
 *
 * A local save is the complete serialized engine state, not a command log. Replaying a
 * log would have to reproduce every random draw and every rules decision the engine made
 * at the time, so a stale build could silently resume a different game. A snapshot
 * resumes the exact revision, deck order, random state, debts and effect counters, and a
 * build that can no longer read it says so instead of guessing.
 *
 * The document carries the versions the game was created with, taken from the state
 * itself. `assertReadable` compares them with the versions this build ships and rejects
 * a mismatch by name.
 */
import {
  BOARD_ID,
  BOARD_VERSION,
  CONTENT_PACK_ID,
  CONTENT_PACK_VERSION,
} from '@seatgrab/content';
import {
  GAME_SCHEMA_VERSION,
  loadGame,
  serializeGame,
  type GameContent,
  type GameState,
} from '@seatgrab/engine';
import {
  isComputerDifficulty,
  type ComputerDifficulty,
  type SeatController,
} from '@seatgrab/protocol';

/** Identifies the file as a SeatGrab local save rather than any other JSON document. */
export const LOCAL_SNAPSHOT_FORMAT = 'seatgrab.local-snapshot';

/** The layout of the envelope around the state. Bump it only for envelope changes. */
export const LOCAL_SNAPSHOT_FORMAT_VERSION = 1;

/**
 * Local play keeps every player's private data on one device, so anyone holding the
 * device can read it. Show this wherever local mode is offered.
 */
export const LOCAL_MODE_NOTICE =
  'Local play is pass-and-play on one trusted device. The save holds every seat’s private '
  + 'cards and answers, so anyone with this device or an exported file can read them.';

/**
 * One seat as the envelope records it.
 *
 * `controller` is additive: a save written before computer seats existed carries no such
 * field, and every reader here defaults it to `human`.
 */
export type SavedSeat = {
  id: string;
  displayName: string;
  partyId: string;
  controller: SeatController;
  difficulty?: ComputerDifficulty;
};

export interface LocalSnapshotEnvelope {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  engineVersion: string;
  contentPackId: string;
  contentVersion: string;
  rulesetId: string;
  rulesetVersion: string;
  boardId: string;
  boardVersion: string;
  matchId: string;
  revision: number;
  status: 'setup' | 'active' | 'finished';
  /** Metadata for the saved-match list. No rule reads it. */
  savedAt: string;
  players: readonly SavedSeat[];
  state: GameState;
}

/** The versions that decide whether this build can read a save. */
export interface ReadabilityVersions {
  formatVersion: number;
  schemaVersion: number;
  contentPackId: string;
  contentVersion: string;
  boardId: string;
  boardVersion: string;
}

/** What the saved-match list needs, without loading or validating the whole state. */
export interface LocalMatchSummary extends ReadabilityVersions {
  matchId: string;
  revision: number;
  status: 'setup' | 'active' | 'finished';
  players: readonly SavedSeat[];
  savedAt: string;
  /**
   * `null` when this build can read the save; otherwise why it cannot.
   *
   * A stored summary was written by whichever build saved the match, so it answers for
   * that build, not this one. `listLocalMatches` recomputes it before the list is shown.
   */
  unreadableReason: string | null;
}

export type LocalSnapshotErrorCode =
  | 'NOT_A_SNAPSHOT'
  | 'UNSUPPORTED_FORMAT'
  | 'SCHEMA_MISMATCH'
  | 'CONTENT_MISMATCH'
  | 'BOARD_MISMATCH'
  | 'UNREADABLE_STATE';

export class LocalSnapshotError extends Error {
  readonly code: LocalSnapshotErrorCode;

  constructor(code: LocalSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'LocalSnapshotError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalSnapshotError('NOT_A_SNAPSHOT', `The save is missing its ${field}.`);
  }
  return value;
}

function requireInteger(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new LocalSnapshotError('NOT_A_SNAPSHOT', `The save is missing its ${field}.`);
  }
  return value;
}

function requireStatus(source: Record<string, unknown>): 'setup' | 'active' | 'finished' {
  const value = source['status'];
  if (value !== 'setup' && value !== 'active' && value !== 'finished') {
    throw new LocalSnapshotError('NOT_A_SNAPSHOT', 'The save is missing its match status.');
  }
  return value;
}

function requirePlayers(source: Record<string, unknown>): readonly SavedSeat[] {
  const value = source['players'];
  if (!Array.isArray(value) || value.length < 3 || value.length > 5) {
    throw new LocalSnapshotError('NOT_A_SNAPSHOT', 'The save does not list 3 to 5 seats.');
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new LocalSnapshotError('NOT_A_SNAPSHOT', 'A seat in the save is not a record.');
    }
    const controller = entry['controller'] === 'computer' ? 'computer' : 'human';
    const difficulty = entry['difficulty'];
    return {
      id: requireString(entry, 'id'),
      displayName: requireString(entry, 'displayName'),
      partyId: requireString(entry, 'partyId'),
      controller,
      ...(controller === 'computer' && isComputerDifficulty(difficulty) ? { difficulty } : {}),
    };
  });
}

/**
 * Read the envelope fields without validating the state inside it.
 *
 * The saved-match list calls this so an unreadable save can be listed and deleted
 * instead of breaking the list.
 */
export function readEnvelope(value: unknown): LocalSnapshotEnvelope {
  if (!isRecord(value)) {
    throw new LocalSnapshotError('NOT_A_SNAPSHOT', 'The file is not a JSON object.');
  }
  const format = value['format'];
  if (format !== LOCAL_SNAPSHOT_FORMAT) {
    throw new LocalSnapshotError(
      'NOT_A_SNAPSHOT',
      `The file is not a SeatGrab local save. Expected format "${LOCAL_SNAPSHOT_FORMAT}", found `
      + `${typeof format === 'string' ? `"${format}"` : 'no format field'}.`,
    );
  }
  const state = value['state'];
  if (!isRecord(state)) {
    throw new LocalSnapshotError('NOT_A_SNAPSHOT', 'The save carries no game state.');
  }
  return {
    format,
    formatVersion: requireInteger(value, 'formatVersion'),
    schemaVersion: requireInteger(value, 'schemaVersion'),
    engineVersion: requireString(value, 'engineVersion'),
    contentPackId: requireString(value, 'contentPackId'),
    contentVersion: requireString(value, 'contentVersion'),
    rulesetId: requireString(value, 'rulesetId'),
    rulesetVersion: requireString(value, 'rulesetVersion'),
    boardId: requireString(value, 'boardId'),
    boardVersion: requireString(value, 'boardVersion'),
    matchId: requireString(value, 'matchId'),
    revision: requireInteger(value, 'revision'),
    status: requireStatus(value),
    savedAt: requireString(value, 'savedAt'),
    players: requirePlayers(value),
    state: state as unknown as GameState,
  };
}

/**
 * Reject a save this build cannot read, naming the version that does not match.
 *
 * The three versions that decide readability are the game schema, the content pack and
 * the board. A save from a different engine build with the same three versions still
 * loads; `engineVersion` is recorded for diagnosis only.
 */
export function assertReadable(envelope: ReadabilityVersions): void {
  if (!recordsItsVersions(envelope)) {
    throw new LocalSnapshotError(
      'UNSUPPORTED_FORMAT',
      'This save does not record the schema, content pack and board versions this build '
      + 'checks, so it was written in a save format this build cannot read.',
    );
  }
  if (envelope.formatVersion !== LOCAL_SNAPSHOT_FORMAT_VERSION) {
    throw new LocalSnapshotError(
      'UNSUPPORTED_FORMAT',
      `This save uses save format version ${envelope.formatVersion}, but this build reads `
      + `version ${LOCAL_SNAPSHOT_FORMAT_VERSION}.`,
    );
  }
  if (envelope.schemaVersion !== GAME_SCHEMA_VERSION) {
    throw new LocalSnapshotError(
      'SCHEMA_MISMATCH',
      `This save uses game schema version ${envelope.schemaVersion}, but this build reads `
      + `version ${GAME_SCHEMA_VERSION}.`,
    );
  }
  if (envelope.contentPackId !== CONTENT_PACK_ID || envelope.contentVersion !== CONTENT_PACK_VERSION) {
    throw new LocalSnapshotError(
      'CONTENT_MISMATCH',
      `This save was made with content pack "${envelope.contentPackId}" ${envelope.contentVersion}, `
      + `but this build ships "${CONTENT_PACK_ID}" ${CONTENT_PACK_VERSION}.`,
    );
  }
  if (envelope.boardId !== BOARD_ID || envelope.boardVersion !== BOARD_VERSION) {
    throw new LocalSnapshotError(
      'BOARD_MISMATCH',
      `This save was made with board "${envelope.boardId}" ${envelope.boardVersion}, but this `
      + `build ships "${BOARD_ID}" ${BOARD_VERSION}.`,
    );
  }
}

/** Build the save document for a state the engine has already accepted. */
export function buildEnvelope(state: GameState, savedAt: Date): LocalSnapshotEnvelope {
  return {
    format: LOCAL_SNAPSHOT_FORMAT,
    formatVersion: LOCAL_SNAPSHOT_FORMAT_VERSION,
    schemaVersion: state.schemaVersion,
    engineVersion: state.engineVersion,
    contentPackId: state.content.contentPackId,
    contentVersion: state.content.contentVersion,
    rulesetId: state.content.rulesetId,
    rulesetVersion: state.content.rulesetVersion,
    boardId: state.content.boardId,
    boardVersion: state.content.boardVersion,
    matchId: state.matchId,
    revision: state.revision,
    status: state.status,
    savedAt: savedAt.toISOString(),
    players: state.players.map((player) => {
      const seat = state.config.players.find((entry) => entry.id === player.id);
      const controller = seat?.controller ?? 'human';
      return {
        id: player.id,
        displayName: player.displayName,
        partyId: player.partyId,
        controller,
        ...(controller === 'computer' && seat?.difficulty !== undefined
          ? { difficulty: seat.difficulty }
          : {}),
      };
    }),
    state: JSON.parse(serializeGame(state)) as GameState,
  };
}

/** Serialize the save document. This exact text is what export writes and import reads. */
export function writeDocument(state: GameState, savedAt: Date): string {
  return JSON.stringify(buildEnvelope(state, savedAt), null, 2);
}

/**
 * Whether the versions are all present and of the right type.
 *
 * A record written by an older save format can be missing a field the current build
 * checks, and `undefined` in a mismatch message tells a player nothing.
 */
function recordsItsVersions(versions: ReadabilityVersions): boolean {
  return Number.isInteger(versions.formatVersion)
    && Number.isInteger(versions.schemaVersion)
    && typeof versions.contentPackId === 'string' && versions.contentPackId.length > 0
    && typeof versions.contentVersion === 'string' && versions.contentVersion.length > 0
    && typeof versions.boardId === 'string' && versions.boardId.length > 0
    && typeof versions.boardVersion === 'string' && versions.boardVersion.length > 0;
}

/** Why this build cannot read a save with these versions, or `null` when it can. */
export function readabilityProblem(versions: ReadabilityVersions): string | null {
  try {
    assertReadable(versions);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function summarize(envelope: LocalSnapshotEnvelope): LocalMatchSummary {
  return {
    matchId: envelope.matchId,
    revision: envelope.revision,
    status: envelope.status,
    players: envelope.players,
    savedAt: envelope.savedAt,
    formatVersion: envelope.formatVersion,
    schemaVersion: envelope.schemaVersion,
    contentPackId: envelope.contentPackId,
    contentVersion: envelope.contentVersion,
    boardId: envelope.boardId,
    boardVersion: envelope.boardVersion,
    unreadableReason: readabilityProblem(envelope),
  };
}

/** Re-answer readability for a stored summary against the versions this build ships. */
export function recheckSummary(summary: LocalMatchSummary): LocalMatchSummary {
  return { ...summary, unreadableReason: readabilityProblem(summary) };
}

/**
 * Read a save document into a validated engine state.
 *
 * The state goes through the engine's own `loadGame`, so the header schema and every
 * state invariant are checked here rather than trusted.
 */
export function readDocument(document: string, content: GameContent): {
  envelope: LocalSnapshotEnvelope;
  state: GameState;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    throw new LocalSnapshotError(
      'NOT_A_SNAPSHOT',
      `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const envelope = readEnvelope(parsed);
  assertReadable(envelope);

  let state: GameState;
  try {
    state = loadGame(JSON.stringify(envelope.state), content);
  } catch (error) {
    throw new LocalSnapshotError(
      'UNREADABLE_STATE',
      `The saved state did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (state.matchId !== envelope.matchId || state.revision !== envelope.revision) {
    throw new LocalSnapshotError(
      'UNREADABLE_STATE',
      `The save header describes match ${envelope.matchId} at revision ${envelope.revision}, but `
      + `the state inside it is match ${state.matchId} at revision ${state.revision}.`,
    );
  }
  return { envelope, state };
}
