/**
 * The one bar that stays put for the whole match.
 *
 * Section 13.4 asks for the turn, the phase and the decision owner to be conspicuous and
 * for End Turn to sit in a stable place that explains why it is disabled. This bar is
 * pinned to the viewport and answers three questions in a fixed order, left to right:
 * which turn, who must act and what they are doing, and what the revealed seat holds. It
 * then carries End turn and whatever the mode uses to change seats.
 *
 * Under that row is the turn as steps — answer, buy and place, end — with the current
 * one marked. A first-time player who does not know the engine's phase names can still
 * see where in the turn the table is, and that the question comes before the market.
 * `turnSteps` in `table.ts` decides the steps; this bar only draws them.
 *
 * Two privacy rules hold here and are asserted by `match-shell.test.tsx`:
 *
 * - Everything but the resources comes from the public projection. `describeDecision`
 *   reads `pendingDecision.summary`, which the engine writes about what a player must do
 *   and never about what only that player may see.
 * - The resources are drawn only for `me`, which the caller sets to the revealed seat and
 *   to nothing on the shared surface. Resource counts are public — the seat list shows
 *   every seat's — but this bar says "your", so it must never name another seat's.
 *
 * The bar measures itself into `--bar-h` so the sticky side columns below can sit under
 * it whatever it wraps to. Nothing reads the measurement for a rule.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import type { PlayerView, PublicPlayerView } from '@gerrymander/protocol';

import { PARTY_BY_ID, RESOURCE_ASSETS } from '../assets/manifest';

import { PartyMark } from './PartyMark';
import type { Availability } from './actions';
import {
  describeDecision,
  describeDecisionFor,
  seatLabel,
  describeStep,
  turnSteps,
} from './table';

const RESOURCE_ORDER = ['cash', 'influence', 'press', 'faith'] as const;

/** `Turn 4`, `Setup` or `Final`. The step row says which part of the turn it is. */
function turnLabel(view: PlayerView): string {
  if (view.status === 'finished') return 'Final';
  if (view.status === 'setup' || view.turnOrdinal === 0) return 'Setup';
  return `Turn ${view.turnOrdinal}`;
}

/** The turn as steps. Pills on a wide screen; one line on a phone, by stylesheet. */
export function TurnSteps({ view }: { view: PlayerView }) {
  const steps = turnSteps(view);
  return (
    <>
      <ol className="steps" aria-label="Where this turn is">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={`step step--${step.state}`}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <span className="step__num" aria-hidden="true">
              {step.state === 'done' ? '✓' : index + 1}
            </span>
            <span className="step__label">{step.label}</span>
            <span className="visually-hidden">
              {step.state === 'done' ? ', done' : step.state === 'current' ? ', now' : ', next'}
            </span>
          </li>
        ))}
      </ol>
      <p className="steps__line" aria-hidden="true">{describeStep(view)}</p>
    </>
  );
}

export function StatusBar({
  view,
  me,
  endTurn,
  switcher,
  thinking = null,
  settings,
}: {
  view: PlayerView;
  /** The revealed seat, whose resources are drawn. `null` draws none. */
  me: PublicPlayerView | null;
  endTurn: Availability & { onEndTurn: () => void; busy: boolean };
  /** The mode's control for changing seats. Absent online, where there is one seat. */
  switcher?: ReactNode;
  /**
   * The computer seat about to act, or `null`.
   *
   * It replaces the decision line while it is set, because "Devi (computer) is thinking…"
   * is the one thing a person watching wants to know and the banner underneath would
   * otherwise read as though the table were waiting on them.
   */
  thinking?: PublicPlayerView | null;
  /** The mode's own settings, folded into the bar. Absent online. */
  settings?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const write = () => {
      document.documentElement.style.setProperty('--bar-h', `${Math.ceil(element.getBoundingClientRect().height)}px`);
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--bar-h');
    };
  }, []);

  // The revealed seat reads the bar as "you"; the shared surface names every seat.
  const decision = me === null ? describeDecision(view) : describeDecisionFor(view, me.id);
  const total = me === null
    ? 0
    : me.resources.cash + me.resources.influence + me.resources.press + me.resources.faith;
  const actor = decision.waitingOn[0]
    ?? view.players.find((player) => player.id === view.activePlayerId);
  const activeName = view.players.find((player) => player.id === view.activePlayerId)?.displayName;
  const partyColor = actor === undefined ? undefined : PARTY_BY_ID.get(actor.partyId)?.color;
  const waitingOnMe = me !== null && decision.waitingOn.some((player) => player.id === me.id);

  return (
    <div
      ref={bar}
      className={[
        'status-bar',
        decision.waitingOn.length > 0 ? 'status-bar--waiting' : '',
        waitingOnMe ? 'status-bar--mine' : '',
      ].filter(Boolean).join(' ')}
      role="region"
      aria-label="Match status"
      style={partyColor === undefined ? undefined : ({ '--party': partyColor } as CSSProperties)}
    >
      <div className="status-bar__row">
        <p className="status-bar__turn">{turnLabel(view)}</p>

        <div className="status-bar__decision">
          {actor === undefined ? null : (
            <span className="status-bar__mark">
              <PartyMark partyId={actor.partyId} size={34} />
            </span>
          )}
          <div className="status-bar__words">
            <p className="status-bar__news">
              {thinking == null ? decision.news : `${seatLabel(thinking)} is thinking…`}
              {decision.awayFromActiveSeat && activeName !== undefined ? (
                <span className="status-bar__interrupt"> · still {activeName}’s turn</span>
              ) : null}
            </p>
            <p className="status-bar__detail" role="status" aria-live="polite">
              {decision.detail}
            </p>
          </div>
        </div>

        {me === null ? null : (
          <ul className="status-bar__resources" aria-label={`${me.displayName}’s resources`}>
            {RESOURCE_ORDER.map((resource) => (
              <li key={resource}>
                <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={22} height={22} />
                <span className="visually-hidden">{RESOURCE_ASSETS[resource].label} </span>
                {/* Keyed on the figure, so a count that changes mounts a fresh node and
                    the stylesheet's bump plays. Paying for something should be visible in
                    the bar that says what you hold. */}
                <span key={me.resources[resource]} className="status-bar__count">
                  {me.resources[resource]}
                </span>
              </li>
            ))}
            <li className="status-bar__cap" title="Resources held, of the most you may hold">
              {total}<span className="status-bar__cap-of">/{me.resourceCap}</span>
            </li>
          </ul>
        )}

        <div className="status-bar__end">
          <button
            type="button"
            className="button button--primary"
            disabled={!endTurn.can || endTurn.busy}
            aria-describedby={endTurn.reason === null ? undefined : 'end-turn-reason'}
            onClick={endTurn.onEndTurn}
          >
            End turn
          </button>
          {endTurn.reason === null ? null : (
            <span id="end-turn-reason" className="status-bar__reason" title={endTurn.reason}>
              {endTurn.reason}
            </span>
          )}
        </div>

        {switcher === undefined ? null : <div className="status-bar__switcher">{switcher}</div>}
        {settings === undefined ? null : <div className="status-bar__settings">{settings}</div>}
      </div>

      <div className="status-bar__steps">
        <TurnSteps view={view} />
      </div>
    </div>
  );
}
