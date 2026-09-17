/**
 * Where this browser keeps the seat credentials it has been issued.
 *
 * A seat credential is the whole of a player's claim on a seat. The server mints it once,
 * at the moment of the claim, stores only its hash, and has no route that reissues it:
 * section 14.1 rules that out deliberately, because a room code is shareable and
 * reissuing from one would hand an occupied seat to whoever read the group chat. The
 * consequence lands here. A credential this browser loses is not recoverable from
 * anywhere, and the player needs a new room — so persisting it is a correctness
 * requirement of the join screen, not a convenience it may skip.
 *
 * That makes this a secret store, and it is written as one:
 *
 * - Nothing but a seat's own screens reads it, and a credential never leaves it except
 *   into the `Authorization` header or the `authenticate` frame of that seat's own
 *   connection. It is never put in a URL, where section 14.2 points out an access log
 *   would keep it, and it is never logged.
 * - It is `localStorage`, not a cookie: a cookie would be attached to every request to
 *   the server's origin by the browser itself, which is exactly the behavior a bearer
 *   credential should not have.
 * - Forgetting is offered and is real. `forget` removes the record outright rather than
 *   marking it spent, because a stored secret nobody needs is only a liability.
 *
 * Storage is injected so the model can be tested without a browser, and every access is
 * guarded: a browser with storage switched off must degrade to "this seat cannot be
 * remembered", which the screens say out loud, rather than throwing on a keystroke.
 */

/** The key everything below lives under. Versioned, so a shape change cannot be misread. */
export const SEAT_STORE_KEY = 'gerrymander.online.seats.v1';

/** One seat this browser holds, as it was claimed. */
export interface StoredSeat {
  matchId: string;
  roomCode: string;
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  /** The name and party this seat was claimed with, so a lobby can be labeled offline. */
  displayName: string;
  partyId: string;
  /** Issued once by the server. The only thing that authorizes a command for this seat. */
  credential: string;
  /** ISO timestamp of the claim, for the "rooms this browser holds" list. */
  claimedAt: string;
}

export interface SeatStore {
  /** Every seat this browser holds, most recently claimed first. */
  list(): readonly StoredSeat[];
  read(matchId: string): StoredSeat | null;
  /** Save a claim, replacing any earlier one for the same match. */
  save(seat: StoredSeat): void;
  /** Remove a seat's credential from this browser. Cannot be undone. */
  forget(matchId: string): void;
}

/** The half of `Storage` this module uses, so a test can be three methods. */
export interface SeatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** True for a record this build can use. A partial one is dropped, not repaired. */
function isStoredSeat(value: unknown): value is StoredSeat {
  if (typeof value !== 'object' || value === null) return false;
  const seat = value as Record<string, unknown>;
  return (
    typeof seat.matchId === 'string'
    && typeof seat.roomCode === 'string'
    && typeof seat.seatIndex === 'number'
    && typeof seat.playerId === 'string'
    && typeof seat.isHost === 'boolean'
    && typeof seat.displayName === 'string'
    && typeof seat.partyId === 'string'
    && typeof seat.credential === 'string'
    && seat.credential.length > 0
    && typeof seat.claimedAt === 'string'
  );
}

/**
 * A store backed by one storage key, or a store that holds nothing.
 *
 * `available` is how a screen tells the two apart. A browser in private mode, or one with
 * site data blocked, throws on the first access; this returns an unavailable store rather
 * than a throwing one, so the screens can say that an online seat cannot be remembered
 * here *before* a player claims one and loses it.
 */
export interface OpenSeatStore extends SeatStore {
  /** False when this browser will not keep a credential across a reload. */
  readonly available: boolean;
  /** Why it will not, when it will not. */
  readonly unavailableReason: string | null;
}

export function openSeatStore(storage?: SeatStorage | null): OpenSeatStore {
  const backing = storage === undefined
    ? (typeof localStorage === 'undefined' ? null : (localStorage as SeatStorage))
    : storage;

  let unavailableReason: string | null = backing === null
    ? 'This browser exposes no local storage, so a seat credential cannot be kept across a reload.'
    : null;

  const readAll = (): StoredSeat[] => {
    if (backing === null) return [];
    let raw: string | null;
    try {
      raw = backing.getItem(SEAT_STORE_KEY);
    } catch (error) {
      unavailableReason = `This browser refused to read its local storage: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return [];
    }
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // An unreadable record is dropped rather than repaired: half a credential is no
      // credential, and guessing at one would only fail later, at a table.
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isStoredSeat) : [];
  };

  const writeAll = (seats: readonly StoredSeat[]): void => {
    if (backing === null) return;
    try {
      backing.setItem(SEAT_STORE_KEY, JSON.stringify(seats));
    } catch (error) {
      unavailableReason = `This browser refused to write to its local storage: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  };

  return {
    get available(): boolean {
      return backing !== null && unavailableReason === null;
    },
    get unavailableReason(): string | null {
      return unavailableReason;
    },
    list(): readonly StoredSeat[] {
      return [...readAll()].sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
    },
    read(matchId: string): StoredSeat | null {
      return readAll().find((seat) => seat.matchId === matchId) ?? null;
    },
    save(seat: StoredSeat): void {
      writeAll([seat, ...readAll().filter((held) => held.matchId !== seat.matchId)]);
    },
    forget(matchId: string): void {
      writeAll(readAll().filter((seat) => seat.matchId !== matchId));
    },
  };
}

/** The record a claim and the form that made it produce together. */
export function storedSeatFrom(
  claim: {
    matchId: string;
    roomCode: string;
    seatIndex: number;
    playerId: string;
    isHost: boolean;
    credential: string;
  },
  identity: { displayName: string; partyId: string },
  claimedAt: Date,
): StoredSeat {
  return {
    matchId: claim.matchId,
    roomCode: claim.roomCode,
    seatIndex: claim.seatIndex,
    playerId: claim.playerId,
    isHost: claim.isHost,
    displayName: identity.displayName,
    partyId: identity.partyId,
    credential: claim.credential,
    claimedAt: claimedAt.toISOString(),
  };
}
