import { CORE_CONTENT, type GameConfig } from '@seatgrab/engine';
import type { ComputerDifficulty } from '@seatgrab/protocol';
import { createLocalMatch, createMemoryStore } from '../src/local';
import { playComputers } from './computerPlay';
const level = (process.argv[2] ?? 'medium') as ComputerDifficulty;
const seed = Number(process.argv[3] ?? '1');
const count = Number(process.argv[4] ?? '3');
const config: GameConfig = { matchId: 'one', players: Array.from({ length: count }, (_u, i) => ({ id: `p${i + 1}`, displayName: `S${i + 1}`, partyId: ['kite', 'cog', 'sprout', 'lantern', 'compass'][i]! })), contentAdvisories: [], tiePolicy: 'jointWinners' };
const match = await createLocalMatch({ store: createMemoryStore(), content: CORE_CONTENT }, config, seed);
const seats: Record<string, ComputerDifficulty> = {};
for (const p of config.players) seats[p.id] = level;
const start = Date.now();
const result = await playComputers(match, seats, { maxSteps: Number(process.argv[5] ?? "20000") });
console.log(`${level} seed ${seed}: finished=${result.finished} steps=${result.steps.length} refusals=${result.refusals.length} ms=${Date.now() - start} stalled=${result.stalled ?? ''}`);
if (!result.finished) {
  for (const step of result.steps.slice(-40)) console.log(step.revision, step.seatId, JSON.stringify(step.command).slice(0, 160));
  const v = result.view;
  console.log('phase', v.phase, 'turn', v.turnOrdinal, 'active', v.activePlayerId, 'pending', JSON.stringify(v.pendingDecision));
  console.log('zones', v.zones.map((z) => `${z.id}:${JSON.stringify(z.counts)}${z.majorityOwnerId ? '*' + z.majorityOwnerId : ''}`).join(' '));
  console.log('empty', v.slots.filter((s) => s.voter === undefined).length, 'market', v.voterMarket, 'reserve', JSON.stringify(v.publicReserve));
  console.log('players', v.players.map((p) => `${p.id}:${JSON.stringify(p.resources)} hand ${p.trickHandCount}`).join(' '));
}
