/**
 * One computer seat, one accepted command.
 *
 * `hasSomethingToDo` reads a seat's own view and says whether the engine is waiting on
 * it. `decide` lists the commands the policy would try, best first. `stepComputer` tries
 * them through the table's `submit` and stops at the first the engine accepts, recording
 * every refusal on the way. A step that has every candidate refused is `stuck`, which is a
 * defect in the enumerator, a policy or a composer derivation, exactly as a stalled
 * autoplay run is: the driver surfaces it and does not retry on a timer.
 */
import type { CommandResponse, ComputerDifficulty, GameCommand, PlayerView } from '@seatgrab/protocol';

import { decideEasy } from './policies/easy.js';
import { decideHard } from './policies/hard.js';
import { decideMedium } from './policies/medium.js';
import { hashSeed, seededRandom } from './random.js';

/** True when this seat's own view says it has something to answer or do. */
export function hasSomethingToDo(view: PlayerView, seatId: string): boolean {
  if (view.status === 'finished') return false;
  if (view.prompt !== undefined) return true;
  if (view.activePlayerId === seatId && view.pendingDecision === undefined) return true;
  return (view.privateTradeOffers ?? []).some((offer) => offer.opponentId === seatId);
}

/**
 * Every command this seat would try now, best first.
 *
 * A pure function of the view: the tie-breaking generator is seeded from the match, the
 * revision, the seat and the difficulty, so the same position always decides the same way
 * and two matches at the same position need not.
 */
export function decide(view: PlayerView, seatId: string, difficulty: ComputerDifficulty): readonly GameCommand[] {
  const random = seededRandom(hashSeed(view.matchId, view.revision, seatId, difficulty));
  switch (difficulty) {
    case 'easy':
      return decideEasy(view, seatId, random);
    case 'medium':
      return decideMedium(view, seatId, random);
    case 'hard':
      return decideHard(view, seatId, random);
  }
}

/** The minimal table a driver hands the step function. Both transports satisfy it. */
export interface ComputerTable {
  view(seatId: string): PlayerView | null;
  submit(seatId: string, command: GameCommand): Promise<CommandResponse>;
}

export type ComputerRefusal = { command: GameCommand; code: string; message: string };

export type ComputerStep =
  | { kind: 'acted'; command: GameCommand; revision: number }
  | { kind: 'idle' }
  | { kind: 'stuck'; refusals: readonly ComputerRefusal[] };

/** One accepted command for one computer seat, or a report that none was accepted. */
export async function stepComputer(
  table: ComputerTable,
  seatId: string,
  difficulty: ComputerDifficulty,
): Promise<ComputerStep> {
  const view = table.view(seatId);
  if (view === null || !hasSomethingToDo(view, seatId)) return { kind: 'idle' };
  const refusals: ComputerRefusal[] = [];
  for (const command of decide(view, seatId, difficulty)) {
    const response = await table.submit(seatId, command);
    if (response.ok) return { kind: 'acted', command, revision: response.revision };
    refusals.push({ command, code: response.code, message: response.message });
  }
  return { kind: 'stuck', refusals };
}
