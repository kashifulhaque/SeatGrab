/**
 * Room lifecycle and authoritative command processing.
 *
 * This is the online equivalent of the browser's local transport adapter: it holds the
 * authoritative state, applies commands with the engine, projects an authorized view per
 * seat, and saves the result. Like that adapter it reimplements no rule. Every question
 * a rule answers — whether a command is legal, whose turn it is, what the next state is,
 * what a given seat may see — is asked of `applyCommand`, `getLegalActions` and
 * `projectGame`.
 *
 * What this file does own is everything the engine has no opinion about: who is holding
 * a seat, whether the credential presented is that seat's, when a lobby becomes a match,
 * and what is written to disk before a command is acknowledged.
 */
import {
  CommandEnvelopeSchema,
  SEATABLE_PARTY_IDS,
  isSeatablePartyId,
  type ClaimedSeat,
  type ComputerDifficulty,
  type CommandResponse,
  type GameCommand,
  type LobbySeatView,
  type LobbyView,
  type SeatView,
  type VisibleEvent,
} from '@seatgrab/protocol';
import {
  applyCommand,
  createGame,
  getLegalActions,
  loadGame,
  projectEvents,
  projectGame,
  serializeGame,
  type GameConfig,
  type GameContent,
  type GameEvent,
  type GameState,
} from '@seatgrab/engine';

import {
  credentialMatches,
  generateCredential,
  generateMatchId,
  generateRoomCode,
  generateSeed,
  hashCredential,
  normalizeRoomCode,
} from '../credentials.js';
import {
  MatchRepository,
  RoomCodeTakenError,
  type MatchRow,
  type SeatRow,
  type StoredEvent,
} from '../persistence/repository.js';

/**
 * The party identities a seat may claim.
 *
 * The list itself is `@seatgrab/protocol`'s, so the server and the browser cannot disagree
 * about which identities exist. What each one looks like stays in the browser, at
 * `apps/web/src/assets/parties.ts`, because that is presentation. Re-exported here
 * because this is where a reader of the room rules expects to find it.
 */
export { SEATABLE_PARTY_IDS };

export const MIN_SEATS = 3;
export const MAX_SEATS = 5;
export const MAX_NAME_LENGTH = 24;
/** Most events one catch-up read returns. A match emits far fewer than this in total. */
export const MAX_EVENT_PAGE = 500;

const ADVISORIES = ['sensitive', 'trigger'] as const;
type Advisory = (typeof ADVISORIES)[number];

/** A failure the transport turns into a status code. Never carries a stored secret. */
export class RoomError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    this.code = code;
  }
}

/** The authenticated caller: one seat of one match. */
export interface SeatIdentity {
  matchId: string;
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  displayName: string;
  partyId: string;
}

/**
 * The shapes the room routes answer with.
 *
 * All three are `@seatgrab/protocol`'s, because both transports return them and the browser
 * reads them: one declaration per shape, on the wire rather than on either side of it.
 * Re-exported here so a caller of `viewFor` or `claimSeat` finds the type beside the
 * method that returns it.
 */
export type { ClaimedSeat, LobbySeatView, LobbyView, SeatView };

export interface RoomServiceOptions {
  repository: MatchRepository;
  content: GameContent;
  /** Injected so tests can pin timestamps. No rule reads a timestamp. */
  now?: () => Date;
  /** Injected so tests can pin the deal. Production uses the system generator. */
  seed?: () => number;
}

function assertName(displayName: string): string {
  const name = displayName.trim();
  if (name.length === 0) {
    throw new RoomError(400, 'INVALID_SEAT', 'Enter a name for this seat.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new RoomError(400, 'INVALID_SEAT', `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return name;
}

function assertParty(partyId: string): string {
  if (!isSeatablePartyId(partyId)) {
    throw new RoomError(400, 'INVALID_SEAT', `"${partyId}" is not a party identity this server seats.`);
  }
  return partyId;
}

function assertAdvisories(values: readonly string[]): readonly Advisory[] {
  const chosen: Advisory[] = [];
  for (const value of values) {
    if (!(ADVISORIES as readonly string[]).includes(value)) {
      throw new RoomError(400, 'INVALID_SETUP', `"${value}" is not a content advisory filter.`);
    }
    if (!chosen.includes(value as Advisory)) chosen.push(value as Advisory);
  }
  return chosen;
}

/** The engine's stored visibility, as one text column. */
function storeVisibility(visibility: GameEvent['visibility']): string {
  return typeof visibility === 'string' ? visibility : JSON.stringify(visibility);
}

function readVisibility(stored: string): GameEvent['visibility'] {
  if (stored === 'public' || stored === 'server') return stored;
  const parsed: unknown = JSON.parse(stored);
  if (
    typeof parsed === 'object' && parsed !== null && 'playerIds' in parsed
    && Array.isArray((parsed as { playerIds: unknown }).playerIds)
  ) {
    return { playerIds: (parsed as { playerIds: string[] }).playerIds };
  }
  // An unreadable visibility is treated as server-only. Failing closed loses a line of
  // history; failing open would show a seat something the engine marked private.
  return 'server';
}

function toStoredEvents(events: readonly GameEvent[]): readonly Omit<StoredEvent, 'sequence'>[] {
  return events.map((event) => ({
    eventId: event.id,
    revision: 0,
    type: event.type,
    message: event.message,
    actorPlayerId: event.actorId ?? null,
    visibility: storeVisibility(event.visibility),
  }));
}

export class RoomService {
  readonly #repository: MatchRepository;
  readonly #content: GameContent;
  readonly #now: () => Date;
  readonly #seed: () => number;

  constructor(options: RoomServiceOptions) {
    this.#repository = options.repository;
    this.#content = options.content;
    this.#now = options.now ?? (() => new Date());
    this.#seed = options.seed ?? generateSeed;
  }

  /**
   * Open a room and claim its first seat for the caller.
   *
   * The caller becomes the host, which grants room management only: starting the match.
   * Section 14.1 keeps a host out of rule overrides and opponent moves, and nothing here
   * gives a host a second credential or a wider projection.
   */
  createRoom(input: {
    seatCount: number;
    contentAdvisories: readonly string[];
    displayName: string;
    partyId: string;
  }): ClaimedSeat {
    if (!Number.isInteger(input.seatCount) || input.seatCount < MIN_SEATS || input.seatCount > MAX_SEATS) {
      throw new RoomError(
        400,
        'INVALID_SETUP',
        `This edition seats ${MIN_SEATS} to ${MAX_SEATS} players, so a room cannot have ${input.seatCount} seats.`,
      );
    }
    const displayName = assertName(input.displayName);
    const partyId = assertParty(input.partyId);
    const advisories = assertAdvisories(input.contentAdvisories);
    const createdAt = this.#now().toISOString();

    // A room code collision is possible, so mint another rather than failing the
    // request. The unique index in the schema, not this loop, is what makes it correct.
    let match: MatchRow | null = null;
    for (let attempt = 0; attempt < 8 && match === null; attempt += 1) {
      try {
        match = this.#repository.createMatch({
          matchId: generateMatchId(),
          roomCode: generateRoomCode(),
          seatCount: input.seatCount,
          contentAdvisories: advisories,
          tiePolicy: 'jointWinners',
          contentPackId: this.#content.contentPackId,
          contentVersion: this.#content.contentVersion,
          rulesetId: this.#content.rulesetId,
          rulesetVersion: this.#content.rulesetVersion,
          boardId: this.#content.board.id,
          boardVersion: this.#content.board.version,
          seats: Array.from({ length: input.seatCount }, (_, index) => ({
            seatIndex: index,
            playerId: `p${index + 1}`,
            isHost: index === 0,
          })),
          createdAt,
        });
      } catch (error) {
        if (!(error instanceof RoomCodeTakenError)) throw error;
      }
    }
    if (match === null) {
      throw new RoomError(503, 'ROOM_CODE_UNAVAILABLE', 'No free room code was found. Try again.');
    }
    return this.#claim(match, 0, displayName, partyId);
  }

  /** The lobby a room code opens. Readable by anyone holding the code. */
  lobby(roomCode: string): LobbyView {
    const match = this.#requireRoom(roomCode);
    const seats = this.#repository.listSeats(match.matchId);
    return {
      roomCode: match.roomCode,
      matchId: match.matchId,
      status: match.status,
      seatCount: match.seatCount,
      contentAdvisories: match.contentAdvisories,
      seats: seats.map((seat) => ({
        seatIndex: seat.seatIndex,
        playerId: seat.playerId,
        isHost: seat.isHost,
        claimed: seat.claimed,
        displayName: seat.displayName,
        partyId: seat.partyId,
        controller: seat.controller,
        ...(seat.controller === 'computer' && seat.difficulty !== null
          ? { difficulty: seat.difficulty }
          : {}),
      })),
      ready: seats.every((seat) => seat.claimed),
      contentPackId: match.contentPackId,
      contentVersion: match.contentVersion,
      boardId: match.boardId,
      boardVersion: match.boardVersion,
    };
  }

  /**
   * Claim a free seat with the room code.
   *
   * `seatIndex` is optional: a player who does not care takes the lowest free seat. An
   * occupied seat is refused, whichever way it was asked for, and the refusal mints
   * nothing. This is where section 14.1's rule that a room code alone must not grant
   * control of an occupied seat is actually enforced.
   */
  claimSeat(input: {
    roomCode: string;
    seatIndex?: number;
    displayName: string;
    partyId: string;
  }): ClaimedSeat {
    const match = this.#requireRoom(input.roomCode);
    if (match.status !== 'lobby') {
      throw new RoomError(409, 'MATCH_STARTED', 'This match has already started, so its seats are locked.');
    }
    const displayName = assertName(input.displayName);
    const partyId = assertParty(input.partyId);
    const seats = this.#repository.listSeats(match.matchId);

    // A computer seat reads as claimed, so this scan already refuses a name or a party
    // that a computer at this table holds.
    for (const seat of seats) {
      if (!seat.claimed) continue;
      if (seat.partyId === partyId) {
        throw new RoomError(409, 'PARTY_TAKEN', `Another seat already holds the ${partyId} identity.`);
      }
      if (seat.displayName?.toLocaleLowerCase() === displayName.toLocaleLowerCase()) {
        throw new RoomError(409, 'NAME_TAKEN', 'Another seat at this table already uses that name.');
      }
    }

    const wanted = input.seatIndex === undefined
      ? seats.find((seat) => !seat.claimed)
      : seats.find((seat) => seat.seatIndex === input.seatIndex);
    if (wanted === undefined) {
      throw new RoomError(
        input.seatIndex === undefined ? 409 : 404,
        input.seatIndex === undefined ? 'ROOM_FULL' : 'NO_SUCH_SEAT',
        input.seatIndex === undefined
          ? 'Every seat at this table is taken.'
          : `This table has no seat ${input.seatIndex}.`,
      );
    }
    if (wanted.claimed) {
      throw new RoomError(
        409,
        'SEAT_TAKEN',
        `Seat ${wanted.seatIndex} is already held by another player. The room code does not transfer it.`,
      );
    }
    return this.#claim(match, wanted.seatIndex, displayName, partyId);
  }

  /**
   * Hold a free seat with a computer.
   *
   * Host only, lobby only, and never the host's own seat: the table needs at least one
   * person in it, and the host is the seat that can still free a computer afterwards.
   * The server picks the name and the party rather than taking them from the request,
   * because a computer seat mints no credential and so has nobody to correct a clash.
   */
  seatComputer(host: SeatIdentity, seatIndex: number, difficulty: ComputerDifficulty): LobbyView {
    const match = this.#repository.findMatch(host.matchId);
    if (match === null) {
      throw new RoomError(404, 'NO_SUCH_MATCH', 'That match no longer exists.');
    }
    if (!host.isHost) {
      throw new RoomError(403, 'NOT_HOST', 'Only the seat that opened this room can seat a computer at it.');
    }
    if (match.status !== 'lobby') {
      throw new RoomError(409, 'MATCH_STARTED', 'This match has started, so its seats are locked.');
    }
    if (seatIndex === host.seatIndex) {
      throw new RoomError(
        409,
        'CANNOT_SEAT_HOST',
        'The host seat is played by a person. Seat the computer somewhere else.',
      );
    }
    const seats = this.#repository.listSeats(match.matchId);
    const wanted = seats.find((seat) => seat.seatIndex === seatIndex);
    if (wanted === undefined) {
      throw new RoomError(404, 'NO_SUCH_SEAT', `This table has no seat ${seatIndex}.`);
    }
    if (wanted.claimed) {
      throw new RoomError(409, 'SEAT_TAKEN', `Seat ${seatIndex} is already held.`);
    }

    const taken = seats
      .filter((seat) => seat.claimed && seat.displayName !== null)
      .map((seat) => seat.displayName!.toLocaleLowerCase());
    let ordinal = 1;
    let displayName = `Computer ${ordinal}`;
    while (taken.includes(displayName.toLocaleLowerCase())) {
      ordinal += 1;
      displayName = `Computer ${ordinal}`;
    }
    const heldParties = new Set(seats.filter((seat) => seat.claimed).map((seat) => seat.partyId));
    const partyId = SEATABLE_PARTY_IDS.find((candidate) => !heldParties.has(candidate));
    if (partyId === undefined) {
      throw new RoomError(409, 'NO_FREE_PARTY', 'Every party identity at this table is taken.');
    }

    const seated = this.#repository.seatComputer(match.matchId, seatIndex, {
      displayName,
      partyId,
      difficulty,
      claimedAt: this.#now().toISOString(),
    });
    if (!seated) {
      throw new RoomError(409, 'SEAT_TAKEN', `Seat ${seatIndex} was taken while this request was in flight.`);
    }
    return this.lobby(match.roomCode);
  }

  /**
   * The identities the computer driver acts under, one per computer seat.
   *
   * These are built from seat rows and never from a credential, because a computer seat
   * holds none. `authenticate` therefore still refuses every computer seat, so nothing
   * arriving over the wire can act as one.
   */
  computerSeats(matchId: string): readonly (SeatIdentity & { difficulty: ComputerDifficulty })[] {
    return this.#repository
      .listSeats(matchId)
      .flatMap((seat) => {
        if (seat.controller !== 'computer' || seat.difficulty === null) return [];
        return [{
          matchId: seat.matchId,
          seatIndex: seat.seatIndex,
          playerId: seat.playerId,
          isHost: false,
          displayName: seat.displayName ?? seat.playerId,
          partyId: seat.partyId ?? seat.playerId,
          difficulty: seat.difficulty,
        }];
      });
  }

  /** Every match that is mid-play and seats at least one computer. */
  matchesWithComputers(): readonly MatchRow[] {
    return this.#repository.listMatchesWithComputers(['setup', 'active']);
  }

  /**
   * Take a seat's claim back, so somebody can claim it again.
   *
   * This exists because of a hole a real table reaches: a seat credential is stored in
   * the browser that claimed it, is returned exactly once, and is the only thing that
   * plays that seat. A player who clears their site data, or opens the room on a second
   * device, has no way back in — and because a room cannot start with an empty seat, one
   * player's cleared storage strands the whole table.
   *
   * Three rules keep this from becoming the hole section 14.1 forbids, where a room code
   * alone is enough to take a seat somebody else is sitting in:
   *
   * 1. **Only the host may release a seat**, and only with the host's own credential. The
   *    room code is not enough, because the room code is read aloud.
   * 2. **Only before the match starts.** Once seats lock, a release would hand a stranger
   *    a seat holding private cards and committed answers. A table that loses a
   *    credential mid-match has lost that seat, and this does not change it.
   * 3. **The host cannot release their own seat.** It would leave a started-but-hostless
   *    room that nobody could release anything in, including the seat just vacated.
   *
   * Releasing does not reissue anything. The old credential stops working, the seat goes
   * back to unclaimed, and the player claims it again with the room code like anyone
   * else — which is the same path, and the same evidence, as sitting down the first time.
   */
  releaseSeat(host: SeatIdentity, seatIndex: number): LobbyView {
    const match = this.#repository.findMatch(host.matchId);
    if (match === null) {
      throw new RoomError(404, 'NO_SUCH_MATCH', 'That match no longer exists.');
    }
    if (!host.isHost) {
      throw new RoomError(
        403,
        'NOT_HOST',
        'Only the seat that opened this room can free a seat at it.',
      );
    }
    if (match.status !== 'lobby') {
      throw new RoomError(
        409,
        'MATCH_STARTED',
        'This match has started, so its seats are locked. A seat holds private cards and '
        + 'answers once play begins, and freeing one would hand them to whoever claimed it next.',
      );
    }
    if (seatIndex === host.seatIndex) {
      throw new RoomError(
        409,
        'CANNOT_RELEASE_HOST',
        'The host seat cannot be freed: nothing would be left that could free a seat at '
        + 'this table. Open a new room instead.',
      );
    }
    const seat = this.#repository
      .listSeats(match.matchId)
      .find((candidate) => candidate.seatIndex === seatIndex);
    if (seat === undefined) {
      throw new RoomError(404, 'NO_SUCH_SEAT', `This table has no seat ${seatIndex}.`);
    }
    if (!seat.claimed) {
      throw new RoomError(409, 'SEAT_FREE', `Seat ${seatIndex} is already free.`);
    }
    this.#repository.releaseSeat(match.matchId, seatIndex);
    return this.lobby(match.roomCode);
  }

  /**
   * Authenticate a credential against a match.
   *
   * The credential is looked up by its hash, and the match named in the route must be
   * the match the seat belongs to — so a valid credential for one room cannot act in
   * another.
   */
  authenticate(matchId: string, credential: string | null): SeatIdentity {
    if (credential === null || credential.length === 0) {
      throw new RoomError(401, 'NO_CREDENTIAL', 'This request needs the seat credential issued when the seat was claimed.');
    }
    const seat = this.#repository.findSeatByCredentialHash(hashCredential(credential));
    // One refusal for every way this can fail — wrong credential, right credential for
    // another match, a seat row without its hash. A caller learns that the credential
    // does not work here, and not which of those it was.
    if (
      seat === null
      || seat.matchId !== matchId
      || seat.credentialHash === null
      || !credentialMatches(credential, seat.credentialHash)
    ) {
      throw new RoomError(401, 'BAD_CREDENTIAL', 'That credential does not hold a seat in this match.');
    }
    if (seat.displayName === null || seat.partyId === null) {
      throw new RoomError(500, 'SEAT_INCOMPLETE', 'That seat holds a credential but no identity.');
    }
    return {
      matchId: seat.matchId,
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      isHost: seat.isHost,
      displayName: seat.displayName,
      partyId: seat.partyId,
    };
  }

  /**
   * Start the match, freezing the lobby into an immutable `GameConfig`.
   *
   * Seat order is the clockwise order the room was created with, so seat 0 is `p1`. The
   * engine re-checks the seat count and the uniqueness of player and party identifiers
   * and rejects a config this method should never have produced.
   */
  start(seat: SeatIdentity): SeatView {
    if (!seat.isHost) {
      throw new RoomError(403, 'NOT_HOST', 'Only the player who opened the room can start the match.');
    }
    const match = this.#requireMatch(seat.matchId);
    if (match.status !== 'lobby') {
      throw new RoomError(409, 'ALREADY_STARTED', 'This match has already started.');
    }
    const seats = this.#repository.listSeats(match.matchId);
    const unclaimed = seats.filter((row) => !row.claimed);
    if (unclaimed.length > 0) {
      throw new RoomError(
        409,
        'SEATS_UNCLAIMED',
        `${unclaimed.length} seat${unclaimed.length === 1 ? ' is' : 's are'} still open. `
        + 'Every seat must be claimed before the match starts.',
      );
    }

    const config: GameConfig = {
      matchId: match.matchId,
      players: seats.map((row) => ({
        id: row.playerId,
        displayName: row.displayName ?? row.playerId,
        partyId: row.partyId ?? row.playerId,
        controller: row.controller,
        ...(row.controller === 'computer' && row.difficulty !== null
          ? { difficulty: row.difficulty }
          : {}),
      })),
      contentAdvisories: match.contentAdvisories.filter(
        (value): value is Advisory => (ADVISORIES as readonly string[]).includes(value),
      ),
      tiePolicy: 'jointWinners',
    };

    let state: GameState;
    try {
      state = createGame(config, this.#content, this.#seed());
    } catch (error) {
      throw new RoomError(
        400,
        'INVALID_SETUP',
        `This table cannot start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const started = this.#repository.startMatch({
      matchId: match.matchId,
      status: state.status,
      revision: state.revision,
      schemaVersion: state.schemaVersion,
      engineVersion: state.engineVersion,
      snapshot: serializeGame(state),
      events: toStoredEvents(state.events),
      at: this.#now().toISOString(),
    });
    if (!started) {
      // Another request started the match between the read and the write. Its state is
      // the authority, so answer with that rather than with a second deal.
      return this.viewFor(seat);
    }
    return this.#seatView(state, seat);
  }

  /** The authorized projection for one seat, read fresh from the stored snapshot. */
  viewFor(seat: SeatIdentity): SeatView {
    const state = this.#requireState(seat.matchId);
    return this.#seatView(state, seat);
  }

  /**
   * Apply one command from one seat, or return why it was refused.
   *
   * The whole read-decide-write path is synchronous, so no second request can run
   * against the match between loading the snapshot and committing the result. That is
   * what serializes command processing per match in a single process; Session 14 adds
   * the explicit per-match queue the WebSocket path needs.
   */
  submit(seat: SeatIdentity, body: unknown): { response: CommandResponse; duplicate: boolean } {
    const parsed = CommandEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new RoomError(400, 'INVALID_COMMAND', `This is not a command envelope: ${parsed.error.message}`);
    }
    const envelope = parsed.data;
    if (envelope.matchId !== seat.matchId) {
      throw new RoomError(400, 'WRONG_MATCH', 'The envelope names a different match from the one addressed.');
    }

    const existing = this.#repository.findCommand(seat.matchId, envelope.commandId);
    if (existing !== null) {
      if (existing.actorPlayerId !== seat.playerId) {
        throw new RoomError(
          409,
          'COMMAND_ID_REUSED',
          'That command ID was already used by another seat in this match. Use a fresh one.',
        );
      }
      return { response: JSON.parse(existing.response) as CommandResponse, duplicate: true };
    }

    const match = this.#requireMatch(seat.matchId);
    if (match.snapshot === null) {
      throw new RoomError(409, 'NOT_STARTED', 'This match has not started, so it takes no commands yet.');
    }
    const state = this.#loadSnapshot(match);
    const at = this.#now().toISOString();
    const serializedCommand = JSON.stringify(envelope.command);

    if (envelope.expectedRevision !== state.revision) {
      const response: CommandResponse = {
        ok: false,
        code: 'STALE_REVISION',
        message:
          `This command was written against revision ${envelope.expectedRevision}, but the match is at `
          + `revision ${state.revision}. Read the match again and choose from what it says now.`,
        revision: state.revision,
      };
      this.#repository.recordRejection({
        matchId: seat.matchId,
        commandId: envelope.commandId,
        actorPlayerId: seat.playerId,
        revisionBefore: state.revision,
        command: serializedCommand,
        response: JSON.stringify(response),
        at,
      });
      return { response, duplicate: false };
    }

    const result = applyCommand(state, { playerId: seat.playerId }, envelope.command as GameCommand, this.#content);
    if (!result.ok) {
      this.#repository.recordRejection({
        matchId: seat.matchId,
        commandId: envelope.commandId,
        actorPlayerId: seat.playerId,
        revisionBefore: state.revision,
        command: serializedCommand,
        response: JSON.stringify(result.response),
        at,
      });
      return { response: result.response, duplicate: false };
    }

    this.#repository.commitCommand({
      matchId: seat.matchId,
      commandId: envelope.commandId,
      actorPlayerId: seat.playerId,
      revisionBefore: envelope.expectedRevision,
      revisionAfter: result.state.revision,
      status: result.state.status,
      schemaVersion: result.state.schemaVersion,
      engineVersion: result.state.engineVersion,
      snapshot: serializeGame(result.state),
      command: serializedCommand,
      response: JSON.stringify(result.response),
      events: toStoredEvents(result.events).map((event) => ({
        ...event,
        revision: result.state.revision,
      })),
      at,
    });
    return { response: result.response, duplicate: false };
  }

  /**
   * Stored events this seat may see, after `sinceSequence`.
   *
   * The filter is the engine's own `projectEvents`, over the visibility the engine wrote
   * at the time. The server never decides visibility itself.
   */
  events(seat: SeatIdentity, sinceSequence: number): {
    events: readonly VisibleEvent[];
    cursor: number;
  } {
    const stored = this.#repository.readEvents(seat.matchId, sinceSequence, MAX_EVENT_PAGE);
    const asEngineEvents: GameEvent[] = stored.map((event) => ({
      id: event.eventId,
      type: event.type,
      message: event.message,
      visibility: readVisibility(event.visibility),
      ...(event.actorPlayerId === null ? {} : { actorId: event.actorPlayerId }),
    }));
    const visible = projectEvents(asEngineEvents, { kind: 'player', playerId: seat.playerId });
    const last = stored.at(-1);
    return { events: visible, cursor: last?.sequence ?? sinceSequence };
  }

  #claim(match: MatchRow, seatIndex: number, displayName: string, partyId: string): ClaimedSeat {
    const credential = generateCredential();
    const claimed = this.#repository.claimSeat(match.matchId, seatIndex, {
      displayName,
      partyId,
      credentialHash: hashCredential(credential),
      claimedAt: this.#now().toISOString(),
    });
    if (!claimed) {
      throw new RoomError(
        409,
        'SEAT_TAKEN',
        `Seat ${seatIndex} was claimed by another player first. The room code does not transfer it.`,
      );
    }
    const seats = this.#repository.listSeats(match.matchId);
    const seat = seats.find((row) => row.seatIndex === seatIndex);
    if (seat === undefined) throw new Error('The claimed seat did not persist.');
    return {
      matchId: match.matchId,
      roomCode: match.roomCode,
      seatIndex,
      playerId: seat.playerId,
      isHost: seat.isHost,
      credential,
    };
  }

  #seatView(state: GameState, seat: SeatIdentity): SeatView {
    const view = projectGame(state, { kind: 'player', playerId: seat.playerId }, this.#content);
    const prompt = view.prompt;
    const promptProblem = prompt?.kind === 'choice' && prompt.context.op === 'unsupported'
      ? `This build cannot describe the prompt this match is waiting on (interaction ${prompt.interactionId}). `
        + 'Do not act on it.'
      : null;
    return {
      view,
      legalActions: getLegalActions(state, seat.playerId),
      eventCursor: this.#repository.countEvents(seat.matchId),
      promptProblem,
    };
  }

  #requireRoom(roomCode: string): MatchRow {
    const normalized = normalizeRoomCode(roomCode);
    if (normalized === null) {
      throw new RoomError(404, 'NO_SUCH_ROOM', 'That is not a room code.');
    }
    const match = this.#repository.findMatchByRoomCode(normalized);
    if (match === null) {
      throw new RoomError(404, 'NO_SUCH_ROOM', 'No room is open with that code.');
    }
    return match;
  }

  #requireMatch(matchId: string): MatchRow {
    const match = this.#repository.findMatch(matchId);
    if (match === null) {
      throw new RoomError(404, 'NO_SUCH_MATCH', 'No match is stored with that identifier.');
    }
    return match;
  }

  #requireState(matchId: string): GameState {
    const match = this.#requireMatch(matchId);
    if (match.snapshot === null) {
      throw new RoomError(409, 'NOT_STARTED', 'This match has not started, so it has no state to read.');
    }
    return this.#loadSnapshot(match);
  }

  /**
   * Read the stored snapshot back into a validated state.
   *
   * `loadGame` re-runs the header schema and every state invariant, so a snapshot that
   * was corrupted on disk is refused here rather than played on.
   */
  #loadSnapshot(match: MatchRow): GameState {
    try {
      return loadGame(match.snapshot ?? '', this.#content);
    } catch (error) {
      throw new RoomError(
        500,
        'SNAPSHOT_UNREADABLE',
        `The stored state for match ${match.matchId} did not load: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
