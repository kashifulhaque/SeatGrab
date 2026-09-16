import type { GameState, PendingInteraction } from '../model/state.js';

export function interruptWith(state: GameState, interaction: PendingInteraction): void {
  if (state.pendingInteraction !== null) {
    state.interactionStack.push(state.pendingInteraction);
  }
  state.pendingInteraction = interaction;
}

export function completeInteraction(state: GameState): PendingInteraction | null {
  const completed = state.pendingInteraction;
  state.pendingInteraction = state.interactionStack.pop() ?? null;
  return completed;
}
