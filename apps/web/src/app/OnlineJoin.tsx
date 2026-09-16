/**
 * Take a seat in someone else's room, with the code they shared.
 *
 * The screen is in two halves and the order matters. First the room code is looked up:
 * `GET /api/rooms/:roomCode` is readable by anyone holding the code and carries no
 * credential and no private game data, so a player can see the table filling up before
 * committing to it. Only then is a seat claimed, and only that request mints anything.
 *
 * What this browser checks and what the server decides are deliberately not the same
 * thing. The lobby makes the obvious refusals immediate — a party another seat holds, a
 * seat already taken — but the server re-decides both, because two players pressing Join
 * at the same moment is exactly the case no client can settle. A refusal from the server
 * is shown as written; it already names the seat, the party or the room at fault.
 *
 * Nothing here decides what a room code is. The server mints them and rules on them, and a
 * second copy of its alphabet in this browser could only drift from it. A typed code is
 * folded the way a person would expect — case and stray spacing forgiven — and sent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ONLINE_MODE_NOTICE,
  RoomRequestError,
  claimSeat,
  foldRoomCode,
  readLobby,
  storedSeatFrom,
  type LobbyView,
  type OpenSeatStore,
} from '../remote';

import { PageFrame } from './PageFrame';
import { PartyMark } from './PartyMark';
import { ROUTES, navigate } from './routes';
import { CredentialNotice, SeatIdentityFields } from './OnlineSeatForm';
import {
  defaultJoinDraft,
  describeLobbyFill,
  describeRoomFailure,
  freeParties,
  freeSeats,
  lobbySeatRows,
  problemsFor,
  validateJoinDraft,
  type JoinDraft,
} from './online';

export function OnlineJoin({ seats, roomCode }: { seats: OpenSeatStore; roomCode: string }) {
  const [draft, setDraft] = useState<JoinDraft>(() => defaultJoinDraft(roomCode));
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [looking, setLooking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const folded = foldRoomCode(draft.roomCode);
  const problems = useMemo(() => validateJoinDraft(draft, lobby), [draft, lobby]);
  const available = useMemo(() => freeParties(lobby), [lobby]);

  const look = useCallback(
    async (code: string) => {
      setFailure(null);
      setLobby(null);
      setLooking(true);
      try {
        const found = await readLobby({}, code);
        setLobby(found);
        // A party this browser has pre-selected may already be taken at that table. Move
        // to a free one rather than letting the player discover it from a refusal.
        setDraft((current) => {
          const taken = found.seats.some(
            (seat) => seat.claimed && seat.partyId === current.partyId,
          );
          const free = freeParties(found)[0];
          return taken && free !== undefined ? { ...current, partyId: free.partyId } : current;
        });
      } catch (error) {
        setFailure(describeRoomFailure(error));
      } finally {
        setLooking(false);
      }
    },
    [],
  );

  // A room code carried in the route came from a host's link, so it is looked up without
  // the player having to press anything. A code typed by hand is not: a lookup per
  // keystroke would be a request per keystroke against someone else's room.
  useEffect(() => {
    const fromRoute = foldRoomCode(roomCode);
    if (fromRoute.length > 0) void look(fromRoute);
  }, [look, roomCode]);

  const join = () => {
    if (problems.length > 0 || !seats.available || joining) return;
    setFailure(null);
    setJoining(true);
    void (async () => {
      const displayName = draft.displayName.trim();
      try {
        const claim = await claimSeat(
          {},
          {
            roomCode: folded,
            displayName,
            partyId: draft.partyId,
            ...(draft.seatIndex === null ? {} : { seatIndex: draft.seatIndex }),
          },
        );
        // Stored before the screen moves. This response is the only time the credential
        // exists outside the server, and the server keeps only its hash.
        seats.save(storedSeatFrom(claim, { displayName, partyId: draft.partyId }, new Date()));
        navigate(ROUTES.onlineRoom(claim.matchId));
      } catch (error) {
        setFailure(describeRoomFailure(error));
        setJoining(false);
        // A refusal about the table is stale information as much as it is a refusal:
        // somebody took the seat or the party while this form was open. Read the room
        // again so the controls show what is actually free now.
        if (error instanceof RoomRequestError && !error.unreached) void look(folded);
      }
    })();
  };

  const rows = lobby === null ? [] : lobbySeatRows(lobby, null);
  const free = lobby === null ? [] : freeSeats(lobby);

  return (
    <PageFrame
      title="Join a room"
      lede="You need the room code the host shared. It opens the lobby; it does not give anyone your seat."
      back={{ href: ROUTES.online, label: 'Online rooms' }}
    >
      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}

      <section className="panel">
        <h2>The room code</h2>
        <form
          className="seat"
          onSubmit={(event) => {
            event.preventDefault();
            if (folded.length > 0) void look(folded);
          }}
        >
          <div className="seat__field">
            <label htmlFor="join-room-code">Room code</label>
            <input
              id="join-room-code"
              className="input input--code"
              value={draft.roomCode}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={problemsFor(problems, 'roomCode').length > 0}
              onChange={(event) => setDraft({ ...draft, roomCode: event.target.value })}
            />
            <span className="hint">
              Case and spacing do not matter. The server decides whether it names a room.
            </span>
          </div>
          <div className="actions">
            <button type="submit" className="button" disabled={folded.length === 0 || looking}>
              {looking ? 'Looking…' : 'Look up this room'}
            </button>
          </div>
        </form>
      </section>

      {lobby === null ? null : (
        <section className="panel">
          <h2>{lobby.roomCode}</h2>
          <p className="panel__lede" role="status">
            {describeLobbyFill(lobby)}
          </p>
          <ol className="seats seats--roster">
            {rows.map((row) => (
              <li key={row.seatIndex} className={`seat seat--roster${row.claimed ? '' : ' seat--free'}`}>
                <p className="seat__ordinal">
                  Seat {row.seatIndex + 1}
                  {row.isHost ? <span className="seat__badge">host</span> : null}
                </p>
                <p className="seat__party">
                  {row.party === null ? null : <PartyMark partyId={row.party.partyId} size={24} />}
                  <span>{row.label}</span>
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="panel panel--commit">
        <h2>Your seat</h2>
        {lobby === null ? (
          <p className="panel__lede">Look up a room code first, so you can see what is free.</p>
        ) : (
          <>
            <SeatIdentityFields
              idPrefix="join"
              displayName={draft.displayName}
              partyId={draft.partyId}
              parties={available}
              problems={problems}
              disabled={joining}
              onName={(displayName) => setDraft({ ...draft, displayName })}
              onParty={(partyId) => setDraft({ ...draft, partyId })}
            />

            <div className="seat__field">
              <label htmlFor="join-seat">Where in the clockwise order</label>
              <select
                id="join-seat"
                className="input"
                value={draft.seatIndex === null ? 'any' : String(draft.seatIndex)}
                disabled={joining}
                aria-invalid={problemsFor(problems, 'seatIndex').length > 0}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    seatIndex: event.target.value === 'any' ? null : Number(event.target.value),
                  })}
              >
                <option value="any">Any free seat</option>
                {free.map((seat) => (
                  <option key={seat.seatIndex} value={seat.seatIndex}>
                    Seat {seat.seatIndex + 1}
                    {seat.isHost ? ' (host)' : ''}
                  </option>
                ))}
              </select>
              {problemsFor(problems, 'seatIndex').map((problem) => (
                <p key={problem.message} className="field-problem">
                  {problem.message}
                </p>
              ))}
              <span className="hint">
                Seat order was fixed when the room opened. Choosing a seat picks a place in it.
              </span>
            </div>

            <CredentialNotice
              storable={seats.available}
              unavailableReason={seats.unavailableReason}
            />
            <p className="notice">{ONLINE_MODE_NOTICE}</p>

            <div className="actions">
              <button
                type="button"
                className="button button--primary"
                disabled={problems.length > 0 || !seats.available || joining}
                onClick={join}
              >
                {joining ? 'Taking the seat…' : 'Take this seat'}
              </button>
            </div>
            {problems.length === 0 ? null : (
              <ul className="field-problem" aria-live="polite">
                {problems.map((problem) => (
                  <li key={problem.message}>{problem.message}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </PageFrame>
  );
}
