/**
 * Open a private room and take its first seat.
 *
 * The host chooses three things and no more: how many seats the table has, which advisory
 * filters the pack is built with, and their own name and party. Everything else about the
 * match is the server's — the seat order, the player IDs, the room code, the shuffle —
 * and none of it is negotiable afterwards, which is why this screen says so before the
 * room exists rather than after.
 *
 * Hosting is room management and nothing else. Section 14.1 keeps a host out of rule
 * overrides and out of other seats' moves, and there is nothing on this screen or the next
 * that gives one a wider projection than anyone else at the table.
 *
 * The order of the two things that happen on submit is the whole correctness argument of
 * this file: the server answers once with a credential that it cannot reissue, so the
 * claim is written to the seat store *before* anything else is done with it, and only a
 * stored claim is navigated to.
 */
import { useMemo, useState } from 'react';

import { CORE_CONTENT } from '@seatgrab/engine';

import { PARTY_IDENTITIES } from '../assets/parties';
import {
  ONLINE_MODE_NOTICE,
  createRoom,
  storedSeatFrom,
  type OpenSeatStore,
} from '../remote';

import { PageFrame } from './PageFrame';
import { ROUTES, navigate } from './routes';
import { CredentialNotice, SeatIdentityFields } from './OnlineSeatForm';
import {
  defaultHostDraft,
  describeRoomFailure,
  problemsFor,
  validateHostDraft,
  type HostDraft,
} from './online';
import { ADVISORY_FILTERS, MAX_SEATS, MIN_SEATS, advisoryImpact } from './setup';

const SEAT_COUNTS = Array.from({ length: MAX_SEATS - MIN_SEATS + 1 }, (_, i) => MIN_SEATS + i);

export function OnlineHost({ seats }: { seats: OpenSeatStore }) {
  const [draft, setDraft] = useState<HostDraft>(defaultHostDraft);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problems = useMemo(() => validateHostDraft(draft), [draft]);
  const impact = useMemo(
    () => advisoryImpact(CORE_CONTENT, draft.advisories),
    [draft.advisories],
  );
  const ready = problems.length === 0 && seats.available && !opening;

  const open = () => {
    if (!ready) return;
    setFailure(null);
    setOpening(true);
    void (async () => {
      try {
        const claim = await createRoom(
          {},
          {
            seatCount: draft.seatCount,
            displayName: draft.displayName.trim(),
            partyId: draft.partyId,
            contentAdvisories: draft.advisories,
          },
        );
        // Written before anything else is done with it. The credential is in exactly one
        // response, the server keeps only its hash, and there is no route that mints a
        // second: a claim that is navigated away from before it is stored is a seat
        // nobody can ever take and a room nobody can ever start.
        seats.save(
          storedSeatFrom(claim, { displayName: draft.displayName.trim(), partyId: draft.partyId }, new Date()),
        );
        navigate(ROUTES.onlineRoom(claim.matchId));
      } catch (error) {
        setFailure(describeRoomFailure(error));
        setOpening(false);
      }
    })();
  };

  return (
    <PageFrame
      title="Open a private room"
      lede="You take the first seat and the room code. Everyone else joins with it."
      back={{ href: ROUTES.online, label: 'Online rooms' }}
    >
      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}

      <section className="panel">
        <h2>Your seat</h2>
        <p className="panel__lede">
          You are seat 1, which is the engine&rsquo;s <code>p1</code> and the first place in the
          clockwise order. Seat order is fixed when the room opens, before anyone else joins, so
          it is never renegotiated at the start.
        </p>
        <SeatIdentityFields
          idPrefix="host"
          displayName={draft.displayName}
          partyId={draft.partyId}
          parties={PARTY_IDENTITIES}
          problems={problems}
          disabled={opening}
          onName={(displayName) => setDraft({ ...draft, displayName })}
          onParty={(partyId) => setDraft({ ...draft, partyId })}
        />
        <CredentialNotice storable={seats.available} unavailableReason={seats.unavailableReason} />
      </section>

      <section className="panel">
        <h2>How many seats</h2>
        <p className="panel__lede">
          Every seat has to be claimed before the table can be dealt, and a seat cannot be added
          or removed once the room is open. Open the room for the number of people who will
          actually be there.
        </p>
        <ul className="choices">
          {SEAT_COUNTS.map((count) => (
            <li key={count}>
              <label className="choice">
                <input
                  type="radio"
                  name="seat-count"
                  value={count}
                  checked={draft.seatCount === count}
                  disabled={opening}
                  onChange={() => setDraft({ ...draft, seatCount: count })}
                />
                <span>
                  <strong>{count} players</strong>
                  <span className="hint">
                    You and {count - 1} other{count - 1 === 1 ? '' : 's'}.
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {problemsFor(problems, 'seatCount').map((problem) => (
          <p key={problem.message} className="field-problem">
            {problem.message}
          </p>
        ))}
      </section>

      <section className="panel">
        <h2>Content advisories</h2>
        <p className="panel__lede">
          Some cards carry an advisory mark. Ticking a filter removes every card
          carrying that mark from the pack before the decks are shuffled. The host sets this for
          the table, so set it for the people who will be at it.
        </p>
        <ul className="choices">
          {ADVISORY_FILTERS.map((filter) => {
            const on = draft.advisories.includes(filter.advisory);
            const alone = advisoryImpact(CORE_CONTENT, [filter.advisory]);
            return (
              <li key={filter.advisory}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={opening}
                    aria-label={`Remove cards marked ${filter.label}`}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        advisories: ADVISORY_FILTERS.map((entry) => entry.advisory).filter((entry) =>
                          entry === filter.advisory ? !on : draft.advisories.includes(entry)),
                      })}
                  />
                  <span>
                    <strong>
                      {filter.label} ({filter.printedMark})
                    </strong>
                    <span className="hint">{filter.description}</span>
                    <span className="hint">
                      Removes {alone.total} cards: {alone.policy} policy, {alone.news}{' '}
                      news, {alone.trick} trick.
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="hint">
          {impact.total === 0
            ? 'No filter selected. The whole pack is shuffled in.'
            : `${impact.total} cards will be removed before the decks are shuffled.`}
        </p>
      </section>

      <section className="panel panel--commit">
        <h2>Open the room</h2>
        <p className="panel__lede">
          Opening the room does not deal the table. You get a room code to share, and the match
          starts when you say so and every seat is taken.
        </p>
        <p className="notice">{ONLINE_MODE_NOTICE}</p>
        {problems.length === 0 ? null : (
          <ul className="field-problem" aria-live="polite">
            {problems.map((problem) => (
              <li key={problem.message}>{problem.message}</li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" className="button button--primary" disabled={!ready} onClick={open}>
            {opening ? 'Opening…' : `Open a room for ${draft.seatCount} players`}
          </button>
        </div>
      </section>
    </PageFrame>
  );
}
