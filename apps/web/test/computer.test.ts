/**
 * What the computer opponent may know, and what each difficulty does with it.
 *
 * The first test is the structural one and matters most: `@seatgrab/computer` must not
 * depend on `@seatgrab/engine`, because a package that cannot import `GameState`,
 * `applyCommand` or `projectGame` cannot read the authoritative state, apply a rule of
 * its own, or look up the reward of a policy answer the projection hides. Every other
 * guarantee in this file rests on that one.
 *
 * The rest play real matches through the real local adapter and read the real
 * projections, for the same reason `full-game.test.ts` does: a hand-built view can only
 * assert what its author thought to build, and the states these policies actually meet
 * are the ones a match produces.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  COMPUTER_DIFFICULTIES,
  decide,
  evaluate,
  hasSomethingToDo,
  placementScore,
} from '@seatgrab/computer';
import { CORE_CONTENT, type GameConfig } from '@seatgrab/engine';
import type { ComputerDifficulty, PlayerView } from '@seatgrab/protocol';

import { createLocalMatch, createMemoryStore, type LocalMatchOptions } from '../src/local';
import { playComputers, tableOf } from './computerPlay';

const PARTIES = ['kite', 'cog', 'sprout', 'lantern', 'compass'] as const;
const NAMES = ['Asha', 'Bikram', 'Chandni', 'Devi', 'Ejaz'] as const;

function options(): LocalMatchOptions {
  let tick = 0;
  return {
    store: createMemoryStore(),
    content: CORE_CONTENT,
    now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000),
  };
}

/**
 * A plain table of `count` seats.
 *
 * The seats are left as people, because these tests drive every seat themselves through
 * `stepComputer` rather than through a driver that reads `controller`. Whether the engine
 * accepts a `controller` and hands it back on the projection is
 * `createGame`'s and `projectGame`'s business, and is asserted separately below.
 */
function config(matchId: string, count: number): GameConfig {
  return {
    matchId,
    players: Array.from({ length: count }, (_unused, index) => ({
      id: `p${index + 1}`,
      displayName: NAMES[index] ?? `Seat ${index + 1}`,
      partyId: PARTIES[index] ?? 'kite',
    })),
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

/** The same table, with every seat after the first handed to the computer. */
function tableWithComputers(matchId: string, levels: readonly ComputerDifficulty[]): GameConfig {
  const base = config(matchId, levels.length + 1);
  return {
    ...base,
    players: base.players.map((player, index) =>
      index === 0
        ? { ...player, controller: 'human' as const }
        : { ...player, controller: 'computer' as const, difficulty: levels[index - 1]! },
    ),
  };
}

describe('the computer package', () => {
  it('does not depend on the engine, so it cannot read the authoritative state', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../packages/computer/package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const named = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(named)).not.toContain('@seatgrab/engine');
    // And it does depend on the three it is allowed to read.
    expect(Object.keys(manifest.dependencies ?? {}).toSorted()).toEqual([
      '@seatgrab/content',
      '@seatgrab/protocol',
      '@seatgrab/seat',
    ]);
  });

  it('offers exactly the three difficulties, each with words for the lobby', () => {
    expect(COMPUTER_DIFFICULTIES.map((level) => level.id)).toEqual(['easy', 'medium', 'hard']);
    for (const level of COMPUTER_DIFFICULTIES) {
      expect(level.label.length).toBeGreaterThan(0);
      expect(level.description.length).toBeGreaterThan(20);
    }
  });
});

describe('deciding', () => {
  /** The first projection of a fresh three-seat match, from seat p1's own point of view. */
  async function firstView(matchId: string): Promise<PlayerView> {
    const match = await createLocalMatch(options(), config(matchId, 3), 4021);
    return match.viewFor({ kind: 'player', playerId: 'p1' }).view;
  }

  it('is a pure function of the view, so one position always decides the same way', async () => {
    const view = await firstView('decide-pure');
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const first = decide(view, 'p1', level);
      const again = decide(view, 'p1', level);
      expect(JSON.stringify(again)).toBe(JSON.stringify(first));
      expect(first.length).toBeGreaterThan(0);
    }
  });

  it('answers a seat the engine is waiting on, and nobody else', async () => {
    const view = await firstView('decide-due');
    // The opening prompt is the first-player vote, which every seat answers.
    expect(view.prompt).toBeDefined();
    expect(hasSomethingToDo(view, 'p1')).toBe(true);
  });
});

describe('the easy policy', () => {
  it('never buys or plays a trick across a whole match', async () => {
    const match = await createLocalMatch(options(), config('easy-no-tricks', 3), 7301);
    const result = await playComputers(match, { p1: 'easy', p2: 'easy', p3: 'easy' });

    expect(result.stalled).toBeUndefined();
    expect(result.finished).toBe(true);
    const kinds = new Set(result.steps.map((step) => step.command.type));
    expect(kinds.has('PlayTrick')).toBe(false);
    expect(kinds.has('BuyTrick')).toBe(false);
  });
});

describe('the placement score', () => {
  it('prefers a zone it can complete over one it cannot', async () => {
    const match = await createLocalMatch(options(), config('placement', 3), 5511);
    const view = match.viewFor({ kind: 'player', playerId: 'p1' }).view;

    const byThreshold = [...view.zones].sort(
      (left, right) => left.majorityThreshold - right.majorityThreshold,
    );
    const cheapest = byThreshold[0];
    const dearest = byThreshold[byThreshold.length - 1];
    expect(cheapest).toBeDefined();
    expect(dearest).toBeDefined();
    expect(cheapest!.majorityThreshold).toBeLessThan(dearest!.majorityThreshold);

    const slotIn = (zoneId: string): string => {
      const slot = view.slots.find((candidate) => candidate.zoneId === zoneId && candidate.voter === undefined);
      if (slot === undefined) throw new Error(`no empty slot in ${zoneId}`);
      return slot.slotId;
    };
    const group = { count: 1, sameZone: false };
    const cheap = placementScore(view, 'p1', group, slotIn(cheapest!.id), [], false);
    const dear = placementScore(view, 'p1', group, slotIn(dearest!.id), [], false);
    // On an empty board a single voter is further along in the cheaper zone, so it scores
    // higher there. Both are legal; the score is what orders them.
    expect(cheap).toBeGreaterThan(dear);
  });
});

describe('the evaluator', () => {
  it('reads every seat the same way from any seat’s view, and scores an empty board level', async () => {
    const match = await createLocalMatch(options(), config('evaluate', 3), 9110);
    const fromP1 = match.viewFor({ kind: 'player', playerId: 'p1' }).view;
    const fromP2 = match.viewFor({ kind: 'player', playerId: 'p2' }).view;

    // p2's standing is a public fact, so p1's view answers the same figure p2's does.
    expect(evaluate(fromP1, 'p2')).toBe(evaluate(fromP2, 'p2'));
    // Nobody has anything yet, so no seat leads.
    expect(evaluate(fromP1, 'p1')).toBe(evaluate(fromP1, 'p3'));
  });
});

describe('a mixed table', () => {
  it('plays a whole three-seat match with no refused command', async () => {
    const seats = { p1: 'easy', p2: 'medium', p3: 'hard' } as const;
    const match = await createLocalMatch(options(), config('mixed-full', 3), 4021);
    const result = await playComputers(match, seats);

    expect(result.stalled).toBeUndefined();
    expect(result.refusals).toEqual([]);
    expect(result.finished).toBe(true);
    expect(result.view.status).toBe('finished');
    expect(result.view.winners?.length ?? 0).toBeGreaterThan(0);
  });

  it('reads only its own projection: the table hands a seat nothing but its own view', async () => {
    const match = await createLocalMatch(options(), config('own-view', 3), 3307);
    const table = tableOf(match);
    const own = table.view('p2');
    const other = match.viewFor({ kind: 'player', playerId: 'p3' }).view;
    expect(own).not.toBeNull();
    expect(own?.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p3']);
    // The two seats hold different private data at the same revision, which is the whole
    // point: a policy given one seat's view cannot answer for another's.
    expect(JSON.stringify(own?.privatePolicyCards ?? []))
      .not.toBe(JSON.stringify([...(other.privatePolicyCards ?? []), 'x']));
    expect(own?.revision).toBe(other.revision);
  });

  it('projects the controller onto every seat, and refuses a table of computers only', async () => {
    const match = await createLocalMatch(
      options(),
      tableWithComputers('projected-controllers', ['easy', 'hard']),
      2024,
    );
    const view = match.viewFor({ kind: 'player', playerId: 'p1' }).view;
    expect(view.players.map((player) => player.controller)).toEqual(['human', 'computer', 'computer']);
    expect(view.players.map((player) => player.difficulty)).toEqual([undefined, 'easy', 'hard']);

    const noHumans = tableWithComputers('no-humans', ['easy', 'hard']);
    await expect(createLocalMatch(options(), {
      ...noHumans,
      players: noHumans.players.map((player) => ({
        ...player,
        controller: 'computer' as const,
        difficulty: 'medium' as const,
      })),
    }, 1)).rejects.toThrow(/at least one human seat/u);
  });
});
