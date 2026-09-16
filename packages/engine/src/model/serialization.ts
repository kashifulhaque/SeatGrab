import { z } from 'zod';
import type { GameContent } from '../content.js';
import { assertGameState } from '../rules/invariants.js';
import { GAME_SCHEMA_VERSION, type GameState } from './state.js';

const GameStateHeaderSchema = z.object({
  schemaVersion: z.literal(GAME_SCHEMA_VERSION),
  matchId: z.string().min(1),
  revision: z.int().nonnegative(),
  players: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(3).max(5),
  voters: z.array(z.unknown()),
  slots: z.array(z.unknown()),
  turn: z.object({ phase: z.string(), ordinal: z.int().nonnegative() }).passthrough(),
  random: z.object({ value: z.int().nonnegative(), draws: z.int().nonnegative() }),
}).passthrough();

export function serializeGame(state: GameState): string {
  return JSON.stringify(state);
}

export function loadGame(serialized: string, content: GameContent): GameState {
  const parsed: unknown = JSON.parse(serialized);
  GameStateHeaderSchema.parse(parsed);
  const state = parsed as GameState;
  assertGameState(state, content);
  return state;
}
