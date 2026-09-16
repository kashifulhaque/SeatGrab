/**
 * Who plays a seat.
 *
 * A seat is held by a person or by the computer, and the choice is fixed when the match
 * is created, like the seat's party. Both fields are additive and optional everywhere
 * they are stored, so a save or a snapshot written before they existed reads every seat
 * as `human`. They are published on every `PublicPlayerView`, because who is playing a
 * seat is a public fact at any table.
 */
import { z } from 'zod';

export const SEAT_CONTROLLERS = ['human', 'computer'] as const;
export type SeatController = (typeof SEAT_CONTROLLERS)[number];

export const COMPUTER_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type ComputerDifficulty = (typeof COMPUTER_DIFFICULTIES)[number];
export const ComputerDifficultySchema = z.enum(COMPUTER_DIFFICULTIES);

export function isComputerDifficulty(value: unknown): value is ComputerDifficulty {
  return typeof value === 'string' && (COMPUTER_DIFFICULTIES as readonly string[]).includes(value);
}
