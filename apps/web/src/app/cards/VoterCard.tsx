/**
 * A voter card, drawn as a card.
 *
 * The face shows the voters as people — one, two or three silhouettes, large — over a
 * price strip of resource coins, because the two facts a buyer weighs are how many voters
 * and what they cost, and neither should have to be read. Everything drawn is also said:
 * the card's accessible name is "2 voters for 1 Cash, 1 Press", and a ribbon can carry
 * the affordability the market derives ("You can pay this", "Short by 1 Faith").
 *
 * The card is presentation only. It is handed the state to draw and never decides it;
 * `Market` reads `affordability` from the seat derivations and passes the result here.
 */
import type { Cost } from '@gerrymander/content';
import type { ReactNode } from 'react';

import { costToText } from '../CostIcons';

import { PriceStrip } from './PriceStrip';
import { VoterFigure } from './VoterFigure';

import './cards.css';

export type VoterCardState = 'can' | 'short' | 'discount' | 'open';
export type CardSize = 'sm' | 'md';

export function VoterCard({
  voters,
  cost,
  state,
  ribbon,
  footer,
  size = 'md',
  index = 0,
}: {
  voters: number;
  cost: Cost;
  state?: VoterCardState | undefined;
  /** A short line across the face: the affordability the market derived. */
  ribbon?: string | undefined;
  /** Drawn under the price, inside the frame: the market's Buy label. */
  footer?: ReactNode;
  size?: CardSize;
  /** Position in a row, for the staggered rise-in. */
  index?: number;
}) {
  const figures = Math.max(1, Math.min(3, voters));
  const label = `${voters} voter${voters === 1 ? '' : 's'} for ${costToText(cost)}`;
  return (
    <span
      className={[
        'card',
        'card--voter',
        `card--${size}`,
        state === undefined ? '' : `card--${state}`,
      ].filter(Boolean).join(' ')}
      role="group"
      aria-label={label}
      style={{ '--card-index': index } as React.CSSProperties}
    >
      <span className="card__face">
        <span className="card-voter__figures" aria-hidden="true" data-count={figures}>
          {Array.from({ length: figures }, (_unused, i) => (
            <VoterFigure key={i} size={size === 'sm' ? 30 : 42} />
          ))}
        </span>
        <span className="card-voter__count" aria-hidden="true">
          <strong>{voters}</strong>
          <span>voter{voters === 1 ? '' : 's'}</span>
        </span>
        {ribbon === undefined ? null : (
          <span className={`card-ribbon${state === 'can' ? ' card-ribbon--ok' : state === 'discount' ? ' card-ribbon--discount' : ' card-ribbon--short'}`}>
            {ribbon}
          </span>
        )}
        <span className="card-voter__price">
          <span className="card-voter__price-label" aria-hidden="true">Price</span>
          <PriceStrip cost={cost} size={size === 'sm' ? 16 : 18} />
        </span>
      </span>
      {footer === undefined ? null : <span className="card__footer">{footer}</span>}
    </span>
  );
}
