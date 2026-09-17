/**
 * The lobby's setup model, with no React in it.
 *
 * Everything the lobby decides before a match exists is here: how many seats a table may
 * have, which party identities are free, what a valid name is, which advisory filters
 * are offered, and how a finished draft becomes the immutable `GameConfig` the engine is
 * created with. Keeping it separate from the screen means the rules can be tested
 * directly, and means the screen has nothing to decide on its own.
 *
 * Nothing here is a game rule. The engine owns those; `createGame` re-checks the seat
 * count and the uniqueness of player and party identifiers, and rejects a config this
 * module should never have produced.
 */
import type { ContentAdvisory } from '@seatgrab/content';
import type { GameConfig, GameContent } from '@seatgrab/engine';
import type { ComputerDifficulty, SeatController } from '@seatgrab/protocol';

import { PARTY_IDENTITIES } from '../assets/parties';

/**
 * Seat counts of the core set.
 *
 * The official two-player mode needs the separate seven-zone board and its 14
 * requirement cards, which this box does not contain, so two seats are not offered at
 * all rather than offered and quietly reinterpreted on the nine-zone board.
 */
export const MIN_SEATS = 3;
export const MAX_SEATS = 5;

export const MAX_NAME_LENGTH = 24;

/** The advisory filters, in the order the lobby lists them. */
export const ADVISORY_FILTERS: readonly {
  advisory: ContentAdvisory;
  label: string;
  /** The short badge shown on a filtered card. */
  printedMark: string;
  description: string;
}[] = [
  {
    advisory: 'sensitive',
    label: 'Mature themes',
    printedMark: '!',
    description:
      'Removes cards that touch adult themes such as gambling, drugs, alcohol or religion in '
      + 'public life. The game plays the same without them.',
  },
  {
    advisory: 'trigger',
    label: 'Distressing themes',
    printedMark: '!!',
    description:
      'Removes cards that touch violence, disasters, epidemics or abuses of power. Each card '
      + 'carries at most one mark, so choosing both filters removes both sets.',
  },
];

/** One seat being edited in the lobby. */
export interface SeatDraft {
  /**
   * Stable identity of this row while the lobby is open.
   *
   * It is not the engine's player ID: seats can be reordered, and the engine ID is
   * assigned from the final seat order in `toGameConfig` so that `p1` is always the
   * first seat clockwise.
   */
  key: string;
  displayName: string;
  partyId: string;
  /** Who plays this seat. Fixed at start, like the party. */
  controller: SeatController;
  /** Present exactly when `controller` is `computer`. */
  difficulty?: ComputerDifficulty;
}

export interface SetupDraft {
  /** Clockwise seat order. The first seat is the engine's `p1`. */
  seats: readonly SeatDraft[];
  advisories: readonly ContentAdvisory[];
}

/** One reason a draft cannot start, addressed to the control that can fix it. */
export interface SetupProblem {
  /** The seat the problem belongs to, or `null` for a table-wide problem. */
  seatKey: string | null;
  field: 'seats' | 'displayName' | 'partyId' | 'controller';
  message: string;
}

let nextSeatKey = 0;

function makeSeat(index: number, partyId: string): SeatDraft {
  nextSeatKey += 1;
  return {
    key: `seat-${nextSeatKey}`,
    displayName: `Player ${index + 1}`,
    partyId,
    controller: 'human',
  };
}

/** The default name for the `ordinal`-th computer at a table: `Computer 1`, `Computer 2`. */
function computerName(ordinal: number): string {
  return `Computer ${ordinal}`;
}

/** The first party identity no seat in `seats` holds, or `null` when all are taken. */
export function firstFreeParty(seats: readonly SeatDraft[]): string | null {
  const taken = new Set(seats.map((seat) => seat.partyId));
  return PARTY_IDENTITIES.find((party) => !taken.has(party.partyId))?.partyId ?? null;
}

/** A table of the smallest supported size, with names and parties already distinct. */
export function defaultSetupDraft(): SetupDraft {
  const seats: SeatDraft[] = [];
  for (let index = 0; index < MIN_SEATS; index += 1) {
    const partyId = firstFreeParty(seats);
    if (partyId === null) throw new Error('Fewer party identities ship than the minimum table size.');
    seats.push(makeSeat(index, partyId));
  }
  return { seats, advisories: [] };
}

/**
 * Hand a seat to a person or to the computer.
 *
 * A seat turned over to the computer takes the default name `Computer N`, where `N` makes
 * the name unique at this table, unless the person editing the lobby has already typed a
 * name of their own that no other seat uses. A seat handed back to a person keeps whatever
 * name it has and drops its difficulty, because the two fields travel together.
 */
export function setController(
  draft: SetupDraft,
  key: string,
  controller: SeatController,
  difficulty: ComputerDifficulty = 'medium',
): SetupDraft {
  const target = draft.seats.find((seat) => seat.key === key);
  if (target === undefined) return draft;
  if (controller === 'human') {
    return {
      ...draft,
      seats: draft.seats.map((seat) => {
        if (seat.key !== key) return seat;
        const { difficulty: _dropped, ...rest } = seat;
        return { ...rest, controller: 'human' as const };
      }),
    };
  }

  const others = draft.seats.filter((seat) => seat.key !== key);
  const taken = new Set(others.map((seat) => seat.displayName.trim().toLocaleLowerCase()));
  let displayName = target.displayName;
  if (target.controller === 'human') {
    let ordinal = 1;
    while (taken.has(computerName(ordinal).toLocaleLowerCase())) ordinal += 1;
    displayName = computerName(ordinal);
  }
  return {
    ...draft,
    seats: draft.seats.map((seat) =>
      seat.key === key ? { ...seat, controller: 'computer' as const, difficulty, displayName } : seat,
    ),
  };
}

/** How many seats a person plays, and how many the computer does. */
export function seatTally(draft: SetupDraft): { humans: number; computers: number } {
  const computers = draft.seats.filter((seat) => seat.controller === 'computer').length;
  return { humans: draft.seats.length - computers, computers };
}

/**
 * The table the home screen's **Play against the computer** action opens.
 *
 * One person and two computers at medium, which is the smallest table this edition seats.
 * The person can add seats, change difficulties or hand a seat back before starting.
 */
export function defaultComputerDraft(): SetupDraft {
  const draft = defaultSetupDraft();
  const seats = draft.seats.map((seat, index) =>
    index === 0
      ? { ...seat, displayName: 'You' }
      : { ...seat, controller: 'computer' as const, difficulty: 'medium' as const, displayName: computerName(index) },
  );
  return { ...draft, seats };
}

export function addSeat(draft: SetupDraft): SetupDraft {
  if (draft.seats.length >= MAX_SEATS) return draft;
  const partyId = firstFreeParty(draft.seats);
  if (partyId === null) return draft;
  return { ...draft, seats: [...draft.seats, makeSeat(draft.seats.length, partyId)] };
}

export function removeSeat(draft: SetupDraft, key: string): SetupDraft {
  if (draft.seats.length <= MIN_SEATS) return draft;
  return { ...draft, seats: draft.seats.filter((seat) => seat.key !== key) };
}

export function renameSeat(draft: SetupDraft, key: string, displayName: string): SetupDraft {
  return {
    ...draft,
    seats: draft.seats.map((seat) =>
      seat.key === key ? { ...seat, displayName: displayName.slice(0, MAX_NAME_LENGTH) } : seat,
    ),
  };
}

/**
 * Give a seat a party identity, swapping with whichever seat already holds it.
 *
 * Swapping rather than rejecting keeps party uniqueness true at every moment, so the
 * lobby never has to show a transient "two seats hold the Kite" error the player did not
 * ask for.
 */
export function assignParty(draft: SetupDraft, key: string, partyId: string): SetupDraft {
  const target = draft.seats.find((seat) => seat.key === key);
  if (target === undefined || target.partyId === partyId) return draft;
  const previous = target.partyId;
  return {
    ...draft,
    seats: draft.seats.map((seat) => {
      if (seat.key === key) return { ...seat, partyId };
      return seat.partyId === partyId ? { ...seat, partyId: previous } : seat;
    }),
  };
}

/** Move a seat one place earlier or later in the clockwise order. */
export function moveSeat(draft: SetupDraft, key: string, direction: -1 | 1): SetupDraft {
  const from = draft.seats.findIndex((seat) => seat.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= draft.seats.length) return draft;
  const seats = [...draft.seats];
  const [moved] = seats.splice(from, 1);
  if (moved === undefined) return draft;
  seats.splice(to, 0, moved);
  return { ...draft, seats };
}

/** Turn one advisory filter on or off, keeping the list in the lobby's own order. */
export function toggleAdvisory(draft: SetupDraft, advisory: ContentAdvisory): SetupDraft {
  const wanted = !draft.advisories.includes(advisory);
  const advisories = ADVISORY_FILTERS.map((filter) => filter.advisory).filter((entry) =>
    entry === advisory ? wanted : draft.advisories.includes(entry),
  );
  return { ...draft, advisories };
}

/**
 * Every reason this draft cannot start a match.
 *
 * Names must be distinct because pass-and-play addresses a seat by name: two players
 * called "Amit" would share one privacy cover as far as the person holding the device is
 * concerned.
 */
export function validateSetup(draft: SetupDraft): readonly SetupProblem[] {
  const problems: SetupProblem[] = [];
  if (draft.seats.length < MIN_SEATS || draft.seats.length > MAX_SEATS) {
    problems.push({
      seatKey: null,
      field: 'seats',
      message: `This edition seats ${MIN_SEATS} to ${MAX_SEATS} players.`,
    });
  }

  if (draft.seats.length > 0 && !draft.seats.some((seat) => seat.controller === 'human')) {
    problems.push({
      seatKey: null,
      field: 'seats',
      message: 'At least one seat has to be played by a person.',
    });
  }
  for (const seat of draft.seats) {
    if (seat.controller === 'computer' && seat.difficulty === undefined) {
      problems.push({
        seatKey: seat.key,
        field: 'controller',
        message: 'Choose a difficulty for this computer seat.',
      });
    }
  }

  const seenNames = new Map<string, string>();
  const seenParties = new Map<string, string>();
  for (const seat of draft.seats) {
    const name = seat.displayName.trim();
    if (name.length === 0) {
      problems.push({ seatKey: seat.key, field: 'displayName', message: 'Enter a name for this seat.' });
    } else if (name.length > MAX_NAME_LENGTH) {
      problems.push({
        seatKey: seat.key,
        field: 'displayName',
        message: `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`,
      });
    } else {
      const folded = name.toLocaleLowerCase();
      const first = seenNames.get(folded);
      if (first === undefined) seenNames.set(folded, seat.key);
      else {
        problems.push({
          seatKey: seat.key,
          field: 'displayName',
          message: 'Two seats have this name. Pass-and-play names a seat on its cover, so names must differ.',
        });
      }
    }

    if (!PARTY_IDENTITIES.some((party) => party.partyId === seat.partyId)) {
      problems.push({ seatKey: seat.key, field: 'partyId', message: 'Choose a party for this seat.' });
    } else if (seenParties.has(seat.partyId)) {
      problems.push({ seatKey: seat.key, field: 'partyId', message: 'Another seat already holds this party.' });
    } else {
      seenParties.set(seat.partyId, seat.key);
    }
  }
  return problems;
}

/** A match identifier unique to this browser, readable in a saved-match list. */
export function newMatchId(now: Date, randomFraction: number): string {
  const stamp = now.getTime().toString(36);
  const salt = Math.floor(randomFraction * 36 ** 4).toString(36).padStart(4, '0');
  return `local-${stamp}-${salt}`;
}

/**
 * Freeze a valid draft into the config the engine is created with.
 *
 * Section 13.3 makes these settings immutable once play starts, and they are: the config
 * is copied into the state by `createGame` and nothing in the engine rewrites it. The
 * only way to change a seat, a party or an advisory filter afterwards is a new match.
 */
export function toGameConfig(draft: SetupDraft, matchId: string): GameConfig {
  const problems = validateSetup(draft);
  if (problems.length > 0) {
    throw new Error(`This table is not ready to start: ${problems.map((p) => p.message).join(' ')}`);
  }
  return {
    matchId,
    players: draft.seats.map((seat, index) => ({
      id: `p${index + 1}`,
      displayName: seat.displayName.trim(),
      partyId: seat.partyId,
      controller: seat.controller,
      ...(seat.controller === 'computer' && seat.difficulty !== undefined
        ? { difficulty: seat.difficulty }
        : {}),
    })),
    contentAdvisories: [...draft.advisories],
    tiePolicy: 'jointWinners',
  };
}

export interface AdvisoryImpact {
  policy: number;
  news: number;
  trick: number;
  total: number;
}

/**
 * How many physical cards a set of advisory filters removes from the shipped pack.
 *
 * Counted from the content itself so the lobby's description cannot drift from what
 * `createGame` actually filters. A marked card is removed whole, both faces with it,
 * which is what the content filters promise.
 */
export function advisoryImpact(
  content: GameContent,
  advisories: readonly ContentAdvisory[],
): AdvisoryImpact {
  const removed = (cards: readonly { advisory?: ContentAdvisory }[]): number =>
    cards.filter((card) => card.advisory !== undefined && advisories.includes(card.advisory)).length;
  const policy = removed(content.policyCards);
  const news = removed(content.newsCards);
  const trick = removed(content.trickCards);
  return { policy, news, trick, total: policy + news + trick };
}
