import type { RandomState } from '../model/state.js';

/** A small serializable LCG. Every consumed value increments `draws`. */
export function nextUint32(state: RandomState): { value: number; state: RandomState } {
  const value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return { value, state: { value, draws: state.draws + 1 } };
}

export function randomInt(state: RandomState, exclusiveMax: number): { value: number; state: RandomState } {
  if (!Number.isSafeInteger(exclusiveMax) || exclusiveMax <= 0) {
    throw new Error('exclusiveMax must be a positive safe integer');
  }
  const next = nextUint32(state);
  return { value: next.value % exclusiveMax, state: next.state };
}

export function shuffle<T>(values: readonly T[], initialState: RandomState): { items: T[]; state: RandomState } {
  const items = [...values];
  let state = initialState;
  for (let index = items.length - 1; index > 0; index -= 1) {
    const next = randomInt(state, index + 1);
    state = next.state;
    const other = items[next.value];
    const current = items[index];
    if (other === undefined || current === undefined) {
      throw new Error('shuffle index escaped array bounds');
    }
    items[index] = other;
    items[next.value] = current;
  }
  return { items, state };
}
