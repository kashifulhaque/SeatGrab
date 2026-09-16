/**
 * What this build ships, read from the content pack rather than written down.
 *
 * The home, lobby and rules screens name the exact content pack and the supported player
 * counts. Every figure below is derived, so a regenerated content pack moves the screens
 * with it instead of leaving a stale number behind.
 */
import {
  BOARD_ID,
  BOARD_VERSION,
  CONTENT_PACK_ID,
  CONTENT_PACK_VERSION,
  HOUSE_RULES,
  RULESET_ID,
  RULESET_VERSION,
} from '@seatgrab/content';
import { ENGINE_VERSION, GAME_SCHEMA_VERSION, CORE_CONTENT } from '@seatgrab/engine';

import { MAX_SEATS, MIN_SEATS } from './setup';

/** The one content pack this build installs. There is no second pack to choose between. */
export const INSTALLED_CAMPAIGN = {
  contentPackId: CONTENT_PACK_ID,
  contentVersion: CONTENT_PACK_VERSION,
  rulesetId: RULESET_ID,
  rulesetVersion: RULESET_VERSION,
  boardId: BOARD_ID,
  boardVersion: BOARD_VERSION,
  engineVersion: ENGINE_VERSION,
  schemaVersion: GAME_SCHEMA_VERSION,
  displayName: 'SeatGrab core set',
} as const;

export const DECK_SIZES = {
  voter: CORE_CONTENT.voterCards.length,
  policy: CORE_CONTENT.policyCards.length,
  news: CORE_CONTENT.newsCards.length,
  trick: CORE_CONTENT.trickCards.length,
  zones: CORE_CONTENT.board.zones.length,
  slots: CORE_CONTENT.board.slots.length,
} as const;

/** The distinct Dirty Trick prices in the pack, ascending. */
export const BACK_COST_VALUES: readonly number[] = [
  ...new Set(
    CORE_CONTENT.trickCards
      .map((card) => card.backCost?.generic)
      .filter((value): value is number => value !== undefined),
  ),
].sort((a, b) => a - b);

/**
 * The limits the lobby and the rules screen both show, stated before a table commits to a
 * match rather than discovered when a command is refused mid-game.
 */
export const KNOWN_LIMITS: readonly { title: string; detail: string }[] = [
  {
    title: 'Two players is not offered',
    detail:
      `This set seats ${MIN_SEATS} to ${MAX_SEATS}. A two-player game needs a smaller board `
      + 'and its own card set, which this build does not include.',
  },
  {
    title: 'Ties are joint wins',
    detail:
      'Players tied on majority voters all win. No tiebreaker on resources, zones or total '
      + 'voters is applied.',
  },
];

/** The house rules the engine applies, listed for players before a match starts. */
export const ADJUDICATIONS = HOUSE_RULES;
