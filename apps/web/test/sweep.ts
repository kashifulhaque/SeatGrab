/**
 * A sweep driver: many seeded autoplay games, reported as a completion rate.
 *
 * This is a measuring instrument, not a test. `full-game.test.ts` holds the fixed seeds
 * that must keep passing; this runs far more of them so a stall class shows up as a
 * population rather than as one unlucky game. It is how the A18 audit was measured, and
 * it is the thing to run after changing a guard — a guard that is wrong the loose way
 * deadlocks a match, and a guard that is wrong the strict way swallows a live card, and
 * neither shows up in one game.
 *
 *     pnpm tsx apps/web/test/sweep.ts [games-per-combination] [seed-offset]
 *
 * Every combination of 3, 4 and 5 players with both placement strategies is played,
 * so the game count is six times the first argument. The offset shifts the seed series,
 * so a second run is a fresh sample rather than a rerun.
 */
import { CORE_CONTENT, type GameConfig } from '@seatgrab/engine';

import { createLocalMatch, createMemoryStore, type LocalMatchOptions } from '../src/local';
import { autoplay, type AutoplayResult } from './autoplay';

const PARTIES = ['kite', 'cog', 'sprout', 'lantern', 'compass'] as const;
const NAMES = ['Asha', 'Bikram', 'Chandni', 'Devi', 'Ejaz'] as const;

export type Placement = 'concentrate' | 'spread';

export function sweepConfig(matchId: string, playerCount: number): GameConfig {
  return {
    matchId,
    players: Array.from({ length: playerCount }, (_unused, index) => ({
      id: `p${index + 1}`,
      displayName: NAMES[index] ?? `Seat ${index + 1}`,
      partyId: PARTIES[index] ?? 'kite',
    })),
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

function options(): LocalMatchOptions {
  let tick = 0;
  return {
    store: createMemoryStore(),
    content: CORE_CONTENT,
    now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000),
  };
}

export async function playOne(
  playerCount: number,
  seed: number,
  placement: Placement,
  // Raised well above the roughly 350 steps a finished game takes, so a run that trips
  // it is a livelock rather than a slow game — the two are indistinguishable at a low
  // ceiling, which is what left Session 16 unable to diagnose two of its stalls.
  maxSteps = 40000,
): Promise<AutoplayResult> {
  const settings = sweepConfig(`sweep-${playerCount}-${seed}-${placement}`, playerCount);
  const match = await createLocalMatch(options(), settings, seed);
  return autoplay(match, settings.players.map((player) => player.id), { placement, maxSteps });
}

interface Stall {
  players: number;
  seed: number;
  placement: Placement;
  reason: string;
  steps: number;
}

/** A stable key for a stall reason, so a population can be counted by cause. */
function stallClass(reason: string): string {
  return reason
    .replace(/\bp\d+\b/g, 'pN')
    .replace(/\b\d+\b/g, 'N')
    .split('\n')
    .slice(0, 2)
    .join(' | ')
    .slice(0, 160);
}

export async function sweep(): Promise<void> {
  const perCombination = Number(process.argv[2] ?? '40');
  const seedOffset = Number(process.argv[3] ?? '0');
  const placements: readonly Placement[] = ['concentrate', 'spread'];
  const counts = [3, 4, 5];
  // A fixed spread of seeds so a sweep is reproducible and a stall can be replayed.
  const seeds = Array.from({ length: perCombination }, (_unused, index) => 1 + seedOffset + index * 2731);

  const stalls: Stall[] = [];
  let played = 0;
  let finished = 0;
  let refused = 0;
  let longest = 0;
  const refusalCodes = new Map<string, number>();

  for (const players of counts) {
    for (const placement of placements) {
      for (const seed of seeds) {
        const result = await playOne(players, seed, placement);
        played += 1;
        if (result.finished) finished += 1;
        refused += result.steps.filter((step) => !step.accepted).length;
        longest = Math.max(longest, result.steps.length);
        for (const step of result.steps) {
          if (step.accepted) continue;
          const key = `${step.code}: ${(step.message ?? '').replace(/\bp\d+\b/g, 'pN').replace(/\b\d+\b/g, 'N')}`;
          refusalCodes.set(key, (refusalCodes.get(key) ?? 0) + 1);
        }
        if (result.stalled !== undefined) {
          stalls.push({
            players,
            seed,
            placement,
            reason: result.stalled,
            steps: result.steps.length,
          });
        }
      }
      process.stdout.write(`${players}p ${placement}: ${finished}/${played}\n`);
    }
  }

  process.stdout.write(`\nplayed ${played}, finished ${finished} (${((finished / played) * 100).toFixed(1)}%), refused commands ${refused}, longest run ${longest} steps\n`);
  if (refusalCodes.size > 0) {
    process.stdout.write('\nrefusals the driver worked around:\n');
    for (const [key, count] of [...refusalCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      process.stdout.write(`  ${String(count).padStart(6)}  ${key}\n`);
    }
  }
  if (stalls.length === 0) {
    return;
  }
  const byClass = new Map<string, Stall[]>();
  for (const stall of stalls) {
    const key = stallClass(stall.reason);
    byClass.set(key, [...(byClass.get(key) ?? []), stall]);
  }
  process.stdout.write(`\n${stalls.length} stalls in ${byClass.size} classes:\n`);
  for (const [key, group] of [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const first = group[0];
    process.stdout.write(`\n[${group.length}] ${key}\n`);
    if (first !== undefined) {
      process.stdout.write(`  repro: ${first.players} players, ${first.placement}, seed ${first.seed}, ${first.steps} steps\n`);
      process.stdout.write(`  seeds: ${group.slice(0, 8).map((stall) => `${stall.players}/${stall.placement}/${stall.seed}`).join(', ')}\n`);
    }
  }
}

// Only when this file is the entry point, so importing the helpers does not run a sweep.
if (process.argv[1] !== undefined && process.argv[1].endsWith('sweep.ts')) {
  await sweep();
}
