/**
 * One command at a time, per match.
 *
 * `RoomService.submit` reads the stored snapshot, applies the command and commits the
 * result without yielding once, and until now that was the only reason two clients could
 * not both act on the same revision. It was a property of how the code happened to be
 * written rather than of the design: a single `await` added between the read and the
 * commit would have let two commands interleave, with the second overwriting the first,
 * and nothing would have failed to compile.
 *
 * This queue makes the guarantee explicit. Work queued for one match runs in the order it
 * was queued and never overlaps with other work for that match, whether or not the task
 * inside yields. Different matches do not wait for each other.
 *
 * The queue is deliberately outside `RoomService`: the service answers "what does this
 * command do", and this answers "when may it run". Putting it inside would serialize
 * every projection behind every command for no benefit.
 */
interface Chain {
  /** Resolves when everything queued so far has settled. Never rejects. */
  tail: Promise<void>;
  /** Callers still inside `run`. The chain is dropped when this reaches zero. */
  waiting: number;
}

export class MatchQueue {
  readonly #chains = new Map<string, Chain>();

  /**
   * Run `task` after everything already queued for `key`, and before anything queued
   * after it.
   *
   * A task that throws rejects only its own caller: the chain records that the task
   * finished and carries on, because one client's failed command must not stop the
   * table.
   */
  async run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const existing = this.#chains.get(key);
    const previous = existing?.tail ?? Promise.resolve();
    const settled = previous.then(task);
    const chain: Chain = existing ?? { tail: previous, waiting: 0 };
    chain.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    chain.waiting += 1;
    this.#chains.set(key, chain);

    try {
      return await settled;
    } finally {
      chain.waiting -= 1;
      if (chain.waiting === 0 && this.#chains.get(key) === chain) this.#chains.delete(key);
    }
  }

  /** How many keys currently have work queued. Diagnostics and tests only. */
  get size(): number {
    return this.#chains.size;
  }
}
