/**
 * A token bucket, keyed by whatever the caller counts.
 *
 * Section 14.1 asks for the rate of socket messages to be validated alongside their
 * size. This is the simplest thing that does it honestly: a bucket that refills on a
 * clock, so a caller can act as fast as a person plays — several frames in a burst while
 * a composer is being filled in — but cannot hold the queue open indefinitely.
 *
 * Two things use it, and the difference is only the key. The socket transport keys by
 * seat, so opening a second connection for one seat does not double its budget. The HTTP
 * transport keys by client address, because the surface it has to defend —
 * `POST /api/rooms` — is reachable before any seat exists to key on.
 *
 * Nothing here is a game rule, and exhausting a budget refuses a message rather than
 * refusing a move: the caller is told, and may send the same command again.
 */
export interface RateLimiterOptions {
  /** Messages available in one burst. */
  burst: number;
  /** Messages per second the burst refills at. */
  perSecond: number;
  /** Injected so tests do not wait. Milliseconds, monotonic. */
  clock?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  readonly #burst: number;
  readonly #perSecond: number;
  readonly #clock: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    this.#burst = options.burst;
    this.#perSecond = options.perSecond;
    this.#clock = options.clock ?? (() => Date.now());
  }

  /**
   * Spend one message's budget for a key.
   *
   * Returns whether the message is within budget. A key that has never been seen starts
   * with a full burst.
   */
  take(key: string): boolean {
    const now = this.#clock();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, updatedAt: now };
    const refilled = ((now - bucket.updatedAt) / 1000) * this.#perSecond;
    bucket.tokens = Math.min(this.#burst, bucket.tokens + Math.max(0, refilled));
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return allowed;
  }

  /** Forget a key's budget. The socket transport calls it when a seat disconnects. */
  forget(key: string): void {
    this.#buckets.delete(key);
  }
}

/**
 * The old name, kept because the socket transport reads as what it does with it.
 *
 * There is one implementation; this is an alias, not a second bucket.
 */
export { TokenBucketLimiter as SeatRateLimiter };
