/**
 * The rules in one minute, folded into the action column.
 *
 * A first-time player usually has not read the rulebook, and it is a screen away from the
 * match. This is the cheat sheet: the goal, the three steps of a turn, the four resources,
 * the cap and the one thing that costs people voters, with a link to the full rulebook
 * for everything else. It is collapsed by default and drawn on the shared surface and in
 * every seat's action column, so it is one tap away throughout the match. Every sentence
 * restates a rule the engine enforces; nothing here is a strategy tip.
 *
 * It stays a `details.drawer.drawer--help` so the surfaces that mount it need no change.
 */
import { RESOURCE_ASSETS } from '../assets/manifest';

import { ROUTES } from './routes';

import './rules/cheatsheet.css';

const RESOURCE_ARCHETYPES = [
  { resource: 'cash', archetype: 'Corporate' },
  { resource: 'influence', archetype: 'Nationalist' },
  { resource: 'press', archetype: 'Populist' },
  { resource: 'faith', archetype: 'Reformer' },
] as const;

const RESOURCE_CAP = 12;

export function HowToPlay() {
  return (
    <details className="drawer drawer--help">
      <summary>
        <h3>How to play</h3>
        <span className="small">The one-minute cheat sheet</span>
      </summary>
      <div className="rb-cheat">
        <p className="rb-cheat-goal">
          <span className="rb-cheat-goal__label">The goal</span>
          Fill a district’s threshold with your own voters to hold it. When all nine are held,
          the most <strong>majority voters</strong> wins. Voters above a threshold don’t score.
        </p>

        <ol className="rb-cheat-steps" aria-label="Your turn, in three steps">
          <li className="rb-cheat-step">
            <span className="rb-cheat-step__n" aria-hidden="true">1</span>
            <span className="rb-cheat-step__text">
              <strong>Answer the question.</strong> Pick one of two answers. It builds an
              archetype and pays resources.
            </span>
          </li>
          <li className="rb-cheat-step">
            <span className="rb-cheat-step__n" aria-hidden="true">2</span>
            <span className="rb-cheat-step__text">
              <strong>Buy voters and place them.</strong> Pay a market card’s price; all its
              voters go into one district. Use powers, tricks and trades too.
            </span>
          </li>
          <li className="rb-cheat-step">
            <span className="rb-cheat-step__n" aria-hidden="true">3</span>
            <span className="rb-cheat-step__text">
              <strong>End your turn.</strong> Play passes clockwise.
            </span>
          </li>
        </ol>

        <ul className="rb-cheat-resources" aria-label="The four resources">
          {RESOURCE_ARCHETYPES.map(({ resource, archetype }) => (
            <li key={resource} className="rb-cheat-resource" style={{ '--rb-accent': `var(--${resource})` } as React.CSSProperties}>
              <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={22} height={22} />
              <span>
                <strong>{RESOURCE_ASSETS[resource].label}</strong>
                <span className="rb-cheat-resource__sub">{archetype}</span>
              </span>
            </li>
          ))}
        </ul>

        <ul className="rb-cheat-notes">
          <li className="rb-cheat-note">
            <span className="rb-cheat-note__badge">{RESOURCE_CAP}</span>
            Hold at most {RESOURCE_CAP} resources. Above that, you discard down at once.
          </li>
          <li className="rb-cheat-note rb-cheat-note--warn">
            <span className="rb-cheat-note__badge" aria-hidden="true">!</span>
            Unplaced voters are lost when your turn ends.
          </li>
        </ul>

        <p className="rb-cheat-more">
          <a href={ROUTES.rules}>Read the full rulebook</a>
        </p>
      </div>
    </details>
  );
}
