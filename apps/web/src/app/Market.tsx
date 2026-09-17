/**
 * The three face-up voter cards, drawn once, as cards.
 *
 * They are visible without opening anything, and they are drawn in exactly one place: on
 * the shared surface read-only, and in a revealed seat's action column as the purchase
 * controls. There the whole card is the button, because a card is what a player reaches
 * for at a table, and the reason a purchase is off is written once beside the list rather
 * than on every card.
 *
 * A buyable card says, before it is opened, whether the seat can pay for it, in the
 * plainest words available on a ribbon across its face: "You can pay this", or "Short by
 * 1 Faith". The arithmetic is `affordability` in `actions.ts`; the card only prints it.
 * The button stays enabled either way, because Volunteers or a trade may still make the
 * purchase possible and the engine is the one that refuses.
 */
import type { PlayerView } from '@gerrymander/protocol';

import { NO_RESOURCES, affordability, volunteersRemaining, purchaseCost } from './actions';
import { VoterCard, type VoterCardState } from './cards/VoterCard';

import './cards/cards.css';

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
    <ul className={`card-market${buy === undefined ? '' : ' card-market--buyable'}`} aria-label="Voter market">
      {view.voterCards.map((card, index) => {
        const cost = buy === undefined ? card.cost : purchaseCost(view, buy.seatId, card.id) ?? card.cost;
        const afford = held === null ? null : affordability(cost, held, discount);
        const open = buy?.openCardId === card.id;
        const state: VoterCardState | undefined = open
          ? 'open'
          : afford === null || !buy?.can
            ? undefined
            : afford.short === null
              ? 'can'
              : afford.viaDiscount
                ? 'discount'
                : 'short';
        const ribbon = afford === null || !buy?.can
          ? undefined
          : afford.short === null
            ? 'You can pay this'
            : afford.viaDiscount
              ? `${needed(afford.short)} — Volunteers can cover it`
              : needed(afford.short);
        const drawn = (
          <VoterCard
            voters={card.voters}
            cost={card.cost}
            state={state}
            ribbon={ribbon}
            index={index}
            footer={buy === undefined ? undefined : (open ? 'Buying…' : 'Buy')}
          />
        );
        return (
          <li key={card.id} className="card-market__item">
            {buy === undefined ? drawn : (
              <button
                type="button"
                className="card-market__buy"
                disabled={buy.busy || !buy.can}
                aria-pressed={open}
                aria-describedby={buy.can || buy.reasonId === undefined ? undefined : buy.reasonId}
                onClick={() => buy.onBuy(card.id)}
              >
                {drawn}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
