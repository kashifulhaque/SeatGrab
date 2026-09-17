/**
 * The live state of every match this process is serving, and when it reaches the store.
 *
 * Until the move to D1 there was no such thing: `RoomService.submit` read the snapshot
 * out of SQLite, applied the command and wrote it back, all synchronously, and the store
 * was the authority at every instant. D1 is reached over HTTP, so keeping that shape
 * would have put a round trip to Cloudflare in the middle of every turn.
 *
 * So the authority moved into this process and the store became a checkpoint of it. A
 * match held here carries its own `GameState`, its own revision, and the events and
 * command records that have not been written yet. `RoomService` reads and writes this;
 * nothing on a request path touches the driver directly.
 *
 * ## What that costs
 *
 * A checkpoint is written every `checkpointEveryCommands` accepted or refused commands,
 * or `checkpointMaxDelayMs` after the first unwritten change, whichever comes first, and
 * always at a boundary that must not be lost: a match finishing, and a shutdown. An
 * unclean crash — a kill, a power loss — therefore loses the commands since the last
 * checkpoint, up to that bound. Every match still resumes at a revision boundary, never
 * a partial one, because a checkpoint carries the snapshot, its events and its command
 * records together.
 *
 * A player whose command is lost that way and who re-sends the same command ID gets it
 * applied again rather than answered from the idempotency record, because the record was
 * lost with it. That is the trade this design makes and the reason the two bounds are
 * configurable: set `GERRYMANDER_CHECKPOINT_EVERY_COMMANDS=1` to write through on every
 * command and pay a round trip per turn instead.
 *
 * ## Reads
 *
 * Reads are answered from here, including the ones that would otherwise miss what has
 * not been checkpointed. `findCommand` looks in the unwritten records before the store,
 * so a duplicate inside the window is still answered from the record rather than
 * applied twice, and `readEvents` merges unwritten events over stored ones, so a seat
 * sees its own action immediately rather than at the next checkpoint.
 */
import { loadGame, serializeGame, type GameContent, type GameState } from '@gerrymander/engine';

import type {
  CheckpointCommand,
  MatchCheckpoint,
  MatchRepository,
  MatchRow,
  MatchStatus,
  StoredCommand,
  StoredEvent,
} from '../persistence/repository.js';

export interface MatchStoreOptions {
  repository: MatchRepository;
  content: GameContent;
  /** Commands that may go unwritten before a checkpoint. `1` writes through. */
  checkpointEveryCommands: number;
  /** The longest a change may sit unwritten, however few commands it is. `0` disables. */
  checkpointMaxDelayMs: number;
  /** Reported when a checkpoint fails, so the operator hears about it. */
  onCheckpointFailed?: (matchId: string, error: unknown, pendingCommands: number) => void;
  /**
   * How many matches may be held in memory at once.
   *
   * A match is held from the first time it is touched, so without a bound a process that
   * ran for weeks would hold every match it had ever served. Over the bound, the
   * least-recently-touched matches that have nothing unwritten are dropped; a match with
   * unwritten changes is never dropped, however old it is, and one that is dropped is
   * read back from the store the next time anybody asks for it.
   */
  maxLiveMatches?: number;
}

/** Matches held in memory before the least-recently-touched clean ones are dropped. */
export const DEFAULT_MAX_LIVE_MATCHES = 256;

/** Raised when a snapshot in the store does not load. The caller turns it into a 500. */
export class SnapshotUnreadableError extends Error {
  readonly matchId: string;

  constructor(matchId: string, cause: unknown) {
    super(
      `The stored state for match ${matchId} did not load: `
      + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'SnapshotUnreadableError';
    this.matchId = matchId;
  }
}

interface LiveMatch {
  row: MatchRow;
  /** The authoritative state, or null while the room is still a lobby. */
  state: GameState | null;
  /** The next sequence an event gets. Allocated here, never by a `SELECT MAX`. */
  nextSequence: number;
  /** Events not yet checkpointed, oldest first. */
  pendingEvents: StoredEvent[];
  /** Command records not yet checkpointed, accepted and refused alike. */
  pendingCommands: CheckpointCommand[];
  /** The unwritten records, by command ID, so a duplicate is found without a read. */
  pendingByCommandId: Map<string, StoredCommand>;
  /** Whether the match row itself has changed since the last checkpoint. */
  snapshotDirty: boolean;
  /** When this match was last read or written, for the eviction order. */
  touchedAt: number;
  timer: NodeJS.Timeout | null;
  /** The checkpoint in flight, so two never overlap for one match. */
  flushing: Promise<void> | null;
}

export class MatchStore {
  readonly #repository: MatchRepository;
  readonly #content: GameContent;
  readonly #every: number;
  readonly #maxDelayMs: number;
  readonly #onFailed: MatchStoreOptions['onCheckpointFailed'];
  readonly #maxLive: number;
  readonly #live = new Map<string, LiveMatch>();
  /** Counts touches, which orders eviction without asking for a clock. */
  #tick = 0;
  /** False once a checkpoint has failed and its changes are still unwritten. */
  #healthy = true;

  constructor(options: MatchStoreOptions) {
    this.#repository = options.repository;
    this.#content = options.content;
    this.#every = options.checkpointEveryCommands;
    this.#maxDelayMs = options.checkpointMaxDelayMs;
    this.#onFailed = options.onCheckpointFailed;
    this.#maxLive = options.maxLiveMatches ?? DEFAULT_MAX_LIVE_MATCHES;
  }

  /** How many matches are held in memory. Diagnostics and tests only. */
  get liveMatchCount(): number {
    return this.#live.size;
  }

  /**
   * Whether everything accepted so far has reached the store.
   *
   * False means a checkpoint failed and its commands are still only in memory. The
   * health route reads it; the process keeps serving, because refusing to play a match
   * that is running correctly would not make the unwritten commands any safer.
   */
  get healthy(): boolean {
    return this.#healthy;
  }

  /** How many commands across every match are waiting to be written. Diagnostics only. */
  get pendingCommandCount(): number {
    let total = 0;
    for (const match of this.#live.values()) total += match.pendingCommands.length;
    return total;
  }

  /** The match row as this process holds it, loading it from the store on first touch. */
  async match(matchId: string): Promise<MatchRow | null> {
    const live = await this.#load(matchId);
    return live?.row ?? null;
  }

  /**
   * A match by room code.
   *
   * Room codes are looked up in the store rather than in memory: the code is how a
   * player who holds nothing else finds the room, and a lobby is written immediately, so
   * there is nothing unwritten to miss.
   */
  async matchByRoomCode(roomCode: string): Promise<MatchRow | null> {
    const row = await this.#repository.findMatchByRoomCode(roomCode);
    if (row === null) return null;
    // Prefer the live row when this process is already holding the match: it is ahead of
    // or equal to the stored one, never behind.
    return this.#live.get(row.matchId)?.row ?? row;
  }

  /** The authoritative state, or null while the match has not started. */
  async state(matchId: string): Promise<GameState | null> {
    const live = await this.#load(matchId);
    if (live === null) return null;
    return live.state;
  }

  /** The idempotency record for a command ID, unwritten ones included. */
  async findCommand(matchId: string, commandId: string): Promise<StoredCommand | null> {
    const live = await this.#load(matchId);
    const pending = live?.pendingByCommandId.get(commandId);
    if (pending !== undefined) return pending;
    return this.#repository.findCommand(matchId, commandId);
  }

  /**
   * Events after `sinceSequence`, unwritten ones included.
   *
   * The stored rows and the unwritten ones are disjoint by sequence — a sequence is
   * allocated once and moves from one to the other at a checkpoint — so this appends
   * rather than merges, and truncates to the same limit a stored read would.
   */
  async readEvents(
    matchId: string,
    sinceSequence: number,
    limit: number,
  ): Promise<readonly StoredEvent[]> {
    const stored = await this.#repository.readEvents(matchId, sinceSequence, limit);
    const live = this.#live.get(matchId);
    if (live === undefined || live.pendingEvents.length === 0) return stored;
    const highestStored = stored.at(-1)?.sequence ?? sinceSequence;
    const unwritten = live.pendingEvents.filter((event) => event.sequence > highestStored);
    return [...stored, ...unwritten].slice(0, limit);
  }

  /**
   * Adopt a match that has just been started and written.
   *
   * `RoomService.start` writes the opening snapshot immediately, because that is where
   * seats lock, so there is nothing pending here — only the state to hold and the
   * sequence to carry on from.
   */
  adoptStarted(row: MatchRow, state: GameState, events: readonly StoredEvent[]): void {
    this.#live.set(row.matchId, {
      row,
      state,
      nextSequence: (events.at(-1)?.sequence ?? 0) + 1,
      pendingEvents: [],
      pendingCommands: [],
      pendingByCommandId: new Map(),
      snapshotDirty: false,
      touchedAt: (this.#tick += 1),
      timer: null,
      flushing: null,
    });
    this.#evictOverflow();
  }

  /**
   * The highest event sequence allocated for a match, written or not.
   *
   * This is what a seat's event cursor is taken from. Counting stored rows instead would
   * put the cursor behind the events the seat has already been sent, and the client
   * would ask for them all again after the next checkpoint.
   */
  async highestSequence(matchId: string): Promise<number> {
    const live = await this.#load(matchId);
    if (live === null) return 0;
    return live.nextSequence - 1;
  }

  /** Allocate the sequence numbers for a set of events the engine has just emitted. */
  async allocateSequences(
    matchId: string,
    events: readonly Omit<StoredEvent, 'sequence'>[],
  ): Promise<readonly StoredEvent[]> {
    const live = await this.#require(matchId);
    return events.map((event) => {
      const sequence = live.nextSequence;
      live.nextSequence += 1;
      return { ...event, sequence };
    });
  }

  /**
   * Record an accepted command: the new state, its events and its idempotency record.
   *
   * The state becomes authoritative here, at once. The checkpoint that writes it may be
   * this call or a later one.
   */
  async recordAccepted(input: {
    matchId: string;
    state: GameState;
    events: readonly StoredEvent[];
    command: CheckpointCommand;
    at: string;
  }): Promise<void> {
    const live = await this.#require(input.matchId);
    live.state = input.state;
    // `snapshot` is deliberately left as it was. Nothing reads its text once the match
    // is live — `state` above is the authority — and it is the test for whether a match
    // has started, so blanking it here would read as a match that never dealt. The
    // serialized form is produced once per checkpoint, in `#flush`, rather than once per
    // command, because serializing a whole game on every turn is work nobody reads.
    live.row = {
      ...live.row,
      revision: input.state.revision,
      status: input.state.status as MatchStatus,
      updatedAt: input.at,
    };
    live.pendingEvents.push(...input.events);
    live.snapshotDirty = true;
    this.#recordCommand(live, input.command);
    // A finished match is a boundary worth writing at once: nothing more will arrive to
    // reach the command bound, and the last thing a table did should not be the thing a
    // crash loses.
    await this.#afterChange(live, input.state.status === 'finished');
  }

  /** Record a command the engine refused. No state changed, so there is no snapshot. */
  async recordRejected(matchId: string, command: CheckpointCommand): Promise<void> {
    const live = await this.#require(matchId);
    this.#recordCommand(live, command);
    await this.#afterChange(live, false);
  }

  /**
   * Write everything this match has pending, now.
   *
   * Safe to call when there is nothing to write. A failure leaves the pending records in
   * place and raises, so the next attempt sends them again; `writeCheckpoint` is written
   * to make that repetition harmless.
   */
  async flush(matchId: string): Promise<void> {
    const live = this.#live.get(matchId);
    if (live === undefined) return;
    await this.#flush(live);
  }

  /** Write every match's pending changes. Used by the shutdown path. */
  async flushAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const live of [...this.#live.values()]) {
      try {
        await this.#flush(live);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} match checkpoints could not be written.`);
    }
  }

  /**
   * Stop the timers and forget everything held in memory.
   *
   * It writes nothing: `close` in `app.ts` calls `flushAll` first and logs what it could
   * not write, so that a failure to write is reported rather than hidden inside a
   * teardown.
   */
  dispose(): void {
    for (const live of this.#live.values()) {
      if (live.timer !== null) clearTimeout(live.timer);
      live.timer = null;
    }
    this.#live.clear();
  }

  /**
   * Drop a match from memory without writing it, after checkpointing what it has.
   *
   * For the caller that knows its copy is stale — `RoomService.start` when another
   * request dealt the table first. The next read loads it from the store.
   */
  async forget(matchId: string): Promise<void> {
    await this.flush(matchId);
    const live = this.#live.get(matchId);
    if (live === undefined) return;
    if (live.timer !== null) clearTimeout(live.timer);
    this.#live.delete(matchId);
  }

  #recordCommand(live: LiveMatch, command: CheckpointCommand): void {
    live.pendingCommands.push(command);
    live.pendingByCommandId.set(command.commandId, {
      matchId: live.row.matchId,
      commandId: command.commandId,
      actorPlayerId: command.actorPlayerId,
      accepted: command.accepted,
      revisionBefore: command.revisionBefore,
      revisionAfter: command.revisionAfter,
      response: command.response,
    });
  }

  /**
   * Decide whether this change has to be written now, and arm the delay bound if not.
   *
   * The command bound is awaited rather than left to a timer: the caller is one command
   * in `n`, and making that caller wait is what "checkpoint every `n` commands" means.
   * The other `n - 1` return without touching the network.
   */
  async #afterChange(live: LiveMatch, force: boolean): Promise<void> {
    if (force || live.pendingCommands.length >= this.#every) {
      await this.#flush(live);
      return;
    }
    if (this.#maxDelayMs > 0 && live.timer === null) {
      live.timer = setTimeout(() => {
        live.timer = null;
        void this.#flush(live).catch(() => {
          // Already reported by `#flush`. A timer must not raise into the event loop.
        });
      }, this.#maxDelayMs);
      // A pending checkpoint must not hold the process open at shutdown.
      live.timer.unref();
    }
  }

  async #flush(live: LiveMatch): Promise<void> {
    // One checkpoint per match at a time. A second caller waits for the one in flight
    // and then writes whatever is still pending, which may by then be nothing.
    while (live.flushing !== null) {
      await live.flushing.catch(() => undefined);
    }
    if (live.pendingCommands.length === 0 && live.pendingEvents.length === 0 && !live.snapshotDirty) {
      return;
    }

    if (live.timer !== null) {
      clearTimeout(live.timer);
      live.timer = null;
    }

    const state = live.state;
    const checkpoint: MatchCheckpoint = {
      matchId: live.row.matchId,
      match: live.snapshotDirty && state !== null
        ? {
          revision: state.revision,
          status: state.status as MatchStatus,
          schemaVersion: state.schemaVersion,
          engineVersion: state.engineVersion,
          snapshot: serializeGame(state),
          updatedAt: live.row.updatedAt,
        }
        : null,
      events: [...live.pendingEvents],
      commands: [...live.pendingCommands],
    };

    const attempt = this.#repository.writeCheckpoint(checkpoint).then(
      () => {
        // Only what was sent is cleared. Anything recorded while the write was in flight
        // stays pending and goes out with the next checkpoint.
        live.pendingEvents.splice(0, checkpoint.events.length);
        live.pendingCommands.splice(0, checkpoint.commands.length);
        for (const command of checkpoint.commands) {
          live.pendingByCommandId.delete(command.commandId);
        }
        if (checkpoint.match !== null && live.state?.revision === checkpoint.match.revision) {
          live.snapshotDirty = false;
        }
        this.#healthy = true;
      },
      (error: unknown) => {
        this.#healthy = false;
        this.#onFailed?.(live.row.matchId, error, live.pendingCommands.length);
        throw error;
      },
    );

    live.flushing = attempt.then(() => undefined, () => undefined);
    try {
      await attempt;
    } finally {
      live.flushing = null;
    }
  }

  async #require(matchId: string): Promise<LiveMatch> {
    const live = await this.#load(matchId);
    if (live === null) throw new Error(`Match ${matchId} is not in the store.`);
    return live;
  }

  /**
   * Bring a match into memory, or return the copy already there.
   *
   * The stored snapshot is parsed once, here, rather than on every read. `loadGame`
   * re-runs the header schema and every state invariant, so a snapshot that was
   * corrupted is refused at this point rather than played on.
   */
  async #load(matchId: string): Promise<LiveMatch | null> {
    const existing = this.#live.get(matchId);
    if (existing !== undefined) {
      existing.touchedAt = (this.#tick += 1);
      return existing;
    }

    const row = await this.#repository.findMatch(matchId);
    if (row === null) return null;

    let state: GameState | null = null;
    if (row.snapshot !== null) {
      try {
        state = loadGame(row.snapshot, this.#content);
      } catch (error) {
        throw new SnapshotUnreadableError(matchId, error);
      }
    }

    const live: LiveMatch = {
      row,
      state,
      nextSequence: (await this.#repository.highestEventSequence(matchId)) + 1,
      pendingEvents: [],
      pendingCommands: [],
      pendingByCommandId: new Map(),
      snapshotDirty: false,
      touchedAt: (this.#tick += 1),
      timer: null,
      flushing: null,
    };
    this.#live.set(matchId, live);
    this.#evictOverflow();
    return live;
  }

  /**
   * Drop the least-recently-touched matches that have nothing unwritten.
   *
   * Only clean matches are candidates, so this never discards state that has not reached
   * the store — a match with a failing checkpoint is held however long it takes. A
   * dropped match is read back from the store when somebody asks for it again.
   */
  #evictOverflow(): void {
    this.evictClean(this.#maxLive);
  }

  /**
   * Drop clean matches until at most `keep` are held. Called with the configured bound;
   * a test calls it with 0 to prove what is and is not a candidate.
   */
  evictClean(keep: number): void {
    if (this.#live.size <= keep) return;
    const clean = [...this.#live.values()]
      .filter((match) => (
        match.pendingCommands.length === 0
        && match.pendingEvents.length === 0
        && !match.snapshotDirty
        && match.flushing === null
      ))
      .sort((left, right) => left.touchedAt - right.touchedAt);

    for (const match of clean) {
      if (this.#live.size <= keep) return;
      if (match.timer !== null) clearTimeout(match.timer);
      this.#live.delete(match.row.matchId);
    }
  }
}
