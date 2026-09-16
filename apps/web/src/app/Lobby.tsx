/**
 * The lobby of section 13.3: seats, parties, clockwise order, advisory filters, and the
 * disclosures a table is entitled to before it commits.
 *
 * Everything this screen decides lives in `setup.ts`, so the screen itself only renders
 * a draft and reports what `validateSetup` says about it. Pressing Start freezes the
 * draft into a `GameConfig`, and `createGame` copies that config into the state: from
 * then on the seats, the parties, the clockwise order, the advisory filters and the tie
 * policy belong to the match and cannot be edited.
 */
import { useMemo, useState } from 'react';

import { CORE_CONTENT } from '@seatgrab/engine';

import { BoardArtwork } from '../board/BoardArtwork';
import { RESOURCE_ASSETS } from '../assets/manifest';
import { PARTY_IDENTITIES } from '../assets/parties';
import { LOCAL_MODE_NOTICE, createLocalMatch, randomSeed, type LocalSnapshotStore } from '../local';

import { PageFrame } from './PageFrame';
import { PartyMark } from './PartyMark';
import { ADJUDICATIONS, DECK_SIZES, INSTALLED_CAMPAIGN, KNOWN_LIMITS } from './edition';
import { ROUTES, navigate } from './routes';
import {
  ADVISORY_FILTERS,
  MAX_NAME_LENGTH,
  MAX_SEATS,
  MIN_SEATS,
  addSeat,
  advisoryImpact,
  assignParty,
  defaultSetupDraft,
  moveSeat,
  newMatchId,
  removeSeat,
  renameSeat,
  toGameConfig,
  toggleAdvisory,
  validateSetup,
  type SetupDraft,
} from './setup';
import { describeError } from './useLocalStore';

const RESOURCE_ORDER = ['cash', 'influence', 'press', 'faith'] as const;

export function Lobby({ store, storeError }: { store: LocalSnapshotStore | null; storeError: string | null }) {
  const [draft, setDraft] = useState<SetupDraft>(defaultSetupDraft);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problems = useMemo(() => validateSetup(draft), [draft]);
  const impact = useMemo(
    () => advisoryImpact(CORE_CONTENT, draft.advisories),
    [draft.advisories],
  );
  const problemsFor = (seatKey: string, field: 'displayName' | 'partyId') =>
    problems.filter((problem) => problem.seatKey === seatKey && problem.field === field);

  const ready = problems.length === 0 && store !== null && !starting;

  const start = () => {
    if (store === null) return;
    setFailure(null);
    setStarting(true);
    const matchId = newMatchId(new Date(), Math.random());
    void (async () => {
      try {
        const config = toGameConfig(draft, matchId);
        await createLocalMatch({ store, content: CORE_CONTENT }, config, randomSeed());
        navigate(ROUTES.match(matchId));
      } catch (error) {
        setFailure(describeError(error));
        setStarting(false);
      }
    })();
  };

  return (
    <PageFrame
      title="Set up a local match"
      lede="Add the players in the order they sit. Everything else is optional."
      back={{ href: ROUTES.home, label: 'Home' }}
    >
      {storeError === null ? null : (
        <p className="alert alert--error" role="alert">
          This browser will not open the save database: {storeError}
        </p>
      )}
      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}

      <div className="lobby-grid">
      <section className="panel lobby-grid__seats" aria-labelledby="seats-heading">
        <h2 id="seats-heading">Who is playing</h2>
        <p className="panel__lede">
          {MIN_SEATS} to {MAX_SEATS} players, in the order they sit around the table. Each takes a
          name and a party emblem.
        </p>
        <ol className="seats">
          {draft.seats.map((seat, index) => {
            const nameProblems = problemsFor(seat.key, 'displayName');
            const partyProblems = problemsFor(seat.key, 'partyId');
            const nameId = `${seat.key}-name`;
            const partyId = `${seat.key}-party`;
            return (
              <li key={seat.key} className="seat">
                <p className="seat__ordinal">
                  Seat {index + 1}
                  {index === 0 ? <span className="seat__badge">starts the order</span> : null}
                </p>
                <div className="seat__field">
                  <label htmlFor={nameId}>Name</label>
                  <input
                    id={nameId}
                    className="input"
                    value={seat.displayName}
                    maxLength={MAX_NAME_LENGTH}
                    autoComplete="off"
                    aria-invalid={nameProblems.length > 0}
                    aria-describedby={nameProblems.length > 0 ? `${nameId}-problem` : undefined}
                    onChange={(event) => setDraft(renameSeat(draft, seat.key, event.target.value))}
                  />
                  {nameProblems.map((problem) => (
                    <p key={problem.message} id={`${nameId}-problem`} className="field-problem">
                      {problem.message}
                    </p>
                  ))}
                </div>
                <div className="seat__field">
                  <label htmlFor={partyId}>Party</label>
                  <span className="seat__party">
                    <PartyMark partyId={seat.partyId} size={28} />
                    <select
                      id={partyId}
                      className="input"
                      value={seat.partyId}
                      aria-invalid={partyProblems.length > 0}
                      onChange={(event) => setDraft(assignParty(draft, seat.key, event.target.value))}
                    >
                      {PARTY_IDENTITIES.map((party) => (
                        <option key={party.partyId} value={party.partyId}>
                          {party.displayName} — {party.description}
                        </option>
                      ))}
                    </select>
                  </span>
                  {partyProblems.map((problem) => (
                    <p key={problem.message} className="field-problem">
                      {problem.message}
                    </p>
                  ))}
                </div>
                <div className="seat__controls actions">
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={index === 0}
                    aria-label={`Move ${seat.displayName} earlier in the clockwise order`}
                    onClick={() => setDraft(moveSeat(draft, seat.key, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={index === draft.seats.length - 1}
                    aria-label={`Move ${seat.displayName} later in the clockwise order`}
                    onClick={() => setDraft(moveSeat(draft, seat.key, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={draft.seats.length <= MIN_SEATS}
                    aria-label={`Remove ${seat.displayName}`}
                    onClick={() => setDraft(removeSeat(draft, seat.key))}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={draft.seats.length >= MAX_SEATS}
            onClick={() => setDraft(addSeat(draft))}
          >
            Add a seat
          </button>
          <span className="hint">
            {draft.seats.length} of {MAX_SEATS} seats.
            {draft.seats.length >= MAX_SEATS ? ' This edition seats no more.' : ''}
          </span>
        </div>
      </section>

      <section className="panel" aria-labelledby="advisories-heading">
        <h2 id="advisories-heading">Content filters</h2>
        <p className="panel__lede">
          Optional. Some cards carry an advisory mark; ticking a filter removes every card with
          that mark before the decks are shuffled.
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
                    aria-label={`Remove cards marked ${filter.label}`}
                    onChange={() => setDraft(toggleAdvisory(draft, filter.advisory))}
                  />
                  <span>
                    <strong>
                      {filter.label} ({filter.printedMark})
                    </strong>
                    <span className="hint">{filter.description}</span>
                    <span className="small">
                      Removes {alone.total} cards: {alone.policy} policy, {alone.news}{' '}
                      news, {alone.trick} trick.
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="small">
          {impact.total === 0
            ? `No filter selected. All ${DECK_SIZES.policy} policy, ${DECK_SIZES.news} news and ${DECK_SIZES.trick} trick cards are shuffled in.`
            : `${impact.total} of ${DECK_SIZES.policy + DECK_SIZES.news + DECK_SIZES.trick} cards will be removed, leaving ${DECK_SIZES.policy - impact.policy} policy, ${DECK_SIZES.news - impact.news} news and ${DECK_SIZES.trick - impact.trick} trick cards.`}
        </p>
      </section>

      <details className="settings">
        <summary>Content pack</summary>
        <p className="small">
          One content pack is installed, so there is nothing to choose between. A match records
          the pack it was created with, and a save from a different one is refused by name rather
          than loaded into the wrong deck.
        </p>
        <dl className="facts">
          <div>
            <dt>Set</dt>
            <dd>{INSTALLED_CAMPAIGN.displayName}</dd>
          </div>
          <div>
            <dt>Content pack</dt>
            <dd>
              {INSTALLED_CAMPAIGN.contentPackId} {INSTALLED_CAMPAIGN.contentVersion}
            </dd>
          </div>
          <div>
            <dt>Ruleset</dt>
            <dd>
              {INSTALLED_CAMPAIGN.rulesetId} {INSTALLED_CAMPAIGN.rulesetVersion}
            </dd>
          </div>
          <div>
            <dt>Board</dt>
            <dd>
              {INSTALLED_CAMPAIGN.boardId} {INSTALLED_CAMPAIGN.boardVersion}
            </dd>
          </div>
        </dl>
      </details>

      <details className="settings">
        <summary>What the table is agreeing to</summary>
        <p className="small">
          These are fixed for this build. They are shown here, before the match exists, rather than
          discovered when a command is refused.
        </p>
        <ul className="disclosures">
          {KNOWN_LIMITS.map((limit) => (
            <li key={limit.title}>
              <strong>{limit.title}</strong>
              <span>{limit.detail}</span>
            </li>
          ))}
        </ul>
        <details className="disclosure">
          <summary>
            The {ADJUDICATIONS.length} house rules this build applies
          </summary>
          <p className="hint">
            Where a table might argue, the engine applies one ruling to every match.
          </p>
          <div className="table-scroll">
            <table className="records">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Issue</th>
                  <th scope="col">Ruling</th>
                </tr>
              </thead>
              <tbody>
                {ADJUDICATIONS.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.id}</th>
                    <td>{entry.issue}</td>
                    <td>{entry.ruling}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <p className="notice">{LOCAL_MODE_NOTICE}</p>
      </details>

      <details className="settings">
        <summary>Preview the board and the resources</summary>
        <p className="small">
          Nothing below is shuffled yet, so nothing here reveals a card. The decks are shuffled when
          the match is created.
        </p>
        <div className="preview">
          <div className="preview__board">
            <BoardArtwork title={`The ${DECK_SIZES.zones} zones and ${DECK_SIZES.slots} voter areas`} />
          </div>
          <div>
            <h3>Resources</h3>
            <ul className="resource-key">
              {RESOURCE_ORDER.map((resource) => (
                <li key={resource}>
                  <img src={RESOURCE_ASSETS[resource].url} alt="" width={24} height={24} />
                  <span>{RESOURCE_ASSETS[resource].label}</span>
                </li>
              ))}
            </ul>
            <h3>Majorities</h3>
            <p>
              Each zone has its own threshold. Hold that many voters in a zone and the zone is yours;
              only those majority voters score at the end. The match ends when every zone has a
              majority, and players tied on majority voters all win.
            </p>
          </div>
        </div>
      </details>

      <section className="panel panel--commit lobby-grid__side" aria-labelledby="start-heading">
        <h2 id="start-heading">Start</h2>
        <p className="panel__lede">
          Starting shuffles the decks and opens the vote for who goes first. Seats, parties, order
          and filters are fixed from that moment.
        </p>
        <ul className="seat-chips lobby-roster" aria-label="Seats in order">
          {draft.seats.map((seat) => (
            <li key={seat.key}>
              <PartyMark partyId={seat.partyId} size={20} />
              {seat.displayName.trim() === '' ? 'Unnamed' : seat.displayName}
            </li>
          ))}
        </ul>
        {problems.length === 0 ? null : (
          <ul className="field-problem" aria-live="polite">
            {problems.map((problem) => (
              <li key={`${problem.seatKey ?? 'table'}-${problem.message}`}>{problem.message}</li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" className="button button--primary" disabled={!ready} onClick={start}>
            {starting ? 'Starting…' : `Start a ${draft.seats.length}-player match`}
          </button>
          {store === null && storeError === null ? <span className="hint">Opening the save database…</span> : null}
        </div>
        <p className="small">
          The first turn begins with a vote for who goes first, then each player takes their
          starting resources.
        </p>
      </section>
      </div>
    </PageFrame>
  );
}
