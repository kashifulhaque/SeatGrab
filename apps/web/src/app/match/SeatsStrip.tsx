/**
 * Every seat as one chip: emblem, name, the score, and a word when a computer plays it.
 *
 * The strip sits against the board's edge so the board, the seats and the actions share
 * one screen. The number on the chip is the one that wins — voters counted in a
 * majority — and the rest of what the old seat rows printed opens under the chip on a
 * tap, so a table that wants the numbers still has them without giving the roster a
 * column of its own.
 *
 * Who is acting is shown three ways at once, none of them colour alone: the acting chip
 * carries a pulsing ring, the word "To act" or "Their turn", and its `aria-current`. A
 * computer seat is marked in words, and `match-shell.test.tsx` counts those words: the
 * badge keeps the `seat-row__badge` class and the exact text "computer".
 *
 * Everything here is public. The strip takes the public projection and never a seat's own.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import type { PlayerView } from '@gerrymander/protocol';

import { PARTY_BY_ID, RESOURCE_ASSETS } from '../../assets/manifest';
import { PartyMark } from '../PartyMark';
import { marksComputer, type PlayerSummary } from '../table';

const RESOURCE_ORDER = ['cash', 'influence', 'press', 'faith'] as const;

function SeatChip({
  summary,
  mine,
  open,
  onToggle,
  acted,
  actedKey,
}: {
  summary: PlayerSummary;
  /** True for the revealed seat, which reads its own chip as "you". */
  mine: boolean;
  open: boolean;
  onToggle: () => void;
  /** True when this seat produced the most recent public event. */
  acted: boolean;
  actedKey: number;
}) {
  const { player } = summary;
  const party = PARTY_BY_ID.get(player.partyId);
  const state = summary.deciding
    ? mine ? 'You act' : 'To act'
    : summary.active
      ? mine ? 'Your turn' : 'Their turn'
      : null;
  const popId = `ms-chip-pop-${player.id}`;
  return (
    <li
      className={[
        'ms-chip',
        summary.deciding ? 'ms-chip--acting' : '',
        summary.active ? 'ms-chip--turn' : '',
        open ? 'ms-chip--open' : '',
      ].filter(Boolean).join(' ')}
      style={party === undefined ? undefined : ({ '--party': party.color } as CSSProperties)}
      aria-current={summary.deciding ? 'true' : undefined}
    >
      <button
        type="button"
        className="ms-chip__button"
        aria-expanded={open}
        aria-controls={popId}
        onClick={onToggle}
      >
        {acted ? <span key={actedKey} className="ms-chip__flash" aria-hidden="true" /> : null}
        <span className="ms-chip__mark">
          <PartyMark partyId={player.partyId} size={28} />
        </span>
        <span className="ms-chip__text">
          <span className="ms-chip__name">{player.displayName}</span>
          <span className="ms-chip__tags">
            {marksComputer(player) ? <span className="seat-row__badge ms-chip__badge">computer</span> : null}
            {state === null ? null : (
              <span className={`ms-chip__state${summary.deciding ? ' ms-chip__state--acting' : ''}`}>
                {state}
              </span>
            )}
          </span>
        </span>
        <span className="ms-chip__score" title="Majority voters: the score">
          <strong key={summary.majorityVoters} className="ms-chip__score-num">{summary.majorityVoters}</strong>
          <span className="visually-hidden"> majority voter{summary.majorityVoters === 1 ? '' : 's'}</span>
        </span>
      </button>
      <div id={popId} className="ms-chip__pop" hidden={!open} role="region" aria-label={`${player.displayName}, details`}>
        <dl className="ms-chip__facts">
          <div>
            <dt>Seat</dt>
            <dd>{player.seat + 1}</dd>
          </div>
          <div>
            <dt>On board</dt>
            <dd>{summary.boardVoters}</dd>
          </div>
          <div>
            <dt>Zones held</dt>
            <dd>{summary.zonesLed.length === 0 ? 'none' : summary.zonesLed.join(', ')}</dd>
          </div>
          <div>
            <dt>Tricks</dt>
            <dd>{player.trickHandCount}</dd>
          </div>
          {summary.zonesWithRights.length === 0 ? null : (
            <div>
              <dt>Rights</dt>
              <dd>{summary.zonesWithRights.join(', ')}</dd>
            </div>
          )}
        </dl>
        <p className="ms-chip__resources" aria-label={`${player.displayName}’s resources`}>
          {RESOURCE_ORDER.map((resource) => (
            <span key={resource}>
              <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={16} height={16} />
              <span className="visually-hidden">{RESOURCE_ASSETS[resource].label} </span>
              {player.resources[resource]}
            </span>
          ))}
          <span className="ms-chip__cap">{summary.resourceTotal}/{player.resourceCap}</span>
        </p>
        <p className="ms-chip__policy">
          Policy cards — corporate {player.policyCounts.corporate}, nationalist{' '}
          {player.policyCounts.nationalist}, populist {player.policyCounts.populist}, reformer{' '}
          {player.policyCounts.reformer}.
        </p>
      </div>
    </li>
  );
}

export function SeatsStrip({
  view,
  players,
  meId,
}: {
  view: PlayerView;
  players: readonly PlayerSummary[];
  /** The revealed seat, or `null` on the shared surface. Only the wording changes. */
  meId: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // The seat that just acted flashes once. The last public event names it, and the
  // history length is the key that replays the flash for the next one.
  const last = view.history[view.history.length - 1];
  const actedId = last?.actorId ?? null;
  const actedKey = view.history.length;

  // Escape closes an open chip, from anywhere in the strip.
  useEffect(() => {
    if (openId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openId]);

  return (
    <div className="ms-seats" data-coach-anchor="seats">
      <ul className="ms-seats__list" aria-label="Seats">
        {players.map((summary) => (
          <SeatChip
            key={summary.player.id}
            summary={summary}
            mine={summary.player.id === meId}
            open={openId === summary.player.id}
            onToggle={() => setOpenId((current) => (current === summary.player.id ? null : summary.player.id))}
            acted={actedId === summary.player.id}
            actedKey={actedKey}
          />
        ))}
      </ul>
    </div>
  );
}
