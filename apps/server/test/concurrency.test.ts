/**
 * The two pieces that make "one command at a time, per seat's budget" a property.
 *
 * The socket suite proves the behaviour through the real routes, where the tasks being
 * queued happen to be synchronous. These tests prove the queue holds when they are not,
 * which is the case it exists for: before it, commands serialized only because
 * `RoomService.submit` never yielded, and nothing would have failed if that changed.
 */
import { describe, expect, it } from 'vitest';

import { MatchQueue } from '../src/rooms/matchQueue';
import { SeatRateLimiter } from '../src/transport/rateLimiter';

const tick = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('the per-match queue', () => {
  it('runs one task at a time even when a task yields', async () => {
    const queue = new MatchQueue();
    const log: string[] = [];

    const task = (name: string) => async (): Promise<void> => {
      log.push(`${name} in`);
      await tick();
      log.push(`${name} out`);
    };

    await Promise.all([
      queue.run('m1', task('a')),
      queue.run('m1', task('b')),
      queue.run('m1', task('c')),
    ]);

    // No task starts before the one ahead of it has finished.
    expect(log).toEqual(['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
  });

  it('does not make one match wait for another', async () => {
    const queue = new MatchQueue();
    const log: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const slow = queue.run('m1', async () => {
      await blocked;
      log.push('m1');
    });
    await queue.run('m2', () => {
      log.push('m2');
    });
    releaseFirst();
    await slow;

    expect(log).toEqual(['m2', 'm1']);
  });

  it('keeps the chain running when a task throws', async () => {
    const queue = new MatchQueue();
    const failing = queue.run('m1', () => {
      throw new Error('refused');
    });
    await expect(failing).rejects.toThrow('refused');
    await expect(queue.run('m1', () => 'still here')).resolves.toBe('still here');
  });

  it('forgets a match once nothing is queued for it', async () => {
    const queue = new MatchQueue();
    await Promise.all([queue.run('m1', tick), queue.run('m1', tick), queue.run('m2', tick)]);
    expect(queue.size).toBe(0);
  });
});

describe('the per-seat frame budget', () => {
  it('allows a burst, then refuses, then refills on the clock', () => {
    let now = 0;
    const limiter = new SeatRateLimiter({ burst: 3, perSecond: 2, clock: () => now });

    expect([limiter.take('s'), limiter.take('s'), limiter.take('s')]).toEqual([true, true, true]);
    expect(limiter.take('s')).toBe(false);

    // Half a second at two per second is one more frame, and no more than one.
    now += 500;
    expect(limiter.take('s')).toBe(true);
    expect(limiter.take('s')).toBe(false);
  });

  it('never refills past the burst, so idling does not bank frames', () => {
    let now = 0;
    const limiter = new SeatRateLimiter({ burst: 2, perSecond: 10, clock: () => now });
    now += 60_000;
    expect([limiter.take('s'), limiter.take('s'), limiter.take('s')]).toEqual([true, true, false]);
  });

  it('budgets each seat separately, and forgets one on request', () => {
    let now = 0;
    const limiter = new SeatRateLimiter({ burst: 1, perSecond: 1, clock: () => now });
    expect(limiter.take('one')).toBe(true);
    expect(limiter.take('two')).toBe(true);
    expect(limiter.take('one')).toBe(false);
    limiter.forget('one');
    expect(limiter.take('one')).toBe(true);
  });
});
