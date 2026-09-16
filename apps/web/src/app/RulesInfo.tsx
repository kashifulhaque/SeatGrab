/**
 * Rules, content pack and house rules, reachable from every screen.
 *
 * The home screen names the content pack and the supported player counts; this page is the
 * long form, including every ruling the engine applies where a table might otherwise argue.
 */
import { PageFrame } from './PageFrame';
import { ADJUDICATIONS, BACK_COST_VALUES, DECK_SIZES, INSTALLED_CAMPAIGN, KNOWN_LIMITS } from './edition';
import { ADVISORY_FILTERS, MAX_SEATS, MIN_SEATS } from './setup';
import { ROUTES } from './routes';
import { LOCAL_MODE_NOTICE } from '../local';

export function RulesInfo() {
  return (
    <PageFrame
      title="Rules and house rules"
      lede="How the game is played, what this build ships, and what it decides for you."
      back={{ href: ROUTES.home, label: 'Home' }}
    >
      <section className="panel">
        <h2>How a match is won</h2>
        <p>
          Each of the {DECK_SIZES.zones} zones has a threshold. Hold that many voters in a zone and
          you hold the zone. The game ends when every zone is held, and the winner is the player
          with the most <strong>scoring voters</strong>: not the most zones, resources or voters on
          the board. Voters above a zone’s threshold, and voters in zones you do not hold, do not
          score.
        </p>
        <p>
          Players vote for who goes first; nobody may vote for themselves, and a tie is voted
          again. Turns then go clockwise. Before the first turn, the first player takes any one
          resource, the second any two, and so on.
        </p>
      </section>

      <section className="panel">
        <h2>A turn, step by step</h2>
        <ol>
          <li>
            <strong>Passive income.</strong> Take one resource for every two policy cards you hold
            in the same archetype.
          </li>
          <li>
            <strong>Answer a policy question.</strong> Draw a card, choose one of its two answers,
            keep the card under that answer’s archetype and take the resources it shows. You may
            pay any four resources to draw a different card first. If you now hold more than 12
            resources, discard down to 12.
          </li>
          <li>
            <strong>Act.</strong> In any order: buy voter cards from the market and place each
            card’s voters together in one zone; use archetype powers you have unlocked; use
            redistricting rights once per zone you hold them in; buy a Dirty Trick face down for
            the price on its back, or play one from your hand; trade resources and Dirty Tricks
            with another player.
          </li>
          <li>
            <strong>End the turn.</strong> Unplaced voters are lost. Any Breaking News card dealt
            this turn resolves now.
          </li>
        </ol>
      </section>

      <section className="panel">
        <h2>The set this build ships</h2>
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
          <div>
            <dt>Engine</dt>
            <dd>{INSTALLED_CAMPAIGN.engineVersion}</dd>
          </div>
          <div>
            <dt>Save schema</dt>
            <dd>{INSTALLED_CAMPAIGN.schemaVersion}</dd>
          </div>
          <div>
            <dt>Players</dt>
            <dd>
              {MIN_SEATS}–{MAX_SEATS}
            </dd>
          </div>
          <div>
            <dt>Voter cards</dt>
            <dd>{DECK_SIZES.voter}</dd>
          </div>
          <div>
            <dt>Policy cards</dt>
            <dd>{DECK_SIZES.policy}</dd>
          </div>
          <div>
            <dt>Breaking News</dt>
            <dd>{DECK_SIZES.news}</dd>
          </div>
          <div>
            <dt>Dirty Tricks</dt>
            <dd>{DECK_SIZES.trick}</dd>
          </div>
          <div>
            <dt>Dirty Trick prices</dt>
            <dd>{BACK_COST_VALUES.join(' or ')}</dd>
          </div>
          <div>
            <dt>Voter areas</dt>
            <dd>{DECK_SIZES.slots}</dd>
          </div>
        </dl>
        <p className="hint">
          A saved match records these versions. A save whose content pack, board or save schema
          differs from this build is named and refused rather than loaded into the wrong deck.
        </p>
      </section>

      <section className="panel">
        <h2>Content filters</h2>
        <p className="panel__lede">
          Some cards carry an advisory mark. The lobby offers a filter for each mark; a filter
          removes every card carrying that mark before the decks are shuffled.
        </p>
        <ul className="disclosures">
          {ADVISORY_FILTERS.map((filter) => (
            <li key={filter.advisory}>
              <strong>
                {filter.label} ({filter.printedMark})
              </strong>
              <span>{filter.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>What this build cannot do</h2>
        <ul className="disclosures">
          {KNOWN_LIMITS.map((limit) => (
            <li key={limit.title}>
              <strong>{limit.title}</strong>
              <span>{limit.detail}</span>
            </li>
          ))}
        </ul>
        <p className="notice">{LOCAL_MODE_NOTICE}</p>
      </section>

      <section className="panel">
        <h2>House rules</h2>
        <p className="panel__lede">
          Where a table might argue, the engine applies one ruling to every match. These are
          those rulings.
        </p>
        <div className="table-scroll">
          <table className="records">
            <caption>{ADJUDICATIONS.length} house rules, applied to every match</caption>
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
      </section>
    </PageFrame>
  );
}
