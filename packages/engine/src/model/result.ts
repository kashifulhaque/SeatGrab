import type { CommandFailure, CommandSuccess, GameCommand } from '@seatgrab/protocol';
import type { GameEvent, GameState, PlayerId } from './state.js';

export type AuthenticatedActor = { playerId: PlayerId };

export type CommandResult =
  | {
      ok: true;
      state: GameState;
      response: CommandSuccess;
      events: readonly GameEvent[];
    }
  | {
      ok: false;
      state: GameState;
      response: CommandFailure;
      events: readonly [];
    };

export interface AppliedCommand {
  actor: AuthenticatedActor;
  command: GameCommand;
}
