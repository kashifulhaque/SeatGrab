/**
 * The slim bar that stays put for the whole match.
 *
 * It answers two questions and holds two controls, left to right: which turn it is, who
 * must act and what they are doing, the revealed seat's resources, and the menu. That is
 * all. The earlier bar also carried End turn, the seat controls, the computer pace and a
 * row of turn steps, and a first-time player read it as the busiest thing on the screen.
 * End turn and the step now live in the action sheet's header, beside the thing they are
 * about; everything else is behind **Menu**.
 *
 * Two privacy rules hold here and are asserted by `match-shell.test.tsx`:
 *
 * - Everything but the resources comes from the public projection. `describeDecision`
 *   reads `pendingDecision.summary`, which the engine writes about what a player must do
 *   and never about what only that player may see.
 * - The resources are drawn only for `me`, which the caller sets to the revealed seat and
 *   to nothing on the shared surface. Resource counts are public, but this bar says
 *   "your", so it must never name another seat's.
 *
 * The bar measures itself into `--bar-h` so the sheet and the docked columns below can
 * sit under it whatever it wraps to. Nothing reads the measurement for a rule.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import type { PlayerView, PublicPlayerView } from '@gerrymander/protocol';

import { PARTY_BY_ID } from '../assets/manifest';

import { PartyMark } from './PartyMark';
import { ResourceCoins } from './match/ResourceCoins';
import { describeDecision, describeDecisionFor, seatLabel } from './table';

/** `Turn 4`, `Setup` or `Final`. */
export function turnLabel(view: PlayerView): string {
  if (view.status === 'finished') return 'Final';
  if (view.status === 'setup' || view.turnOrdinal === 0) return 'Setup';
  return `Turn ${view.turnOrdinal}`;
}

export function StatusBar({
  view,
  me,
  thinking = null,
  menu,
}: {
  view: PlayerView;
  /** The revealed seat, whose resources are drawn. `null` draws none. */
  me: PublicPlayerView | null;
  /**
   * The computer seat about to act, or `null`.
   *
   * It replaces the decision line while it is set, because "Devi (computer) is thinking…"
   * is the one thing a person watching wants to know, and the line underneath would
   * otherwise read as though the table were waiting on them.
   */
  thinking?: PublicPlayerView | null;
  /** The menu control and its drawer. */
  menu?: ReactNode;
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
  const actor = thinking
    ?? decision.waitingOn[0]
    ?? view.players.find((player) => player.id === view.activePlayerId);
  const partyColor = actor === undefined ? undefined : PARTY_BY_ID.get(actor.partyId)?.color;
  const waitingOnMe = me !== null && decision.waitingOn.some((player) => player.id === me.id);
  const news = thinking !== null
    ? `${seatLabel(thinking)} is thinking…`
    : view.status === 'finished'
      ? 'Match finished'
      : decision.waitingOn.length > 0
        ? waitingOnMe ? 'Your move' : actor === undefined ? 'Waiting for a player' : `${seatLabel(actor)} must act`
        : actor === undefined ? 'Between turns' : `${seatLabel(actor)} is acting`;

  return (
    <div
      ref={bar}
      className={[
        'status-bar',
        'ms-bar',
        decision.waitingOn.length > 0 ? 'ms-bar--waiting' : '',
        waitingOnMe ? 'ms-bar--mine' : '',
        thinking == null ? '' : 'ms-bar--thinking',
      ].filter(Boolean).join(' ')}
      role="region"
      aria-label="Match status"
      data-coach-anchor="top-bar"
      style={partyColor === undefined ? undefined : ({ '--party': partyColor } as CSSProperties)}
    >
      <p className="ms-bar__turn">{turnLabel(view)}</p>

      <div className="ms-bar__who">
        {actor === undefined ? null : (
          <span className="ms-bar__mark">
            <PartyMark partyId={actor.partyId} size={28} />
          </span>
        )}
        {/* Keyed on the text, so a change crossfades rather than cutting. */}
        <p key={news} className="ms-bar__news" role="status" aria-live="polite">
          <span className="ms-bar__news-text">{news}</span>
          {thinking == null ? null : (
            <span className="ms-dots" aria-hidden="true">
              <i /><i /><i />
            </span>
          )}
        </p>
      </div>

      {me === null ? null : <ResourceCoins me={me} />}

      {menu === undefined ? null : <div className="ms-bar__menu">{menu}</div>}
    </div>
  );
}
