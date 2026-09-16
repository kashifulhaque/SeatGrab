/**
 * The rules in one minute, folded into the action column.
 *
 * A first-time player usually has not read the rules screen, and it is a screen away from
 * the match. This is the short form, collapsed by default, drawn on the shared surface and
 * in every seat's action column so it is one tap away throughout the match. Every sentence
 * restates a rule the engine enforces; nothing here is a strategy tip.
 */
import { RESOURCE_ASSETS } from '../assets/manifest';

import { ROUTES } from './routes';

const RESOURCE_ARCHETYPES = [
  { resource: 'cash', archetype: 'Corporate' },
  { resource: 'influence', archetype: 'Nationalist' },
  { resource: 'press', archetype: 'Populist' },
  { resource: 'faith', archetype: 'Reformer' },
] as const;

export function HowToPlay() {
  return (
    <details className="drawer drawer--help">
      <summary>
        <h3>How to play</h3>
        <span className="small">The rules in one minute</span>
      </summary>
      <div className="help">
        <section>
          <h4>The goal</h4>
          <p>
            Each zone shows how many voters it takes to hold it. Reach that number with your own
            voters and the zone is yours; each of those voters scores one point. The game ends
            when every zone is held, and the player with the most scoring voters wins. Voters
            above the number, or in zones you do not hold, score nothing.
          </p>
        </section>
        <section>
          <h4>Your turn</h4>
          <ol>
            <li>
              <strong>Answer a policy question.</strong> Two answers are offered; take the one you
              agree with. Each answer builds one of four archetypes and pays the resources shown
              on it. Pay any four resources to draw a different question.
            </li>
            <li>
              <strong>Buy voters and place them.</strong> Pay a market card’s price to take its
              voters, then put all of them in one zone. Buy as many cards as you can afford. You
              may also use a power you have unlocked, buy or play a Dirty Trick, and trade.
            </li>
            <li>
              <strong>End your turn.</strong> Voters you did not place are lost.
            </li>
          </ol>
        </section>
        <section>
          <h4>Resources</h4>
          <ul className="help__resources">
            {RESOURCE_ARCHETYPES.map(({ resource, archetype }) => (
              <li key={resource}>
                <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={20} height={20} />
                <span>
                  <strong>{RESOURCE_ASSETS[resource].label}</strong> · {archetype}
                </span>
              </li>
            ))}
          </ul>
          <p>
            A <strong>?</strong> in a price means any one resource. You may hold at most 12
            resources; above that, you discard down immediately.
          </p>
        </section>
        <section>
          <h4>Archetypes and powers</h4>
          <p>
            Every answer you keep is a card for its archetype. Each pair of cards in one archetype
            pays you one resource of its type at the start of your turn. Three cards unlock that
            archetype’s first power and five unlock the second. Lose the cards and the power goes
            with them. Your mat lists all eight.
          </p>
        </section>
        <section>
          <h4>Redistricting</h4>
          <p>
            Hold strictly the most voters in a zone and you gain its redistricting rights: once a
            turn, move one voter, yours or a rival’s, into, out of or within that zone. A voter
            that already counts toward a majority cannot be moved this way.
          </p>
        </section>
        <section>
          <h4>Volatile areas</h4>
          <p>
            Areas with a dashed ring are volatile. A voter placed there is fixed for the rest of
            the game, and its owner draws a Breaking News card that resolves at the end of the
            turn.
          </p>
        </section>
        <section>
          <h4>Dirty Tricks and trades</h4>
          <p>
            A Dirty Trick is bought face down for the price on its back and played on your own
            turn, or as a reaction when the card says so. A trade must involve the player whose
            turn it is, must move resources both ways, and needs both sides to agree.
          </p>
        </section>
        <p className="small">
          <a href={ROUTES.rules}>The full rules and the house rules this app applies</a>
        </p>
      </div>
    </details>
  );
}
