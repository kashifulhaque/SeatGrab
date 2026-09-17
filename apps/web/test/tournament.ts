/**
 * The three difficulties played against each other, reported as wins.
 *
 * This is a measuring instrument, not a test. The acceptance criterion for the
 * difficulties is an ordering — hard beats medium beats easy over a run of games — and an
 * ordering is not something to assert in a unit test, because a policy change that is an
 * improvement on balance can lose a particular seeded game. So this prints the figures
 * and the session record carries them.
 *
 *     pnpm tsx apps/web/test/tournament.ts [games] [seed-offset]
 *
 * Sixty seeded three-player games by default, one seat per difficulty. The seating is
 * rotated every game so a difficulty is not always `p1`: seat order decides who votes
 * first and who acts first, and a tournament that never rotated would measure the seat as
 * much as the policy.
 */
import { CORE_CONTENT, type GameConfig } from '@gerrymander/engine';
import type { ComputerDifficulty } from '@gerrymander/protocol';

import { createLocalMatch, createMemoryStore, type LocalMatchOptions } from '../src/local';
import { playComputers } from './computerPlay';

const PARTIES = ['kite', 'cog', 'sprout'] as const;
const NAMES = ['Asha', 'Bikram', 'Chandni'] as const;
const LEVELS: readonly ComputerDifficulty[] = ['easy', 'medium', 'hard'];

function options(): LocalMatchOptions {
  let tick = 0;
  return {
    store: createMemoryStore(),
    content: CORE_CONTENT,
    now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000),
  };
}

function config(matchId: string): GameConfig {
  return {
    matchId,
    players: [0, 1, 2].map((index) => ({
      id: `p${index + 1}`,
      displayName: NAMES[index]!,
      partyId: PARTIES[index]!,
    })),
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

/** One difficulty per seat, rotated by `game` so each one takes every seat in turn. */
export function seatingFor(game: number): Readonly<Record<string, ComputerDifficulty>> {
  const seats: Record<string, ComputerDifficulty> = {};
  for (let index = 0; index < 3; index += 1) {
    seats[`p${index + 1}`] = LEVELS[(index + game) % LEVELS.length]!;
  }
  return seats;
}

export async function tournament(): Promise<void> {
  const games = Number(process.argv[2] ?? '60');
  const seedOffset = Number(process.argv[3] ?? '0');

  const wins = new Map<ComputerDifficulty, number>();
  const shared = new Map<ComputerDifficulty, number>();
  const points = new Map<ComputerDifficulty, number>();
  let finished = 0;
  let refusals = 0;
  const stalls: string[] = [];

  for (let game = 0; game < games; game += 1) {
    const seed = 1 + seedOffset + game * 2731;
    const seats = seatingFor(game);
    const match = await createLocalMatch(options(), config(`tournament-${seed}`), seed);
    // Well above the ~650 steps a finished three-player game takes, and low enough that a
    // match which cannot reach an ending is reported in seconds rather than ground through.
    const result = await playComputers(match, seats, { maxSteps: 3000 });

    refusals += result.refusals.length;
    if (result.stalled !== undefined) {
      stalls.push(`seed ${seed}: ${result.stalled.slice(0, 400)}`);
      continue;
    }
    finished += 1;

    const winners = result.view.winners ?? [];
    for (const seatId of Object.keys(seats)) {
      const level = seats[seatId]!;
      points.set(level, (points.get(level) ?? 0) + (result.view.finalScores?.[seatId] ?? 0));
      if (!winners.includes(seatId)) continue;
      wins.set(level, (wins.get(level) ?? 0) + 1);
      if (winners.length > 1) shared.set(level, (shared.get(level) ?? 0) + 1);
    }
  }

  process.stdout.write(`${finished} of ${games} games finished, ${refusals} refusals\n\n`);
  process.stdout.write('difficulty   wins   of which shared   total score\n');
  for (const level of LEVELS) {
    process.stdout.write(
      `${level.padEnd(11)}${String(wins.get(level) ?? 0).padStart(5)}`
      + `${String(shared.get(level) ?? 0).padStart(18)}`
      + `${String(points.get(level) ?? 0).padStart(14)}\n`,
    );
  }
  for (const stall of stalls.slice(0, 5)) process.stdout.write(`\nSTALL ${stall}\n`);
}

// Only when this file is the entry point, so importing the helpers runs no games.
if (process.argv[1] !== undefined && process.argv[1].endsWith('tournament.ts')) {
  await tournament();
}
