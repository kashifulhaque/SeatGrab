/**
 * The three face-up voter cards, drawn once.
 *
 * Section 13.4 wants them visible without opening anything, and the first playtest found
 * them drawn twice: once on the shared surface, and again far below as a purchase list,
 * where only the far copy acted. This is the one drawing. On the shared surface it is
 * read-only; in a revealed seat's action column each card is the purchase button, and the
 * reason a purchase is not on offer is written once beside the list rather than on every
 * card.
 *
 * A buyable card says, before it is opened, whether the seat can pay for it, in the
 * plainest words available: "You can pay this", or "Need 1 more Faith". The second
 * playtest opened cards it could not afford and met the shortfall only inside the
 * composer. The arithmetic is `affordability` in `actions.ts`; the card only prints it.
 * The button stays enabled either way, because Volunteers or a trade may still make
 * the purchase possible and the engine is the one that refuses.
 */
import type { PlayerView } from '@gerrymander/protocol';

import { CostIcons } from './CostIcons';
import { NO_RESOURCES, affordability, volunteersRemaining, purchaseCost } from './actions';

/** `Short 1 Faith.` from the derivation, said as a gap: `Short by 1 Faith`. */
function needed(short: string): string {
  return `Short by ${short.replace(/^Short\s+/, '').replace(/\.$/, '')}`;
}

export function Market({
  view,
  buy,
}: {
  view: PlayerView;
  /** Present when the viewer may compose a purchase. Absent draws the market read-only. */
  buy?: {
    /** The seat buying, whose holding the affordability note is read against. */
    seatId: string;
    can: boolean;
    busy: boolean;
    /** The card whose purchase is open, so its button reads as pressed. */
    openCardId: string | null;
    onBuy: (cardId: string) => void;
    /** Element that says why buying is off, for `aria-describedby`. */
    reasonId?: string;
  };
}) {
  if (view.voterCards.length === 0) return <p>No voter card is face up.</p>;
  const held = buy === undefined
    ? null
    : view.players.find((player) => player.id === buy.seatId)?.resources ?? NO_RESOURCES;
  const discount = buy === undefined ? 0 : volunteersRemaining(view, buy.seatId);
  return (
    <ul className={`market${buy === undefined ? '' : ' market--buyable'}`} aria-label="Voter market">
      {view.voterCards.map((card) => {
        const cost = buy === undefined ? card.cost : purchaseCost(view, buy.seatId, card.id) ?? card.cost;
        const afford = held === null ? null : affordability(cost, held, discount);
        const open = buy?.openCardId === card.id;
        const state = afford === null
          ? ''
          : afford.short === null
            ? ' market__card--can'
            : afford.viaDiscount
              ? ' market__card--discount'
              : ' market__card--short';
        return (
          <li key={card.id} className={`market__card${open ? ' market__card--open' : ''}${state}`}>
            <p className="market__yield">
              <strong>{card.voters}</strong>
              <span>voter{card.voters === 1 ? '' : 's'}</span>
            </p>
            <div className="market__price">
              <span className="market__price-label">Price</span>
              <CostIcons cost={card.cost} />
            </div>
            {afford === null || !buy?.can ? null : (
              <p className={`market__afford${afford.can ? ' market__afford--ok' : ' market__afford--short'}`}>
                {afford.short === null
                  ? 'You can pay this'
                  : afford.viaDiscount
                    ? `${needed(afford.short)} — Volunteers can cover it`
                    : needed(afford.short)}
              </p>
            )}
            {buy === undefined ? null : (
              <button
                type="button"
                className={`button ${open ? 'button--primary' : ''}`}
                disabled={buy.busy || !buy.can}
                aria-pressed={open}
                aria-describedby={buy.can || buy.reasonId === undefined ? undefined : buy.reasonId}
                onClick={() => buy.onBuy(card.id)}
              >
                {open ? 'Buying…' : 'Buy'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
