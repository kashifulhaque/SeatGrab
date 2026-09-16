/** Versioned identifiers and house rules for the SeatGrab core set. */

export const RULESET_ID = 'seatgrab-base';
export const RULESET_VERSION = '2.0.0';
export const CONTENT_PACK_ID = 'core-set';
export const CONTENT_PACK_VERSION = '2.0.0';
export const BOARD_ID = 'grid-nine';
export const BOARD_VERSION = '2.0.0';

/** A rule the digital game fixes where a table might otherwise argue. */
export interface HouseRule {
  id: `R${string}`;
  issue: string;
  ruling: string;
}

/** Every house rule the engine applies. The rules screen lists them before a match starts. */
export const HOUSE_RULES: readonly HouseRule[] = [
  {
    id: 'R01',
    issue: 'Moving voters between zones',
    ruling:
      'Redistricting rights in a zone let you move a voter between that zone and one of its '
      + 'neighbours, or between two of its neighbours that also touch each other. The legal '
      + 'moves are listed in the board definition.',
  },
  {
    id: 'R02',
    issue: 'Which voters count as the majority',
    ruling:
      'When you reach a zone’s threshold you mark exactly that many of your voters as the '
      + 'majority. Marks stay where they are. If a marked voter leaves and the majority '
      + 'survives, you mark only enough voters to fill the gap.',
  },
  {
    id: 'R03',
    issue: 'The Groundswell bonus voter',
    ruling:
      'The bonus voter joins the group from the voter card it came with and must be placed '
      + 'in the same zone before the turn ends.',
  },
  {
    id: 'R04',
    issue: 'The last turns of the game',
    ruling:
      'The turn that fills the last empty area is that player’s final turn. Every other '
      + 'player then takes one more turn in order. An area that empties later does not cancel '
      + 'or restart this.',
  },
  {
    id: 'R05',
    issue: 'What happens at the end of a turn, in order',
    ruling:
      'Finish the current action and anything it forces, offer the Turncoat move, resolve '
      + 'queued Breaking News cards in the order they were dealt, then check whether the game '
      + 'has ended.',
  },
  {
    id: 'R06',
    issue: 'A deck runs out',
    ruling:
      'Reshuffle only that deck’s discards; cards in hands, on the market or in play stay '
      + 'where they are. With no policy card you skip the answer reward but still take passive '
      + 'income. With no Breaking News card a volatile area does nothing. With no Dirty Trick '
      + 'left, buying one is unavailable.',
  },
  {
    id: 'R07',
    issue: 'The bank runs out',
    ruling:
      'The bank holds 30 of each resource and never creates more. A fixed grant pays what is '
      + 'left. A grant you choose from offers only what is left. Costs and transfers are paid '
      + 'exactly or refused.',
  },
  {
    id: 'R08',
    issue: 'Voter supply',
    ruling:
      'Each player has 50 voters. A discarded voter returns to its owner’s supply. '
      + 'Converting a voter returns it to its owner and takes one from your supply, so you '
      + 'cannot convert with an empty supply. Evicted and unplaced voters stay out of supply.',
  },
  {
    id: 'R09',
    issue: 'Redrawing the question',
    ruling: 'Pay any 4 resources to redraw the question. You may do this as often as you can pay.',
  },
  {
    id: 'R10',
    issue: 'Trades',
    ruling:
      'A trade must include at least one resource from each side. Dirty Trick cards may be '
      + 'added to a trade but cannot be the whole of it.',
  },
  {
    id: 'R11',
    issue: 'Who reacts first',
    ruling:
      'Reaction windows go around the table clockwise. Each eligible player acts or passes in '
      + 'turn; the order messages arrive in never decides.',
  },
  {
    id: 'R12',
    issue: 'Auctions',
    ruling:
      'Bids are whole numbers starting at the stated minimum and go clockwise. You cannot bid '
      + 'on your own card or above what you could cover. The winner pays what they hold and '
      + 'owes the rest as a debt.',
  },
  {
    id: 'R13',
    issue: 'A cost you cannot pay',
    ruling:
      'Each card says what happens when its cost cannot be paid. There is no general rule that '
      + 'skips a card for a poor player.',
  },
  {
    id: 'R14',
    issue: 'How long "next turn" lasts',
    ruling:
      '"Next turn" counts the affected player’s own completed turns. An effect with a count '
      + 'ticks down only on the action it names.',
  },
  {
    id: 'R15',
    issue: 'Turncoat',
    ruling:
      'Turncoat counts as one card on the archetype it sits under. Its buyout price is that '
      + 'archetype’s card count at the moment of purchase. Moving it changes unlocks at '
      + 'once but never pays income for turns already taken.',
  },
  {
    id: 'R16',
    issue: 'A card that names an exact number',
    ruling:
      'A card that names an exact number of targets needs that many legal targets unless it '
      + 'says "up to" or "any". A Dirty Trick without them is refused and stays in hand. A '
      + 'Breaking News card without them does nothing.',
  },
  {
    id: 'R17',
    issue: 'Dirty Trick prices',
    ruling:
      'Nine Dirty Tricks cost 5 and eleven cost 4. The cards that swing the whole board, run '
      + 'for the rest of the game, protect a majority or grant resources are the 5s. Cornerstone '
      + 'must cost 5 so that its 4-resource grant is never free.',
  },
];
