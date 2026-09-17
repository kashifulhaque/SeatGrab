/**
 * The player mat: four archetype columns and the eight printed powers.
 *
 * Section 13.6 asks each column to state the archetype, the effective card count, the
 * passive income it pays, the progress toward levels 3 and 5, and whether a power is
 * unlocked, borrowed or locked — with remaining uses and exact costs where they apply.
 *
 * It also forbids something: a power that is a modifier on another command must not get
 * a standalone button. Groundswell is a checkbox on a purchase, Volunteers is a
 * discount inside its payment, and Landslide is permission the gerrymander composer
 * already carries. Each is listed here as what it is, with no control of its own.
 *
 * The powers are compact rows. Eight full descriptions, drawn twice, were most of the
 * private panel's height in the first playtest; a row now says its state and its level,
 * and the description opens on demand. The unlocked ones that can be used also have a
 * button in the action column, so nothing here needs to be one.
 */
import { ARCHETYPES, ARCHETYPE_RESOURCE, type Archetype } from '@gerrymander/content';
import type { PlayerView } from '@gerrymander/protocol';

import { RESOURCE_ASSETS } from '../../assets/manifest';
import {
  effectivePolicyCounts,
  passiveIncome,
  powerStatuses,
  type PowerStatus,
} from '../actions';

const ARCHETYPE_LABELS: Record<Archetype, string> = {
  corporate: 'Corporate',
  nationalist: 'Nationalist',
  populist: 'Populist',
  reformer: 'Reformer',
};

function powerState(power: PowerStatus): { label: string; className: string } {
  if (power.unlocked && power.borrowed) return { label: 'Borrowed', className: 'mat-power--borrowed' };
  if (power.unlocked) return { label: 'Unlocked', className: 'mat-power--unlocked' };
  if (power.lendable) return { label: 'May be lent', className: 'mat-power--lendable' };
  return { label: 'Locked', className: 'mat-power--locked' };
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
    <li className={`mat-power ${state.className}`}>
      <details>
        <summary>
          <span className="mat-power__name">{power.label}</span>
          <span className="mat-power__state">{state.label}</span>
          <span className="small">
            Level {power.level} · {power.held} of {power.level} {power.archetype}
            {power.usage === undefined
              ? ''
              : ` · ${power.usage.used} of ${power.usage.limit} used${exhausted ? ', none left' : ''}`}
          </span>
        </summary>
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

  return (
    <div className="mat">
      <ul className="mat__columns">
        {ARCHETYPES.map((archetype) => {
          const resource = ARCHETYPE_RESOURCE[archetype];
          const held = counts[archetype];
          const borrowed = held - (own?.[archetype] ?? 0);
          const nextLevel = held < 3 ? 3 : held < 5 ? 5 : null;
          return (
            <li key={archetype} className="mat-column">
              <h4>
                <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={22} height={22} />
                {ARCHETYPE_LABELS[archetype]}
              </h4>
              <p className="mat-column__count">
                {held} card{held === 1 ? '' : 's'}
                {borrowed > 0 ? ` (${borrowed} through Turncoat)` : ''}
              </p>
              <p className="small">
                Pays {income[resource]} {RESOURCE_ASSETS[resource].label} a turn
                {nextLevel === null ? '. Both levels reached.' : ` · ${nextLevel - held} more for level ${nextLevel}.`}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="hint">Passive income is one resource per two cards of an archetype, each turn.</p>

      <h4>Archetype powers</h4>
      <ul className="mat-powers">
        {powers.map((power) => (
          <PowerRow key={power.id} power={showUsage ? power : withoutUsage(power)} />
        ))}
      </ul>
    </div>
  );
}
