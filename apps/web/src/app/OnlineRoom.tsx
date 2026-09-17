/**
 * One online room, from the lobby through the last turn.
 *
 * It is a single screen on purpose. A room and the match it becomes are one connection:
 * the socket authenticates while the room is still a lobby, the server answers with
 * `sync.state === null` because there is nothing to project yet, and the host's start is
 * broadcast to every attached seat. Splitting the lobby and the table into two routes
 * would close that connection and open another at the exact moment the table is dealt —
 * the one moment a player is waiting to see something happen.
 *
 * Four rules from section 14 hold here and are the reason this file looks as it does.
 *
 * 1. **The table is drawn from this seat's own view.** A remote adapter has no public
 *    projection — the server produced none — so `viewFor` refuses every viewer but this
 *    one, with `NO_PROJECTION`. A seat's own view carries every public fact, so it is what
 *    `TableSurface` is given. Nothing here assembles a public view by deleting fields:
 *    that would be a second copy of the privacy rules kept in the least trustworthy place.
 * 2. **There is no handoff, and there must not be one.** The pass-and-play cover exists
 *    because one device shows several seats. Here one device holds one credential and the
 *    server never sends it another seat's private data at all, so `SeatSurface` is drawn
 *    without a cover and without a way to pass the device.
 * 3. **A refusal and a silence are different things.** `submit` resolves with the engine's
 *    ruling — shown as written — and rejects when the command could not be put to the
 *    engine. `describeSubmit` and `describeUnheard` keep the two apart, because "that move
 *    is illegal" and "the table did not hear you" call for different things from a player.
 * 4. **`rejected` is terminal.** The banner offers no retry there; it offers the way back
 *    to the room code, because a seat credential is never reissued. Before the deal the host
 *    can free a seat, and it is then claimed again like any free seat; after it, a lost
 *    credential is a lost seat.
 *
 * The connection is opened in an effect rather than during render, so React's double
 * invocation in development opens and closes one socket rather than leaking one.
 */
import { useCallback, useEffect, useReducer, useState } from 'react';

import { COMPUTER_DIFFICULTIES } from '@seatgrab/computer';
import type { ComputerDifficulty, GameCommand } from '@seatgrab/protocol';

import {
  ONLINE_MODE_NOTICE,
  RoomRequestError,
  openRemoteMatch,
  readLobby,
  releaseSeat,
  seatComputer,
  startMatch,
  type LobbyView,
  type OpenSeatStore,
  type RemoteMatch,
  type StoredSeat,
} from '../remote';
import type { DrawableViewResult } from '../transport';

import { PageFrame } from './PageFrame';
import { PartyMark } from './PartyMark';
import { ResultsSurface } from './ResultsSurface';
import { SeatSurface } from './SeatSurface';
import { StatusBar } from './StatusBar';
import { TableSurface } from './TableSurface';
import { ROUTES, navigate } from './routes';
import {
  NO_DRAFT,
  actionDraftReducer,
  draftTargeting,
  endTurnAvailability,
  promptTargeting,
  voterAt,
  type Targeting,
} from './actions';
import {
  describeConnection,
  describeLobbyFill,
  describeRoomFailure,
  describeSubmit,
  describeUnheard,
  hostStartState,
  lobbySeatRows,
  type SubmitOutcome,
} from './online';

/** How often the lobby is re-read while the room is still filling. */
const LOBBY_POLL_MS = 4000;

export function OnlineRoom({ seats, matchId }: { seats: OpenSeatStore; matchId: string }) {
  const seat = seats.read(matchId);
  if (seat === null) {
    return (
      <PageFrame
        title="Online room"
        lede={<code>{matchId}</code>}
        back={{ href: ROUTES.online, label: 'Online rooms' }}
      >
        <section className="panel">
          <h2>This browser holds no seat in that room</h2>
          <p className="panel__lede">
            A seat credential is issued once, to the browser that claimed the seat, and cannot be
            reissued — so there is nothing here to reopen. If you claimed this seat somewhere else,
            play it there. Otherwise join with the room code, which takes a free seat.
          </p>
          <div className="actions">
            <a className="button button--primary" href={ROUTES.onlineJoin()}>
              Join with a room code
            </a>
            <a className="button button--quiet" href={ROUTES.online}>
              Rooms this browser holds
            </a>
          </div>
        </section>
      </PageFrame>
    );
  }
  return <ConnectedRoom key={seat.matchId} seat={seat} seats={seats} />;
}

function ConnectedRoom({ seat, seats }: { seat: StoredSeat; seats: OpenSeatStore }) {
  const [match, setMatch] = useState<RemoteMatch | null>(null);
  /** Bumped to open a fresh connection after a deliberate disconnect or a retry. */
  const [generation, setGeneration] = useState(0);
  const [, repaint] = useState(0);
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [lobbyFailure, setLobbyFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [releasing, setReleasing] = useState<number | null>(null);
  const [seating, setSeating] = useState<number | null>(null);
  const [draft, dispatchDraft] = useReducer(actionDraftReducer, NO_DRAFT);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const opened = openRemoteMatch({ matchId: seat.matchId, credential: seat.credential });
    setMatch(opened);
    return () => {
      opened.close();
      setMatch(null);
    };
  }, [generation, seat.credential, seat.matchId]);

  // One subscription repaints everything: the adapter notifies on a new projection and on
  // every connection state change alike, so the banner needs no subscription of its own.
  useEffect(() => {
    if (match === null) return;
    return match.subscribe(() => repaint((tick) => tick + 1));
  }, [match]);

  const seatView = match?.seatView() ?? null;
  const started = seatView !== null;

  // The lobby is read over HTTP while the room is still filling, because seats arriving is
  // not a change to a match and the hub broadcasts nothing for it. The moment the table is
  // dealt the socket carries a projection, `started` turns true, and this stops.
  useEffect(() => {
    if (started) return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const found = await readLobby({}, seat.roomCode);
        if (cancelled) return;
        setLobby(found);
        setLobbyFailure(null);
      } catch (error) {
        if (!cancelled) setLobbyFailure(describeRoomFailure(error));
      }
    };
    void read();
    const handle = setInterval(() => void read(), LOBBY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [seat.roomCode, started]);

  const submit = useCallback(
    (command: GameCommand) => {
      if (match === null || busy) return;
      setBusy(true);
      setOutcome(null);
      void match.submit(seat.playerId, command).then(
        (response) => {
          setBusy(false);
          const said = describeSubmit(response);
          if (said.kind === 'accepted') dispatchDraft({ type: 'close' });
          else setOutcome(said);
        },
        (error: unknown) => {
          setBusy(false);
          setOutcome(describeUnheard(error));
        },
      );
    },
    [busy, match, seat.playerId],
  );

  const start = useCallback(() => {
    if (starting) return;
    setStarting(true);
    setLobbyFailure(null);
    void startMatch({}, { matchId: seat.matchId, credential: seat.credential }).then(
      () => {
        setStarting(false);
        // The start is broadcast to every attached seat, including this one, so the
        // projection normally arrives on its own. Asking anyway costs one frame and
        // covers the case where this client's socket was reconnecting at that moment.
        match?.resync();
      },
      (error: unknown) => {
        setStarting(false);
        setLobbyFailure(describeRoomFailure(error));
      },
    );
  }, [match, seat.credential, seat.matchId, starting]);

  const status = match?.status() ?? { kind: 'connecting' as const, attempt: 1 };
  const banner = describeConnection(status);

  /**
   * The host frees a seat, so a player who lost their credential can claim it again.
   *
   * The answer is the lobby the server just wrote, which replaces the polled one rather
   * than waiting up to four seconds for the next read. Nothing is broadcast for it: seats
   * arriving and leaving are not changes to a match, so `MatchHub` has nothing to say.
   */
  const release = useCallback((seatIndex: number) => {
    if (releasing !== null) return;
    setReleasing(seatIndex);
    setLobbyFailure(null);
    void releaseSeat({}, { matchId: seat.matchId, seatIndex, credential: seat.credential }).then(
      (updated) => {
        setReleasing(null);
        setLobby(updated);
      },
      (error: unknown) => {
        setReleasing(null);
        setLobbyFailure(
          error instanceof RoomRequestError
            ? error.message
            : 'That seat could not be freed. Read the room again.',
        );
      },
    );
  }, [releasing, seat.credential, seat.matchId]);

  /**
   * The host seats a computer on a free seat.
   *
   * The same shape as `release`: the answer is the lobby the server just wrote, which
   * replaces the polled one rather than waiting for the next read. Seating a computer is
   * not a change to a match, so nothing is broadcast for it either.
   */
  const addComputer = useCallback((seatIndex: number, difficulty: ComputerDifficulty) => {
    if (seating !== null) return;
    setSeating(seatIndex);
    setLobbyFailure(null);
    void seatComputer({}, {
      matchId: seat.matchId,
      seatIndex,
      difficulty,
      credential: seat.credential,
    }).then(
      (updated) => {
        setSeating(null);
        setLobby(updated);
      },
      (error: unknown) => {
        setSeating(null);
        setLobbyFailure(
          error instanceof RoomRequestError
            ? error.message
            : 'A computer could not be seated there. Read the room again.',
        );
      },
    );
  }, [seat.credential, seat.matchId, seating]);

  const result = match?.viewFor({ kind: 'player', playerId: seat.playerId }) ?? null;
  // `NO_PROJECTION` is the one refusal with nothing to draw at all. Narrowing it away here
  // is why nothing below has to ask whether it has a view.
  const drawable: DrawableViewResult | null =
    result !== null && result.view !== null ? result : null;
  const finished = drawable?.view.status === 'finished';

  const targeting: Targeting | null = drawable === null
    ? null
    : draftTargeting(drawable.view, seat.playerId, draft)
      ?? promptTargeting(drawable.view, seat.playerId);

  const me = drawable?.view.players.find((player) => player.id === seat.playerId) ?? null;

  return (
    <PageFrame
      title="Online match"
      lede={
        <>
          Room <code>{seat.roomCode}</code> · your seat is{' '}
          <strong>
            {seat.displayName} <PartyMark partyId={seat.partyId} size={18} />
          </strong>
        </>
      }
      back={{ href: ROUTES.online, label: 'Online rooms' }}
      wide
      compact
      footer={<SeatCredentialPanel seat={seat} seats={seats} />}
    >
      {started && drawable !== null ? (
        <StatusBar
          view={drawable.view}
          me={me}
          endTurn={{
            ...endTurnAvailability(drawable.view, seat.playerId),
            busy: busy || banner.stale,
            onEndTurn: () => submit({ type: 'RequestEndTurn' }),
          }}
        />
      ) : null}

      <ConnectionPanel
        banner={banner}
        onRetry={() => setGeneration((count) => count + 1)}
        onDisconnect={() => match?.close()}
        connected={status.kind === 'synchronized'}
      />

      {outcome === null || outcome.kind === 'accepted' ? null : (
        <p className={`alert ${outcome.kind === 'unheard' ? 'alert--error' : 'alert--error'}`} role="alert">
          {outcome.message}
        </p>
      )}

      {started && drawable !== null ? (
        <>
          {finished ? (
            <ResultsSurface view={drawable.view} again={<PlayAgainOnline />} />
          ) : null}

          <TableSurface
            view={drawable.view}
            targeting={targeting}
            attention={!finished && (
              (drawable.view.pendingDecision?.responsiblePlayerIds.includes(seat.playerId) ?? false)
              || (drawable.view.pendingDecision === undefined && drawable.view.activePlayerId === seat.playerId)
            )}
            onPickSlot={(slotId) =>
              dispatchDraft({ type: 'pick', slotId, voterId: voterAt(drawable.view, slotId) })}
            aside={
              <SeatSurface
                result={drawable}
                seatId={seat.playerId}
                draft={draft}
                dispatch={dispatchDraft}
                targeting={targeting}
                submit={submit}
                busy={busy || banner.stale}
                failure={outcome?.kind === 'ruling' ? outcome.message : null}
                finished={finished === true}
              />
            }
          />
        </>
      ) : (
        <>
          {/*
            * A refused seat is the whole story, so the room is not drawn beside it. The
            * roster would invite a player to act on a table this browser has just been
            * told it has no claim on, and the banner already says what to do instead.
            */}
          {status.kind === 'rejected' ? null : (
            <LobbyPanel
              seat={seat}
              lobby={lobby}
              failure={lobbyFailure}
              starting={starting}
              onStart={start}
              releasing={releasing}
              onRelease={release}
              seating={seating}
              onSeatComputer={addComputer}
            />
          )}
        </>
      )}
    </PageFrame>
  );
}

/** The four states of section 14.4, each visibly different and each saying what to do. */
function ConnectionPanel({
  banner,
  onRetry,
  onDisconnect,
  connected,
}: {
  banner: ReturnType<typeof describeConnection>;
  onRetry: () => void;
  onDisconnect: () => void;
  connected: boolean;
}) {
  return (
    <section className={`panel connection connection--${banner.tone}`} aria-labelledby="connection-heading">
      <h2 id="connection-heading" className="connection__news">
        {banner.news}
      </h2>
      <p className="connection__detail" role="status">
        {banner.detail}
      </p>
      <div className="actions">
        {banner.offerRetry ? (
          <button type="button" className="button button--primary" onClick={onRetry}>
            Reconnect now
          </button>
        ) : null}
        {banner.offerRoomCode ? (
          <a className="button button--primary" href={ROUTES.onlineJoin()}>
            Join with a room code
          </a>
        ) : null}
        {connected ? (
          <button type="button" className="button button--quiet" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The host's control for putting a computer on a free seat.
 *
 * The difficulty is chosen beside the button rather than after it, because the server
 * takes the two together and there is nothing to undo between them: seating a computer
 * fills the seat, and changing its difficulty means freeing it and seating it again.
 */
function SeatComputerControl({
  seatIndex,
  busy,
  working,
  onSeat,
}: {
  seatIndex: number;
  /** True while any seat is being filled, so two requests never race. */
  busy: boolean;
  working: boolean;
  onSeat: (seatIndex: number, difficulty: ComputerDifficulty) => void;
}) {
  const [difficulty, setDifficulty] = useState<ComputerDifficulty>('medium');
  const selectId = `seat-${seatIndex}-difficulty`;
  return (
    <div className="seat__controls actions">
      <label className="visually-hidden" htmlFor={selectId}>
        Difficulty for seat {seatIndex + 1}
      </label>
      <select
        id={selectId}
        className="input"
        value={difficulty}
        disabled={busy}
        onChange={(event) => setDifficulty(event.target.value as ComputerDifficulty)}
      >
        {COMPUTER_DIFFICULTIES.map((level) => (
          <option key={level.id} value={level.id}>
            {level.label} — {level.description}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button button--quiet"
        disabled={busy}
        onClick={() => onSeat(seatIndex, difficulty)}
      >
        {working ? 'Seating…' : 'Seat a computer'}
      </button>
    </div>
  );
}

/** The room while it is still filling, and the host's start. */
function LobbyPanel({
  seat,
  lobby,
  failure,
  starting,
  onStart,
  releasing,
  onRelease,
  seating,
  onSeatComputer,
}: {
  seat: StoredSeat;
  lobby: LobbyView | null;
  failure: string | null;
  starting: boolean;
  onStart: () => void;
  /** The seat currently being freed, so its own control reads as busy. */
  releasing: number | null;
  onRelease: (seatIndex: number) => void;
  /** The seat a computer is being seated on, so its own control reads as busy. */
  seating: number | null;
  onSeatComputer: (seatIndex: number, difficulty: ComputerDifficulty) => void;
}) {
  const start = lobby === null ? null : hostStartState(lobby, seat);
  return (
    <section className="panel">
      <h2>Room {seat.roomCode}</h2>
      <p className="panel__lede">
        Share this code with the other players. Anyone holding it can see this lobby and take a
        free seat; nobody holding it can take a seat that is already claimed, or act for one.
      </p>
      {seat.isHost ? (
        <p className="hint">
          If a player loses the browser that holds their seat, free the seat here and let them
          claim it again with the room code. Only you can do that, and only until the table is
          dealt. Freeing a seat makes its old credential stop working.
        </p>
      ) : null}

      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}

      {lobby === null ? (
        <p role="status">Reading the room…</p>
      ) : (
        <>
          <p className="panel__lede" role="status">
            {describeLobbyFill(lobby)}
          </p>
          <ol className="seats seats--roster">
            {lobbySeatRows(lobby, seat).map((row) => (
              <li
                key={row.seatIndex}
                className={`seat seat--roster${row.claimed ? '' : ' seat--free'}${
                  row.isMine ? ' seat--mine' : ''
                }`}
              >
                <p className="seat__ordinal">
                  Seat {row.seatIndex + 1}
                  {row.isHost ? <span className="seat__badge">host</span> : null}
                  {row.isMine ? <span className="seat__badge">you</span> : null}
                </p>
                <p className="seat__party">
                  {row.party === null ? null : <PartyMark partyId={row.party.partyId} size={24} />}
                  <span>{row.label}</span>
                  {row.controller === 'computer' ? (
                    <span className="small">
                      {' · computer'}
                      {row.difficulty === undefined ? '' : `, ${row.difficulty}`}
                    </span>
                  ) : null}
                </p>
                {row.canSeatComputer ? (
                  <SeatComputerControl
                    seatIndex={row.seatIndex}
                    busy={seating !== null}
                    working={seating === row.seatIndex}
                    onSeat={onSeatComputer}
                  />
                ) : null}
                {row.release.can ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={releasing !== null}
                    onClick={() => onRelease(row.seatIndex)}
                  >
                    {releasing === row.seatIndex
                      ? 'Freeing…'
                      : row.controller === 'computer'
                        ? `Remove the computer from seat ${row.seatIndex + 1}`
                        : `Free seat ${row.seatIndex + 1}`}
                  </button>
                ) : null}
                {row.release.reason === undefined ? null : (
                  <p className="hint">{row.release.reason}</p>
                )}
              </li>
            ))}
          </ol>

          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!start?.canStart || starting}
              onClick={onStart}
            >
              {starting ? 'Dealing…' : 'Start the match'}
            </button>
            <span className="hint" role="status">
              {start?.reason}
            </span>
          </div>
        </>
      )}

      <p className="notice">{ONLINE_MODE_NOTICE}</p>
    </section>
  );
}

/**
 * What this browser holds for this seat, and how to give it up.
 *
 * Forgetting is offered because a stored secret nobody needs is only a liability, and it
 * is spelled out as irreversible because it is: the server keeps only a hash of this
 * credential and has no route that mints another.
 */
function SeatCredentialPanel({ seat, seats }: { seat: StoredSeat; seats: OpenSeatStore }) {
  return (
    <details className="settings">
      <summary>This seat</summary>
      <dl className="facts">
        <div>
          <dt>Room</dt>
          <dd>
            <code>{seat.roomCode}</code>
          </dd>
        </div>
        <div>
          <dt>Seat</dt>
          <dd>
            {seat.seatIndex + 1} of the clockwise order · engine <code>{seat.playerId}</code>
            {seat.isHost ? ' · host' : ''}
          </dd>
        </div>
        <div>
          <dt>Match</dt>
          <dd>
            <code>{seat.matchId}</code>
          </dd>
        </div>
      </dl>
      <p className="hint">
        This browser holds the credential for this seat. It is never put in the address bar, never
        shown, and never sent anywhere but this seat&rsquo;s own connection to the room server. It
        was issued once and cannot be reissued.
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            if (
              !window.confirm(
                `Forget this seat's credential? This browser will no longer be able to play ${seat.displayName}'s seat in room ${seat.roomCode}. The credential is never reissued: to play that seat again, the host has to free it from the lobby, and only until the table is dealt.`,
              )
            ) {
              return;
            }
            seats.forget(seat.matchId);
            navigate(ROUTES.online);
          }}
        >
          Forget this seat on this browser
        </button>
        <span className="hint">
          Irreversible here. The credential is never reissued, so the way back is for the host
          to free the seat from the lobby &mdash; which they can do only before the table is dealt.
        </span>
      </div>
    </details>
  );
}

/** Playing again online is a new room, not a box every seat ticks on one device. */
function PlayAgainOnline() {
  return (
    <section className="panel" aria-labelledby="online-again-heading">
      <h2 id="online-again-heading">Play again</h2>
      <p className="panel__lede">
        A rematch online is a new room. Seats, parties, clockwise order and the advisory filters
        are fixed when a room is opened, and every player joins from their own browser, so there is
        nobody at this one to agree on the table&rsquo;s behalf. This match stays readable here.
      </p>
      <div className="actions">
        <a className="button button--primary" href={ROUTES.onlineHost}>
          Open another room
        </a>
        <a className="button button--quiet" href={ROUTES.online}>
          Rooms this browser holds
        </a>
      </div>
    </section>
  );
}
