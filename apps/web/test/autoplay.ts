/**
 * An autonomous seat, written against the same derivations the composers draw.
 *
 * This exists so a whole match can be played without a person at the table. It is a test
 * fixture and nothing ships it, but it is deliberately not a shortcut: every move it
 * makes goes through `MatchSurface.submit`, every question it answers is read from that
 * seat's own `PlayerView`, and every command it builds comes from the composers'
 * derivations in `@seatgrab/seat`. A driver that reached into `GameState` would prove the
 * engine works and nothing about whether a seat can act on what it is shown, which is the
 * half a full-game run is for.
 *
 * It plays to finish a match rather than to win one. Given a choice it takes the cheapest
 * legal answer, and where an operation offers to pass it passes, because a driver that
 * tried to play well would spend the session failing on strategy rather than on rules.
 *
 * The candidate ladder itself lives in `@seatgrab/computer` as `candidateCommands`, where
 * the three difficulty policies share its building blocks. Its order is unchanged, because
 * the sweeps and `full-game.test.ts` are the regression instrument for it.
 */
import type { GameCommand, PlayerView } from '@seatgrab/protocol';
import { candidateCommands as ladder, type LadderOptions } from '@seatgrab/computer';

import type { MatchSurface } from '../src/transport';

export { affordablePayment } from '@seatgrab/computer';

/** What one step of the driver did, for a transcript a failure can be read from. */
export interface AutoplayStep {
  seatId: string;
  command: GameCommand;
  accepted: boolean;
  /** The engine's refusal code, when it refused. */
  code?: string;
  message?: string;
  revision: number;
}

export interface AutoplayResult {
  steps: readonly AutoplayStep[];
  /** The public projection at the point the driver stopped. */
  view: PlayerView;
  finished: boolean;
  /** Set when the driver stopped because it could find no move to make. */
  stalled?: string;
}

export interface AutoplayOptions extends LadderOptions {
  /** A ceiling so a driver that cannot make progress fails rather than runs forever. */
  maxSteps?: number;
  /** Refusals the driver may absorb and move on from. Any other refusal fails the run. */
  tolerate?: readonly string[];
}

/**
 * Every command this seat would try now, best first.
 *
 * A ladder rather than a single move, because a projection does not carry every reason
 * the engine may refuse. The driver takes the first candidate the engine accepts and
 * records the refusals it walked past, so a run that ends up refusing everything fails
 * with the reasons in its transcript.
 */
export function candidateCommands(
  view: PlayerView,
  seatId: string,
  options: AutoplayOptions,
): readonly GameCommand[] {
  return ladder(view, seatId, options);
}

/* ---------------------------------------------------------------- the driver */

/** The seat the match is waiting on, preferring a pending decision over the turn. */
export function actingSeatId(view: PlayerView): string | null {
  const responsible = view.pendingDecision?.responsiblePlayerIds ?? [];
  return responsible[0] ?? view.activePlayerId ?? null;
}

function drawableView(match: MatchSurface, seatId: string): PlayerView {
  const result = match.viewFor({ kind: 'player', playerId: seatId });
  if (result.view === null) throw new Error(`no projection for ${seatId}`);
  return result.view;
}

/**
 * Play the match until it finishes or the driver runs out of moves.
 *
 * Every read is a projection and every write is `submit`, so this exercises the adapter
 * and the derivations together. It stops rather than throws when it stalls: a stalled run
 * carries its transcript, and reading the last few commands is how a stall gets diagnosed.
 */
export async function autoplay(
  match: MatchSurface,
  seatIds: readonly string[],
  options: AutoplayOptions = {},
): Promise<AutoplayResult> {
  const maxSteps = options.maxSteps ?? 4000;
  const tolerate = new Set(options.tolerate ?? []);
  const steps: AutoplayStep[] = [];
  const first = seatIds[0];
  if (first === undefined) throw new Error('autoplay needs at least one seat');

  for (let step = 0; step < maxSteps; step += 1) {
    const reference = drawableView(match, first);
    if (reference.status === 'finished') {
      return { steps, view: reference, finished: true };
    }
    const seatId = actingSeatId(reference);
    if (seatId === null) {
      return { steps, view: reference, finished: false, stalled: 'nobody is due to act' };
    }
    const view = drawableView(match, seatId);
    const candidates = candidateCommands(view, seatId, options);
    if (candidates.length === 0) {
      return {
        steps,
        view,
        finished: false,
        stalled: `${seatId} has no move: ${view.pendingDecision?.summary ?? view.phase}`,
      };
    }
    let accepted = false;
    const refusals: string[] = [];
    for (const command of candidates) {
      const response = await match.submit(seatId, command);
      steps.push({
        seatId,
        command,
        accepted: response.ok,
        ...(response.ok ? {} : { code: response.code, message: response.message }),
        revision: match.revision(),
      });
      if (response.ok) {
        accepted = true;
        break;
      }
      refusals.push(`${command.type}: ${response.code} ${response.message}`);
      if (tolerate.has(response.code)) continue;
    }
    if (!accepted) {
      return {
        steps,
        view,
        finished: false,
        stalled: `${seatId} had every move refused:\n${refusals.join('\n')}`,
      };
    }
  }
  return {
    steps,
    view: drawableView(match, first),
    finished: false,
    stalled: `reached the ${maxSteps}-step ceiling`,
  };
}
