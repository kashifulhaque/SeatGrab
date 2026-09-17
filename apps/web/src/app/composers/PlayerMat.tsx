/**
 * The player mat: four archetype tracks and the eight printed powers.
 *
 * Each track states the archetype, the effective card count, the passive income it pays,
 * and the progress toward levels 3 and 5 as filled pips with the power names marked on
 * the track. A player reads "two more to Shakedown" from the pips, not from arithmetic.
 *
 * The mat also forbids something: a power that is a modifier on another command must not
 * get a standalone button. Groundswell is a checkbox on a purchase, Volunteers is a
 * discount inside its payment, and Landslide is permission the gerrymander composer
 * already carries. Each is listed here as what it is, with no control of its own.
 *
 * The powers are compact rows with the state as a stamp — "Unlocked" in the archetype's
 * colour, "Locked" greyed — and the description opens on demand. Eight full descriptions,
 * drawn twice, were most of the private panel's height in the first playtest. The
 * unlocked ones that can be used also have a button in the action column, so nothing here
 * needs to be one.
 */
import { ARCHETYPES, ARCHETYPE_RESOURCE, type Archetype } from '@gerrymander/content';
import type { PlayerView } from '@gerrymander/protocol';

import {
  effectivePolicyCounts,
  passiveIncome,
  powerStatuses,
  type PowerStatus,
} from '../actions';
import { ArchetypeTrack } from '../cards/ArchetypeTrack';
import { archetypeStyle } from '../cards/archetypes';

import '../cards/cards.css';

function powerState(power: PowerStatus): { label: string; className: string } {
  if (power.unlocked && power.borrowed) return { label: 'Borrowed', className: 'card-power--borrowed' };
  if (power.unlocked) return { label: 'Unlocked', className: 'card-power--unlocked' };
  if (power.lendable) return { label: 'May be lent', className: 'card-power--lendable' };
  return { label: 'Locked', className: 'card-power--locked' };
}

/** The same row without its per-turn count, for a seat whose turn it is not. */
function withoutUsage(power: PowerStatus): PowerStatus {
  const { usage: _dropped, ...rest } = power;
  return rest;
}

function PowerRow({ power }: { power: PowerStatus }) {
  const state = powerState(power);
  const exhausted = power.usage !== undefined && power.usage.used >= power.usage.limit;
  return (
    <li className={`card-power ${state.className}`} style={archetypeStyle(power.archetype) as React.CSSProperties}>
      <details>
        <summary>
          <span className="card-power__name">{power.label}</span>
          <span className={`card-stamp${power.unlocked ? '' : ' card-stamp--locked'}`}>{state.label}</span>
          <span className="card-power__meta">
            Level {power.level} · {power.held} of {power.level} {power.archetype}
            {power.usage === undefined
              ? ''
              : ` · ${power.usage.used} of ${power.usage.limit} used${exhausted ? ', none left' : ''}`}
          </span>
        </summary>
        <div className="card-power__body">
          <p>{power.effect}</p>
          {power.submission === 'modifier' ? (
            <p className="small">Used inside another action, never on its own.</p>
          ) : null}
          {power.borrowed ? (
            <p className="hint">
              Counted through Turncoat. A rival who buys Turncoat takes this level with it.
            </p>
          ) : null}
          {power.lendable ? (
            <p className="hint">
              A Backroom Deal may be lending this level. The engine decides when you use it.
            </p>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function PlayerMat({
  view,
  seatId,
  /** Usage counts describe the turn in progress, so they are drawn only for its seat. */
  showUsage,
}: {
  view: PlayerView;
  seatId: string;
  showUsage: boolean;
}) {
  const counts = effectivePolicyCounts(view, seatId);
  const income = passiveIncome(view, seatId);
  const own = view.players.find((player) => player.id === seatId)?.policyCounts;
  const powers = powerStatuses(view, seatId);
  const powerNames = (archetype: Archetype): readonly [string, string] => {
    const mine = powers.filter((power) => power.archetype === archetype);
    return [
      mine.find((power) => power.level === 3)?.label ?? 'Level 3',
      mine.find((power) => power.level === 5)?.label ?? 'Level 5',
    ];
  };

  return (
    <div className="card-mat">
      <ul className="card-tracks">
        {ARCHETYPES.map((archetype) => {
          const held = counts[archetype];
          const borrowed = held - (own?.[archetype] ?? 0);
          return (
            <li key={archetype}>
              <ArchetypeTrack
                archetype={archetype}
                held={held}
                borrowed={borrowed}
                income={income[ARCHETYPE_RESOURCE[archetype]]}
                powers={powerNames(archetype)}
              />
            </li>
          );
        })}
      </ul>
      <p className="hint">
        Passive income is one resource per two cards of an archetype, each turn. Three cards
        unlock the first power, five the second.
      </p>

      <h4>Archetype powers</h4>
      <ul className="card-powers">
        {powers.map((power) => (
          <PowerRow key={power.id} power={showUsage ? power : withoutUsage(power)} />
        ))}
      </ul>
    </div>
  );
}
