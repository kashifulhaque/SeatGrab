/**
 * A Dirty Trick card, face up or face down.
 *
 * Face down is the back everyone can see: a navy pattern, the amber emblem and the price
 * in large type, because a trick is bought off the top of the pile for the price on its
 * back. Face up is the title band, the rules and, smaller and in italics, the flavour
 * line. When `face` turns from down to up the card flips about its vertical axis.
 *
 * The front is not in the DOM while the card is face down. A face-down card in the market
 * is a card nobody has seen, and a title that was merely hidden by CSS would still be
 * text on the page.
 */
import type { Cost } from '@gerrymander/content';

import { RESOURCE_ASSETS } from '../../assets/manifest';

import type { CardSize } from './VoterCard';

import './cards.css';

/** The amber emblem on the back: a ballot slipping into a box. Original, decorative. */
function BackEmblem() {
  return (
    <svg className="card-trick__emblem" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
      <path d="M13 26h22v10H13Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M17 26v-2h14v2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M19.5 22 26 10.5l4.5 2.6L24 24.5Z" fill="currentColor" />
      <path d="M21 29.5h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function backPrice(backCost: Cost | number | undefined): number | null {
  if (backCost === undefined) return null;
  if (typeof backCost === 'number') return backCost;
  return backCost.cash + backCost.influence + backCost.press + backCost.faith + backCost.generic;
}

export function TrickCard({
  title,
  rulesText,
  flavorText,
  face,
  backCost,
  size = 'md',
  index = 0,
  /** Names the pile, for a face-down card: `Dirty Trick, top of the pile, price 4`. */
  backLabel,
}: {
  title: string;
  rulesText: string;
  flavorText?: string | undefined;
  face: 'up' | 'down';
  /** The price printed on the back, as the content pack's cost or a plain total. */
  backCost?: Cost | number | undefined;
  size?: CardSize;
  index?: number;
  backLabel?: string | undefined;
}) {
  const price = backPrice(backCost);
  const lines = rulesText.split('\n');
  const label = face === 'up'
    ? `Dirty Trick: ${title}`
    : backLabel ?? (price === null ? 'Dirty Trick, face down' : `Dirty Trick, face down, price ${price} of any resource`);
  return (
    <span
      className={`card card--trick card--${size} card--${face}`}
      role="group"
      aria-label={label}
      style={{ '--card-index': index } as React.CSSProperties}
    >
      <span className="card-trick__flipper">
        <span className="card__face card-trick__front" aria-hidden={face === 'down'}>
          {face === 'down' ? null : (
            <>
              <span className="card__band">
                <span className="card__eyebrow">Dirty Trick</span>
                <span className="card__title">{title}</span>
              </span>
              <span className="card-trick__rules">
                {lines.map((line, i) => (
                  line.trim() === 'OR'
                    ? <span key={i} className="card-trick__or">or</span>
                    : <span key={i} className="card-trick__line">{line}</span>
                ))}
              </span>
              {flavorText === undefined ? null : (
                <span className="card-trick__flavor">{flavorText}</span>
              )}
            </>
          )}
        </span>
        <span className="card__face card-trick__back" aria-hidden={face === 'up'}>
          <span className="card-trick__pattern" />
          <span className="card-trick__back-body">
            <BackEmblem />
            <span className="card-trick__back-title">Dirty Trick</span>
            {price === null ? null : (
              <span className="card-trick__back-price">
                <img src={RESOURCE_ASSETS.generic.url} alt="" width={22} height={22} />
                <strong>{price}</strong>
                <span>any {price}</span>
              </span>
            )}
          </span>
        </span>
      </span>
    </span>
  );
}
