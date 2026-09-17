import { CORE_CONTENT, type GameConfig } from '@gerrymander/engine';
import type { ComputerDifficulty } from '@gerrymander/protocol';

import { createLocalMatch, createMemoryStore } from '../src/local';
import { playComputers } from './computerPlay';

const PARTIES = ['kite', 'cog', 'sprout', 'lantern', 'compass'] as const;
const NAMES = ['Asha', 'Bikram', 'Chandni', 'Devi', 'Ejaz'] as const;

function config(matchId: string, count: number): GameConfig {
  return {
    matchId,
    players: Array.from({ length: count }, (_u, index) => ({
      id: `p${index + 1}`,
      displayName: NAMES[index] ?? `Seat ${index + 1}`,
      partyId: PARTIES[index] ?? 'kite',
    })),
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

const levels = (process.argv[2] ?? 'mixed');
const games = Number(process.argv[3] ?? '10');
const offset = Number(process.argv[4] ?? '0');
const counts = [3, 4, 5];

let finished = 0;
let played = 0;
let refusals = 0;
const wins: Record<string, number> = {};
const stalls: string[] = [];
const refusalKinds = new Map<string, number>();
let longest = 0;
for (const count of counts) {
  for (let g = 0; g < games; g += 1) {
    const seed = 1 + offset + g * 2731;
    let tick = 0;
    const settings = config(`trial-${count}-${seed}`, count);
    const match = await createLocalMatch({ store: createMemoryStore(), content: CORE_CONTENT, now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000) }, settings, seed);
    const seats: Record<string, ComputerDifficulty> = {};
    const all: ComputerDifficulty[] = ['easy', 'medium', 'hard'];
    settings.players.forEach((p, i) => {
      seats[p.id] = levels === 'mixed' ? all[i % 3]! : (levels as ComputerDifficulty);
    });
    const result = await playComputers(match, seats, { maxSteps: 20000 });
    played += 1;
    longest = Math.max(longest, result.steps.length);
    if (result.finished) {
      finished += 1;
      for (const w of result.view.winners ?? []) wins[seats[w]!] = (wins[seats[w]!] ?? 0) + 1;
    }
    refusals += result.refusals.length;
    for (const r of result.refusals) {
      const key = `${seats[r.seatId]} ${r.command.type}: ${r.code} ${r.message.replace(/\bp\d+\b/g, 'pN').replace(/\d+/g, 'N')}`.slice(0, 200);
      refusalKinds.set(key, (refusalKinds.get(key) ?? 0) + 1);
    }
    if (result.stalled) stalls.push(`${count}p seed ${seed}: ${result.stalled.slice(0, 600)}`);
  }
  console.log(`${count}p: ${finished}/${played}`);
}
console.log(`played ${played} finished ${finished} refusals ${refusals} longest ${longest}`);
console.log('wins', wins);
for (const [k, v] of [...refusalKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(String(v).padStart(5), k);
for (const s of stalls.slice(0, 6)) console.log('\nSTALL', s);
