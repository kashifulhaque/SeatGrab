import type { EngineErrorCode } from '@gerrymander/protocol';
import type { GameContent } from '../content.js';
import type { CommandResult } from '../model/result.js';
import type { GameEvent, GameState } from '../model/state.js';
import { assertGameState } from '../rules/invariants.js';

export function commandFailure(state: GameState, code: EngineErrorCode, message: string): CommandResult {
  return {
    ok: false,
    state,
    events: [],
    response: { ok: false, code, message, revision: state.revision },
  };
}

export function createPublicEvent(state: GameState, type: string, message: string, actorId?: string): GameEvent {
  const event: GameEvent = {
    id: `event-${state.nextSequence}`,
    type,
    message,
    visibility: 'public',
  };
  if (actorId !== undefined) {
    event.actorId = actorId;
  }
  state.nextSequence += 1;
  return event;
}

export function commandSuccess(
  original: GameState,
  next: GameState,
  events: GameEvent[],
  content: GameContent,
): CommandResult {
  next.revision = original.revision + 1;
  next.events.push(...events);
  assertGameState(next, content);
  return {
    ok: true,
    state: next,
    events,
    response: {
      ok: true,
      revision: next.revision,
      events: events.map(({ id, type, message, actorId }) => {
        const visible = { id, type, message };
        return actorId === undefined ? visible : { ...visible, actorId };
      }),
    },
  };
}
