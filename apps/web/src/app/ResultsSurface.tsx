/**
 * The results screen of section 13.11.
 *
 * It is drawn in place of the turn controls the moment the projection says the match is
 * finished, because at that point there is nothing left to compose: the engine has
 * cleared the interaction stack, `getLegalActions` returns nothing, and a composer would
 * only offer controls every one of which the engine refuses.
 *
 * What it shows is fixed by 13.11 and nothing more:
 *
 * - each seat's final majority score, as the engine froze it;
 * - a zone-by-zone breakdown that names the voters which did *not* count, because a
 *   surplus voter is the single most common surprise at the end of a physical game;
 * - the end reason and the tie policy in words;
 * - the winners, joint winners included;
 * - the retained policy summary, as the four printed track counts and no ranking;
 * - the public event history in full, rather than the table's last 25;
 * - a way to play again.
 *
 * The last of those is the one thing that differs between transports, so it arrives as
 * the `again` prop rather than being decided here. A pass-and-play rematch is
 * `LocalRematch` below: it preserves the settings, shuffles again, and asks every seat
 * first, because a table is several people and the one holding the device is not all of
 * them. Online, every seat is a separate browser and there is nobody at this one to ask,
 * so playing again is a new room rather than a box each seat ticks.
 *
 * There is deliberately no "best policy" score and no bonus of any kind. The score is
 * marked majority voters, which is the scoring rule.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { CORE_CONTENT } from '@seatgrab/engine';
import type { PlayerView } from '@seatgrab/protocol';

import { createLocalMatch, randomSeed, type LocalSnapshotStore } from '../local';

import { PartyMark } from './PartyMark';
import { ROUTES, navigate } from './routes';
import { newMatchId } from './setup';
import { describeWinners, rematchConfig, rematchSeats, summarizeResults } from './results';
import { describeError } from './useLocalStore';

const ARCHETYPES = ['corporate', 'nationalist', 'populist', 'reformer'] as const;

/**
 * Settings preserved, decks reshuffled, and every seat asked before either happens.
 *
 * Section 13.11 asks for "settings preserved but fresh shuffle/seat consent". Consent is
 * taken literally here: a pass-and-play table is several people, and one of them holding
 * the device is not the table agreeing to play again. Every seat ticks its own box, and
 * the button stays disabled until they all have.
 */
export function LocalRematch({
  view,
  store,
}: {
  view: PlayerView;
  store: LocalSnapshotStore | null;
}) {
  const seats = useMemo(() => rematchSeats(view), [view]);
  const [consented, setConsented] = useState<readonly string[]>([]);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const all = seats.every((seat) => consented.includes(seat.id));
  const ready = all && store !== null && !starting;

  const toggle = useCallback((seatId: string) => {
    setConsented((current) =>
      current.includes(seatId)
        ? current.filter((id) => id !== seatId)
        : [...current, seatId]);
  }, []);

  const start = useCallback(() => {
    if (store === null || !all || starting) return;
    setFailure(null);
    setStarting(true);
    const matchId = newMatchId(new Date(), Math.random());
    void (async () => {
      try {
        // A fresh seed, taken now: nothing about the finished match's shuffle survives.
        await createLocalMatch(
          { store, content: CORE_CONTENT },
          rematchConfig(view, matchId),
          randomSeed(),
        );
        navigate(ROUTES.match(matchId));
      } catch (error) {
        setFailure(describeError(error));
        setStarting(false);
      }
    })();
  }, [all, starting, store, view]);

  return (
    <section className="panel" aria-labelledby="rematch-heading">
      <h2 id="rematch-heading">Play again</h2>
      <p className="panel__lede">
        A rematch keeps the seats, the clockwise order, the party emblems, the advisory
        filters and the tie policy. Nothing else carries over: the decks are shuffled
        from a new seed, the first-player vote is held again, and this match stays saved
        where it is.
      </p>

      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}

      <h3 id="consent-heading">Does everyone want another one?</h3>
      <ul className="choices" aria-labelledby="consent-heading">
        {seats.map((seat) => (
          <li key={seat.id}>
            <label className="choice">
              <input
                type="checkbox"
                checked={consented.includes(seat.id)}
                onChange={() => toggle(seat.id)}
              />
              <span>
                <strong>
                  <PartyMark partyId={seat.partyId} size={20} /> {seat.displayName} is in
                </strong>
                <span className="hint">
                  Seat {seat.seat + 1} clockwise, keeping the same party emblem.
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!ready}
          onClick={start}
        >
          {starting ? 'Shuffling…' : `Start a rematch with these ${seats.length} seats`}
        </button>
        <span className="hint" role="status">
          {all
            ? 'Every seat has agreed.'
            : `${consented.length} of ${seats.length} seats have agreed. `
              + 'A rematch starts only when they all have.'}
          {store === null ? ' Waiting for the save database.' : ''}
        </span>
      </div>
      <div className="actions">
        <a className="button button--quiet" href={ROUTES.lobby}>
          Set up a different table
        </a>
        <span className="hint">
          To change a name, a party, the seat order or an advisory filter, start there
          instead — a rematch cannot, because those are frozen when a match is created.
        </span>
      </div>
    </section>
  );
}

export function ResultsSurface({
  view,
  again,
}: {
  view: PlayerView;
  /** How this table plays again: `LocalRematch` locally, a new room online. */
  again: ReactNode;
}) {
  const results = useMemo(() => summarizeResults(view), [view]);
  if (results === null) return null;

  const history = [...view.history].reverse();

  return (
    <>
      <section className="panel results" aria-labelledby="results-heading">
        <p className="results__eyebrow">Final</p>
        <h2 id="results-heading">{describeWinners(results)}</h2>
        <p className="results__reason" role="status">
          {results.reasonSentence}
        </p>
        <p className="hint">{results.tiePolicySentence}</p>
        {results.unresolvedZones.length === 0 ? null : (
          <p className="hint">
            {results.unresolvedZones.length} zone
            {results.unresolvedZones.length === 1 ? '' : 's'} never resolved a majority:{' '}
            {results.unresolvedZones.join(', ')}. No voter in{' '}
            {results.unresolvedZones.length === 1 ? 'it' : 'them'} scored.
          </p>
        )}

        <h3 id="standings-heading">Final scores</h3>
        <div className="table-scroll">
          <table className="records" aria-labelledby="standings-heading">
            <thead>
              <tr>
                <th scope="col">Place</th>
                <th scope="col">Seat</th>
                <th scope="col">Majority voters</th>
                <th scope="col">Voters on board</th>
                <th scope="col">Did not count</th>
                <th scope="col">Zones held</th>
              </tr>
            </thead>
            <tbody>
              {results.standings.map((standing) => (
                <tr
                  key={standing.player.id}
                  className={standing.winner ? 'results__row results__row--winner' : 'results__row'}
                >
                  <th scope="row">
                    {standing.rank}
                    {standing.winner ? (
                      <span className="results__badge">
                        {results.jointWinners ? 'Joint winner' : 'Winner'}
                      </span>
                    ) : null}
                  </th>
                  <td>
                    <PartyMark partyId={standing.player.partyId} size={22} />{' '}
                    {standing.player.displayName}
                  </td>
                  <td className="results__score">{standing.score}</td>
                  <td>{standing.boardVoters}</td>
                  <td>{standing.surplusVoters}</td>
                  <td>
                    {standing.zonesWon.length === 0 ? 'none' : standing.zonesWon.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Only voters marked for a majority score. {results.countedTotal} voter
          {results.countedTotal === 1 ? '' : 's'} counted across the board and{' '}
          {results.surplusTotal} did not — those are the voters standing in a zone that
          was already decided, or in one that never resolved.
        </p>
      </section>

      <section className="panel" aria-labelledby="breakdown-heading">
        <h2 id="breakdown-heading">Zone by zone</h2>
        <p className="panel__lede">
          Every zone, who took its majority, and what each seat had standing in it when
          the match ended. The second number in each row is the part that scored nothing.
        </p>
        <ul className="zone-list">
          {results.zones.map((zone) => (
            <li key={zone.id} className="zone-card">
              <div className="zone-card__head">
                <h3>{zone.displayName}</h3>
                <p className="zone-card__threshold">
                  {zone.majorityThreshold} of {zone.capacity} for a majority
                </p>
              </div>
              <p className="zone-card__majority">
                {zone.majorityOwner === null
                  ? 'No majority was ever marked here, so nothing in this zone scored.'
                  : `Majority: ${zone.majorityOwner.displayName}, scoring ${zone.majorityOwner.counted}.`}
              </p>
              {zone.holdings.length === 0 ? (
                <p className="hint">No voters stood here.</p>
              ) : (
                <ul className="zone-card__holdings">
                  {zone.holdings.map((holding) => (
                    <li key={holding.playerId}>
                      <PartyMark partyId={holding.partyId} size={20} />
                      <span>
                        {holding.displayName}: {holding.counted} scored,{' '}
                        {holding.surplus} did not count
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="zone-card__fill">
                {zone.filled} filled · {zone.empty} empty · {zone.surplusTotal} voter
                {zone.surplusTotal === 1 ? '' : 's'} that scored nothing
              </p>
            </li>
          ))}
        </ul>
        <details className="disclosure">
          <summary>Every zone, in words</summary>
          <ul className="spoken-zones">
            {results.zones.map((zone) => (
              <li key={zone.id}>{zone.spoken}</li>
            ))}
          </ul>
        </details>
      </section>

      <section className="panel" aria-labelledby="policy-heading">
        <h2 id="policy-heading">Policy kept</h2>
        <p className="panel__lede">
          The four printed tracks, as every seat finished them. These are the counts the
          table could already see; nothing here ranks one policy above another, because
          the game does not score them.
        </p>
        <div className="table-scroll">
          <table className="records" aria-labelledby="policy-heading">
            <thead>
              <tr>
                <th scope="col">Seat</th>
                {ARCHETYPES.map((archetype) => (
                  <th scope="col" key={archetype}>
                    {archetype}
                  </th>
                ))}
                <th scope="col">Cards kept</th>
              </tr>
            </thead>
            <tbody>
              {results.standings.map((standing) => {
                const counts = standing.player.policyCounts;
                return (
                  <tr key={standing.player.id}>
                    <th scope="row">
                      <PartyMark partyId={standing.player.partyId} size={22} />{' '}
                      {standing.player.displayName}
                    </th>
                    {ARCHETYPES.map((archetype) => (
                      <td key={archetype}>{counts[archetype]}</td>
                    ))}
                    <td>
                      {ARCHETYPES.reduce((total, archetype) => total + counts[archetype], 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {again}

      <section className="panel" aria-labelledby="full-history-heading">
        <h2 id="full-history-heading">The whole public record</h2>
        <p className="panel__lede">
          Every public event of the match, newest first. A private event still appears
          only in the view of a seat entitled to it, so this is the record the table
          shared, not a reveal of anyone&rsquo;s hand.
        </p>
        {history.length === 0 ? (
          <p>Nothing was recorded.</p>
        ) : (
          <ol className="history history--full">
            {history.map((event) => (
              <li key={event.id}>
                <span className="history__actor">
                  {event.actorId === undefined
                    ? '—'
                    : view.players.find((player) => player.id === event.actorId)?.displayName
                      ?? event.actorId}
                </span>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="hint">
          {history.length} event{history.length === 1 ? '' : 's'}.
        </p>
      </section>
    </>
  );
}
