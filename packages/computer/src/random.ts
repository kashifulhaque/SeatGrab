/**
 * A seeded generator for tie-breaking, so a decision is a pure function of the view.
 *
 * The seed is a hash of the match, the revision and the seat, so two identical positions
 * in different matches do not always play the same way, and the same position in the same
 * match always does. It is a 32-bit xorshift written here rather than imported from the
 * engine, because this package must not depend on the engine.
 */
export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). */
  below(bound: number): number;
}

/** FNV-1a over the parts, folded to 32 bits. Never zero, which xorshift cannot leave. */
export function hashSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 0x9e3779b9 : hash;
}

export function seededRandom(seed: number): Random {
  let state = seed >>> 0 || 0x9e3779b9;
  const step = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return {
    next: () => step() / 0x1_0000_0000,
    below: (bound) => (bound <= 0 ? 0 : step() % bound),
  };
}

/** A copy of `items` in a seeded order, for breaking ties before a stable sort. */
export function shuffled<T>(items: readonly T[], random: Random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = random.below(index + 1);
    const held = copy[index] as T;
    copy[index] = copy[swap] as T;
    copy[swap] = held;
  }
  return copy;
}
