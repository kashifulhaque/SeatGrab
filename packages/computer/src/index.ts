/**
 * The computer opponent.
 *
 * A computer seat reads exactly what a person at that seat is shown, its own `PlayerView`,
 * and submits commands the way a player does. This package depends on `@seatgrab/seat`,
 * `@seatgrab/protocol` and `@seatgrab/content` and deliberately not on `@seatgrab/engine`,
 * so it cannot read the authoritative state, apply a rule, or look up the reward of a
 * policy answer before committing to it. Difficulty comes from how well it uses public
 * information, and from nothing else.
 */
import type { ComputerDifficulty } from '@seatgrab/protocol';

export type { ComputerDifficulty, SeatController } from '@seatgrab/protocol';

export const COMPUTER_DIFFICULTIES: readonly {
  id: ComputerDifficulty;
  label: string;
  description: string;
}[] = [
  {
    id: 'easy',
    label: 'Easy',
    description: 'Buys the cheapest voters and spreads them around. Never uses powers or tricks.',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Goes for the cheapest majorities, uses its unlocked powers, and plays tricks that help itself.',
  },
  {
    id: 'hard',
    label: 'Hard',
    description: 'Plays to win: targets the leader, defends its majorities, and times the end of the game.',
  },
];

export function describeDifficulty(difficulty: ComputerDifficulty): string {
  return COMPUTER_DIFFICULTIES.find((entry) => entry.id === difficulty)?.label ?? difficulty;
}

export {
  affordablePayment,
  answerChoice,
  candidateCommands,
  chooseSlots,
  discardVector,
  enumerateActions,
  fillControl,
  placementSlots,
  shortfallOrder,
  type ActionCandidates,
  type LadderOptions,
  type Placement,
} from './enumerate.js';
export {
  WEIGHTS,
  afterConversion,
  afterMove,
  afterPlacement,
  afterRemoval,
  afterResources,
  evaluate,
  leadingRivalId,
  standings,
} from './evaluate.js';
export { placementScore, scoredSlots } from './policies/shared.js';
export { hashSeed, seededRandom, type Random } from './random.js';
export {
  decide,
  hasSomethingToDo,
  stepComputer,
  type ComputerRefusal,
  type ComputerStep,
  type ComputerTable,
} from './step.js';
