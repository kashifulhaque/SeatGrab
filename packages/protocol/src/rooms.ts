/**
 * The room shapes both sides of the wire read.
 *
 * `SeatView` has always lived in this package, for the reason these now do: both
 * transports return it and both ends read it, so a second declaration could only drift.
 * `LobbyView` and `ClaimedSeat` were the odd pair out — declared once in
 * `apps/server/src/rooms/roomService.ts` and mirrored once in
 * `apps/web/src/remote/rooms.ts`, because the browser cannot import the server. Session
 * 16 moved them here, which is the eventual home Session 15 named for them.
 *
 * Nothing here is a game rule and nothing here is validated. These are the answers the
 * room routes give; the service decides what goes in them, and it is the only thing that
 * does.
 */

/** One seat in a lobby, as anyone holding the room code may see it. */
export interface LobbySeatView {
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  claimed: boolean;
  /** Null until somebody claims the seat and gives a name. */
  displayName: string | null;
  partyId: string | null;
}

/**
 * What a holder of the room code may see.
 *
 * No credential and no private game data: the room code is read aloud across a table or
 * pasted into a chat, so everything in here is something anyone at that table may know.
 * The content and board versions are included so a browser on a stale build finds out
 * before it sits down rather than during a turn.
 */
export interface LobbyView {
  roomCode: string;
  matchId: string;
  /**
   * The four values the stored match can hold.
   *
   * `setup` is in the database's own `CHECK` constraint and in `MatchStatus`, and the
   * browser's former mirror of this type left it out — a narrowing that nothing caught
   * because every screen asks `status !== 'lobby'` rather than naming the others. It is
   * listed here so the type says what the column allows.
   */
  status: 'lobby' | 'setup' | 'active' | 'finished';
  seatCount: number;
  contentAdvisories: readonly string[];
  seats: readonly LobbySeatView[];
  /** True when every seat is claimed, so the host's start is the only thing missing. */
  ready: boolean;
  contentPackId: string;
  contentVersion: string;
  boardId: string;
  boardVersion: string;
}

/**
 * A seat somebody now holds.
 *
 * `credential` is returned once, by the two claim routes and by nothing else. There is no
 * route that reissues it, so a client must persist it before it discards the response,
 * and a server must never store or log it in the clear.
 */
export interface ClaimedSeat {
  matchId: string;
  roomCode: string;
  seatIndex: number;
  playerId: string;
  isHost: boolean;
  credential: string;
}
