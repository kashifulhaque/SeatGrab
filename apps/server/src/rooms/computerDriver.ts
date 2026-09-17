/**
 * The computer seats of an online room, driven in-process.
 *
 * A computer seat has no connection and no credential, so nothing it is shown ever leaves
 * the server: the driver reads its projection with `RoomService.viewFor` and submits
 * through the same `MatchHub` a person's browser posts to. Every rule decision stays with
 * the engine, and the seat identities come from `RoomService.computerSeats`, which builds
 * them from seat rows rather than from `authenticate` — `authenticate` still refuses a
 * computer seat, because a computer seat holds no credential hash.
 *
 * The loop is the one both transports share:
 *
 * 1. A match changes. The hub says so through `onChanged`.
 * 2. The first computer seat whose own view has something to do waits `delayMs`, then
 *    takes one step.
 * 3. An accepted step changes the match, so the hub fires again and the loop continues.
 *    `idle` stops it until a person acts.
 * 4. A `stuck` step is a defect in the enumerator, a policy or a composer derivation, so
 *    it is logged with every refusal and the match is left alone. Nothing retries it on a
 *    timer, and `/health` reports `computers: degraded` until the process restarts.
 *
 * At most one step per match is ever in flight. `MatchQueue` already serializes the
 * commands themselves; this keeps the driver from queueing a second decision behind one
 * it has not seen the result of.
 */
import { hasSomethingToDo, stepComputer, type ComputerTable } from '@gerrymander/computer';
import type { ComputerDifficulty, GameCommand, PlayerView } from '@gerrymander/protocol';

import type { MatchHub } from './matchHub.js';
import type { RoomService, SeatIdentity } from './roomService.js';

/**
 * Consecutive computer turns that changed nothing before the driver gives up on a match.
 *
 * A board can reach a position the engine cannot end: every zone decided or full, a few
 * empty areas left in zones nobody can win, and no seat that both has voters left and can
 * afford a card. Every seat then ends its turn forever, which on a server is a match that
 * never finishes and a table left watching. The count resets the moment the board changes,
 * whoever changed it, so a quiet run of computer turns in a live match never trips it.
 */
const IDLE_TURN_LIMIT = 12;

/** What the board looks like, as coarsely as "did anything happen" needs. */
function boardSignature(view: PlayerView): string {
  const filled = view.slots.filter((slot) => slot.voter !== undefined).length;
  const decided = view.zones.filter((zone) => zone.majorityOwnerId !== undefined).length;
  return `${filled}:${decided}`;
}

/** Just enough of a logger for this file, so a test can pass two functions. */
export interface DriverLog {
  info: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface ComputerDriverOptions {
  rooms: RoomService;
  hub: MatchHub;
  /** Milliseconds a seat waits before acting, so the table can follow it. 0 in tests. */
  delayMs: number;
  log: DriverLog;
}

export class ComputerDriver {
  readonly #rooms: RoomService;
  readonly #hub: MatchHub;
  readonly #delayMs: number;
  readonly #log: DriverLog;
  /** The step in flight for a match, so a change never schedules a second one. */
  readonly #running = new Map<string, Promise<void>>();
  /** Matches a computer got stuck in. Nothing retries these. */
  readonly #degraded = new Set<string>();
  /** Consecutive computer turns that changed nothing, and the board they saw, per match. */
  readonly #idle = new Map<string, { turns: number; board: string }>();
  #stopped = false;

  constructor(options: ComputerDriverOptions) {
    this.#rooms = options.rooms;
    this.#hub = options.hub;
    this.#delayMs = options.delayMs;
    this.#log = options.log;
  }

  /** Subscribe to the hub. Call once, when the server is assembled. */
  attach(): void {
    this.#hub.onChanged((matchId) => {
      void this.wake(matchId);
    });
  }

  /**
   * Continue every match that seats a computer.
   *
   * Called after the process starts listening. A match whose computer was due to act when
   * the last process stopped has nothing to wake it otherwise: its people are watching a
   * turn that never arrives.
   */
  async recover(): Promise<void> {
    for (const match of await this.#rooms.matchesWithComputers()) {
      this.#log.info({ matchId: match.matchId }, 'Resuming the computer seats of a match');
      void this.wake(match.matchId);
    }
  }

  /** True while every computer seat is still finding moves. The health route reads it. */
  healthy(): boolean {
    return this.#degraded.size === 0;
  }

  /** Stop scheduling. In-flight steps finish; nothing new starts. */
  stop(): void {
    this.#stopped = true;
  }

  /**
   * Resolve once nothing is in flight for a match.
   *
   * Tests await this rather than sleeping: with `delayMs` at 0 the whole chain of
   * computer turns runs as a chain of microtask-scheduled steps, and this is the end of
   * it.
   */
  async settled(matchId: string): Promise<void> {
    // Each step schedules the next through `wake`, so one await is not enough: drain
    // until the match has no step in flight.
    for (;;) {
      const running = this.#running.get(matchId);
      if (running === undefined) return;
      await running;
    }
  }

  /**
   * Take one step for this match, if a computer seat has something to do.
   *
   * Re-entrant by design: the hub fires on every accepted command, including the ones
   * this driver submits, and a step already in flight is the answer to a second call.
   */
  async wake(matchId: string): Promise<void> {
    if (this.#stopped || this.#degraded.has(matchId)) return;
    if (this.#running.has(matchId)) return;
    const running = this.#run(matchId).finally(() => {
      this.#running.delete(matchId);
    });
    this.#running.set(matchId, running);
    await running;
  }

  /**
   * Step this match's computer seats until none of them has anything to do.
   *
   * The loop is here rather than in the hub's callback because the hub fires *during*
   * this driver's own `submit`, while a step is still in flight — which `wake` correctly
   * ignores. Re-reading the seats after each accepted command is what carries a turn
   * from one computer seat to the next, and what picks up a person's command that landed
   * while a computer was deciding.
   */
  async #run(matchId: string): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      const due = await this.#dueSeat(matchId);
      if (due === null) return;
      if (this.#delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.#delayMs).unref?.();
        });
      }
      if (this.#stopped) return;

      const before = this.#idle.get(matchId);
      if (before === undefined || before.board !== due.board) {
        this.#idle.set(matchId, { turns: 0, board: due.board });
      }

      const outcome = await stepComputer(
        this.#tableFor(due.seat, due.view),
        due.seat.playerId,
        due.difficulty,
      );
      if (outcome.kind === 'acted') {
        const running = this.#idle.get(matchId) ?? { turns: 0, board: due.board };
        const turns = outcome.command.type === 'RequestEndTurn' ? running.turns + 1 : 0;
        this.#idle.set(matchId, { turns, board: due.board });
        if (turns < IDLE_TURN_LIMIT) continue;
        this.#degraded.add(matchId);
        this.#log.error(
          { matchId, playerId: due.seat.playerId, revision: due.revision, idleTurns: turns },
          'Every computer seat has ended its turn with nothing to do for several rounds; '
          + 'the board has empty areas no seat can fill, so this match cannot reach an ending',
        );
        return;
      }
      if (outcome.kind === 'idle') return;

      this.#degraded.add(matchId);
      this.#log.error(
        {
          matchId,
          playerId: due.seat.playerId,
          difficulty: due.difficulty,
          revision: due.revision,
          refusals: outcome.refusals.map((refusal) => ({
            command: refusal.command.type,
            code: refusal.code,
            message: refusal.message,
          })),
        },
        'A computer seat had every candidate refused; it will not act again in this match',
      );
      return;
    }
  }

  /** The first computer seat in this match whose own view says it has something to do. */
  async #dueSeat(matchId: string): Promise<{
    seat: SeatIdentity;
    difficulty: ComputerDifficulty;
    /** The projection this decision is made against, carried so it is read once. */
    view: PlayerView;
    revision: number;
    board: string;
  } | null> {
    for (const seat of await this.#rooms.computerSeats(matchId)) {
      const view = await this.#viewOf(seat);
      if (view === null) return null;
      if (hasSomethingToDo(view, seat.playerId)) {
        return {
          seat,
          difficulty: seat.difficulty,
          view,
          revision: view.revision,
          board: boardSignature(view),
        };
      }
    }
    return null;
  }

  /**
   * A `ComputerTable` for one seat.
   *
   * The command ID is derived rather than random, so a decision replayed after a restart
   * is answered from the idempotency record instead of being applied twice. The attempt
   * counter distinguishes the candidates of one decision, which share a revision.
   */
  #tableFor(seat: SeatIdentity, view: PlayerView): ComputerTable {
    let attempt = 0;
    return {
      // `stepComputer` reads the view once, before it considers anything, so the
      // projection `#dueSeat` already took is the one it gets. Projecting again here
      // would be a second read for the same decision — and now that a read may await,
      // a second one could also see a different revision halfway through a step.
      view: (playerId) => (playerId === seat.playerId ? view : null),
      submit: async (playerId, command: GameCommand) => {
        if (playerId !== seat.playerId) {
          throw new Error('The computer driver may only submit for its own seat');
        }
        const revision = view.revision;
        const commandId = `computer:${seat.playerId}:${revision}:${attempt}`;
        attempt += 1;
        const { response } = await this.#hub.submit(seat, {
          matchId: seat.matchId,
          commandId,
          expectedRevision: revision,
          command,
        });
        return response;
      },
    };
  }

  async #viewOf(seat: SeatIdentity): Promise<PlayerView | null> {
    try {
      return (await this.#rooms.viewFor(seat)).view;
    } catch (error) {
      this.#log.error({ err: error, matchId: seat.matchId, playerId: seat.playerId },
        'Failed to project a computer seat');
      return null;
    }
  }
}
