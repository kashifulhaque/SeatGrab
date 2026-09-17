/**
 * What the shared table surface says, decided here rather than inside a component.
 *
 * Section 13.4 asks the table to separate voters, majority score, zone holdings,
 * resources and hand count, and 13.10 asks every zone and slot to state its threshold,
 * its counts and its empty areas to a screen reader. Both are derivations from one
 * `PlayerView`, so they live in a module a unit test can call, and the components below
 * only arrange what this file returns.
 *
 * Two rules hold throughout:
 *
 * 1. Everything here comes from the projection. No screen reads the authoritative state,
 *    because an online client will not have one.
 * 2. Ownership and state are always available as words. Colour and position are
 *    decoration on top of a sentence that already says who owns what.
 */
import { CORE_BOARD, type BoardSlot } from '@seatgrab/content';
import type {
  PendingDecisionView,
  PlayerView,
  PublicPlayerView,
  PublicSlotView,
  PublicZoneView,
} from '@seatgrab/protocol';

/** Board geometry by slot ID, for the drawn board and for the slot ordinals. */
export const SLOT_GEOMETRY: ReadonlyMap<string, BoardSlot> = new Map(
  CORE_BOARD.slots.map((slot) => [slot.slotId, slot]),
);

/**
 * The position of each slot within its own zone, counted from the board content.
 *
 * A player asked to look at "North West, area 4" needs a number that means the same
 * thing on every screen, and a slot ID is not that. The board record order is fixed by
 * the content pack, so this numbering is stable across matches and builds.
 */
export const SLOT_ORDINALS: ReadonlyMap<string, number> = (() => {
  const seen = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const slot of CORE_BOARD.slots) {
    const next = (seen.get(slot.zoneId) ?? 0) + 1;
    seen.set(slot.zoneId, next);
    ordinals.set(slot.slotId, next);
  }
  return ordinals;
})();

export interface ZoneHolding {
  playerId: string;
  displayName: string;
  partyId: string;
  /** Clockwise seat, so a tie in the zone is broken the way the table is seated. */
  seat: number;
  /** Voters this seat has in the zone, marked and unmarked together. */
  voters: number;
  /** Of those, the ones marked as counting toward the majority. */
  majorityVoters: number;
}

export interface ZoneSummary {
  /** `PublicZoneView.id`. A projected zone ID is a string on the wire, not a board enum. */
  id: string;
  displayName: string;
  capacity: number;
  majorityThreshold: number;
  filled: number;
  empty: number;
  volatileSlots: number;
  /** Seats with at least one voter here, most voters first, then by seat order. */
  holdings: readonly ZoneHolding[];
  majorityOwner: ZoneHolding | null;
  rightsOwner: ZoneHolding | null;
  /** The sentence a screen reader is given for the whole zone. */
  spoken: string;
}

function holdingFor(player: PublicPlayerView, voters: number, majorityVoters: number): ZoneHolding {
  return {
    playerId: player.id,
    displayName: player.displayName,
    partyId: player.partyId,
    seat: player.seat,
    voters,
    majorityVoters,
  };
}

/**
 * One zone, counted from the projected slots rather than from `zone.counts`.
 *
 * `counts` already carries the totals, but the table also needs the marked/unmarked
 * split and the empty-area count, and counting the slots once gives all three from the
 * same source instead of reconciling two.
 */
export function summarizeZone(
  zone: PublicZoneView,
  slots: readonly PublicSlotView[],
  players: readonly PublicPlayerView[],
): ZoneSummary {
  const zoneSlots = slots.filter((slot) => slot.zoneId === zone.id);
  const totals = new Map<string, { voters: number; majorityVoters: number }>();
  let filled = 0;
  for (const slot of zoneSlots) {
    if (slot.voter === undefined) continue;
    filled += 1;
    const running = totals.get(slot.voter.ownerId) ?? { voters: 0, majorityVoters: 0 };
    running.voters += 1;
    if (slot.voter.majority) running.majorityVoters += 1;
    totals.set(slot.voter.ownerId, running);
  }
  const holdings = players
    .flatMap((player) => {
      const running = totals.get(player.id);
      return running === undefined ? [] : [holdingFor(player, running.voters, running.majorityVoters)];
    })
    .sort((left, right) => right.voters - left.voters || left.seat - right.seat);

  const owner = (playerId: string | undefined): ZoneHolding | null => {
    if (playerId === undefined) return null;
    const known = holdings.find((holding) => holding.playerId === playerId);
    if (known !== undefined) return known;
    const player = players.find((candidate) => candidate.id === playerId);
    return player === undefined ? null : holdingFor(player, 0, 0);
  };

  const empty = zoneSlots.length - filled;
  const majorityOwner = owner(zone.majorityOwnerId);
  const rightsOwner = owner(zone.rightsOwnerId);
  const spokenHoldings = holdings.length === 0
    ? 'no voters yet'
    : holdings.map((holding) => `${holding.displayName} ${holding.voters}`).join(', ');
  const spokenMajority = majorityOwner === null
    ? 'no majority'
    : `majority ${majorityOwner.displayName}`;
  return {
    id: zone.id,
    displayName: zone.displayName,
    capacity: zone.capacity,
    majorityThreshold: zone.majorityThreshold,
    filled,
    empty,
    volatileSlots: zoneSlots.filter((slot) => slot.volatile).length,
    holdings,
    majorityOwner,
    rightsOwner,
    spoken: `${zone.displayName}, ${zone.majorityThreshold} of ${zone.capacity} required, `
      + `${spokenHoldings}, ${empty} empty, ${spokenMajority}.`,
  };
}

export function summarizeZones(view: PlayerView): readonly ZoneSummary[] {
  return view.zones.map((zone) => summarizeZone(zone, view.slots, view.players));
}

/** The sentence a single voter area is given, whether or not anything is on it. */
export function describeSlot(
  slot: PublicSlotView,
  zone: PublicZoneView | undefined,
  players: readonly PublicPlayerView[],
): string {
  const zoneName = zone?.displayName ?? slot.zoneId;
  const ordinal = SLOT_ORDINALS.get(slot.slotId);
  const where = `${zoneName}, area ${ordinal ?? slot.slotId}`;
  const volatile = slot.volatile ? ', volatile area' : '';
  if (slot.voter === undefined) {
    return `${where}${volatile}, empty.`;
  }
  const owner = players.find((player) => player.id === slot.voter?.ownerId);
  const who = owner?.displayName ?? slot.voter.ownerId;
  const marked = slot.voter.majority ? 'marked for majority' : 'not marked';
  return `${where}${volatile}, ${who} voter, ${marked}.`;
}

export interface PlayerSummary {
  player: PublicPlayerView;
  /** Voters this seat has on the board, marked and unmarked together. */
  boardVoters: number;
  /** Voters marked for a majority. This is the seat's score. */
  majorityVoters: number;
  /** Zones where this seat holds the majority. */
  zonesLed: readonly string[];
  /** Zones where this seat holds redistricting rights. */
  zonesWithRights: readonly string[];
  /** Zones where the seat has at least one voter. */
  zonesPresent: number;
  resourceTotal: number;
  /** True while the match is waiting on this seat. */
  deciding: boolean;
  /** True when it is this seat's turn, which is not always the same thing. */
  active: boolean;
}

export function summarizePlayers(
  view: PlayerView,
  zones: readonly ZoneSummary[],
): readonly PlayerSummary[] {
  const deciding = new Set(view.pendingDecision?.responsiblePlayerIds ?? []);
  return [...view.players]
    .sort((left, right) => left.seat - right.seat)
    .map((player) => {
      const present = zones.filter((zone) =>
        zone.holdings.some((holding) => holding.playerId === player.id));
      return {
        player,
        boardVoters: present.reduce(
          (total, zone) =>
            total + (zone.holdings.find((holding) => holding.playerId === player.id)?.voters ?? 0),
          0,
        ),
        majorityVoters: player.score,
        zonesLed: zones
          .filter((zone) => zone.majorityOwner?.playerId === player.id)
          .map((zone) => zone.displayName),
        zonesWithRights: zones
          .filter((zone) => zone.rightsOwner?.playerId === player.id)
          .map((zone) => zone.displayName),
        zonesPresent: present.length,
        resourceTotal: player.resources.cash + player.resources.influence
          + player.resources.press + player.resources.faith,
        deciding: deciding.has(player.id),
        active: view.activePlayerId === player.id,
      };
    });
}

/**
 * Who the table is waiting on, in words, for the banner section 13.4 asks to keep
 * conspicuous.
 *
 * The decision owner regularly differs from the active player — a reaction, an auction
 * bid and a campaign vote all move it — so the two are always reported separately, never
 * collapsed into "whose turn it is".
 */
export interface DecisionBanner {
  /** Short line naming the owner or owners: the heading of the banner. */
  news: string;
  /** The engine's own description of the decision, or a phase note when none is open. */
  detail: string;
  /** Seats being waited on, for marking them in the seat list. */
  waitingOn: readonly PublicPlayerView[];
  /** True when the pending decision belongs to someone other than the active seat. */
  awayFromActiveSeat: boolean;
}

function nameList(names: readonly string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/**
 * A seat's name as every list and banner prints it.
 *
 * A computer seat is marked in words rather than only by an icon, because who is playing
 * a seat changes how a person reads everything else on the screen. The mark is public:
 * `PublicPlayerView.controller` is projected for every viewer.
 *
 * A name that already says it — the default `Computer 2`, or anything a person typed with
 * the word in it — is left alone, because "Computer 2 (computer)" tells a reader nothing
 * the name did not.
 */
export function seatLabel(player: { displayName: string; controller?: string }): string {
  return marksComputer(player) ? `${player.displayName} (computer)` : player.displayName;
}

/**
 * Whether a seat needs a visible "computer" mark beside its name.
 *
 * False for a person, and false for a computer whose name already says so — the default
 * `Computer 2`, or anything a person typed with the word in it. Every list that draws the
 * mark as its own element asks this, so one rule decides it everywhere.
 */
export function marksComputer(player: { displayName: string; controller?: string }): boolean {
  return player.controller === 'computer' && !/computer/iu.test(player.displayName);
}

export function describeDecision(view: PlayerView): DecisionBanner {
  const decision: PendingDecisionView | undefined = view.pendingDecision;
  const active = view.activePlayerId === undefined
    ? undefined
    : view.players.find((player) => player.id === view.activePlayerId);
  const activeName = view.activePlayerId === undefined
    ? null
    : active === undefined ? view.activePlayerId : seatLabel(active);

  if (decision === undefined) {
    return {
      news: activeName === null ? 'No seat is acting yet' : `${activeName} is acting`,
      detail: view.status === 'finished'
        ? 'The match is over.'
        : view.phase === 'action' && activeName !== null
          ? `${activeName} may buy voters, use powers, or end the turn.`
          : `${describePhase(view)} phase; no decision is pending.`,
      waitingOn: [],
      awayFromActiveSeat: false,
    };
  }
  const waitingOn = decision.responsiblePlayerIds.flatMap((playerId) => {
    const player = view.players.find((candidate) => candidate.id === playerId);
    return player === undefined ? [] : [player];
  });
  const names = waitingOn.map(seatLabel);
  const awayFromActiveSeat = view.activePlayerId !== undefined
    && !decision.responsiblePlayerIds.includes(view.activePlayerId);
  return {
    news: waitingOn.length === 1
      ? `Waiting on ${names[0]!}`
      : `Waiting on ${nameList(names)}`,
    detail: decision.summary,
    waitingOn,
    awayFromActiveSeat,
  };
}

/**
 * The same banner as the revealed seat reads it: "you" wherever that seat is named.
 *
 * The shared surface names every seat in the third person because anyone at the table
 * may be reading it. A revealed seat is one person, and "Waiting on Chandni" read by
 * Chandni is one more thing to decode. Everything else is unchanged, so the privacy rule
 * the status bar test asserts still holds: nothing here reads a private field.
 */
export function describeDecisionFor(view: PlayerView, seatId: string): DecisionBanner {
  const banner = describeDecision(view);
  if (banner.waitingOn.some((player) => player.id === seatId)) {
    const others = banner.waitingOn
      .filter((player) => player.id !== seatId)
      .map(seatLabel);
    return {
      ...banner,
      news: others.length === 0 ? 'Waiting on you' : `Waiting on you, ${nameList(others)}`,
    };
  }
  if (view.pendingDecision === undefined && view.status !== 'finished' && view.activePlayerId === seatId) {
    return {
      ...banner,
      news: 'Your turn',
      detail: view.phase === 'action' ? 'Buy voters, use powers, or end your turn.' : banner.detail,
    };
  }
  return banner;
}

/** Deck and market counts, phrased so a reader never has to guess what a number counts. */
export function describeDecks(view: PlayerView): readonly { label: string; value: string }[] {
  return [
    { label: 'Voter market', value: `${view.voterCards.length} face up` },
    { label: 'Voter draw pile', value: `${view.deckCounts.voter} cards` },
    { label: 'Policy draw pile', value: `${view.deckCounts.policy} cards` },
    { label: 'News draw pile', value: `${view.deckCounts.news} cards` },
    { label: 'Trick draw pile', value: `${view.deckCounts.trick} cards` },
  ];
}

/* ------------------------------------------------------------ status bar */

/**
 * The engine's phase names in the words a player uses.
 *
 * `view.phase` is the engine's own identifier and is kept on the wire unchanged; this is
 * the one place it is translated, so the status bar and every reason that names a phase
 * agree. An unknown phase falls back to the identifier rather than to a guess.
 */
const PHASE_LABELS: Readonly<Record<string, string>> = {
  firstPlayerElection: 'First-player vote',
  startingResources: 'Starting resources',
  beforeAnswer: 'Start of turn',
  policyAnswer: 'Policy question',
  resourceCap: 'Resource cap',
  action: 'Actions',
  endTurn: 'End of turn',
  newsResolution: 'News',
  finished: 'Final',
};

export function describePhase(view: PlayerView): string {
  return PHASE_LABELS[view.phase] ?? view.phase;
}

/** `Turn 4 · Actions`, `Setup · First-player vote`, or `Final`. */
export function describeTurn(view: PlayerView): string {
  if (view.status === 'finished') return 'Final';
  if (view.status === 'setup' || view.turnOrdinal === 0) return `Setup · ${describePhase(view)}`;
  return `Turn ${view.turnOrdinal} · ${describePhase(view)}`;
}

/**
 * The seat that needs the device next: the first seat a decision is waiting on, or the
 * active seat when nothing is pending. `null` once the match is over or before a seat is
 * acting at all.
 */
export function mustActSeat(view: PlayerView): PublicPlayerView | null {
  if (view.status === 'finished') return null;
  const decision = describeDecision(view);
  const waiting = decision.waitingOn[0];
  if (waiting !== undefined) return waiting;
  if (view.activePlayerId === undefined) return null;
  return view.players.find((player) => player.id === view.activePlayerId) ?? null;
}

/* ------------------------------------------------------------ turn steps */

/**
 * A turn as the three steps a player takes, so a first-time player can see where in
 * the turn the table is without knowing the engine's phase names.
 *
 * The steps are the turn order: answer the policy question, buy and place
 * voters, end the turn. Setup has its own two steps. Each engine phase maps onto exactly
 * one step; a phase this build does not know falls back to the phase identifier as a
 * single current step rather than guessing.
 */
export interface TurnStep {
  id: string;
  /** Short enough for a pill: "Answer", "Buy and place", "End turn". */
  label: string;
  state: 'done' | 'current' | 'todo';
}

const SETUP_STEPS: readonly { id: string; label: string; phases: readonly string[] }[] = [
  { id: 'vote', label: 'Vote for first player', phases: ['firstPlayerElection'] },
  { id: 'resources', label: 'Take starting resources', phases: ['startingResources'] },
];

const TURN_STEPS: readonly { id: string; label: string; phases: readonly string[] }[] = [
  { id: 'answer', label: 'Answer the question', phases: ['beforeAnswer', 'policyAnswer', 'resourceCap'] },
  { id: 'act', label: 'Buy and place voters', phases: ['action'] },
  { id: 'end', label: 'End turn', phases: ['endTurn', 'newsResolution'] },
];

export function turnSteps(view: PlayerView): readonly TurnStep[] {
  if (view.status === 'finished') return [{ id: 'final', label: 'Final', state: 'current' }];
  const setup = view.status === 'setup' || view.turnOrdinal === 0;
  const steps = setup ? SETUP_STEPS : TURN_STEPS;
  const currentIndex = steps.findIndex((step) => step.phases.includes(view.phase));
  if (currentIndex < 0) return [{ id: view.phase, label: describePhase(view), state: 'current' }];
  return steps.map((step, index) => ({
    id: step.id,
    label: step.label,
    state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo',
  }));
}

/** `Step 2 of 3 · Buy and place voters`, for a phone that has no room for the pills. */
export function describeStep(view: PlayerView): string {
  const steps = turnSteps(view);
  const current = steps.findIndex((step) => step.state === 'current');
  if (steps.length === 1 || current < 0) return steps[0]?.label ?? '';
  return `Step ${current + 1} of ${steps.length} · ${steps[current]!.label}`;
}
