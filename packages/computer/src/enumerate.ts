/**
 * Every command a seat could try now, listed from its own projection.
 *
 * This is the enumerator the three policies and the autoplay driver share. It reads a
 * seat's `PlayerView` through the same derivations the composers use, so every command it
 * lists is one the screen could have offered. It has no opinion about which command is
 * best: the policies order and filter what it lists, and `candidateCommands` at the bottom
 * is the autoplay ladder, kept in its exact historical order because the sweeps and the
 * fixed-seed full-game tests depend on that behavior.
 *
 * Nothing here applies a rule. The engine re-checks every payment and every target, and a
 * refusal is a finding rather than something to route around.
 */
import { TRICK_CARDS, type Cost, type ResourceType } from '@seatgrab/content';
import type {
  GameCommand,
  PlayerView,
  ResourceVectorDto,
  StructuredChoicePromptView,
  TradeOfferView,
} from '@seatgrab/protocol';
import {
  KHAKI_TERROR_PAYMENT,
  NO_RESOURCES,
  RESOURCE_ORDER,
  choiceCommand,
  choiceModel,
  crackdownSlotIds,
  demolitionSlotIds,
  dueGroupIds,
  gerrymanderDestinationSlotIds,
  gerrymanderRightsZoneIds,
  gerrymanderSourceSlotIds,
  gerrymanderAllowance,
  handCards,
  legalPlacementSlotIds,
  openChoiceDraft,
  outreachSlotIds,
  powerStatuses,
  printedTotal,
  purchaseCost,
  purchaseVoterCount,
  reactionCardIds,
  startingResourceQuota,
  totalOf,
  trickCost,
  voterSupply,
  type ChoiceControl,
  type ChoiceDraft,
  type HandCard,
  type PowerStatus,
} from '@seatgrab/seat';

/** A voter group waiting to be placed, as the projection carries it. */
export type PendingGroup = PlayerView['pendingVoterGroups'][number];

export type Placement = 'concentrate' | 'spread';

/**
 * How many distinct answers the driver composes for one choice prompt.
 *
 * Twelve covers the largest eligible set any operation offers a rotation over without
 * turning a stuck prompt into a long search: a prompt that refuses twelve complete,
 * composer-built drafts is a finding, not a driver that needs more attempts.
 */
export const CHOICE_ATTEMPTS = 12;

/**
 * How many picks one draft may accumulate before the driver gives up on it.
 *
 * The largest operation asks for six, three ordered pairs for Standoff, and each pick
 * costs one pass because the controls are re-derived between them.
 */
export const CHOICE_PICKS = 16;

/**
 * Resources a seat keeps back rather than spending on a trick.
 *
 * A trick costs 4 or 5 and buys no voters, so a seat that spent down to nothing for one
 * would stop filling the board. Three is the cheapest voter card, so this leaves every
 * purchase still reachable next turn.
 */
export const TRICK_RESERVE = 3;

/* -------------------------------------------------------------- the payments */

/**
 * An exact allocation for a printed price, or `null` when this seat cannot pay it.
 *
 * Typed icons are covered first from the matching resource, then the generic `?` icons
 * are covered from whatever is left, in resource order. This is the same arithmetic
 * `paymentProblem` checks, done forwards.
 */
export function affordablePayment(cost: Cost, held: ResourceVectorDto): ResourceVectorDto | null {
  const payment = { ...NO_RESOURCES };
  const left = { ...held };
  for (const resource of RESOURCE_ORDER) {
    if (left[resource] < cost[resource]) return null;
    payment[resource] += cost[resource];
    left[resource] -= cost[resource];
  }
  let generic = cost.generic;
  for (const resource of RESOURCE_ORDER) {
    const take = Math.min(generic, left[resource]);
    payment[resource] += take;
    left[resource] -= take;
    generic -= take;
  }
  return generic === 0 ? payment : null;
}

/**
 * How many more resources, per type and in total, a price needs beyond what is held.
 *
 * The named part is short by its own gap; the generic part is short by whatever the spare
 * holdings cannot cover. `total` is the number of units a discount or a windfall would
 * have to supply.
 */
export function shortfall(cost: Cost, held: ResourceVectorDto): { named: ResourceVectorDto; total: number } {
  const named = { ...NO_RESOURCES };
  let units = 0;
  let spare = 0;
  for (const resource of RESOURCE_ORDER) {
    const gap = cost[resource] - held[resource];
    if (gap > 0) {
      named[resource] = gap;
      units += gap;
    } else {
      spare += -gap;
    }
  }
  return { named, total: units + Math.max(0, cost.generic - spare) };
}

/** Take `count` resources off this seat, largest pile first, for a cap discard. */
export function discardVector(held: ResourceVectorDto, count: number): ResourceVectorDto {
  const discard = { ...NO_RESOURCES };
  const left = { ...held };
  let remaining = count;
  while (remaining > 0) {
    const richest = [...RESOURCE_ORDER].sort((a, b) => left[b] - left[a])[0];
    if (richest === undefined || left[richest] === 0) break;
    discard[richest] += 1;
    left[richest] -= 1;
    remaining -= 1;
  }
  return discard;
}

/**
 * Take `count` resources off this seat in the order `order` names, skipping empty piles.
 *
 * The medium and hard policies discard the types the open market needs least, which is
 * the front of `shortfallOrder`.
 */
export function discardByOrder(
  held: ResourceVectorDto,
  count: number,
  order: readonly ResourceType[],
): ResourceVectorDto {
  const discard = { ...NO_RESOURCES };
  const left = { ...held };
  let remaining = count;
  for (let guard = 0; remaining > 0 && guard < 64; guard += 1) {
    let took = false;
    for (const resource of order) {
      if (remaining === 0) break;
      if (left[resource] === 0) continue;
      discard[resource] += 1;
      left[resource] -= 1;
      remaining -= 1;
      took = true;
    }
    if (!took) break;
  }
  return discard;
}

/**
 * Resource types ordered by how much of each this seat has to spare.
 *
 * "To spare" is what it holds minus the most any one face-up card asks of it, so a type
 * the market needs is never the first one returned. Arbitrage reads this from both ends:
 * give away the front of the list, take the back of it.
 */
export function shortfallOrder(
  view: PlayerView,
  seatId: string,
  held: ResourceVectorDto,
): readonly ResourceType[] {
  const needed = { ...NO_RESOURCES };
  for (const cardId of view.voterMarket) {
    const cost = purchaseCost(view, seatId, cardId);
    if (cost === null) continue;
    for (const resource of RESOURCE_ORDER) {
      needed[resource] = Math.max(needed[resource], cost[resource]);
    }
  }
  return [...RESOURCE_ORDER].sort(
    (left, right) => (held[right] - needed[right]) - (held[left] - needed[left]),
  );
}

/* ------------------------------------------------------------- the placement */

export function zoneOf(view: PlayerView, slotId: string): string | undefined {
  return view.slots.find((slot) => slot.slotId === slotId)?.zoneId;
}

/** Scores one legal slot for one pick; higher is better. Ties break by slot ID. */
export type SlotScorer = (slotId: string, chosen: readonly string[]) => number;

/**
 * Choose slots for a group one at a time, re-asking `legalPlacementSlotIds` after each
 * pick because a same-zone group narrows after its first slot.
 *
 * Returns fewer than `group.count` slots when the board runs out of legal areas, which
 * the caller reads as "this group cannot be placed".
 */
export function chooseSlots(
  view: PlayerView,
  seatId: string,
  group: { count: number; sameZone: boolean; allowedZoneIds?: readonly string[] },
  score: SlotScorer,
): readonly string[] {
  const chosen: string[] = [];
  while (chosen.length < group.count) {
    const legal = legalPlacementSlotIds(view, seatId, group, chosen);
    if (legal.size === 0) return chosen;
    const scores = new Map([...legal].map((slotId) => [slotId, score(slotId, chosen)]));
    const next = [...legal].sort((left, right) => {
      const difference = (scores.get(right) ?? 0) - (scores.get(left) ?? 0);
      return difference !== 0 ? difference : left.localeCompare(right);
    })[0];
    if (next === undefined) return chosen;
    chosen.push(next);
  }
  return chosen;
}

/**
 * Where the autoplay driver puts a group of voters.
 *
 * `concentrate` gives each seat a share of the nine zones by seat number and fills those
 * first, which is how three seats between them decide all nine and the match ends the
 * ordinary way. `spread` takes the emptiest zone instead, which fills the board without
 * anybody completing nine majorities and is the only way to reach `fullBoardFinalTurns`.
 */
export function placementSlots(
  view: PlayerView,
  seatId: string,
  group: { count: number; sameZone: boolean; allowedZoneIds?: readonly string[] },
  placement: Placement,
): readonly string[] {
  const zoneIds = [...view.zones].map((zone) => zone.id).sort();
  const seats = [...view.players].sort((left, right) => left.seat - right.seat).map((p) => p.id);
  const seatIndex = Math.max(seats.indexOf(seatId), 0);
  const isHome = (zoneId: string): boolean =>
    seats.length > 0 && zoneIds.indexOf(zoneId) % seats.length === seatIndex;

  return chooseSlots(view, seatId, group, (slotId) => {
    const zone = view.zones.find((candidate) => candidate.id === zoneOf(view, slotId));
    if (zone === undefined) return -100;
    const total = Object.values(zone.counts).reduce((sum, value) => sum + value, 0);
    if (placement === 'spread') return -total;
    if (zone.majorityOwnerId !== undefined) return -50;
    const mine = zone.counts[seatId] ?? 0;
    const room = view.slots.filter(
      (slot) => slot.zoneId === zone.id && slot.voter === undefined,
    ).length;
    if (mine + room < zone.majorityThreshold) return -20;
    return mine + (isHome(zone.id) ? 20 : 0);
  });
}

/* ---------------------------------------------------------------- the choices */

/**
 * A hook a policy uses to put the options of a control in the order it prefers.
 *
 * The enumerator fills a control from the front of its option list, so reordering the
 * options is how a policy chooses a target without knowing each operation's shape. The
 * hook receives the whole control and returns one with the same shape.
 */
export type OptionOrder = (
  control: ChoiceControl,
  prompt: StructuredChoicePromptView,
) => ChoiceControl;

export const IDENTITY_ORDER: OptionOrder = (control) => control;

/** The resource types a `resources` control fills from, front first. */
export type ResourceOrder = readonly ResourceType[];

/**
 * How a `resources` control is filled: which types first, and how much of each the bank
 * can still supply. A type the bank has run out of is skipped while another can pay, so a
 * grant is never composed around a pile that is empty.
 */
export interface ResourceFill {
  order: ResourceOrder;
  available?: ResourceVectorDto;
}

/**
 * The smallest legal selection for one control, or `null` when it cannot be met.
 *
 * `offset` rotates the eligible list, which is how the driver offers a second and a third
 * answer to the same question. Several operations carry a constraint the control cannot
 * express, and the engine is the only thing that knows; rotating and re-offering is the
 * driver doing what a player does when a move is refused.
 */
export function fillControl(
  control: ChoiceControl,
  draft: ChoiceDraft,
  offset: number,
  fill: ResourceFill = { order: RESOURCE_ORDER },
): ChoiceDraft | null {
  const rotate = <T,>(items: readonly T[]): readonly T[] =>
    items.length === 0 ? items : [...items.slice(offset % items.length), ...items.slice(0, offset % items.length)];

  switch (control.select) {
    case 'option': {
      const first = rotate(control.options)[0];
      return first === undefined ? null : { ...draft, optionId: first.id };
    }
    case 'players': {
      const wanted = Math.max(control.minimum, 0);
      if (control.options.length < wanted) return null;
      return { ...draft, playerIds: rotate(control.options).slice(0, wanted).map((option) => option.id) };
    }
    case 'assign': {
      const first = rotate(control.options)[0];
      if (first === undefined) return null;
      return { ...draft, playerIds: control.rows.map(() => first.id) };
    }
    case 'cards': {
      const wanted = Math.max(control.minimum, 0);
      if (control.options.length < wanted) return null;
      return { ...draft, cardIds: rotate(control.options).slice(0, wanted).map((option) => option.id) };
    }
    case 'board': {
      // Exactly one pick, then the caller re-derives the model. Several operations read
      // the picks as ordered source/destination pairs, and the control offers destinations
      // only once a source is down. Taking two in one go would pair two sources.
      const first = rotate(control.options)[0];
      if (first === undefined) return null;
      return control.of === 'voters'
        ? { ...draft, voterIds: [...draft.voterIds, first.id] }
        : { ...draft, slotIds: [...draft.slotIds, first.id] };
    }
    case 'resources': {
      // Spread across the types rather than taking one pile. A grant is drawn from the
      // bank, which can be short of any one type, so asking for six of a single resource
      // is the way to be refused.
      const resources = { ...NO_RESOURCES };
      const order = fill.order.length === 0 ? RESOURCE_ORDER : fill.order;
      const left = fill.available === undefined ? null : { ...fill.available };
      for (let taken = 0; taken < control.total; taken += 1) {
        let resource = order[(taken + offset) % order.length];
        if (left !== null) {
          // Skip a type the bank has run out of while another can still pay.
          for (let tries = 0; resource !== undefined && left[resource] <= 0 && tries < order.length; tries += 1) {
            resource = order[(taken + offset + tries + 1) % order.length];
          }
        }
        if (resource === undefined) continue;
        resources[resource] += 1;
        if (left !== null) left[resource] -= 1;
      }
      return { ...draft, resources };
    }
  }
}

/** Reactions this seat could play to the card in a priority window, then the pass. */
export function reactionAnswers(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
): { reactions: readonly { cardId: string; command: GameCommand }[]; pass: GameCommand } {
  const pass: GameCommand = { type: 'PassPriority', interactionId: prompt.interactionId };
  if (prompt.context.op !== 'trickPriority') return { reactions: [], pass };
  const context = prompt.context;
  return {
    reactions: reactionCardIds(view, seatId, context.playedCardId, context.playedByPlayerId)
      .map((cardId) => ({
        cardId,
        command: { type: 'PlayReaction' as const, cardId, targetEffectId: prompt.interactionId },
      })),
    pass,
  };
}

/** The floor an auction bid must reach, and whether this seat is already the high bidder. */
export function auctionFloor(
  prompt: StructuredChoicePromptView,
  seatId: string,
): { floor: number; leading: boolean } | null {
  if (prompt.context.op !== 'auction') return null;
  return {
    floor: Math.max(prompt.context.minimumBid, prompt.context.currentBid + 1),
    leading: prompt.context.currentBidderId === seatId,
  };
}

/** A bid command for `amount`, or `null` when the composer would not build one. */
export function bidCommand(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  amount: number,
): GameCommand | null {
  const outcome = choiceCommand(view, seatId, prompt, { ...openChoiceDraft(prompt), bid: amount });
  return outcome.ok ? outcome.command : null;
}

/**
 * The commands that would answer a choice prompt, built exactly as the composer builds
 * them and ordered best first.
 *
 * Each is a complete draft passed through `choiceCommand`, so every one of them is a
 * draft the screen could have produced. A prompt that offers to pass is passed last:
 * passing is always legal where it is offered, and offering it first would let the seat
 * skip the card instead of resolving it.
 *
 * Auctions and priority windows are answered by `auctionAnswers` and `reactionAnswers`;
 * this returns nothing for them and for an unsupported prompt.
 */
export function answerChoice(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
  order: OptionOrder = IDENTITY_ORDER,
  fill: ResourceFill = { order: RESOURCE_ORDER },
): readonly GameCommand[] {
  const op = prompt.context.op;
  if (op === 'trickPriority' || op === 'auction' || op === 'unsupported') return [];

  const answers: GameCommand[] = [];
  const seen = new Set<string>();
  let passes = false;

  for (let offset = 0; offset < CHOICE_ATTEMPTS; offset += 1) {
    let draft = openChoiceDraft(prompt);
    // Controls are re-derived after each fill: several operations narrow what remains
    // eligible as picks accumulate, exactly as they do under a player's hand.
    for (let guard = 0; guard < CHOICE_PICKS; guard += 1) {
      const model = choiceModel(view, seatId, prompt, draft);
      passes = passes || model.allowPass;
      if (choiceCommand(view, seatId, prompt, draft).ok) break;
      let advanced = false;
      for (const control of model.controls) {
        const filled = fillControl(order(control, prompt), draft, offset, fill);
        if (filled !== null && JSON.stringify(filled) !== JSON.stringify(draft)) {
          draft = filled;
          advanced = true;
          break;
        }
      }
      if (!advanced) break;
    }
    const outcome = choiceCommand(view, seatId, prompt, draft);
    if (!outcome.ok) continue;
    const key = JSON.stringify(outcome.command);
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push(outcome.command);
  }
  if (passes) {
    answers.push({
      type: 'SubmitChoice',
      interactionId: prompt.interactionId,
      selection: { kind: 'pass' },
    });
  }
  return answers;
}

/** The autoplay answer to a choice prompt: reactions or the floor bid, then the pass. */
function autoplayChoice(
  view: PlayerView,
  seatId: string,
  prompt: StructuredChoicePromptView,
): readonly GameCommand[] {
  if (prompt.context.op === 'trickPriority') {
    const { reactions, pass } = reactionAnswers(view, seatId, prompt);
    return [...reactions.map((entry) => entry.command), pass];
  }
  if (prompt.context.op === 'auction') {
    // Bid the floor when the seat can cover it, then pass. A winning bid becomes a debt
    // to the seller and an unpaid debt blocks purchases, so bidding the minimum keeps the
    // debt payable and still carries the auction to a sale.
    const held = totalOf(heldBy(view, seatId));
    const floor = auctionFloor(prompt, seatId);
    const answers: GameCommand[] = [];
    if (floor !== null && !floor.leading && floor.floor <= held) {
      const bid = bidCommand(view, seatId, prompt, floor.floor);
      if (bid !== null) answers.push(bid);
    }
    answers.push({ type: 'PassAuction', interactionId: prompt.interactionId });
    return answers;
  }
  return answerChoice(view, seatId, prompt);
}

/* -------------------------------------------------------------- the categories */

export function heldBy(view: PlayerView, seatId: string): ResourceVectorDto {
  return view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
}

/** The setup and interrupt prompts, answered the way the autoplay driver answers them. */
export function firstPlayerVote(view: PlayerView, seatId: string): readonly GameCommand[] {
  // Every seat votes for the lowest-numbered seat other than itself, which the engine
  // refuses. That gives the lowest seat every vote but its own, so the election is
  // decided on the first ballot.
  const candidate = [...view.players]
    .sort((a, b) => a.seat - b.seat)
    .find((player) => player.id !== seatId);
  return candidate === undefined ? [] : [{ type: 'VoteForFirstPlayer', candidateId: candidate.id }];
}

/** An even split of the starting quota across the four types. */
export function evenStartingResources(view: PlayerView, seatId: string): ResourceVectorDto {
  const quota = startingResourceQuota(view, seatId);
  const resources = { ...NO_RESOURCES };
  for (let taken = 0; taken < quota; taken += 1) {
    const resource = RESOURCE_ORDER[taken % RESOURCE_ORDER.length];
    if (resource !== undefined) resources[resource] += 1;
  }
  return resources;
}

/** An affordable purchase of one market card, with its payment already computed. */
export interface Purchase {
  cardId: string;
  cost: Cost;
  voters: number;
  payment: ResourceVectorDto;
}

/** A market card this seat cannot pay for, and by how much. */
export interface Unaffordable {
  cardId: string;
  cost: Cost;
  voters: number;
  short: { named: ResourceVectorDto; total: number };
}

export interface Move {
  rightsZoneId: string;
  voterId: string;
  ownerId: string;
  sourceSlotId: string;
  sourceZoneId: string;
  destinationSlotId: string;
  destinationZoneId: string;
  command: GameCommand;
}

export interface Target {
  voterId: string;
  ownerId: string;
  slotId: string;
  zoneId: string;
  majority: boolean;
}

export interface OutreachPair {
  voterIds: readonly [string, string];
  ownerId: string;
  zoneId: string;
}

export interface TrickPlay {
  card: HandCard;
  handlerId: string;
  /** Set for the printed `OR` branch, when that is what this entry plays. */
  mode?: string;
  command: GameCommand;
}

export interface IncomingTrade {
  offer: TradeOfferView;
  accept: GameCommand;
  reject: GameCommand;
}

/**
 * Everything the active seat could do in its action window, by category.
 *
 * Payments are computed, targets are enumerated from the composers' own legal sets, and
 * nothing is ordered beyond the categories themselves. A policy reads this and decides.
 */
export interface ActionCandidates {
  held: ResourceVectorDto;
  obligations: readonly GameCommand[];
  debts: readonly GameCommand[];
  /** Groups that must be placed or discarded before anything else. */
  dueGroups: readonly PendingGroup[];
  /** The discard of every due group, offered when placement is refused. */
  discard: GameCommand | null;
  /** True while an unpaid Relief Fund obligation blocks every purchase. */
  purchasesBlocked: boolean;
  purchases: readonly Purchase[];
  unaffordable: readonly Unaffordable[];
  /** The face-down trick, when it can be paid for outright. */
  trick: { cost: Cost; payment: ResourceVectorDto } | null;
  powers: readonly PowerStatus[];
  /** Arbitrage still has a use this turn and the seat holds something to return. */
  arbitrage: boolean;
  /** Shakedown still has a use this turn. */
  shakedown: boolean;
  moves: readonly Move[];
  demolition: readonly Target[];
  crackdown: readonly Target[];
  outreach: readonly OutreachPair[];
  plays: readonly TrickPlay[];
  trades: readonly IncomingTrade[];
  endTurn: boolean;
}

function powerUsable(power: PowerStatus | undefined): boolean {
  return power !== undefined
    && power.unlocked
    && (power.usage === undefined || power.usage.used < power.usage.limit);
}

function targetsOf(view: PlayerView, slotIds: ReadonlySet<string>): readonly Target[] {
  return view.slots.flatMap((slot) =>
    slotIds.has(slot.slotId) && slot.voter !== undefined
      ? [{
        voterId: slot.voter.id,
        ownerId: slot.voter.ownerId,
        slotId: slot.slotId,
        zoneId: slot.zoneId,
        majority: slot.voter.majority,
      }]
      : []);
}

/** Trade offers waiting on this seat, with both answers built. */
export function incomingTrades(view: PlayerView, seatId: string): readonly IncomingTrade[] {
  return (view.privateTradeOffers ?? [])
    .filter((offer) => offer.opponentId === seatId)
    .map((offer) => ({
      offer,
      accept: { type: 'AcceptTrade', tradeId: offer.id },
      reject: { type: 'RejectTrade', tradeId: offer.id },
    }));
}

export function enumerateActions(view: PlayerView, seatId: string): ActionCandidates {
  const held = heldBy(view, seatId);
  const legal = new Set(view.legalActions);

  const obligations: GameCommand[] = [];
  for (const obligation of view.privateObligations ?? []) {
    // The obligation is offered only when the seat can actually meet it. Relief Fund asks
    // for one of each of the four types.
    if (RESOURCE_ORDER.some((resource) => held[resource] < KHAKI_TERROR_PAYMENT[resource])) continue;
    obligations.push({
      type: 'PayObligation',
      obligationId: obligation.id,
      selection: { kind: 'resources', resources: KHAKI_TERROR_PAYMENT },
    });
  }

  const debts: GameCommand[] = [];
  for (const debt of view.privateDebts ?? []) {
    const payment = affordablePayment(
      { ...NO_RESOURCES, generic: Math.min(debt.amount, totalOf(held)) },
      held,
    );
    if (payment !== null && totalOf(payment) > 0) {
      debts.push({ type: 'PayDebt', debtId: debt.id, payment });
    }
  }

  const due = dueGroupIds(view, seatId);
  const dueGroups = due.flatMap((groupId) => {
    const group = view.pendingVoterGroups.find((candidate) => candidate.id === groupId);
    return group === undefined ? [] : [group];
  });
  const discard: GameCommand | null = due.length > 0
    ? { type: 'ConfirmPendingVoterDiscard', groupIds: [...due] }
    : null;

  const purchasesBlocked = (view.privateObligations ?? [])
    .some((obligation) => obligation.kind === 'reliefFund');

  const supply = voterSupply(view);
  const purchases: Purchase[] = [];
  const unaffordable: Unaffordable[] = [];
  if (!purchasesBlocked && legal.has('InfluenceVoterCard')) {
    for (const cardId of view.voterMarket) {
      const cost = purchaseCost(view, seatId, cardId);
      const voters = purchaseVoterCount(view, cardId, false);
      if (cost === null || voters === null) continue;
      if (supply !== null && voters > supply) continue;
      const payment = affordablePayment(cost, held);
      if (payment === null) unaffordable.push({ cardId, cost, voters, short: shortfall(cost, held) });
      else purchases.push({ cardId, cost, voters, payment });
    }
  }

  let trick: ActionCandidates['trick'] = null;
  if (!purchasesBlocked && legal.has('BuyTrick')) {
    const cost = trickCost(view);
    const payment = cost === null ? null : affordablePayment(cost, held);
    if (cost !== null && payment !== null) trick = { cost, payment };
  }

  const powers = powerStatuses(view, seatId);
  const byId = new Map(powers.map((power) => [power.id, power]));
  const arbitrage = powerUsable(byId.get('arbitrage')) && totalOf(held) > 0;
  const shakedown = powerUsable(byId.get('shakedown'));

  const moves: Move[] = [];
  if (legal.has('Gerrymander')) {
    for (const rightsZoneId of gerrymanderRightsZoneIds(view, seatId)) {
      const allowance = gerrymanderAllowance(view, seatId, rightsZoneId);
      if (allowance.used >= allowance.limit) continue;
      for (const sourceSlotId of gerrymanderSourceSlotIds(view, seatId, rightsZoneId)) {
        const source = view.slots.find((slot) => slot.slotId === sourceSlotId);
        if (source?.voter === undefined) continue;
        for (const destinationSlotId of gerrymanderDestinationSlotIds(view, rightsZoneId, sourceSlotId)) {
          const destinationZoneId = zoneOf(view, destinationSlotId);
          if (destinationZoneId === undefined) continue;
          moves.push({
            rightsZoneId,
            voterId: source.voter.id,
            ownerId: source.voter.ownerId,
            sourceSlotId,
            sourceZoneId: source.zoneId,
            destinationSlotId,
            destinationZoneId,
            command: { type: 'Gerrymander', rightsZoneId, voterId: source.voter.id, destinationSlotId },
          });
        }
      }
    }
  }

  const demolition = legal.has('UseBreakingGround') && powerUsable(byId.get('demolition'))
    ? targetsOf(view, demolitionSlotIds(view))
    : [];
  const crackdown = legal.has('UsePayback') && powerUsable(byId.get('crackdown')) && totalOf(held) >= 1
    ? targetsOf(view, crackdownSlotIds(view, seatId))
    : [];

  const outreach: OutreachPair[] = [];
  const outreachCost: Cost = { cash: 0, influence: 0, press: 0, faith: 2, generic: 2 };
  if (
    legal.has('UseToughLove')
    && powerUsable(byId.get('outreach'))
    && affordablePayment(outreachCost, held) !== null
    && (supply === null || supply >= 2)
  ) {
    for (const first of targetsOf(view, outreachSlotIds(view, seatId, []))) {
      for (const second of targetsOf(view, outreachSlotIds(view, seatId, [first.voterId]))) {
        if (first.voterId < second.voterId) {
          outreach.push({ voterIds: [first.voterId, second.voterId], ownerId: first.ownerId, zoneId: first.zoneId });
        }
      }
    }
  }

  const plays: TrickPlay[] = [];
  if (legal.has('PlayTrick')) {
    for (const card of handCards(view, seatId)) {
      const handlerId = handlerOf(card.cardId);
      if (card.mode !== undefined && card.mode.available) {
        plays.push({
          card,
          handlerId,
          mode: card.mode.id,
          command: { type: 'PlayTrick', cardId: card.cardId, mode: card.mode.id },
        });
      }
      if (card.blocked === undefined) {
        plays.push({ card, handlerId, command: { type: 'PlayTrick', cardId: card.cardId } });
      }
    }
  }

  return {
    held,
    obligations,
    debts,
    dueGroups,
    discard,
    purchasesBlocked,
    purchases,
    unaffordable,
    trick,
    powers,
    arbitrage,
    shakedown,
    moves,
    demolition,
    crackdown,
    outreach,
    plays,
    trades: incomingTrades(view, seatId),
    endTurn: legal.has('RequestEndTurn'),
  };
}

const TRICK_HANDLERS = new Map(TRICK_CARDS.map((card) => [card.id as string, card.handlerId]));

/** The engine handler behind a trick card, or the card ID when it is not a trick. */
export function handlerOf(cardId: string): string {
  return TRICK_HANDLERS.get(cardId) ?? cardId;
}

/* ------------------------------------------------------------ the autoplay ladder */

export interface LadderOptions {
  placement?: Placement;
}

/**
 * Every command the autoplay seat would try now, best first.
 *
 * This is the historical driver ladder, kept in its exact order: the sweeps and the
 * fixed-seed full-game tests are the regression instrument for the enumerator, and they
 * measure this. It is built from the same building blocks the policies use.
 */
export function candidateCommands(
  view: PlayerView,
  seatId: string,
  options: LadderOptions = {},
): readonly GameCommand[] {
  const prompt = view.prompt;
  const held = heldBy(view, seatId);
  const placement = options.placement ?? 'concentrate';

  if (prompt !== undefined) {
    switch (prompt.kind) {
      case 'firstPlayerVote':
        return firstPlayerVote(view, seatId);
      case 'startingResources':
        return [{ type: 'ChooseStartingResources', resources: evenStartingResources(view, seatId) }];
      case 'policyAnswer':
        return [
          { type: 'CommitPolicyAnswer', answerIndex: 0 },
          { type: 'CommitPolicyAnswer', answerIndex: 1 },
        ];
      case 'capDiscard':
        return [{ type: 'DiscardExcessResources', resources: discardVector(held, prompt.excess) }];
      case 'majoritySelection': {
        const voterIds = prompt.eligibleVoterIds.slice(0, prompt.required);
        return voterIds.length < prompt.required
          ? []
          : [{
            type: 'SubmitChoice',
            interactionId: prompt.interactionId,
            selection: { kind: 'voters', voterIds: [...voterIds] },
          }];
      }
      case 'choice':
        return autoplayChoice(view, seatId, prompt);
    }
  }

  if (view.activePlayerId !== seatId) return [];

  const actions = enumerateActions(view, seatId);
  const candidates: GameCommand[] = [...actions.obligations, ...actions.debts];

  // A group waiting to be placed blocks the end of the turn, so it goes next. The
  // discard is the last rung: it is the printed policy when nowhere legal remains.
  for (const group of actions.dueGroups) {
    const slotIds = placementSlots(view, seatId, group, placement);
    if (slotIds.length === group.count) {
      candidates.push({ type: 'PlaceVoterGroup', groupId: group.id, slotIds: [...slotIds] });
    }
  }
  if (actions.discard !== null) {
    candidates.push(actions.discard);
    return candidates;
  }

  // The cheapest card first, so a seat buys as often as it can afford to and the board
  // fills at a rate a match can finish at.
  for (const entry of [...actions.purchases].sort((left, right) => printedTotal(left.cost) - printedTotal(right.cost))) {
    candidates.push({
      type: 'InfluenceVoterCard',
      cardId: entry.cardId,
      payment: { resources: entry.payment, discounts: { ...NO_RESOURCES } },
    });
  }

  // A trick, below the voter market. The seat buys one whenever it can still pay for a
  // voter card afterwards.
  if (actions.trick !== null && totalOf(held) - printedTotal(actions.trick.cost) >= TRICK_RESERVE) {
    candidates.push({
      type: 'BuyTrick',
      payment: { resources: actions.trick.payment, discounts: { ...NO_RESOURCES } },
    });
  }

  // Arbitrage, when nothing in the market can be paid for. The driver reaches for it
  // only when a purchase is already impossible, so it stays a fallback.
  if (actions.arbitrage) {
    for (const give of shortfallOrder(view, seatId, held)) {
      if (held[give] < 1) continue;
      for (const take of shortfallOrder(view, seatId, held).slice().reverse()) {
        if (give === take) continue;
        candidates.push({
          type: 'UseProspecting',
          payment: { ...NO_RESOURCES, [give]: 1 },
          gain: { ...NO_RESOURCES, [take]: 2 },
        });
      }
    }
  }

  // Then play what it bought. Cornerstone is offered in its triple mode first.
  for (const play of actions.plays) candidates.push(play.command);

  if (actions.endTurn) candidates.push({ type: 'RequestEndTurn' });
  return candidates;
}
