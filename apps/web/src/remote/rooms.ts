/**
 * The browser's client for the room server's HTTP routes.
 *
 * `remoteMatch.ts` is the connection to a match that has started. This module is
 * everything before that: opening a room, reading the lobby a room code names, claiming a
 * seat in it, and the host's start. All six live here rather than in a screen, for the
 * same reason `local/` exists — one path out of the browser, so a screen never assembles
 * a request or decides what a status code means.
 *
 * Three things are worth stating about the shapes below.
 *
 * `LobbyView`, `ClaimedSeat` and `SeatView` all come from `@seatgrab/protocol` and are
 * re-exported below, so a caller finds them beside the functions that return them. Until
 * Session 16 the first two were declared twice — once in the server, once here — because
 * the browser cannot import the server; there is now one declaration of each, on the
 * wire rather than on either side of it.
 *
 * Nothing here validates a room code's spelling. The server mints room codes and decides
 * what one is, and a second copy of its alphabet in the browser could only drift from it.
 * What this module does is fold a typed code the way a person would expect — case and
 * stray spacing forgiven — and let the server rule on the rest, whose refusal is written
 * to be read by the player who typed it.
 *
 * A refusal is an answer, not an exception to hide: every non-2xx comes back as a
 * `RoomRequestError` carrying the server's own code and message, and a screen shows that
 * message as written rather than inventing wording of its own.
 */
import type { ClaimedSeat, LobbySeatView, LobbyView, SeatView } from '@seatgrab/protocol';

/**
 * The shapes the room routes answer with, re-exported from the protocol package.
 *
 * `ClaimedSeat.credential` is returned once, by the two claim routes and by nothing
 * else. There is no route that reissues it, so it must be persisted before the response
 * is discarded — which is what `seatStore.ts` is for.
 */
export type { ClaimedSeat, LobbySeatView, LobbyView, SeatView };

/**
 * A request the server refused, or one that never reached it.
 *
 * `status` is `0` for a request that failed in the browser — no network, a server that is
 * not running, an origin the server does not allow. That case is the one a screen must
 * word for itself, because there is no server message to show.
 */
export class RoomRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RoomRequestError';
    this.status = status;
    this.code = code;
  }

  /** True when the server was never reached, so nothing was decided either way. */
  get unreached(): boolean {
    return this.status === 0;
  }
}

export interface RoomClientOptions {
  /** Base URL of the room server. Empty, the default, means the page's own origin. */
  serverUrl?: string;
  /** Injected so a test can answer without a network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Fold a typed room code the way a person expects.
 *
 * A code is read aloud from a group chat and typed by hand, so case and stray spacing and
 * dashes are forgiven. Nothing else is: whether the result names a room is the server's
 * ruling, and this function never repairs one code into another.
 */
export function foldRoomCode(value: string): string {
  return value.trim().toUpperCase().replaceAll(/[\s-]/gu, '');
}

function endpoint(options: RoomClientOptions, path: string): string {
  const base = options.serverUrl ?? '';
  return base === '' ? path : new URL(path, base).toString();
}

/**
 * A server answer shaped like the error handler's, or the nearest honest thing to one.
 *
 * A body carrying a code and a message is the room service's own refusal, and it is used
 * as written: it already names the room, the seat or the party at fault, in wording meant
 * for the player who caused it.
 *
 * Anything else is not a refusal and must not be described as one. A 5xx with no readable
 * body is most often nothing to do with the room at all — a stopped server, a restart, a
 * proxy answering for an upstream that is not there — so it says the request was not
 * answered rather than claiming the table decided something.
 */
function readFailure(status: number, body: unknown): RoomRequestError {
  if (typeof body === 'object' && body !== null) {
    const record = body as { code?: unknown; message?: unknown };
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return new RoomRequestError(status, record.code, record.message);
    }
  }
  if (status >= 500) {
    return new RoomRequestError(
      status,
      'SERVER_UNAVAILABLE',
      `The room server did not answer this request (status ${status}). It may be stopped or `
      + 'restarting. Nothing at the table was changed by it.',
    );
  }
  return new RoomRequestError(
    status,
    'UNREADABLE_REFUSAL',
    `The room server refused this request with status ${status} and no readable reason.`,
  );
}

async function request<T>(
  options: RoomClientOptions,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; credential?: string },
): Promise<T> {
  const call = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await call(endpoint(options, path), {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.credential === undefined ? {} : { authorization: `Bearer ${init.credential}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    throw new RoomRequestError(
      0,
      'UNREACHABLE',
      'The room server did not answer. It may be stopped, or this browser may have no route to '
      + `it. Nothing was sent to the table. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let body: unknown = null;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = null;
  }
  if (!response.ok) throw readFailure(response.status, body);
  return body as T;
}

function requireClaim(value: unknown): ClaimedSeat {
  const claim = value as Partial<ClaimedSeat> | null;
  if (
    claim === null
    || typeof claim.matchId !== 'string'
    || typeof claim.roomCode !== 'string'
    || typeof claim.credential !== 'string'
    || typeof claim.playerId !== 'string'
    || typeof claim.seatIndex !== 'number'
    || typeof claim.isHost !== 'boolean'
  ) {
    throw new RoomRequestError(
      0,
      'UNREADABLE_CLAIM',
      'The room server answered the claim in a shape this build does not understand, so the seat '
      + 'credential it holds cannot be saved. This browser and that server are different versions.',
    );
  }
  return claim as ClaimedSeat;
}

/** Open a room and claim its first seat. The caller becomes the host. */
export async function createRoom(
  options: RoomClientOptions,
  input: {
    seatCount: number;
    displayName: string;
    partyId: string;
    contentAdvisories: readonly string[];
  },
): Promise<ClaimedSeat> {
  return requireClaim(
    await request<unknown>(options, '/api/rooms', {
      method: 'POST',
      body: {
        seatCount: input.seatCount,
        displayName: input.displayName,
        partyId: input.partyId,
        contentAdvisories: [...input.contentAdvisories],
      },
    }),
  );
}

/** The lobby a room code opens. Carries no credential and no private game data. */
export async function readLobby(
  options: RoomClientOptions,
  roomCode: string,
): Promise<LobbyView> {
  return request<LobbyView>(
    options,
    `/api/rooms/${encodeURIComponent(foldRoomCode(roomCode))}`,
    { method: 'GET' },
  );
}

/**
 * Claim a free seat with the room code.
 *
 * Leaving `seatIndex` out takes the lowest free seat, which is what a player who does not
 * care about turn order wants. An occupied seat is refused by the server whichever way it
 * was asked for, and the refusal mints nothing.
 */
export async function claimSeat(
  options: RoomClientOptions,
  input: {
    roomCode: string;
    displayName: string;
    partyId: string;
    seatIndex?: number;
  },
): Promise<ClaimedSeat> {
  return requireClaim(
    await request<unknown>(
      options,
      `/api/rooms/${encodeURIComponent(foldRoomCode(input.roomCode))}/seats`,
      {
        method: 'POST',
        body: {
          displayName: input.displayName,
          partyId: input.partyId,
          ...(input.seatIndex === undefined ? {} : { seatIndex: input.seatIndex }),
        },
      },
    ),
  );
}

/**
 * Deal the table. The host only, and only once every seat is claimed.
 *
 * The answer is this seat's first projection. Every other connected seat is sent its own
 * at the same moment, so a screen that already holds a connection does not need this
 * answer to notice the match has begun.
 */
/**
 * The host frees a seat, so a player who lost their credential can claim it again.
 *
 * The server decides every rule around it — host only, with the host's own credential,
 * before the match starts, never the host's own seat. This sends the request and returns
 * the lobby the server answers with, so the screen repaints from the same shape it polls.
 *
 * Nothing is reissued. The freed seat goes back to unclaimed and is claimed again with
 * the room code, which is the same path as sitting down the first time.
 */
export async function releaseSeat(
  options: RoomClientOptions,
  input: { matchId: string; seatIndex: number; credential: string },
): Promise<LobbyView> {
  return request<LobbyView>(
    options,
    `/api/matches/${encodeURIComponent(input.matchId)}/seats/${input.seatIndex}`,
    { method: 'DELETE', credential: input.credential },
  );
}

export async function startMatch(
  options: RoomClientOptions,
  input: { matchId: string; credential: string },
): Promise<SeatView> {
  return request<SeatView>(options, `/api/matches/${encodeURIComponent(input.matchId)}/start`, {
    method: 'POST',
    credential: input.credential,
  });
}
