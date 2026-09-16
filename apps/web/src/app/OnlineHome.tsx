/**
 * The way into online play, and the way back to a seat this browser already holds.
 *
 * The list matters more than it looks. A seat credential is issued once and cannot be
 * reissued, so the browser that claimed a seat is the only thing that can play it — which
 * makes "which seats does this browser hold" a real question with a real answer, and one a
 * player has no other way to ask. It is also what makes a reload mid-match harmless: the
 * route is bookmarkable, and if it is lost, the seat is still listed here.
 *
 * Nothing on this screen reaches the network. It reads the local seat store and offers the
 * two routes that do.
 */
import { PARTY_IDENTITY_BY_ID } from '../assets/parties';
import { ONLINE_MODE_NOTICE, type OpenSeatStore } from '../remote';

import { PageFrame } from './PageFrame';
import { PartyMark } from './PartyMark';
import { ROUTES, navigate } from './routes';

function claimedAtLabel(claimedAt: string): string {
  const when = new Date(claimedAt);
  return Number.isNaN(when.getTime()) ? claimedAt : when.toLocaleString();
}

export function OnlineHome({ seats, onChange }: { seats: OpenSeatStore; onChange: () => void }) {
  const held = seats.list();
  return (
    <PageFrame
      title="Online rooms"
      lede="Every player has their own screen, and the server holds the cards."
      back={{ href: ROUTES.home, label: 'Home' }}
    >
      {seats.available ? null : (
        <p className="alert alert--error" role="alert">
          This browser will not keep a seat credential: {seats.unavailableReason} Hosting and
          joining are disabled, because a credential is issued once and cannot be reissued.
        </p>
      )}

      <section className="panel">
        <h2>Start or join a room</h2>
        <p className="panel__lede">
          A room has a code anyone may hold and a seat credential nobody else ever sees. The code
          finds the table; the credential is what plays a seat, and the two are deliberately not
          the same secret.
        </p>
        <p className="notice">{ONLINE_MODE_NOTICE}</p>
        <div className="actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!seats.available}
            onClick={() => navigate(ROUTES.onlineHost)}
          >
            Open a private room
          </button>
          <button
            type="button"
            className="button"
            disabled={!seats.available}
            onClick={() => navigate(ROUTES.onlineJoin())}
          >
            Join with a room code
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Seats this browser holds</h2>
        <p className="panel__lede">
          A seat credential is never reissued, so these are the only seats this browser can play.
          Opening one from another device, or after clearing this site&rsquo;s data, is not
          possible — that is what keeps a shared room code from handing over an occupied seat.
        </p>
        {held.length === 0 ? (
          <p>No online seat is held in this browser yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="records">
              <caption>
                {held.length} {held.length === 1 ? 'seat' : 'seats'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Room</th>
                  <th scope="col">Seat</th>
                  <th scope="col">Claimed</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {held.map((seat) => (
                  <tr key={seat.matchId}>
                    <th scope="row">
                      <code>{seat.roomCode}</code>
                      {seat.isHost ? <span className="seat__badge">host</span> : null}
                    </th>
                    <td>
                      <PartyMark partyId={seat.partyId} size={20} />{' '}
                      {seat.displayName} · seat {seat.seatIndex + 1}
                      <span className="hint">
                        {PARTY_IDENTITY_BY_ID.get(seat.partyId)?.displayName ?? seat.partyId}
                      </span>
                    </td>
                    <td>{claimedAtLabel(seat.claimedAt)}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="button"
                        onClick={() => navigate(ROUTES.onlineRoom(seat.matchId))}
                      >
                        Open
                      </button>
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
                          onChange();
                        }}
                      >
                        Forget
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageFrame>
  );
}
