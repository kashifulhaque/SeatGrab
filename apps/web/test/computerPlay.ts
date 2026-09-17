/**
 * A whole match played by computer seats, through `stepComputer`.
 *
 * This is the policies' counterpart of `autoplay.ts`. Every seat is a computer at some
 * difficulty, every read is that seat's own projection through `viewFor`, and every write
 * is `submit`. It records each accepted command and every refusal a step walked past, so a
 * `stuck` step is reported with the reasons rather than hidden by a retry.
 */
import type { ComputerDifficulty, GameCommand, PlayerView } from '@gerrymander/protocol';
import { stepComputer, type ComputerRefusal, type ComputerTable } from '@gerrymander/computer';

import type { MatchSurface } from '../src/transport';
import { actingSeatId } from './autoplay';

export interface ComputerPlayStep {
  seatId: string;
  command: GameCommand;
  revision: number;
}

export interface ComputerPlayResult {
  steps: readonly ComputerPlayStep[];
  /** Every refusal any step walked past before a command was accepted. */
  refusals: readonly (ComputerRefusal & { seatId: string; revision: number })[];
  view: PlayerView;
  finished: boolean;
  stalled?: string;
}

export interface ComputerPlayOptions {
  maxSteps?: number;
}

/** A `ComputerTable` over a match surface, reading each seat's own projection. */
export function tableOf(match: MatchSurface): ComputerTable {
  return {
    view: (seatId) => match.viewFor({ kind: 'player', playerId: seatId }).view,
    submit: (seatId, command) => match.submit(seatId, command),
  };
}

export async function playComputers(
  match: MatchSurface,
  seats: Readonly<Record<string, ComputerDifficulty>>,
  options: ComputerPlayOptions = {},
): Promise<ComputerPlayResult> {
  const maxSteps = options.maxSteps ?? 6000;
  const table = tableOf(match);
  const steps: ComputerPlayStep[] = [];
  const refusals: (ComputerRefusal & { seatId: string; revision: number })[] = [];
  const seatIds = Object.keys(seats);
  const first = seatIds[0];
  if (first === undefined) throw new Error('playComputers needs at least one seat');

  const reference = (): PlayerView => {
    const view = table.view(first);
    if (view === null) throw new Error(`no projection for ${first}`);
    return view;
  };

  for (let step = 0; step < maxSteps; step += 1) {
    const view = reference();
    if (view.status === 'finished') return { steps, refusals, view, finished: true };
    const seatId = actingSeatId(view);
    const difficulty = seatId === null ? undefined : seats[seatId];
    if (seatId === null || difficulty === undefined) {
      return { steps, refusals, view, finished: false, stalled: `nobody is due to act (${seatId ?? 'null'})` };
    }
    const before = match.revision();
    const outcome = await stepComputer(table, seatId, difficulty);
    if (outcome.kind === 'acted') {
      steps.push({ seatId, command: outcome.command, revision: outcome.revision });
      continue;
    }
    if (outcome.kind === 'stuck') {
      refusals.push(...outcome.refusals.map((refusal) => ({ ...refusal, seatId, revision: before })));
      const own = table.view(seatId);
      return {
        steps,
        refusals,
        view,
        finished: false,
        stalled: `${seatId} (${difficulty}) had every move refused at revision ${before}: `
          + `${own?.pendingDecision?.summary ?? own?.phase ?? '?'}\n`
          + outcome.refusals.map((r) => `${r.command.type}: ${r.code} ${r.message}`).join('\n'),
      };
    }
    return {
      steps,
      refusals,
      view,
      finished: false,
      stalled: `${seatId} (${difficulty}) was due to act but its own view said it had nothing to do`,
    };
  }
  return { steps, refusals, view: reference(), finished: false, stalled: `reached the ${maxSteps}-step ceiling` };
}
