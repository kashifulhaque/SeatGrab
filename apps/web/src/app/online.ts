/**
 * Everything the online screens decide, with no React in it.
 *
 * This is the online counterpart of `setup.ts`, and it is a separate module rather than a
 * wider one because the two lobbies are different models, not two settings of one. A
 * local lobby is a draft of the whole table: every seat is typed in on one device, and
 * pressing Start freezes all of them at once. An online lobby is a draft of *one* seat
 * against a table the server owns — the other seats arrive over the network, already
 * decided, and the only thing this browser may change is its own. Merging them would mean
 * one model with a "which seats are mine" flag threaded through every operation, and the
 * privacy rule that makes online play safe is exactly that the answer is always "one".
 *
 * What is shared is shared honestly: the seat counts, the name length and the advisory
 * filters come from `setup.ts`, because those are facts about the edition rather than
 * about a transport, and the server re-checks every one of them anyway.
 *
 * Two rules from section 14.4 are implemented here rather than in a screen:
 *
 * 1. A failed submit is either a ruling or a silence, and they are not the same thing to
 *    a player mid-turn. `MatchSurface.submit` resolves with the engine's refusal and
 *    rejects when the command could not be put to the engine at all; `describeSubmit`
 *    turns that distinction into the two sentences a screen shows.
 * 2. `rejected` is terminal. `describeConnection` offers no retry there — retrying says
 *    nothing new — and offers the way back to the room code instead.
 */
import type { ContentAdvisory } from '@seatgrab/content';
import type { CommandResponse, ComputerDifficulty, SeatController } from '@seatgrab/protocol';

import { PARTY_IDENTITIES, type PartyIdentity } from '../assets/parties';
import type { ConnectionStatus, LobbySeatView, LobbyView, StoredSeat } from '../remote';
import { RoomRequestError, foldRoomCode } from '../remote';

import { MAX_NAME_LENGTH, MAX_SEATS, MIN_SEATS } from './setup';

/** One reason a form cannot be sent, addressed to the control that can fix it. */
export interface OnlineProblem {
  field: 'seatCount' | 'displayName' | 'partyId' | 'roomCode' | 'seatIndex';
  message: string;
}

/* ------------------------------------------------------------------ hosting */

/** The host's own seat, and the settings the room is opened with. */
export interface HostDraft {
  seatCount: number;
  displayName: string;
  partyId: string;
  advisories: readonly ContentAdvisory[];
}

export function defaultHostDraft(): HostDraft {
  const first = PARTY_IDENTITIES[0];
  if (first === undefined) throw new Error('No party identity ships, so no seat can be claimed.');
  return { seatCount: MIN_SEATS, displayName: '', partyId: first.partyId, advisories: [] };
}

export function validateHostDraft(draft: HostDraft): readonly OnlineProblem[] {
  const problems: OnlineProblem[] = [];
  if (
    !Number.isInteger(draft.seatCount)
    || draft.seatCount < MIN_SEATS
    || draft.seatCount > MAX_SEATS
  ) {
    problems.push({
      field: 'seatCount',
      message: `This edition seats ${MIN_SEATS} to ${MAX_SEATS} players.`,
    });
  }
  problems.push(...nameProblems(draft.displayName));
  problems.push(...partyProblems(draft.partyId));
  return problems;
}

/* ------------------------------------------------------------------ joining */

/**
 * One seat being claimed in someone else's room.
 *
 * `seatIndex` is `null` for "any free seat", which is what a player who does not care
 * about turn order wants and what the server does when the field is left out. Seat order
 * is fixed when the room is created, so choosing a seat here is choosing a place in a
 * clockwise order that already exists rather than negotiating one.
 */
export interface JoinDraft {
  roomCode: string;
  displayName: string;
  partyId: string;
  seatIndex: number | null;
}

export function defaultJoinDraft(roomCode = ''): JoinDraft {
  const first = PARTY_IDENTITIES[0];
  if (first === undefined) throw new Error('No party identity ships, so no seat can be claimed.');
  return { roomCode, displayName: '', partyId: first.partyId, seatIndex: null };
}

/**
 * Every reason this draft cannot be sent.
 *
 * `lobby` is what the room code has answered with so far, or `null` before it has. When
 * it is present the check is sharper — a taken party and a taken seat are refusals this
 * browser can make without a round trip — but it is never the authority: the server
 * re-decides both, and two players pressing Join at once is precisely the case only the
 * server can settle.
 */
export function validateJoinDraft(
  draft: JoinDraft,
  lobby: LobbyView | null,
): readonly OnlineProblem[] {
  const problems: OnlineProblem[] = [];
  if (foldRoomCode(draft.roomCode).length === 0) {
    problems.push({ field: 'roomCode', message: 'Enter the room code the host shared with you.' });
  }
  problems.push(...nameProblems(draft.displayName));
  problems.push(...partyProblems(draft.partyId));

  if (lobby !== null) {
    if (lobby.status !== 'lobby') {
      problems.push({
        field: 'roomCode',
        message: 'This match has already started, so its seats are locked. Ask the host for a new room.',
      });
    }
    const takenParty = lobby.seats.find((seat) => seat.claimed && seat.partyId === draft.partyId);
    if (takenParty !== undefined) {
      problems.push({
        field: 'partyId',
        message: `${takenParty.displayName ?? 'Another seat'} already holds this party. Choose another.`,
      });
    }
    if (draft.seatIndex !== null) {
      const seat = lobby.seats.find((entry) => entry.seatIndex === draft.seatIndex);
      if (seat === undefined) {
        problems.push({ field: 'seatIndex', message: 'This room has no such seat.' });
      } else if (seat.claimed) {
        problems.push({
          field: 'seatIndex',
          message: `Seat ${seat.seatIndex + 1} is taken. Choose a free one, or let the server pick.`,
        });
      }
    } else if (lobby.seats.every((seat) => seat.claimed)) {
      problems.push({ field: 'seatIndex', message: 'Every seat in this room is taken.' });
    }
  }
  return problems;
}

function nameProblems(displayName: string): readonly OnlineProblem[] {
  const name = displayName.trim();
  if (name.length === 0) {
    return [{ field: 'displayName', message: 'Enter the name the other players will see.' }];
  }
  if (name.length > MAX_NAME_LENGTH) {
    return [{
      field: 'displayName',
      message: `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`,
    }];
  }
  return [];
}

function partyProblems(partyId: string): readonly OnlineProblem[] {
  return PARTY_IDENTITIES.some((party) => party.partyId === partyId)
    ? []
    : [{ field: 'partyId', message: 'Choose a party for this seat.' }];
}

/** The problems for one field, in the order they were found. */
export function problemsFor(
  problems: readonly OnlineProblem[],
  field: OnlineProblem['field'],
): readonly OnlineProblem[] {
  return problems.filter((problem) => problem.field === field);
}

/* ------------------------------------------------------- reading the lobby */

/** One seat of an online lobby, ready to draw. */
export interface LobbySeatRow {
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  claimed: boolean;
  /** The claimed name, or wording for a seat nobody holds yet. */
  label: string;
  party: PartyIdentity | null;
  /** True for the seat this browser holds the credential for. */
  isMine: boolean;
  /**
   * Whether this browser may free this seat, and what to say when it may not.
   *
   * `reason` is present only when there is something worth saying — a claimed seat this
   * browser cannot free — so a row with no reason draws no note. A free seat and the
   * host's own seat are ordinary rows; neither needs an explanation.
   */
  release: { can: boolean; reason?: string };
  /** Who plays the seat. A computer seat is claimed and holds no credential. */
  controller: SeatController;
  /** Present exactly when `controller` is `computer`. */
  difficulty?: ComputerDifficulty;
  /**
   * Whether this browser may seat a computer here.
   *
   * It mirrors `RoomService.seatComputer`: the host only, before the match starts, on a
   * free seat, and never the host's own.
   */
  canSeatComputer: boolean;
}

export function lobbySeatRows(
  lobby: LobbyView,
  /**
   * The seat this browser holds, or `null` for a lobby read without one.
   *
   * `isHost` is what decides whether freeing a seat is offered. It is optional because a
   * caller that does not know is not the host — a browser holding no seat, or a call from
   * before the claim landed — and defaulting to "not the host" is the right way to be
   * wrong about it.
   */
  mine: { seatIndex: number; isHost?: boolean } | null,
): readonly LobbySeatRow[] {
  return [...lobby.seats]
    .sort((left, right) => left.seatIndex - right.seatIndex)
    .map((seat) => ({
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      isHost: seat.isHost,
      claimed: seat.claimed,
      label: seat.claimed
        ? seat.displayName ?? seat.playerId
        : 'Waiting for a player',
      party: seat.partyId === null
        ? null
        : PARTY_IDENTITIES.find((party) => party.partyId === seat.partyId) ?? null,
      isMine: mine !== null && seat.seatIndex === mine.seatIndex,
      release: releaseState(lobby, seat, mine),
      controller: seat.controller,
      ...(seat.controller === 'computer' && seat.difficulty !== undefined
        ? { difficulty: seat.difficulty }
        : {}),
      canSeatComputer: !seat.claimed
        && lobby.status === 'lobby'
        && mine !== null
        && mine.isHost === true
        && seat.seatIndex !== mine.seatIndex,
    }));
}

/**
 * Whether this browser may free a seat.
 *
 * The server decides this and refuses anything else; this decides what to draw, and it
 * mirrors the server's rules so a host is not offered a button that will be refused. The
 * three rules are the ones in `RoomService.releaseSeat`: the host only, before the match
 * starts, and never the host's own seat.
 *
 * Freeing is offered at all because of a hole a real table reaches — a seat credential is
 * issued once, to one browser, and a player who clears their site data cannot rejoin.
 * Since a room cannot start with an empty seat, one player's cleared storage would
 * otherwise strand the whole table.
 */
function releaseState(
  lobby: LobbyView,
  seat: LobbySeatView,
  mine: { seatIndex: number; isHost?: boolean } | null,
): { can: boolean; reason?: string } {
  if (!seat.claimed) return { can: false };
  if (mine === null || mine.isHost !== true) return { can: false };
  if (seat.seatIndex === mine.seatIndex) return { can: false };
  if (lobby.status !== 'lobby') {
    return {
      can: false,
      reason: 'Seats lock when the table is dealt. A seat holds private cards and answers '
        + 'once play begins, so it cannot be handed on.',
    };
  }
  return { can: true };
}

/** The seats nobody holds yet, in seat order. */
export function freeSeats(lobby: LobbyView): readonly LobbySeatView[] {
  return [...lobby.seats]
    .filter((seat) => !seat.claimed)
    .sort((left, right) => left.seatIndex - right.seatIndex);
}

/** The party identities no claimed seat in this lobby holds. */
export function freeParties(lobby: LobbyView | null): readonly PartyIdentity[] {
  if (lobby === null) return PARTY_IDENTITIES;
  const taken = new Set(
    lobby.seats.filter((seat) => seat.claimed && seat.partyId !== null).map((seat) => seat.partyId),
  );
  return PARTY_IDENTITIES.filter((party) => !taken.has(party.partyId));
}

/** How full the room is, as a sentence the lobby shows while it waits. */
export function describeLobbyFill(lobby: LobbyView): string {
  const claimed = lobby.seats.filter((seat) => seat.claimed).length;
  if (lobby.status !== 'lobby') return 'This match has started.';
  if (claimed >= lobby.seatCount) return `All ${lobby.seatCount} seats are taken.`;
  const waiting = lobby.seatCount - claimed;
  return `${claimed} of ${lobby.seatCount} seats taken. Waiting for ${waiting} more player${
    waiting === 1 ? '' : 's'
  } to join with the room code.`;
}

/**
 * Whether this browser may deal the table, and why not when it may not.
 *
 * The server decides this too, and refuses a start from a seat that is not the host or a
 * table that is not full. Saying it here as well is what lets the control be drawn
 * disabled with the reason beside it, which section 13.3 asks for throughout, rather than
 * inviting a click that can only be refused.
 */
export function hostStartState(
  lobby: LobbyView,
  mine: StoredSeat | null,
): { canStart: boolean; reason: string } {
  if (mine === null) {
    return { canStart: false, reason: 'This browser holds no seat in this room.' };
  }
  // Whether the table has already been dealt is asked first, because it is true of every
  // seat: telling a guest that only the host may start a match that started ten minutes
  // ago answers a question nobody asked.
  if (lobby.status !== 'lobby') {
    return { canStart: false, reason: 'This match has already started.' };
  }
  if (!mine.isHost) {
    const host = lobby.seats.find((seat) => seat.isHost);
    return {
      canStart: false,
      reason: `Only the host starts the match. ${
        host?.displayName ?? 'The host'
      } opened this room, so the table is dealt when they say so.`,
    };
  }
  if (!lobby.ready) {
    return {
      canStart: false,
      reason: 'Every seat has to be claimed before the table can be dealt. '
        + 'A seat cannot be filled after the deal, so an empty one would stay empty.',
    };
  }
  return {
    canStart: true,
    reason: 'Starting shuffles the decks and opens the first-player vote. '
      + 'Seats, parties, clockwise order and the advisory filters are fixed from that moment.',
  };
}

/* ----------------------------------------------------- the connection banner */

/**
 * What the connection banner says, for each of the states section 14.4 requires to be
 * distinguishable.
 *
 * `tone` is the only presentational thing here, and it is a name rather than a colour so
 * the screen picks the style. `offerRetry` and `offerRoomCode` are the two controls the
 * banner may carry, and which of them appears is a rule: a rejected credential is
 * terminal, so it is offered the way back to the room code and never a retry that would
 * say the same thing again.
 */
export interface ConnectionBanner {
  tone: 'ok' | 'working' | 'lost' | 'rejected';
  news: string;
  detail: string;
  /** Whether asking the server again could say anything new. */
  offerRetry: boolean;
  /** Whether the only way forward is a different seat or a different room. */
  offerRoomCode: boolean;
  /** True while this seat's view of the table may be behind the server's. */
  stale: boolean;
}

export function describeConnection(status: ConnectionStatus): ConnectionBanner {
  switch (status.kind) {
    case 'connecting':
      return {
        tone: 'working',
        news: 'Reaching the table',
        detail: status.attempt <= 1
          ? 'Opening this seat’s connection to the room server.'
          : `Opening this seat’s connection to the room server (attempt ${status.attempt}).`,
        offerRetry: false,
        offerRoomCode: false,
        stale: true,
      };
    case 'synchronized':
      return {
        tone: 'ok',
        news: 'Connected',
        detail: 'The server is sending this seat every change as it happens.',
        offerRetry: false,
        offerRoomCode: false,
        stale: false,
      };
    case 'reconnecting':
      return {
        tone: 'lost',
        news: 'Reconnecting',
        detail: `${status.reason} Trying again in ${Math.round(status.retryInMs / 100) / 10}s `
          + '(attempt ' + status.attempt + '). Nothing is lost: your seat keeps whatever it was '
          + 'being asked for until you are back, and the table waits.',
        offerRetry: true,
        offerRoomCode: false,
        stale: true,
      };
    case 'disconnected':
      return {
        tone: 'lost',
        news: 'Disconnected',
        detail: `${status.reason} This seat is not receiving changes. Your place at the table is `
          + 'held; reopen the connection when you are ready.',
        offerRetry: true,
        offerRoomCode: false,
        stale: true,
      };
    case 'rejected':
      return {
        tone: 'rejected',
        news: 'This seat was refused',
        detail: `${status.message} (${status.code}) Asking again will say the same thing, because `
          + 'a seat credential is never reissued. If the table has not been dealt yet, ask the '
          + 'host to free your seat and claim it again with the room code. Otherwise join as a '
          + 'new seat, or ask the host to open a new room.',
        offerRetry: false,
        offerRoomCode: true,
        stale: true,
      };
    default:
      return {
        tone: 'lost',
        news: 'Connection state unknown',
        detail: 'This build does not recognise the connection state it is in.',
        offerRetry: true,
        offerRoomCode: false,
        stale: true,
      };
  }
}

/* -------------------------------------------------- submitting, and failing */

/**
 * What came of a submitted command.
 *
 * The three cases are genuinely different and a screen must not blur them. An accepted
 * command needs no words. A `ruling` is the engine refusing a move, and its message is
 * written for a player and shown exactly as written. `unheard` is the transport: the
 * command may or may not have reached the engine, which is why the wording says to read
 * the table again rather than to send it again — section 14.4 forbids replaying an old
 * target, and a resend here would be a second intent with a second command ID.
 */
export type SubmitOutcome =
  | { kind: 'accepted' }
  | { kind: 'ruling'; message: string }
  | { kind: 'unheard'; message: string };

export function describeSubmit(response: CommandResponse): SubmitOutcome {
  return response.ok ? { kind: 'accepted' } : { kind: 'ruling', message: response.message };
}

/** A rejected `submit`: the table did not hear it, and this says so rather than guessing. */
export function describeUnheard(error: unknown): Extract<SubmitOutcome, { kind: 'unheard' }> {
  return {
    kind: 'unheard',
    message: `The table did not hear that. ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

/**
 * A room request that failed, as one sentence for the player who caused it.
 *
 * A refusal the server wrote is shown as written — it already names the room, the seat or
 * the party at fault. A request that never reached the server is the one case the browser
 * has to word, because there is no server message to show.
 */
export function describeRoomFailure(error: unknown): string {
  if (error instanceof RoomRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
