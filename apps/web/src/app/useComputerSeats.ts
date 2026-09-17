/**
 * The computer seats of a local match, driven from the browser.
 *
 * This is the pass-and-play half of the driver `apps/server/src/rooms/computerDriver.ts`
 * is the online half of. Both follow the same four rules, and both get every decision
 * from `@seatgrab/computer`, which reads a seat's own `PlayerView` and nothing else:
 *
 * 1. After every accepted command, and once when the match opens, look for the first
 *    computer seat whose own view says it has something to do.
 * 2. Wait `paceMs`, so a person can follow what happened, then take one step.
 * 3. An accepted step loops; `idle` stops until a person acts; `stuck` stops for this
 *    match and is surfaced, never retried on a timer.
 * 4. At most one command is in flight per match, people and computers together. The
 *    `busy` gate the shell shares with its own `submit` is what enforces it.
 *
 * Nothing here draws anything. A computer seat never reveals, so its hand, kept policy
 * cards and prompts never reach the document: `revealedSeatId` stays the only accessor
 * for private data and this hook never calls it.
 *
 * The scheduling effect deliberately registers no cleanup. It raises the shared `busy`
 * flag itself, which re-renders and re-runs the effect; a cleanup would then cancel the
 * very step that raising the flag announced. Re-entry is closed by the `running` ref
 * instead, which is set before the timer is armed, and the timer is cleared once, when
 * the shell unmounts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { hasSomethingToDo, stepComputer, type ComputerTable } from '@seatgrab/computer';
import type { ComputerDifficulty } from '@seatgrab/protocol';

import type { LocalMatch } from '../local';

/** How long a computer seat waits before acting, as a person chooses it. */
export type ComputerPace = 'normal' | 'fast';

export const COMPUTER_PACE_KEY = 'seatgrab.computerPace';

export const COMPUTER_PACES: readonly { id: ComputerPace; label: string; description: string }[] = [
  { id: 'normal', label: 'Normal', description: 'The computer pauses briefly so you can follow its turn.' },
  { id: 'fast', label: 'Fast', description: 'The computer plays its turn as quickly as it can.' },
];

export function paceDelayMs(pace: ComputerPace): number {
  return pace === 'fast' ? 0 : 800;
}

/** Read the stored pace, defaulting to Normal when storage is unavailable or unset. */
export function readComputerPace(): ComputerPace {
  try {
    return globalThis.localStorage?.getItem(COMPUTER_PACE_KEY) === 'fast' ? 'fast' : 'normal';
  } catch {
    return 'normal';
  }
}

export function writeComputerPace(pace: ComputerPace): void {
  try {
    globalThis.localStorage?.setItem(COMPUTER_PACE_KEY, pace);
  } catch {
    // A browser with storage blocked still plays; it just forgets the choice.
  }
}

/**
 * Consecutive computer turns of nothing but "end turn" before the driver gives up.
 *
 * A board can reach a position the engine cannot end: every zone decided or full, a
 * handful of empty areas left in zones nobody can win, and no seat that both has voters
 * left and can afford a card. Every seat then ends its turn, forever, and at the Normal
 * pace that is a screen that does nothing for as long as it is left open.
 *
 * The count is of computer turns that changed nothing. It resets the moment the board
 * changes, whoever changed it, so a run of quiet computer turns in a live match — which
 * is ordinary late on — never trips it.
 */
const IDLE_TURN_LIMIT = 12;

/** What the board looks like, as coarsely as "did anything happen" needs. */
function boardSignature(view: { slots: readonly { voter?: unknown }[]; zones: readonly { majorityOwnerId?: string }[] }): string {
  const filled = view.slots.filter((slot) => slot.voter !== undefined).length;
  const decided = view.zones.filter((zone) => zone.majorityOwnerId !== undefined).length;
  return `${filled}:${decided}`;
}

/** One refusal a stuck step walked past, in the shape the alert prints. */
export interface ComputerRefusalNote {
  command: string;
  code: string;
  message: string;
}

export interface ComputerSeatsState {
  /** The seat the driver is about to act for, or `null` when none is. */
  thinkingSeatId: string | null;
  /**
   * The refusals of a step that found no legal move, or `null`.
   *
   * A non-null value is a defect in the enumerator, a policy or a composer derivation,
   * exactly as a stalled autoplay run is. The shell shows it and the driver stops.
   */
  stuck: readonly ComputerRefusalNote[] | null;
}

/**
 * Play this match's computer seats.
 *
 * `busy` is the shell's shared gate: the hook raises it around its own step, so a
 * person's controls are disabled while a computer is acting and no step starts while a
 * person's command is in flight.
 */
export function useComputerSeats({
  match,
  revision,
  pace,
  busy,
  setBusy,
}: {
  match: LocalMatch | null;
  /** Bumped by the shell on every accepted command, so this re-runs after one. */
  revision: number;
  pace: ComputerPace;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}): ComputerSeatsState {
  const [thinkingSeatId, setThinkingSeatId] = useState<string | null>(null);
  const [stuck, setStuck] = useState<readonly ComputerRefusalNote[] | null>(null);
  /** Closed while a step is armed or in flight, so an effect re-run starts no second one. */
  const running = useRef(false);
  /** Consecutive computer steps that did nothing but end a turn. */
  const idleTurns = useRef(0);
  /** The board as it was at the last step, so any change resets that count. */
  const lastBoard = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const tableOf = useCallback((current: LocalMatch): ComputerTable => ({
    view: (seatId) => current.viewFor({ kind: 'player', playerId: seatId }).view,
    submit: (seatId, command) => current.submit(seatId, command),
  }), []);

  useEffect(() => {
    if (match === null || busy || running.current || stuck !== null) return;
    const publicView = match.viewFor({ kind: 'public' }).view;
    if (publicView.status === 'finished') {
      setThinkingSeatId(null);
      return;
    }

    const due = publicView.players
      .filter((player) => player.controller === 'computer' && player.difficulty !== undefined)
      .map((player) => ({ seatId: player.id, difficulty: player.difficulty as ComputerDifficulty }))
      .find((seat) => hasSomethingToDo(
        match.viewFor({ kind: 'player', playerId: seat.seatId }).view,
        seat.seatId,
      ));
    if (due === undefined) {
      setThinkingSeatId(null);
      return;
    }

    const signature = boardSignature(publicView);
    if (lastBoard.current !== signature) {
      lastBoard.current = signature;
      idleTurns.current = 0;
    }

    running.current = true;
    setThinkingSeatId(due.seatId);
    setBusy(true);

    const finish = (): void => {
      running.current = false;
      timer.current = null;
      if (!live.current) return;
      setBusy(false);
      setThinkingSeatId(null);
    };

    timer.current = setTimeout(() => {
      void stepComputer(tableOf(match), due.seatId, due.difficulty).then(
        (outcome) => {
          if (outcome.kind === 'acted') {
            idleTurns.current = outcome.command.type === 'RequestEndTurn' ? idleTurns.current + 1 : 0;
          }
          if (outcome.kind === 'stuck' && live.current) {
            setStuck(outcome.refusals.map((refusal) => ({
              command: refusal.command.type,
              code: refusal.code,
              message: refusal.message,
            })));
          } else if (idleTurns.current >= IDLE_TURN_LIMIT && live.current) {
            setStuck([{
              command: 'RequestEndTurn',
              code: 'NO_PROGRESS',
              message: 'Every seat has ended its turn with nothing to do for several rounds. '
                + 'The board has empty areas no seat can fill, so the match cannot reach an ending.',
            }]);
          }
          finish();
          // An accepted step saved a new revision, which bumps `revision` through the
          // shell's subscription; lowering `busy` re-runs this effect for the next seat.
        },
        () => {
          finish();
        },
      );
    }, paceDelayMs(pace));
    // `revision` is a dependency because an accepted command is what makes the next seat
    // due; the views themselves are read through `match`.
  }, [busy, match, pace, revision, setBusy, stuck, tableOf]);

  return { thinkingSeatId, stuck };
}
