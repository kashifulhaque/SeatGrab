/**
 * The hard policy: plays to win. It targets the leader, defends its majorities, accepts a
 * fair trade, and times the end of the game.
 *
 * It shares the medium policy's shape and differs in its filters: every power and trick
 * with a positive evaluated value is on the table, Shakedown takes from the leader, Veto
 * answers the leader's beneficial cards, and the placement score carries the endgame
 * terms. See `shared.ts` for each filter, keyed on the level.
 */
import type { GameCommand, PlayerView } from '@seatgrab/protocol';

import type { Random } from '../random.js';
import { decideRanked } from './medium.js';

export function decideHard(view: PlayerView, seatId: string, random: Random): readonly GameCommand[] {
  return decideRanked(view, seatId, random, 'hard');
}
