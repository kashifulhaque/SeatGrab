/**
 * What an ordinary action needs before it can be submitted, decided outside React.
 *
 * Section 13.7 asks a purchase or a target to be composed step by step, with the final
 * cost, the legal targets and the reason an illegal one is illegal all visible before
 * anything is spent. Those are derivations from one `PlayerView` plus the printed board,
 * so they live here rather than inside a component, and a unit test can drive a whole
 * composition without rendering anything.
 *
 * Three rules hold throughout this file:
 *
 * 1. The engine decides. Everything here is guidance for the player composing a command:
 *    `applyCommand` re-validates every payment and every target, and its rejection is
 *    what a player is shown when the two disagree. Nothing here may be the last word.
 * 2. Everything comes from the projection and from the content pack. No screen reads the
 *    authoritative state, because an online client will not have one.
 * 3. A target set is never "everything". An empty set means no target is legal, which is
 *    a fact worth showing, not an invitation to try anything.
 */
import {
  TRICK_CARDS,
  NEWS_CARDS,
  POLICY_CARDS,
  CORE_BOARD,
  ARCHETYPE_RESOURCE,
  ARCHETYPES,
  RESOURCE_TYPES,
  VOTER_CARDS,
  type Cost,
  type Archetype,
  type ResourceType,
} from '@gerrymander/content';
import type {
  ChoiceSelection,
  GameCommand,
  PlayerView,
  PublicSlotView,
  ResourceVectorDto,
  StructuredChoicePromptView,
  TradeOfferView,
} from '@gerrymander/protocol';

import { SLOT_ORDINALS, describePhase } from './table.js';

export const RESOURCE_ORDER = RESOURCE_TYPES;

export const NO_RESOURCES: ResourceVectorDto = { cash: 0, influence: 0, press: 0, faith: 0 };

/**
 * Effect kinds the composers have to recognize.
 *
 * These are the engine's own names for three effects a client must price or count, and
 * they are the same strings `packages/engine/src/rules` matches on. The composers used to
 * match the printed title instead, because `activeEffects` published only that; the
 * coupling never broke anything, since both sides read one content pack, but retitling a
 * card would have quietly changed a quoted purchase price. The engine still re-checks
 * every one of them, so a disagreement surfaces as its rejection.
 */
const TABLOID_SCANDAL = 'tabloidScandal';
const GRAND_COALITION = 'grandCoalition';
const BACKROOM_DEAL = 'backroomDeal';

const ZONE_BY_ID = new Map(CORE_BOARD.zones.map((zone) => [zone.id as string, zone]));

export function totalOf(resources: ResourceVectorDto): number {
  return resources.cash + resources.influence + resources.press + resources.faith;
}

export function withResource(
  resources: ResourceVectorDto,
  resource: ResourceType,
  amount: number,
): ResourceVectorDto {
  return { ...resources, [resource]: Math.max(0, Math.trunc(amount)) };
}

/** `2 cash, 1 influence`, or `nothing` — never an empty string in the middle of a sentence. */
export function describeResources(resources: ResourceVectorDto): string {
  const parts = RESOURCE_ORDER.filter((resource) => resources[resource] > 0).map(
    (resource) => `${resources[resource]} ${resource}`,
  );
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

/** `North West, area 4`. The ordinal is stable across matches, the slot ID is not. */
export function describeSlotTarget(slotId: string): string {
  const slot = CORE_BOARD.slots.find((candidate) => candidate.slotId === slotId);
  if (slot === undefined) return slotId;
  const zone = ZONE_BY_ID.get(slot.zoneId);
  return `${zone?.displayName ?? slot.zoneId}, area ${SLOT_ORDINALS.get(slotId) ?? '?'}`;
}

export function zoneName(zoneId: string): string {
  return ZONE_BY_ID.get(zoneId)?.displayName ?? zoneId;
}

/** The zone an area belongs to, read off the board rather than off a projection. */
export function zoneOfSlot(slotId: string): string | null {
  return CORE_BOARD.slots.find((candidate) => candidate.slotId === slotId)?.zoneId ?? null;
}

/** `matchingEffect` in `packages/engine/src/rules/effectModifiers.ts`, read off the view. */
function effectTouches(view: PlayerView, kind: string, playerId: string): boolean {
  return view.activeEffects.some(
    (effect) => effect.kind === kind
      && (effect.ownerId === playerId || effect.targetPlayerIds.includes(playerId)),
  );
}

function slotById(view: PlayerView): Map<string, PublicSlotView> {
  return new Map(view.slots.map((slot) => [slot.slotId, slot]));
}

function slotOfVoter(view: PlayerView, voterId: string): PublicSlotView | undefined {
  return view.slots.find((slot) => slot.voter?.id === voterId);
}

/* ------------------------------------------------------------------ payments */

/**
 * A price being allocated: what the player spends, and what an effect removes.
 *
 * `discounts` is the Volunteers allowance. It is not a payment in a second currency;
 * it is the part of the printed price that is not paid at all.
 */
export interface PaymentDraft {
  resources: ResourceVectorDto;
  discounts: ResourceVectorDto;
}

export const NO_PAYMENT: PaymentDraft = { resources: NO_RESOURCES, discounts: NO_RESOURCES };

export function printedTotal(cost: Cost): number {
  return cost.cash + cost.influence + cost.press + cost.faith + cost.generic;
}

/** One resource type of a price being allocated, for a stepper that says what is wrong. */
export interface PaymentRow {
  resource: ResourceType;
  /** Units the printed price names in this type. Zero when the type only covers `?`. */
  named: number;
  /** Units allocated to this type, paid and discounted together. */
  covered: number;
  held: number;
  /** Why this row is wrong, or `null`. Placed beside the stepper, not after the list. */
  problem: string | null;
}

/**
 * A price being allocated, broken down the way the composer draws it.
 *
 * Section 13.7 wants the shortfall beside the stepper that is short, and a stepper only
 * for the resource types the price actually names. `rows` lists those: every named type,
 * and — when the price has a `?` part — every type the seat holds, since any of them can
 * pay it. A type with something already allocated stays listed so it can be taken back.
 *
 * `problem` is the first problem in the order the engine checks them, which is what
 * `paymentProblem` has always returned and what the Confirm button reads.
 */
export interface PaymentBreakdown {
  rows: readonly PaymentRow[];
  /** The `?` part of the price, or `null` when the price names every unit. */
  generic: { required: number; covered: number; problem: string | null } | null;
  discountProblem: string | null;
  problem: string | null;
}

export function paymentBreakdown(
  cost: Cost,
  payment: PaymentDraft,
  held: ResourceVectorDto,
  maximumDiscount: number,
): PaymentBreakdown {
  const discountsUsed = totalOf(payment.discounts);
  const discountProblem = discountsUsed > maximumDiscount
    ? maximumDiscount === 0
      ? 'No discount is available for this price.'
      : `Volunteers can remove only ${maximumDiscount} from this price.`
    : null;

  const overdrawn = new Map<ResourceType, string>();
  const short = new Map<ResourceType, string>();
  let namedCovered = 0;
  for (const resource of RESOURCE_ORDER) {
    if (payment.resources[resource] > held[resource]) {
      overdrawn.set(resource, `You hold ${held[resource]} ${resource}, not ${payment.resources[resource]}.`);
    }
    const covered = payment.resources[resource] + payment.discounts[resource];
    if (covered < cost[resource]) {
      short.set(resource, `This price needs ${cost[resource]} ${resource}; ${covered} allocated.`);
    }
    namedCovered += Math.min(covered, cost[resource]);
  }
  const allocated = totalOf(payment.resources) + discountsUsed;
  const total = printedTotal(cost);
  const totalProblem = allocated < total
    ? `Allocate ${total - allocated} more for the ? icons.`
    : allocated > total
      ? `Remove ${allocated - total}; this price is ${total} in total.`
      : null;

  const rows = RESOURCE_ORDER.flatMap((resource): PaymentRow[] => {
    const covered = payment.resources[resource] + payment.discounts[resource];
    const listed = cost[resource] > 0
      || (cost.generic > 0 && held[resource] > 0)
      || covered > 0;
    if (!listed) return [];
    return [{
      resource,
      named: cost[resource],
      covered,
      held: held[resource],
      problem: overdrawn.get(resource) ?? short.get(resource) ?? null,
    }];
  });

  const generic = cost.generic === 0
    ? null
    : {
      required: cost.generic,
      covered: Math.max(0, allocated - namedCovered),
      problem: short.size === 0 && overdrawn.size === 0 ? totalProblem : null,
    };

  const problem = discountProblem
    ?? RESOURCE_ORDER.map((resource) => overdrawn.get(resource)).find((p) => p !== undefined)
    ?? RESOURCE_ORDER.map((resource) => short.get(resource)).find((p) => p !== undefined)
    ?? totalProblem;

  return { rows, generic, discountProblem, problem };
}

/**
 * Why this allocation is not yet the printed price, or `null` when it is exact.
 *
 * This mirrors `validatePayment` in `packages/engine/src/rules/resources.ts`. It exists
 * so the composer can show a running shortfall instead of offering a Confirm that will
 * certainly be refused; the engine remains the authority on whether a payment is legal.
 */
const RESOURCE_LABELS: Readonly<Record<ResourceType, string>> = {
  cash: 'Cash',
  influence: 'Influence',
  press: 'Press',
  faith: 'Faith',
};

/**
 * A way to pay `cost` out of `held`, or `null` when there is none.
 *
 * The named parts of the price are paid in kind. The `?` parts are then taken from what
 * is left, largest holding first, so the suggestion spends what the player has most of
 * and keeps the scarce types. It is a suggestion: the steppers stay editable, and the
 * engine checks the payment it is finally sent.
 */
export function suggestedPayment(cost: Cost, held: ResourceVectorDto): ResourceVectorDto | null {
  const payment: ResourceVectorDto = { ...NO_RESOURCES };
  const left: ResourceVectorDto = { ...held };
  for (const resource of RESOURCE_ORDER) {
    if (left[resource] < cost[resource]) return null;
    payment[resource] += cost[resource];
    left[resource] -= cost[resource];
  }
  let generic = cost.generic;
  const byHolding = [...RESOURCE_ORDER].sort((a, b) => left[b] - left[a]);
  for (const resource of byHolding) {
    const take = Math.min(generic, left[resource]);
    payment[resource] += take;
    left[resource] -= take;
    generic -= take;
  }
  return generic === 0 ? payment : null;
}

/** The named part of a price, paid as far as the holding allows, so the short stepper shows the gap. */
function partialPayment(cost: Cost, held: ResourceVectorDto): ResourceVectorDto {
  const payment: ResourceVectorDto = { ...NO_RESOURCES };
  for (const resource of RESOURCE_ORDER) {
    payment[resource] = Math.min(cost[resource], held[resource]);
  }
  return payment;
}

/**
 * The payment a purchase composer opens with.
 *
 * The first playtest opened every purchase at zero and made the player click a stepper
 * for each unit of a price that was already printed on the card. This opens with the
 * printed price allocated when the seat can pay it, and with as much of it as the seat
 * can cover otherwise, so the one stepper that is short says so at once. Discounts start
 * empty: Volunteers is the player's choice, not a default.
 */
export function openingPayment(cost: Cost, held: ResourceVectorDto): PaymentDraft {
  return {
    resources: suggestedPayment(cost, held) ?? partialPayment(cost, held),
    discounts: NO_RESOURCES,
  };
}

/** Whether a holding covers a price, before the composer is opened. */
export interface Affordability {
  /** True when the price can be paid outright, or with the discount allowed. */
  can: boolean;
  /** True when only the discount makes it payable. */
  viaDiscount: boolean;
  /** The gap in words when it cannot be paid outright: `Short 1 Faith.` */
  short: string | null;
}

export function affordability(
  cost: Cost,
  held: ResourceVectorDto,
  maximumDiscount = 0,
): Affordability {
  if (suggestedPayment(cost, held) !== null) return { can: true, viaDiscount: false, short: null };
  const gaps: string[] = [];
  let units = 0;
  let spare = 0;
  for (const resource of RESOURCE_ORDER) {
    const gap = cost[resource] - held[resource];
    if (gap > 0) {
      gaps.push(`${gap} ${RESOURCE_LABELS[resource]}`);
      units += gap;
    } else {
      spare += -gap;
    }
  }
  const genericGap = cost.generic - spare;
  if (genericGap > 0) {
    gaps.push(`${genericGap} more of any type`);
    units += genericGap;
  }
  return {
    can: units <= maximumDiscount,
    viaDiscount: units <= maximumDiscount,
    short: `Short ${nameList(gaps)}.`,
  };
}

export function paymentProblem(
  cost: Cost,
  payment: PaymentDraft,
  held: ResourceVectorDto,
  maximumDiscount: number,
): string | null {
  return paymentBreakdown(cost, payment, held, maximumDiscount).problem;
}

/* --------------------------------------------------------------- seat order */

/**
 * The clockwise turn order, starting at the seat that is currently acting.
 *
 * `createGame` seats players in the physical order they were configured in, and the
 * first-player election rotates that same cycle so the winner leads. The projection
 * publishes the physical seat and who is acting, which is the cycle and its current
 * start, so no order has to be published separately.
 */
export function turnOrderIds(view: PlayerView): readonly string[] {
  const seats = [...view.players].sort((left, right) => left.seat - right.seat).map((p) => p.id);
  const start = view.activePlayerId === undefined ? -1 : seats.indexOf(view.activePlayerId);
  return start < 0 ? seats : [...seats.slice(start), ...seats.slice(0, start)];
}

/**
 * Starting resources this seat takes: one for the first player, two for the next, and so
 * on clockwise. Meaningful only while setup is choosing them, when the acting seat is
 * still the elected first player.
 */
export function startingResourceQuota(view: PlayerView, seatId: string): number {
  return turnOrderIds(view).indexOf(seatId) + 1;
}

/* ------------------------------------------------- archetypes, income, powers */

/**
 * Archetype cards that count for this seat, Turncoat included.
 *
 * `policyCounts` is the seat's own kept cards. Turncoat is an extra card of a chosen
 * archetype that a rival can buy away, so it counts toward a level but is not owned in
 * the way a kept card is; `powerStatuses` marks a power that needs it as borrowed.
 */
export function effectivePolicyCounts(
  view: PlayerView,
  seatId: string,
): Record<Archetype, number> {
  const player = view.players.find((candidate) => candidate.id === seatId);
  const counts: Record<Archetype, number> = {
    corporate: player?.policyCounts.corporate ?? 0,
    nationalist: player?.policyCounts.nationalist ?? 0,
    populist: player?.policyCounts.populist ?? 0,
    reformer: player?.policyCounts.reformer ?? 0,
  };
  for (const holding of view.turncoatHoldings) {
    if (holding.ownerId === seatId) counts[holding.archetype] += 1;
  }
  return counts;
}

/** Resources a seat is paid at the start of its turn: one per two cards, per archetype. */
export function passiveIncome(view: PlayerView, seatId: string): ResourceVectorDto {
  const counts = effectivePolicyCounts(view, seatId);
  const income = { ...NO_RESOURCES };
  for (const archetype of ARCHETYPES) {
    income[ARCHETYPE_RESOURCE[archetype]] += Math.floor(counts[archetype] / 2);
  }
  return income;
}

/** Grand Coalition doubles every printed level 3 per-turn limit for its owner. */
export function level3Limit(view: PlayerView, seatId: string, printed: number): number {
  return view.activeEffects.some(
    (effect) => effect.kind === GRAND_COALITION && effect.ownerId === seatId,
  )
    ? printed * 2
    : printed;
}

/**
 * Exactly how much Arbitrage takes, and how much of each type the reserve can pay it.
 *
 * `UseProspecting` in `packages/engine/src/flow/applyCommand.ts`, read off the view. The
 * returned resource goes back to the reserve before the gain is taken, so it counts
 * towards both figures: a seat returning its last cash may take that cash straight back.
 * The engine takes `min(2, what the reserve then holds)` and refuses any other total,
 * which is why this is a required figure rather than a maximum — the composer used to
 * accept one or two and let the refusal name which.
 */
export function arbitrageLimits(
  view: PlayerView,
  payment: ResourceVectorDto,
): { required: number; perResource: ResourceVectorDto } {
  const perResource = { ...NO_RESOURCES };
  for (const resource of RESOURCE_ORDER) {
    perResource[resource] = view.publicReserve[resource] + payment[resource];
  }
  return { required: Math.min(2, totalOf(perResource)), perResource };
}

/** Discount still available inside this turn's purchases, or zero without the power. */
export function volunteersRemaining(view: PlayerView, seatId: string): number {
  if (effectivePolicyCounts(view, seatId).reformer < 3) return 0;
  return Math.max(0, level3Limit(view, seatId, 2) - view.turnUsage.volunteers);
}

export type PowerId =
  | 'arbitrage'
  | 'shakedown'
  | 'groundswell'
  | 'volunteers'
  | 'demolition'
  | 'crackdown'
  | 'landslide'
  | 'outreach';

export interface PowerStatus {
  id: PowerId;
  label: string;
  archetype: Archetype;
  level: 3 | 5;
  /**
   * How the power reaches the engine.
   *
   * A `modifier` is a flag inside another command — a checkbox on a purchase, a discount
   * in its payment, a second move under existing rights. Section 13.6 forbids giving one
   * a standalone button, because the button would do nothing on its own.
   */
  submission: 'command' | 'modifier';
  unlocked: boolean;
  /** Unlocked only because Turncoat is currently sitting on this archetype. */
  borrowed: boolean;
  /** True while a Backroom Deal may be lending this level 3 power. The engine decides. */
  lendable: boolean;
  held: number;
  requirement: string;
  effect: string;
  /** Per-turn allowance, when the power has one. Landslide's is per zone instead. */
  usage?: { used: number; limit: number };
}

/**
 * The eight printed powers for one seat, as the player mat in 13.6 asks for them.
 *
 * Usage counts describe the turn in progress, so they mean what they say only for the
 * active seat; the mat draws them only there.
 */
export function powerStatuses(view: PlayerView, seatId: string): readonly PowerStatus[] {
  const counts = effectivePolicyCounts(view, seatId);
  const turncoat = new Set(
    view.turncoatHoldings.filter((holding) => holding.ownerId === seatId).map((h) => h.archetype),
  );
  const own = view.players.find((candidate) => candidate.id === seatId)?.policyCounts;
  const lendable = effectTouches(view, BACKROOM_DEAL, seatId);
  const usage = view.turnUsage;

  const status = (
    id: PowerId,
    label: string,
    archetype: Archetype,
    level: 3 | 5,
    submission: 'command' | 'modifier',
    effect: string,
    allowance?: { used: number; limit: number },
  ): PowerStatus => {
    const held = counts[archetype];
    const ownHeld = own?.[archetype] ?? 0;
    return {
      id,
      label,
      archetype,
      level,
      submission,
      unlocked: held >= level,
      borrowed: held >= level && ownHeld < level && turncoat.has(archetype),
      lendable: level === 3 && held < level && lendable,
      held,
      requirement: `${level} ${archetype} cards`,
      effect,
      ...(allowance === undefined ? {} : { usage: allowance }),
    };
  };

  return [
    status('arbitrage', 'Arbitrage', 'corporate', 3, 'command',
      'Return one resource to the reserve and take two of your choice.',
      { used: usage.arbitrage, limit: level3Limit(view, seatId, 1) }),
    status('shakedown', 'Shakedown', 'nationalist', 3, 'command',
      'Take one resource of your choice from an opponent.',
      { used: usage.shakedown, limit: level3Limit(view, seatId, 2) }),
    status('groundswell', 'Groundswell', 'populist', 3, 'modifier',
      'A voter card you influence yields one extra voter for the same price.',
      { used: usage.groundswell, limit: level3Limit(view, seatId, 2) }),
    status('volunteers', 'Volunteers', 'reformer', 3, 'modifier',
      'Remove resources from a price you are paying instead of spending them.',
      { used: usage.volunteers, limit: level3Limit(view, seatId, 2) }),
    status('demolition', 'Demolition', 'corporate', 5, 'command',
      'Evict a voter from a non-volatile area.',
      { used: usage.demolition, limit: 3 }),
    status('crackdown', 'Crackdown', 'nationalist', 5, 'command',
      'Pay one resource to discard an opponent voter from a non-volatile area.',
      { used: usage.crackdown, limit: 2 }),
    status('landslide', 'Landslide', 'populist', 5, 'modifier',
      'Each zone you hold rights in authorizes a second move, and a marked voter may move.'),
    status('outreach', 'Outreach', 'reformer', 5, 'command',
      'Pay 2 faith and 2 of your choice to convert two of one opponent’s voters in one zone.',
      { used: usage.outreach, limit: 1 }),
  ];
}

/* ------------------------------------------------------------- voter purchase */

/** The printed price of a market card plus any surcharge an effect has put on it. */
export function purchaseCost(view: PlayerView, seatId: string, cardId: string): Cost | null {
  const card = view.voterCards.find((candidate) => candidate.id === cardId);
  if (card === undefined) return null;
  const surcharge = effectTouches(view, TABLOID_SCANDAL, seatId) ? 1 : 0;
  return { ...card.cost, generic: card.cost.generic + surcharge };
}

/**
 * Voter tokens this seat still has in supply, or `null` when the view is not its own.
 *
 * `null` is not zero. A public projection carries no supply figure at all, and a composer
 * reading one must fall back to letting the engine rule rather than declaring every
 * purchase impossible.
 */
export function voterSupply(view: PlayerView): number | null {
  return view.privateVoterSupply ?? null;
}

/**
 * Tokens a purchase of this market card would take out of supply.
 *
 * Groundswell adds a voter to the card rather than to the price, so it is the one modifier
 * that changes the figure. `null` when the card is no longer face up.
 */
export function purchaseVoterCount(
  view: PlayerView,
  cardId: string,
  groundswell: boolean,
): number | null {
  const card = view.voterCards.find((candidate) => candidate.id === cardId);
  return card === undefined ? null : card.voters + (groundswell ? 1 : 0);
}

/**
 * Why this seat's supply cannot cover `needed` tokens, or `null` when it can.
 *
 * Every phrasing of this refusal used to arrive from the engine after the click. The
 * projection now carries the figure, so the composer says it first — which is what a
 * player reading their own token pile does.
 */
export function supplyProblem(view: PlayerView, needed: number): string | null {
  const supply = voterSupply(view);
  if (supply === null || supply >= needed) return null;
  return `You have ${supply} voter token${supply === 1 ? '' : 's'} left, not ${needed}.`;
}

/**
 * What this seat pays for the top trick, or `null` when the draw pile is empty.
 *
 * The engine projects both the printed price and the payable one, so this reads the
 * payable figure rather than reapplying a surcharge the view already counted. Nothing here
 * knows which card it is; that is the point of buying off the top of a face-down pile.
 */
export function trickCost(view: PlayerView): Cost | null {
  return view.trickMarket?.payable ?? null;
}

/** Zones with room for a whole group, for the placement note section 13.7 asks for. */
export function placementZoneIds(view: PlayerView, count: number): readonly string[] {
  return view.zones
    .filter((zone) =>
      view.slots.filter((slot) => slot.zoneId === zone.id && slot.voter === undefined).length
        >= count)
    .map((zone) => zone.id);
}

/* ------------------------------------------------------------- availability */

/** Whether a control may act now, and the reason it may not, in the player's words. */
export interface Availability {
  can: boolean;
  /** `null` when `can` is true. Never an engine code: always a sentence. */
  reason: string | null;
}

function nameList(names: readonly string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/**
 * Why `action` is absent from this seat's `legalActions`, when it is.
 *
 * `getLegalActions` answers with names and no reasons, so a disabled control used to say
 * nothing, or say only the one thing the composer happened to know. The reasons here are
 * read off the same public facts the engine's table reads — the status, the pending
 * decision, the active seat and the phase — in the order that table checks them, so the
 * first thing that would stop the command is the thing named. The engine still rules.
 */
export function actionAvailability(view: PlayerView, seatId: string, action: string): Availability {
  if (view.legalActions.includes(action)) return { can: true, reason: null };
  if (view.status === 'finished') return { can: false, reason: 'The match is over.' };
  const decision = view.pendingDecision;
  if (decision !== undefined) {
    const names = decision.responsiblePlayerIds.map((playerId) => playerName(view, playerId));
    return decision.responsiblePlayerIds.includes(seatId)
      ? { can: false, reason: `Answer your prompt first: ${decision.summary}` }
      : { can: false, reason: `Waiting on ${nameList(names)}: ${decision.summary}` };
  }
  if (view.activePlayerId === undefined) {
    return { can: false, reason: 'No seat is acting yet.' };
  }
  if (view.activePlayerId !== seatId) {
    return { can: false, reason: `It is ${playerName(view, view.activePlayerId)}’s turn, not yours.` };
  }
  if (view.phase !== 'action') {
    return {
      can: false,
      reason: `Actions are taken in the action phase; this is ${describePhase(view).toLowerCase()}.`,
    };
  }
  return { can: false, reason: 'The engine is not offering this action right now.' };
}

/**
 * Whether the turn may end, with the reason it may not.
 *
 * A due voter group is the one refusal `RequestEndTurn` can meet while it is still listed
 * as legal — `getLegalActions` lists commands by phase, and `applyEndTurn` then refuses a
 * turn with a group still due — so it is checked here first, against the same deadline
 * the engine reads.
 */
export function endTurnAvailability(view: PlayerView, seatId: string): Availability {
  const listed = actionAvailability(view, seatId, 'RequestEndTurn');
  if (!listed.can) return listed;
  const due = dueGroupIds(view, seatId);
  if (due.length > 0) {
    return {
      can: false,
      reason: `Place or discard the ${due.length === 1 ? 'waiting voter group' : `${due.length} waiting voter groups`} first.`,
    };
  }
  return listed;
}

/**
 * What this seat should do now, in two lines: a short heading and one sentence.
 *
 * A first-time player, handed the device, has to find the one thing the match wants from
 * them among a prompt, a market, a list of powers and a board. This says it once, at the
 * top of the action column, and says the next thing once that is done. It reads the
 * same facts the controls read — the prompt, the pending decision, the active seat, the
 * phase, the waiting voter groups and the open draft — so it never points at a control
 * that is not there.
 */
export interface Guidance {
  news: string;
  detail: string;
}

export function guidance(view: PlayerView, seatId: string, draft: ActionDraft): Guidance {
  if (view.status === 'finished') {
    return { news: 'The match is over', detail: 'The final scores are above.' };
  }
  const prompt = view.prompt;
  if (prompt !== undefined) {
    switch (prompt.kind) {
      case 'firstPlayerVote':
        return {
          news: 'Vote for who goes first',
          detail: 'Pick another player below. Nobody may vote for themselves, and a tie is voted again.',
        };
      case 'startingResources':
        return {
          news: 'Take your starting resources',
          detail: 'Choose any mix of the four types. Seats later in the order take more.',
        };
      case 'policyAnswer':
        return {
          news: 'Answer the question',
          detail: 'Choose the answer you agree with. Each answer secretly belongs to one of your four '
            + 'archetypes and pays you the resources printed on it.',
        };
      case 'capDiscard':
        return {
          news: 'Discard down to your cap',
          detail: 'You hold more than your cap allows. Choose what to give back before anything else happens.',
        };
      case 'majoritySelection':
        return {
          news: 'Mark your majority',
          detail: 'You reached a majority. Choose which of your voters count for it; those voters score.',
        };
      case 'choice':
        return { news: 'Resolve the card', detail: prompt.explanation };
    }
  }
  const decision = view.pendingDecision;
  if (decision !== undefined) {
    if (decision.responsiblePlayerIds.includes(seatId)) {
      return { news: 'Waiting on you', detail: decision.summary };
    }
    const names = decision.responsiblePlayerIds.map((playerId) => playerName(view, playerId));
    return {
      news: `Waiting on ${nameList(names)}`,
      detail: `${decision.summary} Nothing is needed from you yet.`,
    };
  }
  if (view.activePlayerId !== seatId) {
    const active = view.activePlayerId === undefined ? 'Nobody' : playerName(view, view.activePlayerId);
    return {
      news: `${active}’s turn`,
      detail: 'Wait for your turn. You may be offered a trade, and you can play a trick right '
        + 'before another player answers their question.',
    };
  }
  if (view.phase === 'action') {
    if (view.pendingVoterGroups.some((group) => group.controllerId === seatId)) {
      return {
        news: 'Place your voters',
        detail: 'Choose an area on the board for each waiting voter. Voters from one card go in one '
          + 'zone, and any left unplaced are lost when the turn ends.',
      };
    }
    if (draft.kind !== 'none') {
      return { news: 'Finish your action', detail: 'Complete the open action below, or cancel it.' };
    }
    return {
      news: 'Your turn',
      detail: 'Buy voter cards from the market and place their voters in one zone. Use any power you '
        + 'have unlocked. End your turn when you are done.',
    };
  }
  return { news: 'Your turn', detail: `${describePhase(view)}.` };
}

/**
 * True when the trades, reactions and debts panel has something this seat must look at:
 * an offer to answer, a debt or obligation to settle, a voter of theirs held by a rival,
 * or a campaign action already being composed. The panel is collapsed otherwise.
 */
export function campaignAttention(view: PlayerView, seatId: string, draft: ActionDraft): boolean {
  if (draft.kind === 'trade' || draft.kind === 'debt' || draft.kind === 'stealBase') return true;
  if (tradeOffers(view, seatId).theirs.length > 0) return true;
  if ((view.privateDebts ?? []).length > 0) return true;
  if ((view.privateObligations ?? []).length > 0) return true;
  return (view.privateHeldVoters ?? []).length > 0;
}

/* ---------------------------------------------------------------- the drafts */

/**
 * An action being composed. `none` is the resting state: no action is open, nothing is
 * highlighted on the board, and no resource is reserved.
 */
export type ActionDraft =
  | { kind: 'none' }
  | { kind: 'influence'; cardId: string; groundswell: boolean; payment: PaymentDraft }
  | { kind: 'trick'; payment: PaymentDraft }
  | {
    kind: 'place';
    groupId: string;
    slotIds: readonly string[];
    /**
     * The zone the placement has been narrowed to, or absent for the whole board.
     *
     * Placing a card's voters is a choice of *zone* first — the rule is that they go in
     * one — and only then of areas inside it. Ringing all 126 empty areas at once put the
     * real decision behind a hundred equal-looking ones. This narrows what the board
     * rings; it forbids nothing the engine allows, and clearing it returns the whole
     * legal set. `legalPlacementSlotIds` is still what says which areas are legal.
     */
    zoneId?: string | null;
  }
  | {
    kind: 'gerrymander';
    rightsZoneId: string;
    voterId: string | null;
    destinationSlotId: string | null;
  }
  | { kind: 'arbitrage'; payment: ResourceVectorDto; gain: ResourceVectorDto }
  | { kind: 'shakedown'; opponentId: string; resource: ResourceType }
  | { kind: 'demolition'; voterId: string | null }
  | { kind: 'crackdown'; voterId: string | null; payment: ResourceVectorDto }
  | { kind: 'outreach'; voterIds: readonly string[]; payment: PaymentDraft }
  | { kind: 'turncoatAcquire'; ownerId: string; payment: ResourceVectorDto }
  | {
    kind: 'trade';
    opponentId: string;
    giveResources: ResourceVectorDto;
    receiveResources: ResourceVectorDto;
    giveTrickIds: readonly string[];
  }
  | { kind: 'debt'; debtId: string; payment: ResourceVectorDto }
  | { kind: 'stealBase'; sourceCardId: string; voterIds: readonly string[] }
  | ChoiceDraft;

/**
 * A card-driven choice being answered.
 *
 * One shape carries all six selection kinds, because the prompt's `allowed` list and its
 * typed context already say which of them this interaction reads. Anything the engine
 * ignores stays at its empty value rather than being modelled per operation.
 *
 * It is an `ActionDraft` rather than state inside the composer for the same reason every
 * other draft is: the board below has to ring the areas it may still take, and one state
 * producing both the list and the ring is one that cannot disagree with itself. It is
 * also cleared when the device changes hands, which is what a secret ballot and a secret
 * Karachi selection need.
 */
export interface ChoiceDraft {
  kind: 'choice';
  interactionId: string;
  /**
   * The operation this draft was opened for.
   *
   * An interaction can move to another operation without closing — Skimming picks an
   * opponent and then a resource under one ID — so the identifier alone does not say
   * whether a draft is still answering the question on screen.
   */
  op: string;
  /** What a click on the board adds, fixed when the draft opened. */
  picking: 'voters' | 'slots' | null;
  /** How many board picks this operation can hold. */
  limit: number;
  optionId: string | null;
  playerIds: readonly string[];
  voterIds: readonly string[];
  slotIds: readonly string[];
  cardIds: readonly string[];
  resources: ResourceVectorDto;
  /** An auction bid being composed. Every other operation leaves it at zero. */
  bid: number;
}

export const NO_DRAFT: ActionDraft = { kind: 'none' };

/** Which vector a resource stepper is editing, since several drafts carry two. */
export type DraftResourceField =
  | 'payment'
  | 'discount'
  | 'gain'
  | 'give'
  | 'receive'
  | 'selection';

export type DraftAction =
  | { type: 'close' }
  | { type: 'open'; draft: ActionDraft }
  | { type: 'resource'; field: DraftResourceField; resource: ResourceType; amount: number }
  | { type: 'groundswell'; on: boolean }
  | { type: 'donationOpponent'; playerId: string }
  | { type: 'donationResource'; resource: ResourceType }
  | { type: 'rightsZone'; zoneId: string }
  /** Narrow an open placement to one zone, or to the whole board again with `null`. */
  | { type: 'placeZone'; zoneId: string | null }
  /**
   * One board area was chosen, from the map or from a list.
   *
   * The caller passes the voter standing there, because only it holds the projection;
   * `null` means the area is empty. What the pick means depends on the open draft, which
   * is why the board never has to know one.
   */
  | { type: 'pick'; slotId: string; voterId: string | null }
  | { type: 'choiceOption'; optionId: string | null }
  | { type: 'choiceToggle'; list: 'players' | 'voters' | 'slots' | 'cards'; id: string; limit: number }
  /** One row of a per-voter assignment answered. */
  | { type: 'choiceAssign'; index: number; playerId: string }
  | { type: 'choiceBid'; amount: number }
  | { type: 'tradeOpponent'; playerId: string }
  | { type: 'tradeCard'; cardId: string };

function toggle(ids: readonly string[], id: string, limit: number): readonly string[] {
  if (ids.includes(id)) return ids.filter((candidate) => candidate !== id);
  return ids.length >= limit ? ids : [...ids, id];
}

function editPayment(
  payment: PaymentDraft,
  field: DraftResourceField,
  resource: ResourceType,
  amount: number,
): PaymentDraft {
  if (field === 'payment') return { ...payment, resources: withResource(payment.resources, resource, amount) };
  if (field === 'discount') return { ...payment, discounts: withResource(payment.discounts, resource, amount) };
  return payment;
}

export function actionDraftReducer(draft: ActionDraft, action: DraftAction): ActionDraft {
  switch (action.type) {
    case 'close':
      return NO_DRAFT;
    case 'open':
      return action.draft;
    case 'groundswell':
      return draft.kind === 'influence' ? { ...draft, groundswell: action.on } : draft;
    case 'donationOpponent':
      return draft.kind === 'shakedown' ? { ...draft, opponentId: action.playerId } : draft;
    case 'donationResource':
      return draft.kind === 'shakedown' ? { ...draft, resource: action.resource } : draft;
    case 'rightsZone':
      return draft.kind === 'gerrymander'
        ? { ...draft, rightsZoneId: action.zoneId, voterId: null, destinationSlotId: null }
        : draft;
    case 'placeZone':
      // Changing zone abandons the areas already chosen, because for a group that must
      // stay together they are what fixed the old zone.
      return draft.kind === 'place'
        ? { ...draft, zoneId: action.zoneId, slotIds: [] }
        : draft;
    case 'choiceOption':
      return draft.kind === 'choice' ? { ...draft, optionId: action.optionId } : draft;
    case 'choiceToggle': {
      if (draft.kind !== 'choice') return draft;
      const { list, id, limit } = action;
      if (list === 'players') return { ...draft, playerIds: toggle(draft.playerIds, id, limit) };
      if (list === 'voters') return { ...draft, voterIds: toggle(draft.voterIds, id, limit) };
      if (list === 'slots') return { ...draft, slotIds: toggle(draft.slotIds, id, limit) };
      return { ...draft, cardIds: toggle(draft.cardIds, id, limit) };
    }
    case 'choiceAssign': {
      if (draft.kind !== 'choice') return draft;
      const playerIds = [...draft.playerIds];
      while (playerIds.length <= action.index) playerIds.push('');
      playerIds[action.index] = action.playerId;
      return { ...draft, playerIds };
    }
    case 'choiceBid':
      return draft.kind === 'choice'
        ? { ...draft, bid: Math.max(0, Math.trunc(action.amount)) }
        : draft;
    case 'tradeOpponent':
      return draft.kind === 'trade'
        ? { ...draft, opponentId: action.playerId }
        : draft;
    case 'tradeCard':
      return draft.kind === 'trade'
        ? {
          ...draft,
          giveTrickIds: toggle(
            draft.giveTrickIds,
            action.cardId,
            Number.MAX_SAFE_INTEGER,
          ),
        }
        : draft;
    case 'resource': {
      const { field, resource, amount } = action;
      switch (draft.kind) {
        case 'influence':
        case 'trick':
        case 'outreach':
          return { ...draft, payment: editPayment(draft.payment, field, resource, amount) };
        case 'arbitrage':
          return field === 'gain'
            ? { ...draft, gain: withResource(draft.gain, resource, amount) }
            : { ...draft, payment: withResource(draft.payment, resource, amount) };
        case 'crackdown':
        case 'turncoatAcquire':
        case 'debt':
          return field === 'payment'
            ? { ...draft, payment: withResource(draft.payment, resource, amount) }
            : draft;
        case 'trade':
          if (field === 'give') {
            return { ...draft, giveResources: withResource(draft.giveResources, resource, amount) };
          }
          if (field === 'receive') {
            return {
              ...draft,
              receiveResources: withResource(draft.receiveResources, resource, amount),
            };
          }
          return draft;
        case 'choice':
          return field === 'selection'
            ? { ...draft, resources: withResource(draft.resources, resource, amount) }
            : draft;
        default:
          return draft;
      }
    }
    case 'pick': {
      const { slotId, voterId } = action;
      switch (draft.kind) {
        case 'place': {
          // Before a zone is settled, tapping an area settles it and places the first
          // voter there in the same gesture. A card's voters go in one zone, so the tap
          // that chooses an area has already chosen the zone; asking for both separately
          // was a step the rule does not have.
          if ((draft.zoneId ?? null) === null) {
            const zoneId = zoneOfSlot(slotId);
            return zoneId === null ? draft : { ...draft, zoneId, slotIds: [slotId] };
          }
          return { ...draft, slotIds: toggle(draft.slotIds, slotId, Number.MAX_SAFE_INTEGER) };
        }
        case 'gerrymander': {
          if (draft.voterId === null) {
            return voterId === null ? draft : { ...draft, voterId, destinationSlotId: null };
          }
          if (voterId === draft.voterId) {
            return { ...draft, voterId: null, destinationSlotId: null };
          }
          if (voterId !== null) return draft;
          return {
            ...draft,
            destinationSlotId: draft.destinationSlotId === slotId ? null : slotId,
          };
        }
        case 'demolition':
        case 'crackdown':
          if (voterId === null) return draft;
          return { ...draft, voterId: draft.voterId === voterId ? null : voterId };
        case 'outreach':
          return voterId === null ? draft : { ...draft, voterIds: toggle(draft.voterIds, voterId, 2) };
        case 'stealBase':
          return voterId === null ? draft : { ...draft, voterIds: toggle(draft.voterIds, voterId, 3) };
        case 'choice':
          if (draft.picking === 'slots') {
            return { ...draft, slotIds: toggle(draft.slotIds, slotId, draft.limit) };
          }
          if (draft.picking === 'voters' && voterId !== null) {
            return { ...draft, voterIds: toggle(draft.voterIds, voterId, draft.limit) };
          }
          return draft;
        default:
          return draft;
      }
    }
  }
}

/* ---------------------------------------------------------- legal target sets */

/**
 * Areas a group may still be placed on.
 *
 * A group that must stay together narrows to its first chosen zone, and a group with
 * every voter placed highlights nothing, because there is nothing left to choose.
 *
 * `Blacklist` forbids a named seat a named zone for a turn, and that restriction *is*
 * published — `activeEffects` carries both the seat and the zone, which is what
 * `blockedZoneIds` reads. This function used to say it was not and leave the refusal to
 * the engine, which cost a player more than a wasted click: the ordinary placement is the
 * one a seat cannot decline, so a screen that offered only blocked areas walked the seat
 * into discarding voters it could have placed elsewhere.
 *
 * A group's own `allowedZoneIds` narrows it the same way, and for the same reason. It
 * restricts whole zones rather than individual areas, so the `sameZone` room count below
 * still reads every empty area of a zone that survives the filter.
 */
export function legalPlacementSlotIds(
  view: PlayerView,
  seatId: string,
  group: { count: number; sameZone: boolean; allowedZoneIds?: readonly string[] },
  chosen: readonly string[],
): ReadonlySet<string> {
  if (chosen.length >= group.count) return new Set();
  const blocked = blockedZoneIds(view, seatId);
  const allowed = group.allowedZoneIds;
  const empty = view.slots.filter(
    (slot) => slot.voter === undefined
      && !blocked.has(slot.zoneId)
      && (allowed === undefined || allowed.includes(slot.zoneId)),
  );
  if (!group.sameZone) {
    return new Set(empty.filter((slot) => !chosen.includes(slot.slotId)).map((slot) => slot.slotId));
  }
  const chosenZone = chosen.length === 0
    ? null
    : view.slots.find((slot) => slot.slotId === chosen[0])?.zoneId ?? null;
  const roomy = new Set(placementZoneIds(view, group.count));
  return new Set(
    empty
      .filter((slot) => !chosen.includes(slot.slotId))
      .filter((slot) => (chosenZone === null ? roomy.has(slot.zoneId) : slot.zoneId === chosenZone))
      .map((slot) => slot.slotId),
  );
}

/** Zones where this seat holds redistricting rights outright. */
export function gerrymanderRightsZoneIds(view: PlayerView, seatId: string): readonly string[] {
  return view.zones.filter((zone) => zone.rightsOwnerId === seatId).map((zone) => zone.id);
}

/** Destination zones a rights zone authorizes moves into, from a given source zone. */
function destinationZonesFor(rightsZoneId: string, sourceZoneId: string): readonly string[] {
  return CORE_BOARD.movementTriples
    .filter(([rights, source]) => rights === rightsZoneId && source === sourceZoneId)
    .map(([, , destination]) => destination);
}

function sourceZonesFor(rightsZoneId: string): ReadonlySet<string> {
  return new Set(
    CORE_BOARD.movementTriples
      .filter(([rights]) => rights === rightsZoneId)
      .map(([, source]) => source),
  );
}

/** True when this seat's own Populist cards reach the Landslide level. */
export function hasElectionFever(view: PlayerView, seatId: string): boolean {
  return effectivePolicyCounts(view, seatId).populist >= 5;
}

/**
 * Moves a rights zone still authorizes this turn: one, or two under Landslide.
 */
export function gerrymanderAllowance(
  view: PlayerView,
  seatId: string,
  rightsZoneId: string,
): { used: number; limit: number } {
  return {
    used: view.turnUsage.gerrymandersByZoneId[rightsZoneId] ?? 0,
    limit: hasElectionFever(view, seatId) ? 2 : 1,
  };
}

/**
 * Voters this rights zone can authorize a move for.
 *
 * Volatile voters never move. A voter marked for a majority moves only under Election
 * Fever, which is a property of the seat rather than a choice it makes. The single voter
 * holding the rights zone cannot walk out of it, because leaving would revoke the rights
 * authorizing the move. A source with no empty destination is left out: highlighting it
 * would offer a move that cannot be completed.
 */
export function gerrymanderSourceSlotIds(
  view: PlayerView,
  seatId: string,
  rightsZoneId: string,
): ReadonlySet<string> {
  const landslide = hasElectionFever(view, seatId);
  const sources = sourceZonesFor(rightsZoneId);
  const ownInRightsZone = view.slots.filter(
    (slot) => slot.zoneId === rightsZoneId && slot.voter?.ownerId === seatId,
  ).length;
  return new Set(
    view.slots
      .filter((slot) => slot.voter !== undefined && !slot.volatile && sources.has(slot.zoneId))
      .filter((slot) => landslide || slot.voter?.majority !== true)
      .filter((slot) =>
        !(slot.voter?.ownerId === seatId && slot.zoneId === rightsZoneId && ownInRightsZone === 1))
      .filter((slot) =>
        destinationZonesFor(rightsZoneId, slot.zoneId).some((zoneId) =>
          view.slots.some((candidate) => candidate.zoneId === zoneId && candidate.voter === undefined)))
      .map((slot) => slot.slotId),
  );
}

export function gerrymanderDestinationSlotIds(
  view: PlayerView,
  rightsZoneId: string,
  sourceSlotId: string,
): ReadonlySet<string> {
  const sourceZoneId = view.slots.find((slot) => slot.slotId === sourceSlotId)?.zoneId;
  if (sourceZoneId === undefined) return new Set();
  const destinations = new Set(destinationZonesFor(rightsZoneId, sourceZoneId));
  return new Set(
    view.slots
      .filter((slot) => slot.voter === undefined && destinations.has(slot.zoneId))
      .map((slot) => slot.slotId),
  );
}

/** Any voter standing on a non-volatile area. Demolition evicts friend or rival. */
export function demolitionSlotIds(view: PlayerView): ReadonlySet<string> {
  return new Set(
    view.slots
      .filter((slot) => slot.voter !== undefined && !slot.volatile)
      .map((slot) => slot.slotId),
  );
}

/** Opponent voters on non-volatile areas. Crackdown never discards your own. */
export function crackdownSlotIds(view: PlayerView, seatId: string): ReadonlySet<string> {
  return new Set(
    view.slots
      .filter((slot) => slot.voter !== undefined && !slot.volatile && slot.voter.ownerId !== seatId)
      .map((slot) => slot.slotId),
  );
}

/**
 * Voters Outreach may still take.
 *
 * Both converted voters belong to one opponent and stand in one zone, so the first pick
 * decides the owner and the zone for the second.
 */
export function outreachSlotIds(
  view: PlayerView,
  seatId: string,
  chosenVoterIds: readonly string[],
): ReadonlySet<string> {
  if (chosenVoterIds.length >= 2) return new Set();
  const anchor = chosenVoterIds.length === 0
    ? null
    : view.slots.find((slot) => slot.voter?.id === chosenVoterIds[0]) ?? null;
  return new Set(
    view.slots
      .filter((slot) => slot.voter !== undefined && !slot.volatile && slot.voter.ownerId !== seatId)
      .filter((slot) => anchor === null
        || (slot.zoneId === anchor.zoneId
          && slot.voter?.ownerId === anchor.voter?.ownerId
          && slot.slotId !== anchor.slotId))
      .map((slot) => slot.slotId),
  );
}

/** Areas the open draft may legally use, and what choosing one would mean. */
export interface Targeting {
  slotIds: ReadonlySet<string>;
  label: string;
}

export function draftTargeting(
  view: PlayerView,
  seatId: string,
  draft: ActionDraft,
): Targeting | null {
  switch (draft.kind) {
    case 'place': {
      const group = view.pendingVoterGroups.find((candidate) => candidate.id === draft.groupId);
      if (group === undefined) return null;
      // Every voter has an area: there is nothing left to choose, so the board goes back
      // to being a board rather than saying that nothing is legal.
      if (draft.slotIds.length >= group.count) return null;
      const legal = legalPlacementSlotIds(view, seatId, group, draft.slotIds);
      const zoneId = draft.zoneId ?? null;
      if (zoneId === null) {
        return {
          slotIds: legal,
          label: group.sameZone && group.count > 1
            ? 'start placing — the zone you tap takes the whole group'
            : 'place a voter here',
        };
      }
      const inZone = new Set(
        view.slots
          .filter((slot) => slot.zoneId === zoneId && legal.has(slot.slotId))
          .map((slot) => slot.slotId),
      );
      return { slotIds: inZone, label: `place a voter in ${zoneName(zoneId)}` };
    }
    case 'gerrymander':
      return draft.voterId === null
        ? {
          slotIds: gerrymanderSourceSlotIds(view, seatId, draft.rightsZoneId),
          label: 'move this voter',
        }
        : {
          slotIds: gerrymanderDestinationSlotIds(
            view,
            draft.rightsZoneId,
            slotOfVoter(view, draft.voterId)?.slotId ?? '',
          ),
          label: 'move the voter here',
        };
    case 'demolition':
      return { slotIds: demolitionSlotIds(view), label: 'evict this voter' };
    case 'crackdown':
      return { slotIds: crackdownSlotIds(view, seatId), label: 'discard this voter' };
    case 'outreach':
      return { slotIds: outreachSlotIds(view, seatId, draft.voterIds), label: 'convert this voter' };
    case 'stealBase':
      return {
        slotIds: stealBaseSlotIds(view, seatId, draft.voterIds),
        label: 'convert this voter of yours',
      };
    case 'choice': {
      const prompt = view.prompt;
      if (prompt?.kind !== 'choice' || !choiceDraftMatches(draft, prompt)) return null;
      return choiceTargeting(view, seatId, prompt, draft);
    }
    default:
      return null;
  }
}

/**
 * Areas the prompt this seat is answering concerns, before it opens a draft.
 *
 * A majority selection is a choice between voters already on the board, so the board can
 * show which ones without the seat opening anything. A card-driven choice is the same:
 * its first eligible set does not depend on anything chosen yet, so it rings as soon as
 * the prompt appears.
 */
export function promptTargeting(view: PlayerView, seatId: string): Targeting | null {
  const prompt = view.prompt;
  if (prompt?.kind === 'choice') return choiceTargeting(view, seatId, prompt, null);
  if (prompt?.kind !== 'majoritySelection') return null;
  const eligible = new Set(prompt.eligibleVoterIds);
  return {
    slotIds: new Set(
      view.slots
        .filter((slot) => slot.voter !== undefined && eligible.has(slot.voter.id))
        .map((slot) => slot.slotId),
    ),
    label: 'mark this voter for the majority',
  };
}

/* ------------------------------------------------------------ command building */

export type DraftOutcome =
  | { ok: true; command: GameCommand }
  | { ok: false; problem: string };

function incomplete(problem: string): DraftOutcome {
  return { ok: false, problem };
}

/**
 * The command this draft would submit, or the reason it is not ready.
 *
 * A `problem` here is a gap in the composition — a target not chosen, a price not fully
 * allocated. It is never a ruling: a complete draft can still be refused by the engine,
 * and that refusal is what the player is shown.
 */
export function draftCommand(
  view: PlayerView,
  seatId: string,
  draft: ActionDraft,
): DraftOutcome {
  const player = view.players.find((candidate) => candidate.id === seatId);
  const held = player?.resources ?? NO_RESOURCES;

  switch (draft.kind) {
    case 'none':
      return incomplete('No action is open.');

    case 'influence': {
      const cost = purchaseCost(view, seatId, draft.cardId);
      if (cost === null) return incomplete('That voter card is no longer face up.');
      const problem = paymentProblem(cost, draft.payment, held, volunteersRemaining(view, seatId));
      if (problem !== null) return incomplete(problem);
      const needed = purchaseVoterCount(view, draft.cardId, draft.groundswell);
      const shortfall = needed === null ? null : supplyProblem(view, needed);
      if (shortfall !== null) return incomplete(shortfall);
      return {
        ok: true,
        command: {
          type: 'InfluenceVoterCard',
          cardId: draft.cardId,
          payment: { resources: draft.payment.resources, discounts: draft.payment.discounts },
          ...(draft.groundswell ? { groundswell: true } : {}),
        },
      };
    }

    case 'trick': {
      const cost = trickCost(view);
      if (cost === null) return incomplete('The trick draw pile is empty.');
      const problem = paymentProblem(cost, draft.payment, held, volunteersRemaining(view, seatId));
      if (problem !== null) return incomplete(problem);
      return {
        ok: true,
        command: {
          type: 'BuyTrick',
          payment: { resources: draft.payment.resources, discounts: draft.payment.discounts },
        },
      };
    }

    case 'place': {
      const group = view.pendingVoterGroups.find((candidate) => candidate.id === draft.groupId);
      if (group === undefined) return incomplete('That group is no longer waiting to be placed.');
      if (draft.slotIds.length !== group.count) {
        return incomplete(
          `Choose ${group.count} area${group.count === 1 ? '' : 's'}; ${draft.slotIds.length} chosen.`,
        );
      }
      return { ok: true, command: { type: 'PlaceVoterGroup', groupId: group.id, slotIds: [...draft.slotIds] } };
    }

    case 'gerrymander': {
      if (draft.voterId === null) return incomplete('Choose the voter to move.');
      if (draft.destinationSlotId === null) return incomplete('Choose where the voter moves to.');
      return {
        ok: true,
        command: {
          type: 'Gerrymander',
          rightsZoneId: draft.rightsZoneId,
          voterId: draft.voterId,
          destinationSlotId: draft.destinationSlotId,
        },
      };
    }

    case 'arbitrage': {
      if (totalOf(draft.payment) !== 1) return incomplete('Return exactly one resource.');
      for (const resource of RESOURCE_ORDER) {
        if (draft.payment[resource] > held[resource]) {
          return incomplete(`You hold no ${resource} to return.`);
        }
      }
      const limits = arbitrageLimits(view, draft.payment);
      for (const resource of RESOURCE_ORDER) {
        if (draft.gain[resource] > limits.perResource[resource]) {
          return incomplete(
            `The reserve can supply ${limits.perResource[resource]} ${resource}, not`
            + ` ${draft.gain[resource]}.`,
          );
        }
      }
      if (totalOf(draft.gain) !== limits.required) {
        return incomplete(
          `Take exactly ${limits.required} resource${limits.required === 1 ? '' : 's'};`
          + ` ${totalOf(draft.gain)} chosen.`,
        );
      }
      return { ok: true, command: { type: 'UseProspecting', payment: draft.payment, gain: draft.gain } };
    }

    case 'shakedown': {
      const opponent = view.players.find((candidate) => candidate.id === draft.opponentId);
      if (opponent === undefined || opponent.id === seatId) return incomplete('Choose an opponent.');
      if (opponent.resources[draft.resource] < 1) {
        return incomplete(`${opponent.displayName} holds no ${draft.resource}.`);
      }
      return {
        ok: true,
        command: { type: 'UseDonations', opponentId: opponent.id, resource: draft.resource },
      };
    }

    case 'demolition':
      if (draft.voterId === null) return incomplete('Choose the voter to evict.');
      return { ok: true, command: { type: 'UseBreakingGround', voterId: draft.voterId } };

    case 'crackdown': {
      if (draft.voterId === null) return incomplete('Choose an opponent voter to discard.');
      if (totalOf(draft.payment) !== 1) return incomplete('Crackdown costs exactly one resource.');
      for (const resource of RESOURCE_ORDER) {
        if (draft.payment[resource] > held[resource]) {
          return incomplete(`You hold no ${resource} to pay with.`);
        }
      }
      return { ok: true, command: { type: 'UsePayback', voterId: draft.voterId, payment: draft.payment } };
    }

    case 'outreach': {
      const [first, second] = draft.voterIds;
      if (first === undefined || second === undefined) {
        return incomplete('Choose two voters of one opponent in one zone.');
      }
      const cost: Cost = { cash: 0, influence: 0, press: 0, faith: 2, generic: 2 };
      const problem = paymentProblem(cost, draft.payment, held, volunteersRemaining(view, seatId));
      if (problem !== null) return incomplete(problem);
      // The two converted voters are replaced from this seat's own supply, so Outreach
      // needs two tokens in hand as well as the price.
      const short = supplyProblem(view, 2);
      if (short !== null) return incomplete(short);
      return {
        ok: true,
        command: {
          type: 'UseToughLove',
          voterIds: [first, second],
          payment: { resources: draft.payment.resources, discounts: draft.payment.discounts },
        },
      };
    }

    case 'turncoatAcquire': {
      const holding = view.turncoatHoldings.find((candidate) => candidate.ownerId === draft.ownerId);
      if (holding === undefined) return incomplete('That seat no longer holds Turncoat.');
      if (totalOf(draft.payment) !== holding.acquisitionCost) {
        return incomplete(
          `Turncoat costs exactly ${holding.acquisitionCost} resource`
          + `${holding.acquisitionCost === 1 ? '' : 's'}.`,
        );
      }
      for (const resource of RESOURCE_ORDER) {
        if (draft.payment[resource] > held[resource]) {
          return incomplete(`You hold ${held[resource]} ${resource}, not ${draft.payment[resource]}.`);
        }
      }
      return {
        ok: true,
        command: { type: 'AcquireJumla', ownerId: draft.ownerId, payment: draft.payment },
      };
    }

    case 'trade': {
      const opponent = view.players.find((candidate) => candidate.id === draft.opponentId);
      if (opponent === undefined || opponent.id === seatId) return incomplete('Choose an opponent.');
      if (totalOf(draft.giveResources) < 1) return incomplete('Offer at least one resource.');
      if (totalOf(draft.receiveResources) < 1) return incomplete('Ask for at least one resource.');
      for (const resource of RESOURCE_ORDER) {
        if (draft.giveResources[resource] > held[resource]) {
          return incomplete(`You hold ${held[resource]} ${resource}, not ${draft.giveResources[resource]}.`);
        }
        if (draft.receiveResources[resource] > opponent.resources[resource]) {
          return incomplete(
            `${opponent.displayName} holds ${opponent.resources[resource]} ${resource}, not `
            + `${draft.receiveResources[resource]}.`,
          );
        }
      }
      return {
        ok: true,
        command: {
          type: 'ProposeTrade',
          opponentId: opponent.id,
          giveResources: draft.giveResources,
          receiveResources: draft.receiveResources,
          giveTrickIds: [...draft.giveTrickIds],
          receiveTrickIds: [],
        },
      };
    }

    case 'debt': {
      const debt = (view.privateDebts ?? []).find((candidate) => candidate.id === draft.debtId);
      if (debt === undefined) return incomplete('That debt is already settled.');
      const paid = totalOf(draft.payment);
      if (paid < 1) return incomplete('Pay at least one resource.');
      if (paid > debt.amount) return incomplete(`This debt is ${debt.amount}; remove ${paid - debt.amount}.`);
      for (const resource of RESOURCE_ORDER) {
        if (draft.payment[resource] > held[resource]) {
          return incomplete(`You hold ${held[resource]} ${resource}, not ${draft.payment[resource]}.`);
        }
      }
      return { ok: true, command: { type: 'PayDebt', debtId: debt.id, payment: draft.payment } };
    }

    case 'stealBase': {
      const [first, second, third] = draft.voterIds;
      if (first === undefined || second === undefined || third === undefined) {
        return incomplete(`Choose three of your own voters; ${draft.voterIds.length} chosen.`);
      }
      return {
        ok: true,
        command: {
          type: 'StealBase',
          sourceCardId: draft.sourceCardId,
          voterIds: [first, second, third],
        },
      };
    }

    case 'choice': {
      const prompt = view.prompt;
      if (prompt?.kind !== 'choice' || !choiceDraftMatches(draft, prompt)) {
        return incomplete('The decision this was answering has moved on.');
      }
      return choiceCommand(view, seatId, prompt, draft);
    }
  }
}

/**
 * Voter groups the active seat must resolve before the turn can end.
 *
 * The engine requires every *due* group in one `ConfirmPendingVoterDiscard` and refuses a
 * set that is short or long, so this is checked against the projected deadline rather than
 * assumed. Every group the engine creates today carries the ordinal it was created on, so
 * in practice a controller in its own action phase faces all of them — but that is a fact
 * about today's call sites, and a group created with a later deadline would have made this
 * set silently wrong.
 */
export function dueGroupIds(view: PlayerView, seatId: string): readonly string[] {
  return view.pendingVoterGroups
    .filter((group) => group.controllerId === seatId
      && group.deadlineTurnOrdinal <= view.turnOrdinal)
    .map((group) => group.id);
}

/** The voter standing on an area, for a board click that has to say what it picked. */
export function voterAt(view: PlayerView, slotId: string): string | null {
  return slotById(view).get(slotId)?.voter?.id ?? null;
}

/* ------------------------------------------------- campaign interactions */

/**
 * Card-driven interactions, decided outside React exactly like the ordinary actions
 * above.
 *
 * A campaign interaction is not a second kind of action. It is the same composition
 * problem — a set of legal targets, a running shortfall, one typed command at the end —
 * arriving through `StructuredChoicePromptView` instead of through a button this screen
 * owns. So the derivations live beside the ordinary ones, and the three rules at the top
 * of this file hold here too. In particular: a candidate set here is guidance. The
 * engine re-checks every selection, and several of its rules depend on values a client
 * is not given — another seat's hand, another seat's voter supply — so a set offered here
 * can still be refused, and that refusal is what the player is shown.
 */

/** Engine effect kinds, for the same reason as the three at the top of this file. */
const LOYAL_BASE = 'loyalBase';
const BLACKLIST = 'blacklist';

const TRICK_BY_ID = new Map(TRICK_CARDS.map((card) => [card.id as string, card]));
const NEWS_BY_ID = new Map(NEWS_CARDS.map((card) => [card.id as string, card]));
const POLICY_BY_ID = new Map(POLICY_CARDS.map((card) => [card.id as string, card]));
const VOTER_CARD_BY_ID = new Map(VOTER_CARDS.map((card) => [card.id as string, card]));

/** The printed title of any effect card, for a list a player has to read. */
export function cardTitle(cardId: string): string {
  return TRICK_BY_ID.get(cardId)?.title ?? NEWS_BY_ID.get(cardId)?.title ?? cardId;
}

/** The printed rules text of an effect card, shown beside the title before it is played. */
export function cardRules(cardId: string): string | undefined {
  return TRICK_BY_ID.get(cardId)?.rulesText ?? NEWS_BY_ID.get(cardId)?.rulesText;
}

export function playerName(view: PlayerView, playerId: string): string {
  return view.players.find((player) => player.id === playerId)?.displayName ?? playerId;
}

/** One voter standing on the board, flattened out of the slot list. */
export interface BoardVoter {
  voterId: string;
  ownerId: string;
  slotId: string;
  zoneId: string;
  volatile: boolean;
  majority: boolean;
}

export function boardVoters(view: PlayerView): readonly BoardVoter[] {
  return view.slots.flatMap((slot) =>
    slot.voter === undefined ? [] : [{
      voterId: slot.voter.id,
      ownerId: slot.voter.ownerId,
      slotId: slot.slotId,
      zoneId: slot.zoneId,
      volatile: slot.volatile,
      majority: slot.voter.majority,
    }]);
}

/**
 * Zones another seat's Loyal Base shields from this one.
 *
 * The engine refuses every removal, conversion and move an opponent aims into such a
 * zone, so offering one as a target would offer a choice that cannot be completed.
 */
export function protectedZoneIds(view: PlayerView, seatId: string): ReadonlySet<string> {
  return new Set(
    view.activeEffects.flatMap((effect) =>
      effect.kind === LOYAL_BASE && effect.ownerId !== seatId ? [...effect.targetZoneIds] : []),
  );
}

/** Zones a Blacklist marker currently closes to this seat's placements. */
export function blockedZoneIds(view: PlayerView, seatId: string): ReadonlySet<string> {
  return new Set(
    view.activeEffects.flatMap((effect) =>
      effect.kind === BLACKLIST && effect.targetPlayerIds.includes(seatId)
        ? [...effect.targetZoneIds]
        : []),
  );
}

/* ------------------------------------------------------- the choice contract */

export interface ChoiceOption {
  id: string;
  label: string;
  /** A second line: who owns a voter, what a card does, what an answer said. */
  detail?: string;
}

/**
 * One control a choice prompt needs, derived from its typed context.
 *
 * `allowed` on the prompt says which `ChoiceSelection` kinds the interaction accepts,
 * and the context variant carries the eligible sets. Together they decide the controls,
 * so no operation needs a branch of its own here unless its shape really is its own —
 * an assignment of one player per voter, a pair of source and destination areas.
 */
export type ChoiceControl =
  | { select: 'option'; label: string; options: readonly ChoiceOption[] }
  | {
    select: 'players';
    label: string;
    options: readonly ChoiceOption[];
    minimum: number;
    maximum: number;
  }
  /** One player per row, in the row's order, with repeats allowed. */
  | { select: 'assign'; label: string; options: readonly ChoiceOption[]; rows: readonly ChoiceOption[] }
  | {
    select: 'cards';
    label: string;
    options: readonly ChoiceOption[];
    minimum: number;
    maximum: number;
  }
  | {
    select: 'board';
    label: string;
    /** `voters` submits voter IDs; `slots` submits area IDs. Both ring the same map. */
    of: 'voters' | 'slots';
    options: readonly ChoiceOption[];
    slotIds: ReadonlySet<string>;
    minimum: number;
    maximum: number;
    /** Sizes this interaction accepts, when it accepts only some. */
    counts?: readonly number[];
    /** True when picks are read as ordered pairs rather than as a set. */
    pairs?: boolean;
  }
  | { select: 'resources'; label: string; total: number };

export interface ChoiceModel {
  controls: readonly ChoiceControl[];
  allowPass: boolean;
  /** What this screen can add about the choice. Never a ruling, never the engine's. */
  note?: string;
}

function playerOptions(view: PlayerView, playerIds: readonly string[]): readonly ChoiceOption[] {
  return playerIds.map((playerId) => ({ id: playerId, label: playerName(view, playerId) }));
}

function voterOptions(
  view: PlayerView,
  entries: readonly BoardVoter[],
): readonly ChoiceOption[] {
  return entries.map((entry) => ({
    id: entry.voterId,
    label: describeSlotTarget(entry.slotId),
    detail: `${playerName(view, entry.ownerId)}${entry.majority ? ', marked for a majority' : ''}`,
  }));
}

function slotOptions(slotIds: readonly string[]): readonly ChoiceOption[] {
  return slotIds.map((slotId) => ({ id: slotId, label: describeSlotTarget(slotId) }));
}

function boardControl(
  label: string,
  of: 'voters' | 'slots',
  options: readonly ChoiceOption[],
  slotIds: readonly string[],
  minimum: number,
  maximum: number,
  extra: { counts?: readonly number[]; pairs?: boolean } = {},
): ChoiceControl {
  return { select: 'board', label, of, options, slotIds: new Set(slotIds), minimum, maximum, ...extra };
}

function votersControl(
  view: PlayerView,
  label: string,
  entries: readonly BoardVoter[],
  chosen: readonly string[],
  minimum: number,
  maximum: number,
  extra: { counts?: readonly number[]; pairs?: boolean } = {},
): ChoiceControl {
  const open = entries.filter((entry) => !chosen.includes(entry.voterId));
  return boardControl(
    label,
    'voters',
    voterOptions(view, open),
    open.map((entry) => entry.slotId),
    minimum,
    maximum,
    extra,
  );
}

function slotsControl(
  label: string,
  slotIds: readonly string[],
  chosen: readonly string[],
  minimum: number,
  maximum: number,
  extra: { counts?: readonly number[]; pairs?: boolean } = {},
): ChoiceControl {
  const open = slotIds.filter((slotId) => !chosen.includes(slotId));
  return boardControl(label, 'slots', slotOptions(open), open, minimum, maximum, extra);
}

function emptySlotIds(view: PlayerView): readonly string[] {
  return view.slots.filter((slot) => slot.voter === undefined).map((slot) => slot.slotId);
}

function policyCardOptions(
  view: PlayerView,
  cardIds: readonly string[],
): readonly ChoiceOption[] {
  const answered = new Map(
    (view.privatePolicyCards ?? []).map((card) => [card.cardId, card]),
  );
  return cardIds.map((cardId) => {
    const definition = POLICY_BY_ID.get(cardId);
    const kept = answered.get(cardId);
    return {
      id: cardId,
      label: definition?.question ?? cardId,
      ...(kept === undefined
        ? {}
        : { detail: `You answered “${definition?.answers[kept.answerIndex].text ?? ''}” — ${kept.archetype}.` }),
    };
  });
}

function voterCardOptions(cardIds: readonly string[]): readonly ChoiceOption[] {
  return cardIds.map((cardId) => {
    const card = VOTER_CARD_BY_ID.get(cardId);
    return {
      id: cardId,
      label: card === undefined
        ? cardId
        : `${card.voters} voter${card.voters === 1 ? '' : 's'}`,
      ...(card === undefined ? {} : { detail: `Costs ${printedTotal(card.cost)} in total.` }),
    };
  });
}

function effectCardOptions(view: PlayerView, cardIds: readonly string[]): readonly ChoiceOption[] {
  return cardIds.map((cardId) => ({
    id: cardId,
    label: cardTitle(cardId),
    ...(() => {
      const effect = view.activeEffects.find((candidate) => candidate.sourceCardId === cardId);
      return effect === undefined ? {} : { detail: `Played by ${playerName(view, effect.ownerId)}.` };
    })(),
  }));
}

function zoneOptions(zoneIds: readonly string[]): readonly ChoiceOption[] {
  return zoneIds.map((zoneId) => ({ id: zoneId, label: zoneName(zoneId) }));
}

/** Zones next to this one on the printed board, for a move that must cross a border. */
function adjacentZoneIds(zoneId: string): readonly string[] {
  return ZONE_BY_ID.get(zoneId)?.adjacency ?? [];
}

/**
 * Areas a Flood Relief move may start from and end on.
 *
 * The rule is the gerrymander movement rule without the gerrymander allowance: some zone
 * where this seat holds Rights must print a triple joining the source zone to the
 * destination zone, and the seat may not walk its only voter out of the zone granting
 * those Rights.
 */
function floodReliefSourceSlotIds(view: PlayerView, seatId: string): readonly string[] {
  const rights = gerrymanderRightsZoneIds(view, seatId);
  const shielded = protectedZoneIds(view, seatId);
  return view.slots
    .filter((slot) => slot.voter !== undefined && !slot.volatile && !shielded.has(slot.zoneId))
    .filter((slot) => rights.some((rightsZoneId) => sourceZonesFor(rightsZoneId).has(slot.zoneId)))
    .filter((slot) => !rights.some((rightsZoneId) =>
      slot.voter?.ownerId === seatId
      && slot.zoneId === rightsZoneId
      && view.slots.filter((candidate) =>
        candidate.zoneId === rightsZoneId && candidate.voter?.ownerId === seatId).length === 1))
    .filter((slot) => floodReliefDestinationSlotIds(view, seatId, slot.slotId).length > 0)
    .map((slot) => slot.slotId);
}

function floodReliefDestinationSlotIds(
  view: PlayerView,
  seatId: string,
  sourceSlotId: string,
): readonly string[] {
  const sourceZoneId = view.slots.find((slot) => slot.slotId === sourceSlotId)?.zoneId;
  if (sourceZoneId === undefined) return [];
  const destinations = new Set(
    gerrymanderRightsZoneIds(view, seatId).flatMap((rightsZoneId) =>
      destinationZonesFor(rightsZoneId, sourceZoneId)),
  );
  return view.slots
    .filter((slot) => slot.voter === undefined && !slot.volatile && destinations.has(slot.zoneId))
    .map((slot) => slot.slotId);
}

/**
 * The controls one choice prompt needs right now.
 *
 * "Right now" matters: several operations are answered in ordered pairs, so the eligible
 * set after an odd number of picks is the set of destinations for the area just chosen,
 * not the set of sources. Passing the open draft in is what lets one function answer
 * both halves.
 */
export function choiceModel(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  draft: ChoiceDraft | null,
): ChoiceModel {
  const context = prompt.context;
  const allowPass = prompt.allowPass;
  const pickedVoters = draft?.voterIds ?? [];
  const pickedSlots = draft?.slotIds ?? [];
  const shielded = protectedZoneIds(view, seatId);
  const voters = boardVoters(view);
  const takeable = voters.filter((entry) => !entry.volatile && !shielded.has(entry.zoneId));
  /**
   * This seat's own board voters that it may still touch.
   *
   * A rival's Loyal Base closes its zone to *everyone but the rival*, the
   * voters' own owner included, which is the half of that rule easiest to forget: an
   * eligible set counted straight off the slot table over-reports, and the three cards
   * below that ask a seat to give up its own voters all did. So this is `takeable`
   * narrowed to the seat, not the slot table narrowed by ownership.
   */
  const mine = takeable.filter((entry) => entry.ownerId === seatId);
  /**
   * Board voters no Cult protects, because two cards do not read that protection.
   *
   * Loyal Base shields a zone from `removeBoardVoter`, `moveVoter` and
   * `convertVoters`, which is how most cards reach the board — but Long March's
   * eviction and Musical Chairs's swap touch the slot table directly, and Session
   * 17's audit left both that way deliberately: `canRunBharatEvictions` counts exactly
   * "non-volatile board voters" and its resolver checks nothing else. A composer that
   * narrowed those two to `takeable` anyway was not being careful, it was denying a legal
   * move — and for Long March, whose five is an exact figure it cannot pass on, it turned a
   * legal answer into a match that stopped.
   */
  const movable = voters.filter((entry) => !entry.volatile);

  switch (context.op) {
    case 'campaignVote':
      return {
        allowPass,
        controls: [{
          select: 'option',
          label: 'Vote for one player to receive the revealed trick',
          options: playerOptions(
            view,
            context.candidateIds.filter((playerId) => playerId !== seatId),
          ),
        }],
        note: `Round ${context.round}. ${context.ballotsCast} ballot`
          + `${context.ballotsCast === 1 ? '' : 's'} cast so far. Ballots stay secret until the`
          + ' count, and a tied round is rerun.',
      };

    case 'auction':
      return {
        allowPass,
        controls: [],
        note: `${playerName(view, context.sellerId)} is selling. The bidding opened at `
          + `${context.minimumBid}.`,
      };

    case 'trickPriority':
      return {
        allowPass,
        controls: [],
        note: `${playerName(view, context.playedByPlayerId)} played `
          + `${cardTitle(context.playedCardId)}.`,
      };

    case 'chaiOpponent':
      return {
        allowPass,
        controls: [{
          select: 'players',
          label: 'Choose the opponent Skimming skims from',
          options: playerOptions(
            view,
            context.restrictToPlayerId === undefined
              ? context.eligiblePlayerIds
              : [context.restrictToPlayerId],
          ),
          minimum: 1,
          maximum: 1,
        }],
        ...(context.restrictToPlayerId === undefined
          ? {}
          : { note: `Reversed: only ${playerName(view, context.restrictToPlayerId)} may be skimmed.` }),
      };

    case 'chaiResource':
      return {
        allowPass,
        controls: [{
          select: 'option',
          label: `Choose the resource intercepted from ${playerName(view, context.opponentId)}`,
          options: context.optionIds.map((resource) => ({ id: resource, label: resource })),
        }],
      };

    case 'turncoatTrack':
      return {
        allowPass,
        controls: [{
          select: 'option',
          label: 'Choose the Archetype track Turncoat sits under',
          options: context.optionIds.map((archetype) => ({ id: archetype, label: archetype })),
        }],
        note: 'It counts as an extra Policy Card on that track, and an opponent may buy it'
          + ' from you for the level it stands on.',
      };

    case 'blockOpen':
      return {
        allowPass,
        controls: [{
          select: 'cards',
          label: 'Choose one open trick or news to discard',
          options: effectCardOptions(view, context.openCardIds),
          minimum: 1,
          maximum: 1,
        }],
      };

    case 'accentFlip':
      return {
        allowPass,
        controls: [{
          select: 'cards',
          label: 'Choose one of your Policy Cards to flip',
          options: policyCardOptions(view, context.policyCardIds),
          minimum: 1,
          maximum: 1,
        }],
        note: 'Flipping moves the card to the Archetype the other answer feeds.',
      };

    case 'bharatVoters': {
      const eligible = context.restrictToPlayerId === undefined
        ? movable
        : movable.filter((entry) => entry.ownerId === context.restrictToPlayerId);
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Choose ${context.exactly} voters to evict`,
          eligible,
          pickedVoters,
          context.exactly,
          context.exactly,
        )],
        ...(context.restrictToPlayerId === undefined
          ? {}
          : { note: `Reversed: only ${playerName(view, context.restrictToPlayerId)}’s voters may be taken.` }),
      };
    }

    case 'bharatOwners':
      return {
        allowPass,
        controls: [{
          select: 'assign',
          label: 'Send each evicted voter to an opponent’s player mat',
          options: playerOptions(
            view,
            context.restrictToPlayerId === undefined
              ? context.eligiblePlayerIds
              : [context.restrictToPlayerId],
          ),
          rows: context.voterIds.map((voterId) => ({
            id: voterId,
            label: describeSlotTarget(
              view.slots.find((slot) => slot.voter?.id === voterId)?.slotId ?? voterId,
            ),
          })),
        }],
        note: 'Each of them places the voter anywhere on their own turn.',
      };

    case 'cultZone':
    case 'cultStolenZone':
      return {
        allowPass,
        controls: [{
          select: 'option',
          label: 'Choose the majority this card shields from your opponents',
          options: zoneOptions(context.eligibleZoneIds),
        }],
      };

    case 'notOneTarget':
      return {
        allowPass,
        controls: [
          {
            select: 'players',
            label: 'Choose the opponent shut out',
            options: playerOptions(
              view,
              context.restrictToPlayerId === undefined
                ? context.eligiblePlayerIds
                : [context.restrictToPlayerId],
            ),
            minimum: 1,
            maximum: 1,
          },
          {
            select: 'option',
            label: 'Choose the zone they may not place in',
            options: zoneOptions(context.eligibleZoneIds),
          },
        ],
        note: 'The restriction lasts through their next turn.',
      };

    case 'imprisonVoters': {
      const eligible = takeable
        .filter((entry) => !entry.majority)
        .filter((entry) =>
          context.restrictToPlayerId === undefined || entry.ownerId === context.restrictToPlayerId);
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Choose ${context.exactly} non-majority voters to imprison`,
          eligible,
          pickedVoters,
          context.exactly,
          context.exactly,
        )],
        note: 'Their owners may buy each one back from you for a single resource.',
      };
    }

    case 'hostageVoters':
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Choose ${context.exactly} of your own voters to hold`,
          mine,
          pickedVoters,
          context.exactly,
          context.exactly,
        )],
      };

    case 'redevelopmentDiscard':
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Choose ${context.exactly} non-majority voters in ${zoneName(context.zoneId)} to discard`,
          takeable.filter((entry) => entry.zoneId === context.zoneId && !entry.majority),
          pickedVoters,
          context.exactly,
          context.exactly,
        )],
      };

    case 'documentsVoters': {
      const rights = new Set(context.rightsZoneIds);
      const usedZones = new Set(
        pickedVoters.flatMap((voterId) => {
          const entry = voters.find((candidate) => candidate.voterId === voterId);
          return entry === undefined ? [] : [entry.zoneId];
        }),
      );
      const eligible = takeable
        .filter((entry) => rights.has(entry.zoneId) && !usedZones.has(entry.zoneId))
        .filter((entry) =>
          context.restrictToPlayerId === undefined || entry.ownerId === context.restrictToPlayerId);
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Choose up to ${context.maximum} voters, at most one in each zone you hold Rights in`,
          eligible,
          pickedVoters,
          context.minimum,
          context.maximum,
        )],
        note: rights.size === 0
          ? 'You hold redistricting rights nowhere, so this card can take nothing.'
          : `You hold Rights in ${rights.size} zone${rights.size === 1 ? '' : 's'}.`,
      };
    }

    case 'slumdogSwap':
      return {
        allowPass,
        controls: [votersControl(
          view,
          'Choose voters in pairs; each pair swaps places',
          movable.filter((entry) => !entry.majority),
          pickedVoters,
          2,
          6,
          { counts: context.allowedCounts, pairs: true },
        )],
        note: 'Picks are read in order: first with second, third with fourth, fifth with sixth.',
      };

    case 'cornerstoneGain':
      return {
        allowPass,
        controls: [{
          select: 'resources',
          label: `Take ${context.resourceTotal} resources from the bank`,
          total: context.resourceTotal,
        }],
        note: 'The reserve is not published to a seat, so the engine is the last word on'
          + ' whether it can supply what you ask for.',
      };

    case 'cornerstoneZone':
      return {
        allowPass,
        controls: [{
          select: 'option',
          label: 'Choose the 6/11 zone to convert completely',
          options: zoneOptions(context.eligibleZoneIds),
        }],
      };

    case 'dostiTarget':
      return {
        allowPass,
        controls: [{
          select: 'players',
          label: 'Choose the opponent who may use your redistricting rights next turn',
          options: playerOptions(view, context.eligiblePlayerIds),
          minimum: 1,
          maximum: 1,
        }],
      };

    case 'mansplainTarget':
      return {
        allowPass,
        controls: [{
          select: 'players',
          label: 'Choose the opponent this news targets',
          options: playerOptions(view, context.eligiblePlayerIds),
          minimum: 1,
          maximum: 1,
        }],
      };

    case 'nerosMoves': {
      const sourcesOpen = pickedSlots.length % 2 === 0;
      const previousDestinations = pickedSlots.filter((_, index) => index % 2 === 1);
      const leaving = previousDestinations.length === 0
        ? null
        : previousDestinations.every((slotId) =>
          view.slots.find((slot) => slot.slotId === slotId)?.zoneId !== context.zoneId);
      const sources = view.slots
        .filter((slot) => slot.zoneId === context.zoneId && slot.voter !== undefined && !slot.volatile)
        .filter((slot) => !shielded.has(slot.zoneId))
        .map((slot) => slot.slotId);
      const destinations = view.slots
        .filter((slot) => slot.voter === undefined)
        .filter((slot) => leaving === null
          || (leaving ? slot.zoneId !== context.zoneId : slot.zoneId === context.zoneId))
        .map((slot) => slot.slotId);
      return {
        allowPass,
        controls: [slotsControl(
          sourcesOpen
            ? `Choose a voter in ${zoneName(context.zoneId)} to move`
            : 'Choose where that voter goes',
          sourcesOpen ? sources : destinations,
          pickedSlots,
          context.pairs * 2,
          context.pairs * 2,
          { pairs: true },
        )],
        note: `All ${context.pairs} moves must stay inside ${zoneName(context.zoneId)}, or all`
          + ' must leave it.',
      };
    }

    case 'poloPlayers':
      return {
        allowPass,
        controls: [{
          select: 'players',
          label: `Choose ${context.exactly} players to share a Level 3 power`,
          options: playerOptions(view, context.eligiblePlayerIds),
          minimum: context.exactly,
          maximum: context.exactly,
        }],
      };

    case 'poloFallback':
      return {
        allowPass,
        controls: [{
          select: 'option',
          label: 'Choose the Archetype whose Level 3 power they share',
          options: context.optionIds.map((archetype) => ({ id: archetype, label: archetype })),
        }],
        note: `It is shared by ${context.playerIds.map((id) => playerName(view, id)).join(' and ')}.`,
      };

    case 'karachiKeep':
      return {
        allowPass,
        controls: [{
          select: 'cards',
          label: 'Choose one drawn trick to keep; the others go to auction',
          options: context.drawnCardIds.map((cardId) => {
            const rules = cardRules(cardId);
            return {
              id: cardId,
              label: cardTitle(cardId),
              ...(rules === undefined ? {} : { detail: rules }),
            };
          }),
          minimum: 1,
          maximum: 1,
        }],
        note: 'Only this seat sees the three cards. Cover the screen before the device moves on.',
      };

    case 'blessingsKeep':
      return {
        allowPass,
        controls: [{
          select: 'cards',
          label: 'Choose one drawn Voter Card to keep',
          options: voterCardOptions(context.drawnCardIds),
          minimum: 1,
          maximum: 1,
        }],
      };

    case 'blessingsDonate':
      return {
        allowPass,
        controls: [{
          select: 'players',
          label: `Choose who receives ${voterCardOptions([context.donatedCardId])[0]?.label ?? 'the other card'}`,
          options: playerOptions(view, context.eligiblePlayerIds),
          minimum: 1,
          maximum: 1,
        }],
      };

    case 'blessingsPlace':
      return {
        allowPass,
        controls: [slotsControl(
          `Place ${context.voterCount} free voter${context.voterCount === 1 ? '' : 's'}`,
          placementSlotIdsForFreeGroup(view, seatId, context.voterCount, pickedSlots),
          pickedSlots,
          context.voterCount,
          context.voterCount,
        )],
        note: 'Every voter from one card goes into a single zone.',
      };

    case 'greatLeaderMove': {
      // The seat answering this is the one *after* the seat that triggered the card, and
      // the voters it may move are the trigger's, not its own. Offering `mine` here asked
      // the wrong seat: every source the control listed was refused, and in 420 autoplay
      // games the card therefore never once resolved. A Cult zone still shields its
      // voters from this mover, and a volatile area is still immune as a source.
      const sources = voters
        .filter((entry) => entry.ownerId === context.ownerId)
        .filter((entry) => !entry.majority && !entry.volatile && !shielded.has(entry.zoneId))
        .filter((entry) => view.slots.some((slot) =>
          slot.voter === undefined && adjacentZoneIds(entry.zoneId).includes(slot.zoneId)))
        .map((entry) => entry.slotId);
      const sourcesOpen = pickedSlots.length % 2 === 0;
      const sourceZoneId = view.slots.find((slot) => slot.slotId === pickedSlots[0])?.zoneId;
      const destinations = sourceZoneId === undefined
        ? []
        : view.slots
          .filter((slot) => slot.voter === undefined && adjacentZoneIds(sourceZoneId).includes(slot.zoneId))
          .map((slot) => slot.slotId);
      return {
        allowPass,
        controls: [slotsControl(
          sourcesOpen ? 'Choose one of your voters to move' : 'Choose an adjacent zone to move it into',
          sourcesOpen ? sources : destinations,
          pickedSlots,
          2,
          2,
          { pairs: true },
        )],
        note: `${context.remainingMoves} move${context.remainingMoves === 1 ? '' : 's'} left.`,
      };
    }

    case 'floodReliefMove': {
      const sourcesOpen = pickedSlots.length % 2 === 0;
      const sourceSlotId = pickedSlots[0];
      return {
        allowPass,
        controls: [slotsControl(
          sourcesOpen ? 'Choose a voter to move' : 'Choose where that voter goes',
          sourcesOpen
            ? floodReliefSourceSlotIds(view, seatId)
            : floodReliefDestinationSlotIds(view, seatId, sourceSlotId ?? ''),
          pickedSlots,
          2,
          2,
          { pairs: true },
        )],
        note: 'Only a move your own redistricting rights already authorize is legal here.',
      };
    }

    case 'coughEvict':
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Evict ${context.exactly} of your own voters`,
          mine,
          pickedVoters,
          context.exactly,
          context.exactly,
        )],
        note: 'The voter returns to your mat and can be placed again on your next turn.',
      };

    case 'coughReward':
    case 'limitsReward':
    case 'goalparaReward':
    case 'donationReward':
      return {
        allowPass,
        controls: [{
          select: 'resources',
          label: `Take ${context.resourceTotal} resource${context.resourceTotal === 1 ? '' : 's'}`,
          total: context.resourceTotal,
        }],
      };

    case 'limitsConvert': {
      const eligible = context.leftPlayerId === undefined
        ? []
        : takeable.filter((entry) => entry.ownerId === context.leftPlayerId);
      return {
        allowPass,
        controls: [votersControl(
          view,
          `Convert ${context.exactly} voters of the player on your left`,
          eligible,
          pickedVoters,
          context.exactly,
          context.exactly,
        )],
        ...(context.leftPlayerId === undefined
          ? {}
          : { note: `The player on your left is ${playerName(view, context.leftPlayerId)}.` }),
      };
    }

    case 'goalparaCard':
      return {
        allowPass,
        controls: [{
          select: 'cards',
          label: 'Choose one open Voter Card',
          options: voterCardOptions(context.marketCardIds),
          minimum: 1,
          maximum: 1,
        }],
      };

    case 'oxyChoice':
      return {
        allowPass,
        controls: [
          votersControl(
            view,
            'Discard one of your own voters',
            mine,
            pickedVoters,
            1,
            1,
          ),
          {
            select: 'players',
            label: 'Or choose an opponent to gain a free voter',
            options: playerOptions(view, context.eligiblePlayerIds),
            minimum: 1,
            maximum: 1,
          },
        ],
        note: 'Answer one of the two, not both.',
      };

    case 'oxyPlace':
      return {
        allowPass,
        controls: [slotsControl(
          'Place the free voter',
          placementSlotIdsForFreeGroup(view, seatId, 1, pickedSlots),
          pickedSlots,
          1,
          1,
        )],
      };

    case 'donatePolicy':
      return {
        allowPass,
        controls: [{
          select: 'cards',
          label: context.recipientPlayerId === undefined
            ? 'Donate one Policy Card to the player on your left'
            : `Donate one Policy Card to ${playerName(view, context.recipientPlayerId)}`,
          options: policyCardOptions(view, context.policyCardIds),
          minimum: 1,
          maximum: 1,
        }],
        note: 'Donating pays six resources. Passing keeps the card and pays nothing.',
      };

    case 'unsupported':
      return { allowPass: false, controls: [] };
  }
}

/**
 * Empty areas a group of freely influenced voters may go on.
 *
 * Every voter from one card goes into one zone, so the first pick fixes the zone. A zone
 * closed to this seat by Blacklist is left out, and so is one without room for the
 * whole group.
 */
function placementSlotIdsForFreeGroup(
  view: PlayerView,
  seatId: string,
  count: number,
  chosen: readonly string[],
): readonly string[] {
  const blocked = blockedZoneIds(view, seatId);
  const chosenZoneId = chosen.length === 0
    ? null
    : view.slots.find((slot) => slot.slotId === chosen[0])?.zoneId ?? null;
  const roomy = new Set(placementZoneIds(view, count));
  return view.slots
    .filter((slot) => slot.voter === undefined && !blocked.has(slot.zoneId))
    .filter((slot) => (chosenZoneId === null ? roomy.has(slot.zoneId) : slot.zoneId === chosenZoneId))
    .map((slot) => slot.slotId);
}

/** Areas a choice prompt concerns, so the map rings exactly what the list offers. */
export function choiceTargeting(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  draft: ChoiceDraft | null,
): Targeting | null {
  for (const control of choiceModel(view, seatId, prompt, draft).controls) {
    if (control.select === 'board') {
      return { slotIds: control.slotIds, label: control.label.toLowerCase() };
    }
  }
  return null;
}

/** How many board picks an operation can take, fixed when its draft opens. */
function choiceMaximum(prompt: StructuredChoicePromptView): number {
  const context = prompt.context;
  switch (context.op) {
    case 'bharatVoters':
    case 'imprisonVoters':
    case 'hostageVoters':
    case 'redevelopmentDiscard':
    case 'coughEvict':
    case 'limitsConvert':
      return context.exactly;
    case 'documentsVoters':
      return context.maximum;
    case 'slumdogSwap':
      return Math.max(...context.allowedCounts);
    case 'nerosMoves':
      return context.pairs * 2;
    case 'greatLeaderMove':
    case 'floodReliefMove':
      return 2;
    case 'blessingsPlace':
      return context.voterCount;
    case 'bharatOwners':
      return context.voterIds.length;
    case 'poloPlayers':
      return context.exactly;
    default:
      return 1;
  }
}

/** What a click on the board adds to this operation, or nothing when it takes no area. */
function choicePicking(prompt: StructuredChoicePromptView): 'voters' | 'slots' | null {
  if (prompt.allowed.includes('slots')) return 'slots';
  if (prompt.allowed.includes('voters')) return 'voters';
  return null;
}

/** A fresh draft for one prompt. Opened by the composer; cleared when the device moves. */
export function openChoiceDraft(prompt: StructuredChoicePromptView): ChoiceDraft {
  return {
    kind: 'choice',
    interactionId: prompt.interactionId,
    op: prompt.context.op,
    picking: choicePicking(prompt),
    limit: choiceMaximum(prompt),
    optionId: null,
    playerIds: [],
    voterIds: [],
    slotIds: [],
    cardIds: [],
    resources: NO_RESOURCES,
    bid: 0,
  };
}

/** True when this draft is still the one answering this prompt. */
export function choiceDraftMatches(
  draft: ActionDraft,
  prompt: StructuredChoicePromptView,
): draft is ChoiceDraft {
  return draft.kind === 'choice'
    && draft.interactionId === prompt.interactionId
    && draft.op === prompt.context.op;
}

/** `1 card`, `3 cards`. A shortfall is read aloud, so it has to count properly. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function countProblem(
  chosen: number,
  minimum: number,
  maximum: number,
  counts: readonly number[] | undefined,
  noun: string,
): string | null {
  if (counts !== undefined) {
    return counts.includes(chosen)
      ? null
      : `Choose ${counts.join(', ')} ${noun}s; ${chosen} chosen.`;
  }
  if (chosen < minimum) {
    const missing = minimum - chosen;
    return `Choose ${missing} more ${noun}${missing === 1 ? '' : 's'}.`;
  }
  if (chosen > maximum) return `Remove ${plural(chosen - maximum, noun)}.`;
  return null;
}

/**
 * The command this choice draft would submit, or the reason it is not ready.
 *
 * Campaign votes and auctions carry their own commands, so they are named here rather
 * than folded into `SubmitChoice`: `getLegalActions` maps each open interaction to the
 * commands it accepts, and this follows that mapping instead of guessing from the prompt.
 */
export function choiceCommand(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  draft: ChoiceDraft,
): DraftOutcome {
  const model = choiceModel(view, seatId, prompt, draft);
  const context = prompt.context;

  if (context.op === 'campaignVote') {
    if (draft.optionId === null) return incomplete('Choose the player you are voting for.');
    return {
      ok: true,
      command: { type: 'SubmitVote', interactionId: prompt.interactionId, optionId: draft.optionId },
    };
  }
  if (context.op === 'auction') {
    const floor = Math.max(context.minimumBid, context.currentBid + 1);
    if (draft.bid < floor) return incomplete(`A bid must be at least ${floor}.`);
    return {
      ok: true,
      command: { type: 'PlaceBid', interactionId: prompt.interactionId, amount: draft.bid },
    };
  }
  if (context.op === 'trickPriority' || context.op === 'unsupported') {
    return incomplete('This interaction is answered by its own controls.');
  }

  if (context.op === 'notOneTarget') {
    const targetId = draft.playerIds[0];
    if (targetId === undefined) return incomplete('Choose the opponent shut out.');
    if (draft.optionId === null) return incomplete('Choose the zone they may not place in.');
    return {
      ok: true,
      command: {
        type: 'SubmitChoice',
        interactionId: prompt.interactionId,
        selection: { kind: 'option', optionId: `${targetId}|${draft.optionId}` },
      },
    };
  }

  if (context.op === 'bharatOwners') {
    const rows = context.voterIds.length;
    if (draft.playerIds.length !== rows || draft.playerIds.some((id) => id === '')) {
      return incomplete(`Name a recipient for all ${rows} evicted voters.`);
    }
    return {
      ok: true,
      command: {
        type: 'SubmitChoice',
        interactionId: prompt.interactionId,
        selection: { kind: 'players', playerIds: [...draft.playerIds] },
      },
    };
  }

  if (context.op === 'oxyChoice') {
    if (draft.voterIds.length === 1) {
      return submitChoice(prompt, { kind: 'voters', voterIds: [...draft.voterIds] });
    }
    if (draft.playerIds.length === 1) {
      return submitChoice(prompt, { kind: 'players', playerIds: [...draft.playerIds] });
    }
    return incomplete('Discard one of your own voters, or choose an opponent to gain one.');
  }

  const control = model.controls[0];
  if (control === undefined) return incomplete('This prompt offers nothing to choose.');

  switch (control.select) {
    case 'option': {
      if (draft.optionId === null) return incomplete(`${control.label}.`);
      return submitChoice(prompt, { kind: 'option', optionId: draft.optionId });
    }
    case 'players': {
      const problem = countProblem(
        draft.playerIds.length,
        control.minimum,
        control.maximum,
        undefined,
        'player',
      );
      if (problem !== null) return incomplete(problem);
      return submitChoice(prompt, { kind: 'players', playerIds: [...draft.playerIds] });
    }
    case 'cards': {
      const problem = countProblem(
        draft.cardIds.length,
        control.minimum,
        control.maximum,
        undefined,
        'card',
      );
      if (problem !== null) return incomplete(problem);
      return submitChoice(prompt, { kind: 'cards', cardIds: [...draft.cardIds] });
    }
    case 'board': {
      const chosen = control.of === 'voters' ? draft.voterIds : draft.slotIds;
      const problem = countProblem(
        chosen.length,
        control.minimum,
        control.maximum,
        control.counts,
        control.of === 'voters' ? 'voter' : 'area',
      );
      if (problem !== null) return incomplete(problem);
      return submitChoice(
        prompt,
        control.of === 'voters'
          ? { kind: 'voters', voterIds: [...chosen] }
          : { kind: 'slots', slotIds: [...chosen] },
      );
    }
    case 'resources': {
      const taken = totalOf(draft.resources);
      if (taken !== control.total) {
        return incomplete(taken < control.total
          ? `Take ${control.total - taken} more.`
          : `Take ${taken - control.total} fewer.`);
      }
      return submitChoice(prompt, { kind: 'resources', resources: draft.resources });
    }
    case 'assign':
      return incomplete('Name a recipient for every row.');
  }
}

function submitChoice(
  prompt: StructuredChoicePromptView,
  selection: ChoiceSelection,
): DraftOutcome {
  return {
    ok: true,
    command: { type: 'SubmitChoice', interactionId: prompt.interactionId, selection },
  };
}

/* ------------------------------------------------- reactions and the hand */

/**
 * Cards in this seat's hand that may answer the trick awaiting priority.
 *
 * Veto answers anything. Boomerang answers only the five tricks whose effect can be
 * turned back on the player who played it; the engine holds that list, so a card it
 * would refuse is left out rather than offered and rejected.
 *
 * A Boomerang also has to *land*. The reversed card is re-run with this seat as its owner
 * and the original player as its only legal target, so the same A18 counting that governs
 * playing the card governs reversing it — and Dragnet's five and Show Me
 * Your Documents' rights zone are both this seat's problem once it reverses them, not the
 * original player's. Offering a Boomerang that cannot land spends the card on a refusal.
 */
export function reactionCardIds(
  view: PlayerView,
  seatId: string,
  playedCardId: string,
  playedByPlayerId: string,
): readonly string[] {
  const played = TRICK_BY_ID.get(playedCardId);
  const reversible = played !== undefined
    && REVERSIBLE_HANDLERS.has(played.handlerId)
    && trickBlockedReason(view, seatId, played.handlerId, playedByPlayerId) === undefined;
  return (view.privateTrickIds ?? []).filter((cardId) => {
    const handlerId = TRICK_BY_ID.get(cardId)?.handlerId;
    return handlerId === 'trick.veto' || (handlerId === 'trick.boomerang' && reversible);
  });
}

/**
 * The tricks whose effect Boomerang can turn around.
 *
 * This mirrors `REVERSIBLE_TRICK_HANDLERS` in `packages/engine/src/flow/effects.ts`.
 * The engine still decides; this only keeps the reaction window from offering a card the
 * engine will refuse.
 */
const REVERSIBLE_HANDLERS: ReadonlySet<string> = new Set([
  'trick.skimming',
  'trick.longMarch',
  'trick.blacklist',
  'trick.dragnet',
  'trick.rollPurge',
]);

/** A card in hand, with what it does and whether it can be played from here. */
export interface HandCard {
  cardId: string;
  title: string;
  rulesText: string;
  /**
   * The printed `OR` branch this card offers, when it offers one.
   *
   * A mode is independent of `blocked`: the two branches of Cornerstone have different
   * requirements, so the reserve can be too short for the ordinary play while the triple
   * conversion is still available. A caller must read both.
   */
  mode?: { id: string; label: string; available: boolean; requirement: string };
  /** Why the *ordinary* play of this card is blocked, when it is. Never the `mode`. */
  blocked?: string;
}

/**
 * This seat's trick hand, in the order the engine holds it.
 *
 * Boomerang never leaves the hand on a turn: it is a reaction, and the engine refuses it
 * outside a priority window. That refusal is stated here rather than the card being
 * hidden, because a player has to know they are holding it.
 */
/**
 * Board voters this seat may touch at all, which every A18 count starts from.
 *
 * A volatile area is immune, and a rival's Loyal Base closes its zone to
 * everyone but the seat that played it — including, deliberately, a voter's own owner.
 * This is `reachableBoardVoters` in the engine, read off the projection.
 */
function reachableVoters(view: PlayerView, seatId: string): readonly BoardVoter[] {
  const shielded = protectedZoneIds(view, seatId);
  return boardVoters(view).filter((entry) => !entry.volatile && !shielded.has(entry.zoneId));
}

/**
 * Why this trick cannot be played right now, or `undefined` when it can.
 *
 * House rule R16 makes a fixed quantity mandatory and refuses a *chosen* card that cannot
 * reach it, so each of these is a refusal the engine will issue after the click. All
 * eight guards `beginEffect` applies to a trick are mirrored here from the
 * projection, so the seat is told instead. The eighth closed when the bank was
 * projected: ordinary Cornerstone needs four resources left in it, and until then the
 * engine had the last word on that one alone.
 *
 * This answers the *ordinary* play. Cornerstone' triple conversion is a separate branch
 * with no reserve requirement of its own, so it is reported by `mode` below and stays
 * available when this blocks the ordinary one.
 *
 * These are guidance, not rulings. Every one of them is re-checked by `beginEffect`, and
 * a disagreement surfaces as its refusal.
 */
function trickBlockedReason(
  view: PlayerView,
  seatId: string,
  handlerId: string,
  /** Set when this card is being reversed: every target must be that seat's. */
  restrictToPlayerId?: string,
): string | undefined {
  const owned = (entries: readonly BoardVoter[]): readonly BoardVoter[] =>
    restrictToPlayerId === undefined
      ? entries
      : entries.filter((entry) => entry.ownerId === restrictToPlayerId);
  switch (handlerId) {
    case 'trick.boomerang':
      return 'Boomerang is played only as a reaction, when an opponent plays a'
        + ' trick against you.';
    case 'trick.veto':
      return view.activeEffects.length === 0
        ? 'Veto needs an open trick or news effect to discard; none is open.'
        : undefined;
    case 'trick.flipFlop':
      return (view.privatePolicyCards ?? []).length === 0
        ? 'Flip-Flop flips one of your own Policy Cards; you have kept none.'
        : undefined;
    case 'trick.loyalBase':
      return view.zones.some((zone) => zone.majorityOwnerId === seatId)
        ? undefined
        : 'Loyal Base protects a majority of yours; you hold none.';
    case 'trick.dragnet': {
      const eligible = owned(reachableVoters(view, seatId).filter((entry) => !entry.majority));
      return eligible.length < 5
        ? `Dragnet imprisons exactly five voters; ${eligible.length} can be reached.`
        : undefined;
    }
    case 'trick.rollPurge': {
      const rightsZoneIds = new Set(
        view.zones.filter((zone) => zone.rightsOwnerId === seatId).map((zone) => zone.id),
      );
      return owned(reachableVoters(view, seatId)).some((entry) => rightsZoneIds.has(entry.zoneId))
        ? undefined
        : 'Roll Purge needs a reachable voter in a zone where you hold'
          + ' redistricting rights; there is none.';
    }
    case 'trick.cornerstone': {
      const reserve = totalOf(view.publicReserve);
      return reserve < 4
        ? `Cornerstone grants four resources from the bank; ${reserve}`
          + ` ${reserve === 1 ? 'is' : 'are'} left in it.`
        : undefined;
    }
    case 'trick.musicalChairs': {
      // The engine does not apply Cult protection to this one, so neither does this.
      const swappable = boardVoters(view).filter((entry) => !entry.volatile && !entry.majority);
      return swappable.length < 2
        ? `Musical Chairs swaps two voters; ${swappable.length} can be swapped.`
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Whether the Cornerstone triple conversion has a zone it could actually convert.
 *
 * `canConvertSomeElevenZone`, read off the projection: an 11-area zone whose opponent
 * voters this seat could replace one for one out of its own supply, none of them shielded
 * by a rival's Cult. The engine checks this *before* the other two cards leave the hand,
 * because a refusal after that point would cost the seat two cards for nothing — which is
 * exactly why the seat should be told first.
 */
function canConvertElevenZone(view: PlayerView, seatId: string): boolean {
  const supply = voterSupply(view);
  if (supply === null) return true;
  const shielded = protectedZoneIds(view, seatId);
  return view.zones.filter((zone) => zone.capacity === 11).some((zone) => {
    const opponents = boardVoters(view).filter((entry) =>
      entry.zoneId === zone.id && !entry.volatile && entry.ownerId !== seatId);
    return opponents.length <= supply && !opponents.some((entry) => shielded.has(entry.zoneId));
  });
}

export function handCards(view: PlayerView, seatId: string): readonly HandCard[] {
  const hand = view.privateTrickIds ?? [];
  const pillars = hand.filter((cardId) =>
    TRICK_BY_ID.get(cardId)?.handlerId === 'trick.cornerstone');
  const convertible = canConvertElevenZone(view, seatId);
  return hand.flatMap((cardId) => {
    const card = TRICK_BY_ID.get(cardId);
    if (card === undefined) return [];
    const entry: HandCard = { cardId, title: card.title, rulesText: card.rulesText };
    const blocked = trickBlockedReason(view, seatId, card.handlerId);
    if (blocked !== undefined) {
      entry.blocked = blocked;
    }
    if (card.handlerId === 'trick.cornerstone') {
      entry.mode = {
        id: 'triple',
        label: 'Play three to convert a 6/11 zone',
        available: pillars.length >= 3 && convertible,
        requirement: pillars.length < 3
          ? `Needs three Cornerstone cards; you hold ${pillars.length}.`
          : 'Needs an 11-area zone whose opponent voters you could replace from your own'
            + ' supply, and none of them protected by a rival’s Cult.',
      };
    }
    return [entry];
  });
}

/* ------------------------------------------------------------------- trades */

/**
 * True when the engine's trade window is open.
 *
 * This mirrors the window in `applyTradeCommand`: the active seat's before-answer or
 * action window, with nothing pending but an Policy Card. It is checked rather than
 * `legalActions` because a seat that is not the active one may still answer or counter a
 * trade, and `getLegalActions` only advertises the commands of the seat it is asked about.
 */
export function tradeWindowOpen(view: PlayerView): boolean {
  return view.status === 'active'
    && view.activePlayerId !== undefined
    && (view.phase === 'action' || view.phase === 'policyAnswer')
    && (view.pendingDecision === undefined || view.pendingDecision.kind === 'policyAnswer');
}

/** Trade offers this seat proposed, and offers it has been asked to answer. */
export function tradeOffers(
  view: PlayerView,
  seatId: string,
): { mine: readonly TradeOfferView[]; theirs: readonly TradeOfferView[] } {
  const offers = view.privateTradeOffers ?? [];
  return {
    mine: offers.filter((offer) => offer.proposerId === seatId),
    theirs: offers.filter((offer) => offer.opponentId === seatId),
  };
}

/* ------------------------------------------------ debts, obligations, voters */

/** The one obligation this build can settle, with the price the engine will demand. */
export const KHAKI_TERROR_PAYMENT: ResourceVectorDto = { cash: 1, influence: 1, press: 1, faith: 1 };

/**
 * Voters this seat may take back from a rival's Loyal Base.
 *
 * Three of this seat's own voters convert to the rival's, so the candidates are its own
 * board voters on non-volatile areas. The engine also requires the rival to hold three
 * voters in supply and this seat to keep a majority afterwards, neither of which is
 * published, so it has the last word.
 */
export function stealBaseSlotIds(
  view: PlayerView,
  seatId: string,
  chosenVoterIds: readonly string[],
): ReadonlySet<string> {
  if (chosenVoterIds.length >= 3) return new Set();
  return new Set(
    boardVoters(view)
      .filter((entry) => entry.ownerId === seatId && !entry.volatile)
      .filter((entry) => !chosenVoterIds.includes(entry.voterId))
      .map((entry) => entry.slotId),
  );
}

/** Loyal Base cards held by a rival, which this seat may try to steal. */
export function stealableCultCards(
  view: PlayerView,
  seatId: string,
): readonly { sourceCardId: string; ownerId: string; zoneIds: readonly string[] }[] {
  return view.activeEffects
    .filter((effect) => effect.kind === LOYAL_BASE && effect.ownerId !== seatId)
    .map((effect) => ({
      sourceCardId: effect.sourceCardId,
      ownerId: effect.ownerId,
      zoneIds: [...effect.targetZoneIds],
    }));
}
