/**
 * One archetype's progress as a track.
 *
 * Five pips, filled for each policy card held, with the two powers marked at pips three
 * and five. The resource disc and the "pays N a turn" line say what the cards are worth
 * now; the markers say what the next card is worth. A player reads "two more to
 * Shakedown" from the track without arithmetic, which is the whole reason it is a track
 * and not a count.
 */
import { useEffect, useRef } from 'react';
import { ARCHETYPE_RESOURCE, type Archetype } from '@gerrymander/content';

import { RESOURCE_ASSETS } from '../../assets/manifest';

import { ARCHETYPE_LABELS, archetypeStyle } from './archetypes';
import { ResourceChip } from './ResourceChip';

import './cards.css';

const PIPS = [1, 2, 3, 4, 5] as const;

export function ArchetypeTrack({
  archetype,
  held,
  borrowed = 0,
  income,
  powers,
}: {
  archetype: Archetype;
  /** Effective cards on this archetype, Turncoat included. */
  held: number;
  /** How many of `held` are counted through Turncoat. */
  borrowed?: number;
  /** What this archetype pays each turn, in its own resource. */
  income: number;
  /** The level 3 and level 5 power names, in that order. */
  powers: readonly [string, string];
}) {
  const resource = ARCHETYPE_RESOURCE[archetype];
  const filled = Math.min(5, Math.max(0, held));
  const previous = useRef<{ archetype: Archetype; held: number; income: number } | null>(null);
  const was = previous.current?.archetype === archetype ? previous.current : null;
  const incomeRaised = was !== null && income > was.income;
  const powerUnlocked = was !== null && ((was.held < 3 && held >= 3) || (was.held < 5 && held >= 5));
  useEffect(() => {
    previous.current = { archetype, held, income };
  }, [archetype, held, income]);
  const nextLevel = held < 3 ? 3 : held < 5 ? 5 : null;
  const summary = `${ARCHETYPE_LABELS[archetype]}: ${held} of 5 card${held === 1 ? '' : 's'}`
    + (borrowed > 0 ? `, ${borrowed} through Turncoat` : '')
    + `; pays ${income} ${RESOURCE_ASSETS[resource].label} a turn`
    + (nextLevel === null ? '; both powers unlocked.' : `; ${nextLevel - held} more for ${powers[nextLevel === 3 ? 0 : 1]}.`);
  return (
    <div
      className={[
        'card-track',
        incomeRaised ? 'card-track--income-raised' : '',
        powerUnlocked ? 'card-track--power-unlocked' : '',
      ].filter(Boolean).join(' ')}
      style={archetypeStyle(archetype) as React.CSSProperties}
      role="group"
      aria-label={summary}
    >
      <div className="card-track__head" aria-hidden="true">
        <ResourceChip resource={resource} size="sm" label="" />
        <span className="card-track__name">{ARCHETYPE_LABELS[archetype]}</span>
        <span className="card-track__count">
          <strong>{held}</strong>/5
        </span>
      </div>
      <ol className="card-track__pips" aria-hidden="true">
        {PIPS.map((pip) => {
          const marker = pip === 3 ? powers[0] : pip === 5 ? powers[1] : null;
          const isBorrowed = pip > held - borrowed && pip <= held;
          return (
            <li
              key={pip}
              className={[
                'card-track__pip',
                pip <= filled ? 'card-track__pip--filled' : '',
                was !== null && pip > was.held && pip <= filled ? 'card-track__pip--new' : '',
                isBorrowed ? 'card-track__pip--borrowed' : '',
                marker === null ? '' : 'card-track__pip--marker',
                marker !== null && pip <= filled ? 'card-track__pip--unlocked' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="card-track__dot">{marker === null ? '' : pip}</span>
              {marker === null ? null : <span className="card-track__marker">{marker}</span>}
            </li>
          );
        })}
      </ol>
      <p className="card-track__pays" aria-hidden="true">
        Pays <strong>{income}</strong> {RESOURCE_ASSETS[resource].label} a turn
        {borrowed > 0 ? ` · ${borrowed} through Turncoat` : ''}
      </p>
    </div>
  );
}
