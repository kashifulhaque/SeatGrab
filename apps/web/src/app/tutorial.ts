/**
 * The guided tutorial: a real match against the computer, with a coach beside it.
 *
 * The tutorial is not a simulation and not a scripted board. It is an ordinary local
 * match — one person, two Easy computers, the same engine, the same content pack — with
 * one extra panel on the match screen that says what the table is asking for and which
 * rule is behind it. Everything a player learns here is therefore true of every other
 * match, and no rule is restated in a place the engine cannot enforce.
 *
 * Two decisions in this module are worth stating plainly, because both were the
 * alternative to something more elaborate:
 *
 * 1. **A lesson is chosen from the projection, not from a script.** Each lesson carries
 *    `when`, which says whether its moment has come, and most carry `done`, which says
 *    whether the projection already shows the player doing it. `nextLesson` walks the
 *    list in order and returns the first lesson that is unfinished and whose moment is
 *    now. A scripted step counter would drift the moment a computer seat did something
 *    unexpected, a Breaking News card interrupted a turn, or the player reloaded the page.
 *    Nothing here counts clicks.
 * 2. **A tutorial match is named, not flagged.** `newTutorialMatchId` prefixes the match
 *    ID, and `isTutorialMatchId` is the only question the match screen asks. The alternative
 *    was a field in the save document, which would have changed the snapshot schema and
 *    every version check that reads it for a fact no rule consults. Naming the match also
 *    means the coach survives everything that reopens a match by ID: a reload, the
 *    **Continue** button on the title screen, and the saved-match list.
 *
 * `TutorialFacts` is the whole of what a lesson may read. Deriving the facts once, in one
 * place, keeps every lesson a plain predicate over named values that a test can build, and
 * keeps the projection contract in one function rather than in fifteen.
 */
import type { PlayerView } from '@gerrymander/protocol';

import { affordability, powerStatuses, purchaseCost } from './actions';
import { defaultSetupDraft, type SetupDraft } from './setup';

/** The prefix that marks a match as a tutorial. See the note on naming, in this file. */
export const TUTORIAL_MATCH_PREFIX = 'tutorial-';

/** The seat the person plays in a tutorial match. Seat 1 of a table the tutorial builds. */
export const TUTORIAL_SEAT_NAME = 'You';

export function isTutorialMatchId(matchId: string): boolean {
  return matchId.startsWith(TUTORIAL_MATCH_PREFIX);
}

/** A tutorial match ID, unique in this browser and readable in the saved-match list. */
export function newTutorialMatchId(now: Date, randomFraction: number): string {
  const stamp = now.getTime().toString(36);
  const salt = Math.floor(randomFraction * 36 ** 4).toString(36).padStart(4, '0');
  return `${TUTORIAL_MATCH_PREFIX}${stamp}-${salt}`;
}

/**
 * The table the tutorial starts: you and two computers at Easy.
 *
 * Three seats is the smallest table this edition seats, so the tutorial is the shortest
 * real match rather than a cut-down one. Easy buys cheap voter cards and spreads them
 * around, which leaves zones open long enough for a first-time player to take one.
 */
export function tutorialSetupDraft(): SetupDraft {
  const draft = defaultSetupDraft();
  return {
    ...draft,
    seats: draft.seats.map((seat, index) =>
      index === 0
        ? { ...seat, displayName: TUTORIAL_SEAT_NAME }
        : {
          ...seat,
          controller: 'computer' as const,
          difficulty: 'easy' as const,
          displayName: `Computer ${index}`,
        },
    ),
  };
}

/* ------------------------------------------------------------------- the facts */

/**
 * Everything a lesson is allowed to read, derived from one seat's own projection.
 *
 * Counts rather than identifiers: a lesson asks whether the player holds a zone, not
 * which. Anything a lesson would need an identifier for belongs on the board or in the
 * seat's own column, both of which are already on screen.
 */
export interface TutorialFacts {
  /** The seat the person holds. */
  seatId: string;
  finished: boolean;
  /** True while the match is still electing a first player or taking starting resources. */
  setup: boolean;
  /** The kind of prompt this seat must answer, or `null` when none is open. */
  promptKind: string | null;
  /** True while this seat is the active player and no prompt blocks its action phase. */
  actionPhase: boolean;
  /** True while another seat is the active player. */
  someoneElsesTurn: boolean;
  /** Voters bought or granted and not yet placed. Lost if the turn ends without them. */
  votersToPlace: number;
  /** Voters this seat has standing on the board. */
  votersOnBoard: number;
  /** Zones where this seat holds the majority. Each one is scoring. */
  zonesHeld: number;
  /** Zones where this seat holds redistricting rights. */
  rightsZones: number;
  /** Policy cards this seat has kept, which is one per question answered. */
  policyCards: number;
  /** Powers this seat has unlocked, out of the eight on the mat. */
  powersUnlocked: number;
  /** Dirty Tricks in hand. */
  tricksInHand: number;
  /** True while at least one face-up voter card is within this seat's means. */
  canBuyVoters: boolean;
  /** True once this seat can afford the Dirty Trick on top of the pile. */
  canBuyTrick: boolean;
  /** True when the match is over and this seat is among the winners. */
  won: boolean;
}



/** Read one seat's own projection into the values the lessons are written against. */
export function tutorialFacts(view: PlayerView, seatId: string): TutorialFacts {
  const me = view.players.find((player) => player.id === seatId);
  const prompt = view.prompt;
  const finished = view.status === 'finished';
  const myTurn = view.activePlayerId === seatId;
  const trick = view.trickMarket;
  return {
    seatId,
    finished,
    setup: view.status === 'setup',
    promptKind: prompt === undefined ? null : prompt.kind,
    actionPhase: !finished && myTurn && prompt === undefined && view.phase === 'action',
    someoneElsesTurn: !finished && view.activePlayerId !== undefined && !myTurn,
    votersToPlace: view.pendingVoterGroups
      .filter((group) => group.controllerId === seatId)
      .reduce((running, group) => running + group.count, 0),
    votersOnBoard: view.slots.filter((slot) => slot.voter?.ownerId === seatId).length,
    zonesHeld: view.zones.filter((zone) => zone.majorityOwnerId === seatId).length,
    rightsZones: view.zones.filter((zone) => zone.rightsOwnerId === seatId).length,
    policyCards: me === undefined
      ? 0
      : me.policyCounts.corporate + me.policyCounts.nationalist
        + me.policyCounts.populist + me.policyCounts.reformer,
    powersUnlocked: powerStatuses(view, seatId).filter((power) => power.unlocked).length,
    tricksInHand: me?.trickHandCount ?? 0,
    canBuyVoters: me !== undefined && view.voterCards.some((card) => {
      const cost = purchaseCost(view, seatId, card.id);
      return cost !== null && affordability(cost, me.resources).can;
    }),
    canBuyTrick: trick !== undefined && me !== undefined
      && affordability(trick.payable, me.resources).can,
    won: finished && (view.winners ?? []).includes(seatId),
  };
}

/* ----------------------------------------------------------------- the lessons */

export interface Lesson {
  id: string;
  /** The heading on the coach card, in sentence case. */
  title: string;
  /** The rule, one paragraph per entry, addressed to the player. */
  body: readonly string[];
  /** What to do next, when the lesson asks for an action rather than a read. */
  task?: string;
  /**
   * True while this lesson is the one the table is on.
   *
   * A lesson whose moment has not come is passed over, so a rule that never comes up —
   * a discard down to the cap, a majority nobody reaches — never interrupts a turn to
   * explain itself.
   */
  when: (facts: TutorialFacts) => boolean;
  /**
   * True once the projection shows the player has done this.
   *
   * A lesson without one is finished by the reader instead. Both count: a lesson the
   * player has read and a lesson the player has performed are equally behind them.
   */
  done?: (facts: TutorialFacts) => boolean;
}

/**
 * The curriculum, in the order a first match meets it.
 *
 * Order decides which lesson wins when two moments overlap, so the prompts — which block
 * everything else until they are answered — come before the free parts of a turn, and
 * the rules a player meets only later come last. A lesson that is skipped because its
 * moment never came stays available for the turn it finally does.
 */
export const TUTORIAL_LESSONS: readonly Lesson[] = [
  {
    id: 'goal',
    title: 'What you are trying to do',
    body: [
      'The board has nine zones, and each one shows how many voters it takes to hold it. '
      + 'Reach that number with your own voters and the zone is yours; each of those voters '
      + 'scores one point for you.',
      'The match ends when every zone is held, and the player with the most scoring voters '
      + 'wins. Voters above a zone’s number, and voters in zones you do not hold, score '
      + 'nothing. Two computers are playing against you, and they are reading the same board '
      + 'you are.',
    ],
    task: 'Read this, then continue. The coach stays with you for the whole match.',
    when: () => true,
  },
  {
    id: 'firstPlayer',
    title: 'Vote for who goes first',
    body: [
      'Every match opens with a vote. Pick any other player; nobody may vote for themselves, '
      + 'and a tie is voted again.',
      'Going first is not the advantage it looks like. Seats later in the order take more '
      + 'starting resources, one more for each seat, so the last seat starts richest.',
    ],
    task: 'Choose a player in the prompt.',
    when: (facts) => facts.promptKind === 'firstPlayerVote',
    done: (facts) => !facts.setup,
  },
  {
    id: 'startingResources',
    title: 'Take your starting resources',
    body: [
      'There are four resources, and each belongs to one political archetype: Cash to '
      + 'Corporate, Influence to Nationalist, Press to Populist, Faith to Reformer.',
      'Take any mix you like. Voter cards in the market are priced in specific resources, so '
      + 'a spread of types buys more cards than a pile of one. You may hold at most 12 '
      + 'resources at a time.',
    ],
    task: 'Choose your resources in the prompt.',
    when: (facts) => facts.promptKind === 'startingResources',
    done: (facts) => !facts.setup,
  },
  {
    id: 'waiting',
    title: 'Watch a computer take a turn',
    body: [
      'The computer plays the same turn you do, in the open: it answers a question, buys '
      + 'voter cards, places the voters and ends its turn. Watch the board and the log to see '
      + 'where it is building.',
      'Your turn comes round the table clockwise. While you wait you can still be offered a '
      + 'trade, and you can play a Dirty Trick as a reaction when the card says so.',
    ],
    when: (facts) => facts.someoneElsesTurn && facts.policyCards === 0,
    done: (facts) => facts.policyCards >= 1,
  },
  {
    id: 'policyAnswer',
    title: 'Answer the policy question',
    body: [
      'Every turn opens with a question and two answers. Take the one you agree with — '
      + 'there is no wrong answer, and you cannot see what an answer pays before you commit '
      + 'to it.',
      'The answer you take is kept as a card for one of the four archetypes, and it pays you '
      + 'the resources printed on it. To draw a different question instead, pay any four '
      + 'resources; you can do that as often as you can pay.',
    ],
    task: 'Choose an answer.',
    when: (facts) => facts.promptKind === 'policyAnswer',
    done: (facts) => facts.policyCards >= 1,
  },
  {
    id: 'buy',
    title: 'Buy voters from the market',
    body: [
      'The market shows voter cards face up, each with a price and a number of voters. Pay '
      + 'the price and you take that card’s voters. A question mark in a price means any '
      + 'one resource, whichever type you like.',
      'Buy as many cards as you can afford in one turn. Resources you keep are worth nothing '
      + 'at the end, so spending is usually right.',
    ],
    task: 'Open "What you can do" in your column and buy a voter card you can afford.',
    when: (facts) => facts.actionPhase
      && facts.canBuyVoters
      && facts.votersToPlace === 0
      && facts.votersOnBoard === 0,
    done: (facts) => facts.votersToPlace > 0 || facts.votersOnBoard > 0,
  },
  {
    id: 'place',
    title: 'Place the voters you bought',
    body: [
      'All the voters from one card go in one zone, in any empty areas of it. Concentrate '
      + 'them: voters spread thin across nine zones hold none of them.',
      'Areas with a dashed ring are volatile. A voter placed in one is fixed there for the '
      + 'rest of the match and deals you a Breaking News card that resolves at the end of the '
      + 'turn, for good or ill.',
      'Voters you leave unplaced when the turn ends are lost, so place them before you end it.',
    ],
    task: 'Tap a ringed area in the zone you want, fill the rest of the group, then confirm.',
    when: (facts) => facts.votersToPlace > 0,
    done: (facts) => facts.votersToPlace === 0 && facts.votersOnBoard > 0,
  },
  {
    id: 'capDiscard',
    title: 'Discard down to your cap',
    body: [
      'You may hold at most 12 resources. You are over the cap, so you have to give some '
      + 'back to the bank before anything else happens.',
      'This is the rule that punishes hoarding. Spending on voter cards as you earn keeps you '
      + 'under it.',
    ],
    task: 'Choose what to give back.',
    when: (facts) => facts.promptKind === 'capDiscard',
  },
  {
    id: 'majority',
    title: 'Mark your majority',
    body: [
      'You have reached a zone’s threshold, so the zone is yours. Mark exactly that many '
      + 'of your voters in it; those are the ones that score.',
      'Marks stay where they are for the rest of the match. A marked voter cannot be moved by '
      + 'redistricting, which makes a majority hard to take back.',
    ],
    task: 'Choose which of your voters count.',
    when: (facts) => facts.promptKind === 'majoritySelection',
    done: (facts) => facts.zonesHeld >= 1,
  },
  {
    id: 'endTurn',
    title: 'End your turn',
    body: [
      'When you have spent what you want to spend and placed every voter, end your turn with '
      + 'the button in the bar at the top.',
      'Ending the turn resolves any Breaking News waiting on you, then passes play to the '
      + 'next seat. Anything you left unplaced is lost at that moment.',
      'A turn where nothing in the market is within reach is an ordinary turn. End it: your '
      + 'archetypes pay you again when your next one begins.',
    ],
    task: 'Select "End turn" in the bar at the top when you are done.',
    when: (facts) => facts.actionPhase && facts.votersToPlace === 0,
  },
  {
    id: 'archetypes',
    title: 'Your archetypes pay you',
    body: [
      'Each answer you keep counts as a card for its archetype. Every two cards in one '
      + 'archetype pay you one resource of that type at the start of your turn, without your '
      + 'doing anything.',
      'Three cards in one archetype unlock that archetype’s first power, and five unlock '
      + 'its second. Your mat lists all eight powers and what each one needs.',
    ],
    task: 'Open "Player mat" in your column to see where you are.',
    when: (facts) => facts.actionPhase && facts.policyCards >= 2,
  },
  {
    id: 'powers',
    title: 'You have unlocked a power',
    body: [
      'Three cards in one archetype unlock its first power. Some powers are their own action, '
      + 'such as taking a resource from an opponent; others change an action you were taking '
      + 'anyway, such as a purchase that yields an extra voter for the same price.',
      'A power you unlock with cards you later lose goes with them. The mat shows which of the '
      + 'eight you hold and how much of each per-turn allowance is left.',
    ],
    task: 'Look under "Other actions" and on your mat for what you can use.',
    when: (facts) => facts.actionPhase && facts.powersUnlocked >= 1,
  },
  {
    id: 'redistricting',
    title: 'You hold redistricting rights',
    body: [
      'Hold strictly the most voters in a zone and you gain its redistricting rights. Once a '
      + 'turn, you may move one voter — yours or a rival’s — into that zone, out '
      + 'of it, or within it.',
      'A voter already marked for a majority cannot be moved this way, and a move has to run '
      + 'between zones that touch. This is how you break up an opponent building next door.',
    ],
    task: 'Look for the gerrymander action under "Other actions".',
    when: (facts) => facts.actionPhase && facts.rightsZones >= 1,
  },
  {
    id: 'tricks',
    title: 'Dirty Tricks',
    body: [
      'A Dirty Trick is bought face down off the top of the pile for the price printed on its '
      + 'back, so you pay before you see it. Play it on your own turn, or as a reaction when '
      + 'the card itself says so.',
      'Tricks are the part of the match that reaches across the table: they move voters, tax '
      + 'purchases, or put a card up for auction. Nobody sees what is in your hand.',
    ],
    when: (facts) => facts.actionPhase && (facts.tricksInHand > 0 || facts.canBuyTrick),
  },
  {
    id: 'graduate',
    title: 'You know enough to play',
    body: [
      'That is the whole turn: answer the question, buy voters and place them, end the turn. '
      + 'Everything else — powers, redistricting, tricks and trades — hangs off those '
      + 'three steps.',
      'Play this match out against the computer. For the full rules, including the house rules '
      + 'this app applies where a table might argue, open How to play from the title screen.',
    ],
    when: (facts) => facts.policyCards >= 3 && facts.zonesHeld >= 1,
  },
  {
    id: 'finished',
    title: 'The match is over',
    body: [
      'Every zone is held, or the board filled and every seat took its last turn. Each player '
      + 'scores one point per voter marked for a majority; everything else on the board scores '
      + 'nothing.',
      'The standings are on the results panel. Start a full match from the title screen when '
      + 'you want a table of your own size, or another table against the computer.',
    ],
    when: (facts) => facts.finished,
  },
];

/* ---------------------------------------------------------------- the progress */

export interface LessonPlacement {
  lesson: Lesson;
  /** How many lessons the curriculum holds, for the progress line on the card. */
  total: number;
}

function isComplete(lesson: Lesson, facts: TutorialFacts, read: ReadonlySet<string>): boolean {
  return read.has(lesson.id) || lesson.done?.(facts) === true;
}

/**
 * The lesson to show now, or `null` when none applies.
 *
 * `read` holds the lessons the player has marked as read. A lesson is behind the player
 * when it is in that set or when its own `done` says the projection already shows it,
 * whichever comes first.
 */
export function nextLesson(
  facts: TutorialFacts,
  read: ReadonlySet<string>,
): LessonPlacement | null {
  const lesson = TUTORIAL_LESSONS.find(
    (candidate) => !isComplete(candidate, facts, read) && candidate.when(facts),
  );
  return lesson === undefined ? null : { lesson, total: TUTORIAL_LESSONS.length };
}

/** How many lessons are behind the player, for the progress line on the coach card. */
export function lessonsCompleted(facts: TutorialFacts, read: ReadonlySet<string>): number {
  return TUTORIAL_LESSONS.filter((lesson) => isComplete(lesson, facts, read)).length;
}

/* ------------------------------------------------------------- what is remembered */

/**
 * Which lessons this browser has marked as read, per match.
 *
 * It is stored rather than kept in the component so that reloading the page does not
 * replay the opening lesson. It is a convenience and nothing depends on it: a browser
 * with storage blocked plays the same tutorial and is offered a lesson it has already
 * read, which is a smaller failure than losing the match.
 */
export function readLessonsKey(matchId: string): string {
  return `gerrymander.tutorial.${matchId}`;
}

export function readLessons(matchId: string): ReadonlySet<string> {
  try {
    const stored = globalThis.localStorage?.getItem(readLessonsKey(matchId));
    if (stored === null || stored === undefined) return new Set();
    const parsed: unknown = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeLessons(matchId: string, read: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(readLessonsKey(matchId), JSON.stringify([...read]));
  } catch {
    // A browser with storage blocked still plays; it just forgets what has been read.
  }
}
