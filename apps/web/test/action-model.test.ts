/**
 * The action model: payments, legal targets, power status, and the commands a draft
 * produces.
 *
 * These are the decisions a composer makes before anything is submitted, so they are
 * tested against real projected views from the real engine rather than hand-built
 * literals. Two things matter here beyond the arithmetic:
 *
 * 1. A composed command must actually be accepted. Several tests finish by handing the
 *    command `draftCommand` produced to `applyCommand`, because a composer that builds
 *    a well-typed command the engine refuses is worse than one that builds none.
 * 2. A target set the composer offers must be a set the engine agrees with. Where a rule
 *    is mirrored here — a volatile voter cannot move, a marked one needs Landslide —
 *    the test drives the engine with an excluded target and expects the refusal.
 */
import { describe, expect, it } from 'vitest';

import { CORE_BOARD, type Cost, type Archetype } from '@gerrymander/content';
import { CORE_CONTENT, applyCommand, createGame, projectGame } from '@gerrymander/engine';
import type { GameConfig, GameState } from '@gerrymander/engine';
import type { GameCommand, PlayerView, ResourceVectorDto } from '@gerrymander/protocol';

import {
  NO_PAYMENT,
  NO_RESOURCES,
  RESOURCE_ORDER,
  actionAvailability,
  actionDraftReducer,
  campaignAttention,
  draftCommand,
  endTurnAvailability,
  draftTargeting,
  dueGroupIds,
  effectivePolicyCounts,
  gerrymanderAllowance,
  gerrymanderDestinationSlotIds,
  gerrymanderRightsZoneIds,
  gerrymanderSourceSlotIds,
  hasElectionFever,
  volunteersRemaining,
  legalPlacementSlotIds,
  level3Limit,
  passiveIncome,
  paymentBreakdown,
  paymentProblem,
  powerStatuses,
  arbitrageLimits,
  promptTargeting,
  trickCost,
  purchaseCost,
  startingResourceQuota,
  turnOrderIds,
  withResource,
  type ActionDraft,
} from '../src/app/actions';

const config: GameConfig = {
  matchId: 'action-model',
  players: [
    { id: 'p1', displayName: 'Asha', partyId: 'kite' },
    { id: 'p2', displayName: 'Bikram', partyId: 'cog' },
    { id: 'p3', displayName: 'Chandni', partyId: 'sprout' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

function viewFor(state: GameState, playerId: string): PlayerView {
  return projectGame(state, { kind: 'player', playerId }, CORE_CONTENT);
}

function accepted(state: GameState, playerId: string, command: GameCommand): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) throw new Error(`${result.response.code}: ${result.response.message}`);
  return result.state;
}

function refused(state: GameState, playerId: string, command: GameCommand): { code: string; message: string } {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (result.ok) throw new Error('The engine accepted a command this test expected it to refuse.');
  return { code: result.response.code, message: result.response.message };
}

/**
 * A match in p1's action phase, with nothing pending and resources to spend.
 *
 * Resources are moved out of the bank rather than conjured, because the engine
 * asserts that every unit is accounted for after each accepted command and would
 * otherwise reject the very commands these tests are checking.
 */
function actionPhase(seed = 31): GameState {
  const state = createGame(config, CORE_CONTENT, seed);
  state.status = 'active';
  state.turn.activePlayerId = 'p1';
  state.turn.order = ['p1', 'p2', 'p3'];
  state.turn.ordinal = 1;
  state.turn.phase = 'action';
  state.pendingInteraction = null;
  for (const player of state.players) {
    for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
      player.resources[resource] = 6;
      state.publicReserve[resource] -= 6;
    }
  }
  return state;
}

/**
 * Keep a seat's Policy Cards, taken from the real draw pile.
 *
 * The engine reconciles every policy card against the filtered content pack after each
 * command, so a seat cannot be handed invented cards: each one is removed from the pile
 * it came from, and the answer index recorded is one that really names that archetype.
 */
function grantPolicy(state: GameState, playerId: string, archetype: Archetype, count: number): void {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error(`No player ${playerId}`);
  for (let taken = 0; taken < count; taken += 1) {
    const index = state.policyDeck.drawPile.findIndex((cardId) =>
      CORE_CONTENT.policyCards
        .find((card) => card.id === cardId)
        ?.answers.some((answer) => answer.archetype === archetype) === true);
    if (index < 0) throw new Error(`The draw pile has no ${archetype} answer left`);
    const cardId = state.policyDeck.drawPile.splice(index, 1)[0]!;
    const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId)!;
    const answerIndex = card.answers[0].archetype === archetype ? 0 : 1;
    player.retainedPolicy.push({ cardId, answerIndex, archetype });
  }
}

/** Set a seat's holdings, moving the difference through the bank. */
function setResources(state: GameState, playerId: string, resources: ResourceVectorDto): void {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error(`No player ${playerId}`);
  for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
    state.publicReserve[resource] += player.resources[resource] - resources[resource];
    player.resources[resource] = resources[resource];
  }
}

/**
 * Leave the bank holding exactly `leave`, parking the rest on one seat.
 *
 * The engine reconciles every resource unit after each accepted command, so the reserve
 * cannot be shortened by writing to it — the units have to go somewhere. They are parked
 * on a seat that is not acting. That leaves it over the resource cap, which is checked
 * when a seat acts rather than asserted as an invariant, so the parked pile stays put.
 */
function leaveInReserve(state: GameState, leave: ResourceVectorDto, parkOn: string): void {
  const holder = state.players.find((candidate) => candidate.id === parkOn);
  if (holder === undefined) throw new Error(`No player ${parkOn}`);
  for (const resource of RESOURCE_ORDER) {
    const moved = state.publicReserve[resource] - leave[resource];
    if (moved < 0) {
      throw new Error(`The reserve holds less ${resource} than this test asks it to leave`);
    }
    state.publicReserve[resource] -= moved;
    holder.resources[resource] += moved;
  }
}

function place(state: GameState, ownerId: string, slotId: string, majority = false): void {
  const voter = state.voters.find(
    (candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply',
  );
  if (voter === undefined) throw new Error(`${ownerId} has no voter in supply`);
  voter.location = { kind: 'board', slotId, majority };
  const slot = state.slots.find((candidate) => candidate.slotId === slotId);
  if (slot === undefined) throw new Error(`No slot ${slotId}`);
  slot.voterId = voter.id;
}

const zoneSlots = (zoneId: string) =>
  CORE_BOARD.slots.filter((slot) => slot.zoneId === zoneId);

describe('payment allocation', () => {
  const cost = { cash: 2, influence: 0, press: 0, faith: 0, generic: 1 };
  const held = { cash: 3, influence: 3, press: 0, faith: 0 };

  it('accepts an exact allocation of the named resources and the wildcard', () => {
    expect(paymentProblem(
      cost,
      { resources: { cash: 2, influence: 1, press: 0, faith: 0 }, discounts: NO_RESOURCES },
      held,
      0,
    )).toBeNull();
  });

  it('names the shortfall on a named resource before the wildcard', () => {
    expect(paymentProblem(
      cost,
      { resources: { cash: 1, influence: 2, press: 0, faith: 0 }, discounts: NO_RESOURCES },
      held,
      0,
    )).toBe('This price needs 2 cash; 1 allocated.');
  });

  it('counts what is still unallocated, and what is over', () => {
    expect(paymentProblem(
      cost,
      { resources: { cash: 2, influence: 0, press: 0, faith: 0 }, discounts: NO_RESOURCES },
      held,
      0,
    )).toBe('Allocate 1 more for the ? icons.');
    expect(paymentProblem(
      cost,
      { resources: { cash: 2, influence: 2, press: 0, faith: 0 }, discounts: NO_RESOURCES },
      held,
      0,
    )).toBe('Remove 1; this price is 3 in total.');
  });

  it('refuses to spend what the seat does not hold', () => {
    expect(paymentProblem(
      cost,
      { resources: { cash: 2, influence: 0, press: 1, faith: 0 }, discounts: NO_RESOURCES },
      held,
      0,
    )).toBe('You hold 0 press, not 1.');
  });

  it('caps a discount at the available Volunteers allowance', () => {
    const payment = {
      resources: { cash: 0, influence: 0, press: 0, faith: 0 },
      discounts: { cash: 2, influence: 1, press: 0, faith: 0 },
    };
    expect(paymentProblem(cost, payment, held, 0)).toBe('No discount is available for this price.');
    expect(paymentProblem(cost, payment, held, 2)).toBe('Volunteers can remove only 2 from this price.');
    expect(paymentProblem(cost, payment, held, 3)).toBeNull();
  });
});

describe('seat order during setup', () => {
  it('reads the clockwise order and each seat’s quota from the projection alone', () => {
    let state = createGame(config, CORE_CONTENT, 7);
    state = accepted(state, 'p1', { type: 'VoteForFirstPlayer', candidateId: 'p2' });
    state = accepted(state, 'p2', { type: 'VoteForFirstPlayer', candidateId: 'p3' });
    state = accepted(state, 'p3', { type: 'VoteForFirstPlayer', candidateId: 'p2' });

    const view = viewFor(state, 'p3');
    expect(turnOrderIds(view)).toEqual(['p2', 'p3', 'p1']);
    expect(startingResourceQuota(view, 'p2')).toBe(1);
    expect(startingResourceQuota(view, 'p3')).toBe(2);
    expect(startingResourceQuota(view, 'p1')).toBe(3);

    // The engine agrees with the quota the composer would offer.
    state = accepted(state, 'p3', {
      type: 'ChooseStartingResources',
      resources: { cash: 2, influence: 0, press: 0, faith: 0 },
    });
    expect(refused(state, 'p1', {
      type: 'ChooseStartingResources',
      resources: { cash: 2, influence: 0, press: 0, faith: 0 },
    }).message).toContain('exactly 3');
  });
});

describe('voter purchase', () => {
  it('composes a purchase the engine accepts, and reports what is missing first', () => {
    const state = actionPhase();
    const view = viewFor(state, 'p1');
    const card = view.voterCards[0]!;
    const cost = purchaseCost(view, 'p1', card.id)!;

    let draft: ActionDraft = {
      kind: 'influence',
      cardId: card.id,
      groundswell: false,
      payment: NO_PAYMENT,
    };
    const empty = draftCommand(view, 'p1', draft);
    expect(empty.ok).toBe(false);

    // Pay each named resource, then the wildcards with cash.
    for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
      draft = actionDraftReducer(draft, {
        type: 'resource',
        field: 'payment',
        resource,
        amount: cost[resource] + (resource === 'cash' ? cost.generic : 0),
      });
    }
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.command.type).toBe('InfluenceVoterCard');
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('adds a surcharge an effect has put on the price', () => {
    const state = actionPhase();
    const view = viewFor(state, 'p1');
    const card = view.voterCards[0]!;
    expect(purchaseCost(view, 'p1', card.id)).toEqual(card.cost);

    const surcharged: PlayerView = {
      ...view,
      activeEffects: [{
        id: 'effect-1',
        sourceCardId: 'NEWS012',
        title: 'Tabloid Scandal',
        kind: 'tabloidScandal',
        ownerId: 'p1',
        targetPlayerIds: ['p1'],
        targetZoneIds: [],
      }],
    };
    expect(purchaseCost(surcharged, 'p1', card.id)?.generic).toBe(card.cost.generic + 1);
    expect(purchaseCost(surcharged, 'p2', card.id)?.generic).toBe(card.cost.generic);
  });

  it('prices the surcharge off the effect kind, so a retitled card still charges it', () => {
    // Session 21's first item. The composers used to match the printed title, so a
    // content pack that renamed this card would have quoted the price without the
    // surcharge and sent a payment the engine refuses.
    const view = viewFor(actionPhase(), 'p1');
    const card = view.voterCards[0]!;
    const retitled: PlayerView = {
      ...view,
      activeEffects: [{
        id: 'effect-1',
        sourceCardId: 'NEWS012',
        title: 'Freedom, But Too Much Of It',
        kind: 'tabloidScandal',
        ownerId: 'p1',
        targetPlayerIds: ['p1'],
        targetZoneIds: [],
      }],
    };
    expect(purchaseCost(retitled, 'p1', card.id)?.generic).toBe(card.cost.generic + 1);

    // And the converse: the printed title on its own buys nothing.
    const titleOnly: PlayerView = {
      ...view,
      activeEffects: [{
        id: 'effect-1',
        sourceCardId: 'NEWS012',
        title: 'Tabloid Scandal',
        kind: 'somethingElse',
        ownerId: 'p1',
        targetPlayerIds: ['p1'],
        targetZoneIds: [],
      }],
    };
    expect(purchaseCost(titleOnly, 'p1', card.id)?.generic).toBe(card.cost.generic);
  });

  it('doubles a level 3 allowance from Grand Coalition’s kind rather than its title', () => {
    const view = viewFor(actionPhase(), 'p1');
    expect(level3Limit(view, 'p1', 2)).toBe(2);
    const alliance = (kind: string, title: string): PlayerView => ({
      ...view,
      activeEffects: [{
        id: 'effect-1',
        sourceCardId: 'TRK006',
        title,
        kind,
        ownerId: 'p1',
        targetPlayerIds: [],
        targetZoneIds: [],
      }],
    });
    expect(level3Limit(alliance('grandCoalition', 'Renamed Alliance'), 'p1', 2)).toBe(4);
    expect(level3Limit(alliance('somethingElse', 'Grand Coalition'), 'p1', 2)).toBe(2);
  });

  it('names the voter tokens a purchase is short of before the price is spent', () => {
    // A player at a table can see their own pile. Until Session 20 this build could not:
    // the composer built a payable command, the engine took the click and answered "not
    // enough voter tokens in supply", and the seat found out afterwards.
    const state = actionPhase();
    const card = CORE_CONTENT.voterCards.find(
      (candidate) => candidate.id === viewFor(state, 'p1').voterCards[0]!.id,
    )!;
    // Leave one fewer token in supply than the card yields.
    const spare = state.voters.filter(
      (voter) => voter.ownerId === 'p1' && voter.location.kind === 'supply',
    );
    for (const voter of spare.slice(0, spare.length - (card.voters - 1))) {
      voter.location = { kind: 'removed', reason: 'fixture' };
    }
    const view = viewFor(state, 'p1');
    expect(view.privateVoterSupply).toBe(card.voters - 1);

    const cost = purchaseCost(view, 'p1', card.id)!;
    let draft: ActionDraft = {
      kind: 'influence',
      cardId: card.id,
      groundswell: false,
      payment: NO_PAYMENT,
    };
    for (const resource of RESOURCE_ORDER) {
      draft = actionDraftReducer(draft, {
        type: 'resource',
        field: 'payment',
        resource,
        amount: cost[resource] + (resource === 'cash' ? cost.generic : 0),
      });
    }
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain(`${card.voters - 1} voter token`);

    // The price is fully allocated, so the only thing left is the figure the engine would
    // have answered with — and it answers with exactly that.
    if (draft.kind !== 'influence') throw new Error('the draft stopped being a purchase');
    expect(refused(state, 'p1', {
      type: 'InfluenceVoterCard',
      cardId: card.id,
      payment: { resources: draft.payment.resources, discounts: draft.payment.discounts },
    }).message).toContain('not have enough voter tokens in supply');

    // One more token and the same draft composes.
    state.voters.find((voter) => voter.ownerId === 'p1' && voter.location.kind === 'removed')!
      .location = { kind: 'supply' };
    expect(draftCommand(viewFor(state, 'p1'), 'p1', draft).ok).toBe(true);
  });

  it('offers no discount until three Reformer cards are kept', () => {
    const state = actionPhase();
    expect(volunteersRemaining(viewFor(state, 'p1'), 'p1')).toBe(0);

    grantPolicy(state, 'p1', 'reformer', 3);
    expect(volunteersRemaining(viewFor(state, 'p1'), 'p1')).toBe(2);

    state.turn.usage.volunteers = 2;
    expect(volunteersRemaining(viewFor(state, 'p1'), 'p1')).toBe(0);
  });
});

describe('trick purchase', () => {
  it('quotes the price the engine charges, and composes a purchase it accepts', () => {
    const state = actionPhase();
    const view = viewFor(state, 'p1');
    const cost = trickCost(view);

    // The composer is told a price and nothing else. It has no card ID to show, because
    // the card is bought face down; the whole control is the price and the payment.
    expect(cost).not.toBeNull();
    expect(cost?.generic).toBeGreaterThanOrEqual(4);
    expect(cost?.generic).toBeLessThanOrEqual(5);
    for (const resource of RESOURCE_ORDER) {
      expect(cost?.[resource]).toBe(0);
    }

    let draft: ActionDraft = { kind: 'trick', payment: NO_PAYMENT };
    expect(draftCommand(view, 'p1', draft).ok).toBe(false);

    draft = actionDraftReducer(draft, {
      type: 'resource',
      field: 'payment',
      resource: 'cash',
      amount: cost!.generic,
    });
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.command.type).toBe('BuyTrick');

    const next = accepted(state, 'p1', outcome.command);
    expect(next.players.find((player) => player.id === 'p1')?.trickHand).toHaveLength(1);
  });

  it('reports the shortfall rather than offering a purchase that would be refused', () => {
    const state = actionPhase();
    setResources(state, 'p1', { cash: 2, influence: 0, press: 0, faith: 0 });
    const view = viewFor(state, 'p1');
    const cost = trickCost(view)!;

    const draft = actionDraftReducer(
      { kind: 'trick', payment: NO_PAYMENT },
      { type: 'resource', field: 'payment', resource: 'cash', amount: 2 },
    );
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The shortfall is counted off the real price, whichever of 4 and 5 this card carries.
    expect(outcome.problem).toContain(`${cost.generic - 2} more`);
  });

  it('shows the surcharge in the quote, so the price on screen is the price charged', () => {
    const state = actionPhase();
    const plain = trickCost(viewFor(state, 'p1'))!;

    state.newsDeck.drawPile = state.newsDeck.drawPile.filter((id) => id !== 'NEWS007');
    state.activeEffects.push({
      id: 'effect-leakedTapes',
      kind: 'leakedTapes',
      sourceCardId: 'NEWS007',
      ownerId: 'p1',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: {},
    } as GameState['activeEffects'][number]);

    expect(trickCost(viewFor(state, 'p1'))?.generic).toBe(plain.generic + 1);
    expect(trickCost(viewFor(state, 'p2'))?.generic).toBe(plain.generic);

    // And the quote is what the engine takes: paying the unsurcharged price is refused.
    const short = actionDraftReducer(
      { kind: 'trick', payment: NO_PAYMENT },
      { type: 'resource', field: 'payment', resource: 'cash', amount: plain.generic },
    );
    expect(draftCommand(viewFor(state, 'p1'), 'p1', short).ok).toBe(false);
  });

  it('composes nothing once the draw pile is empty', () => {
    const state = actionPhase();
    state.trickDeck.drawPile = [];
    const view = viewFor(state, 'p1');

    expect(view.trickMarket).toBeUndefined();
    expect(trickCost(view)).toBeNull();
    const outcome = draftCommand(view, 'p1', { kind: 'trick', payment: NO_PAYMENT });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain('empty');
  });
});

describe('placing a voter group', () => {
  function withPendingGroup(): GameState {
    const state = actionPhase();
    const voters = state.voters
      .filter((voter) => voter.ownerId === 'p1' && voter.location.kind === 'supply')
      .slice(0, 2);
    for (const voter of voters) voter.location = { kind: 'pending', groupId: 'group-1' };
    state.pendingVoterGroups.push({
      id: 'group-1',
      ownerId: 'p1',
      controllerId: 'p1',
      voterIds: voters.map((voter) => voter.id),
      origin: { kind: 'eviction' },
      sameZone: true,
      deadlineTurnOrdinal: 1,
    });
    return state;
  }

  it('narrows a same-zone group to the zone of its first chosen area', () => {
    const state = withPendingGroup();
    const view = viewFor(state, 'p1');
    const group = view.pendingVoterGroups[0]!;

    const before = legalPlacementSlotIds(view, 'p1', group, []);
    expect(before.size).toBe(CORE_BOARD.slots.length);

    const first = zoneSlots('north')[0]!.slotId;
    const after = legalPlacementSlotIds(view, 'p1', group, [first]);
    expect([...after].every((slotId) =>
      CORE_BOARD.slots.find((slot) => slot.slotId === slotId)?.zoneId === 'north')).toBe(true);
    expect(after.has(first)).toBe(false);
  });

  it('highlights nothing once every voter in the group has an area', () => {
    const state = withPendingGroup();
    const view = viewFor(state, 'p1');
    const group = view.pendingVoterGroups[0]!;
    const [first, second] = zoneSlots('north');
    expect(legalPlacementSlotIds(view, 'p1', group, [first!.slotId, second!.slotId]).size).toBe(0);
  });

  it('composes a placement the engine accepts, and lists the group as due', () => {
    const state = withPendingGroup();
    const view = viewFor(state, 'p1');
    expect(dueGroupIds(view, 'p1')).toEqual(['group-1']);

    const [first, second] = zoneSlots('north');
    let draft: ActionDraft = { kind: 'place', groupId: 'group-1', slotIds: [] };
    draft = actionDraftReducer(draft, { type: 'pick', slotId: first!.slotId, voterId: null });
    expect(draftCommand(view, 'p1', draft).ok).toBe(false);
    draft = actionDraftReducer(draft, { type: 'pick', slotId: second!.slotId, voterId: null });

    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('leaves out a zone Blacklist shuts this seat out of', () => {
    // The refusal this removes is not a wasted click. The ordinary placement is the one
    // move a seat cannot decline, and a screen that offered only shut-out areas walked it
    // into discarding voters it could have placed elsewhere.
    const state = withPendingGroup();
    state.trickDeck.drawPile = state.trickDeck.drawPile.filter((id) => id !== 'TRK011');
    state.activeEffects.push({
      id: 'effect-not-one-of-us',
      kind: 'blacklist',
      sourceCardId: 'TRK011',
      ownerId: 'p2',
      targetPlayerIds: ['p1'],
      targetZoneIds: ['north'],
      data: {},
    } as GameState['activeEffects'][number]);

    const view = viewFor(state, 'p1');
    const group = view.pendingVoterGroups[0]!;
    const legal = legalPlacementSlotIds(view, 'p1', group, []);
    expect(legal.size).toBeGreaterThan(0);
    for (const slotId of legal) {
      expect(CORE_BOARD.slots.find((slot) => slot.slotId === slotId)?.zoneId)
        .not.toBe('north');
    }
    // p2 is not the seat named, so nothing is withheld from it.
    expect(legalPlacementSlotIds(viewFor(state, 'p2'), 'p2', group, []).size)
      .toBe(CORE_BOARD.slots.length);

    // And the engine refuses exactly the areas that were withheld.
    const [first, second] = zoneSlots('north');
    expect(refused(state, 'p1', {
      type: 'PlaceVoterGroup',
      groupId: 'group-1',
      slotIds: [first!.slotId, second!.slotId],
    }).message).toContain('blocks this player from placing voters in that zone');
  });

  it('takes a second pick on a chosen area as a change of mind, keeping the zone', () => {
    const slotId = zoneSlots('north')[0]!.slotId;
    let draft: ActionDraft = { kind: 'place', groupId: 'group-1', slotIds: [] };
    draft = actionDraftReducer(draft, { type: 'pick', slotId, voterId: null });
    draft = actionDraftReducer(draft, { type: 'pick', slotId, voterId: null });
    // Taking an area back is not taking the zone back: the zone is a separate choice with
    // its own control, and a group has to stay in one zone anyway.
    expect(draft).toEqual({ kind: 'place', groupId: 'group-1', slotIds: [], zoneId: 'north' });
  });

  it('settles the zone on the first area tapped, and rings only that zone after', () => {
    // Placing is a choice of zone and then of areas inside it. Ringing all 126 empty areas
    // at once put the real decision behind a hundred equal-looking ones, so the first tap
    // does both: it names the zone and places the first voter of the group in it.
    const state = withPendingGroup();
    const view = viewFor(state, 'p1');
    const [first] = zoneSlots('north');

    let draft: ActionDraft = { kind: 'place', groupId: 'group-1', slotIds: [], zoneId: null };
    const whole = draftTargeting(view, 'p1', draft);
    expect(whole).not.toBeNull();
    expect(whole!.slotIds.size).toBeGreaterThan(zoneSlots('north').length);

    draft = actionDraftReducer(draft, { type: 'pick', slotId: first!.slotId, voterId: null });
    expect(draft).toEqual({
      kind: 'place',
      groupId: 'group-1',
      slotIds: [first!.slotId],
      zoneId: 'north',
    });

    const narrowed = draftTargeting(view, 'p1', draft);
    expect(narrowed).not.toBeNull();
    for (const slotId of narrowed!.slotIds) {
      expect(CORE_BOARD.slots.find((slot) => slot.slotId === slotId)?.zoneId).toBe('north');
    }
    expect(narrowed!.slotIds.has(first!.slotId)).toBe(false);
  });

  it('changes zone by abandoning the areas that fixed the old one', () => {
    const [first] = zoneSlots('north');
    let draft: ActionDraft = { kind: 'place', groupId: 'group-1', slotIds: [], zoneId: null };
    draft = actionDraftReducer(draft, { type: 'pick', slotId: first!.slotId, voterId: null });
    draft = actionDraftReducer(draft, { type: 'placeZone', zoneId: null });
    expect(draft).toEqual({ kind: 'place', groupId: 'group-1', slotIds: [], zoneId: null });
  });

  it('rings nothing once every voter in the group has an area', () => {
    const state = withPendingGroup();
    const view = viewFor(state, 'p1');
    const [first, second] = zoneSlots('north');
    const draft: ActionDraft = {
      kind: 'place',
      groupId: 'group-1',
      slotIds: [first!.slotId, second!.slotId],
      zoneId: 'north',
    };
    // Not "nothing is legal", which is a problem, but "nothing is left to choose", which
    // is the step being finished. The board goes back to being a board.
    expect(draftTargeting(view, 'p1', draft)).toBeNull();
  });

  it('narrows to a group’s own allowedZoneIds, and the engine refuses the rest', () => {
    // Session 21's third item. The restriction was on the engine's group and was not
    // projected, so the composer offered all 129 areas and the engine refused 118 of them.
    const state = withPendingGroup();
    state.pendingVoterGroups[0]!.allowedZoneIds = ['northWest'];

    const view = viewFor(state, 'p1');
    const group = view.pendingVoterGroups[0]!;
    expect(group.allowedZoneIds).toEqual(['northWest']);

    const legal = legalPlacementSlotIds(view, 'p1', group, []);
    expect(legal.size).toBe(zoneSlots('northWest').length);
    for (const slotId of legal) {
      expect(CORE_BOARD.slots.find((slot) => slot.slotId === slotId)?.zoneId)
        .toBe('northWest');
    }

    // The two areas it does offer compose a placement the engine takes.
    const allowed = zoneSlots('northWest');
    expect(() => accepted(state, 'p1', {
      type: 'PlaceVoterGroup',
      groupId: 'group-1',
      slotIds: [allowed[0]!.slotId, allowed[1]!.slotId],
    })).not.toThrow();

    // And the areas it withheld are exactly the ones the engine refuses.
    const [first, second] = zoneSlots('north');
    expect(refused(state, 'p1', {
      type: 'PlaceVoterGroup',
      groupId: 'group-1',
      slotIds: [first!.slotId, second!.slotId],
    }).message).toContain('allowed slots in one zone');
  });

  it('leaves a group out of the due set until its deadline turn is reached', () => {
    // Today's safety was an argument rather than an invariant: every group the engine
    // creates carries the ordinal it was created on, so a controller in its own action
    // phase faces all of them. A group with a later deadline broke that silently, because
    // `ConfirmPendingVoterDiscard` refuses a set that names a group which is not yet due.
    const state = withPendingGroup();
    state.pendingVoterGroups[0]!.deadlineTurnOrdinal = state.turn.ordinal + 1;
    const view = viewFor(state, 'p1');

    expect(view.pendingVoterGroups).toHaveLength(1);
    expect(dueGroupIds(view, 'p1')).toEqual([]);
    expect(refused(state, 'p1', { type: 'ConfirmPendingVoterDiscard', groupIds: ['group-1'] }).code)
      .toBe('INVALID_TARGET_SET');
    // An empty set is not a command at all — the schema requires one group — which is why
    // this is a set the screen must not offer rather than one it may send empty. The
    // discard button is disabled on `due.length === 0` for exactly that reason.
    // Nor does a group that is not yet due hold the turn open.
    expect(() => accepted(state, 'p1', { type: 'RequestEndTurn' })).not.toThrow();

    // Once the ordinal reaches the deadline, the group is due and must be named.
    state.turn.ordinal += 1;
    expect(dueGroupIds(viewFor(state, 'p1'), 'p1')).toEqual(['group-1']);
  });
});

describe('gerrymandering', () => {
  /** p1 leads North West outright, so p1 holds its redistricting rights. */
  function withRights(): GameState {
    const state = actionPhase();
    const areas = zoneSlots('northWest');
    place(state, 'p1', areas[0]!.slotId);
    place(state, 'p1', areas[1]!.slotId);
    place(state, 'p2', areas[2]!.slotId);
    return state;
  }

  it('offers only the zones this seat leads outright', () => {
    const view = viewFor(withRights(), 'p1');
    expect(gerrymanderRightsZoneIds(view, 'p1')).toEqual(['northWest']);
    expect(gerrymanderRightsZoneIds(view, 'p2')).toEqual([]);
  });

  it('never offers a volatile voter, and the engine refuses one', () => {
    const state = withRights();
    const volatileSlot = zoneSlots('northWest').find((slot) => slot.volatile);
    if (volatileSlot === undefined) throw new Error('North West has no volatile area to test');
    place(state, 'p1', volatileSlot.slotId);
    const view = viewFor(state, 'p1');

    const sources = gerrymanderSourceSlotIds(view, 'p1', 'northWest');
    expect(sources.has(volatileSlot.slotId)).toBe(false);

    const stuck = view.slots.find((slot) => slot.slotId === volatileSlot.slotId)!;
    const destinations = [...gerrymanderDestinationSlotIds(view, 'northWest', volatileSlot.slotId)];
    expect(destinations.length).toBeGreaterThan(0);
    expect(refused(state, 'p1', {
      type: 'Gerrymander',
      rightsZoneId: 'northWest',
      voterId: stuck.voter!.id,
      destinationSlotId: destinations[0]!,
    }).code).toBe('VOLATILE_VOTER_IMMUNE');
  });

  it('offers a marked voter only with Landslide', () => {
    const state = withRights();
    const marked = zoneSlots('northWest')[3]!;
    place(state, 'p2', marked.slotId, true);

    const view = viewFor(state, 'p1');
    expect(hasElectionFever(view, 'p1')).toBe(false);
    expect(gerrymanderSourceSlotIds(view, 'p1', 'northWest').has(marked.slotId)).toBe(false);

    grantPolicy(state, 'p1', 'populist', 5);
    const feverish = viewFor(state, 'p1');
    expect(hasElectionFever(feverish, 'p1')).toBe(true);
    expect(gerrymanderSourceSlotIds(feverish, 'p1', 'northWest').has(marked.slotId)).toBe(true);
    expect(gerrymanderAllowance(feverish, 'p1', 'northWest')).toEqual({ used: 0, limit: 2 });
  });

  it('keeps every destination inside a printed movement triple', () => {
    const state = withRights();
    const view = viewFor(state, 'p1');
    const source = [...gerrymanderSourceSlotIds(view, 'p1', 'northWest')][0]!;
    const sourceZone = view.slots.find((slot) => slot.slotId === source)!.zoneId;
    const destinations = gerrymanderDestinationSlotIds(view, 'northWest', source);

    expect(destinations.size).toBeGreaterThan(0);
    for (const slotId of destinations) {
      const zoneId = view.slots.find((slot) => slot.slotId === slotId)!.zoneId;
      expect(CORE_BOARD.movementTriples).toContainEqual(['northWest', sourceZone, zoneId]);
    }
  });

  it('composes a move the engine accepts, one pick at a time', () => {
    const state = withRights();
    const view = viewFor(state, 'p1');
    let draft: ActionDraft = {
      kind: 'gerrymander',
      rightsZoneId: 'northWest',
      voterId: null,
      destinationSlotId: null,
    };

    const sourceSlotId = [...draftTargeting(view, 'p1', draft)!.slotIds][0]!;
    const sourceVoterId = view.slots.find((slot) => slot.slotId === sourceSlotId)!.voter!.id;
    draft = actionDraftReducer(draft, { type: 'pick', slotId: sourceSlotId, voterId: sourceVoterId });
    expect(draftCommand(view, 'p1', draft).ok).toBe(false);

    const destinationSlotId = [...draftTargeting(view, 'p1', draft)!.slotIds][0]!;
    draft = actionDraftReducer(draft, { type: 'pick', slotId: destinationSlotId, voterId: null });

    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });
});

describe('the player mat', () => {
  function withCards(archetype: Archetype, count: number): GameState {
    const state = actionPhase();
    grantPolicy(state, 'p1', archetype, count);
    return state;
  }

  it('reports a level 3 power as locked, then unlocked, with its per-turn count', () => {
    const locked = powerStatuses(viewFor(withCards('corporate', 2), 'p1'), 'p1')
      .find((power) => power.id === 'arbitrage')!;
    expect(locked.unlocked).toBe(false);
    expect(locked.requirement).toBe('3 corporate cards');

    const state = withCards('corporate', 3);
    state.turn.usage.arbitrage = 1;
    const unlocked = powerStatuses(viewFor(state, 'p1'), 'p1')
      .find((power) => power.id === 'arbitrage')!;
    expect(unlocked.unlocked).toBe(true);
    expect(unlocked.borrowed).toBe(false);
    expect(unlocked.usage).toEqual({ used: 1, limit: 1 });
  });

  it('marks a level reached only through Turncoat as borrowed', () => {
    const state = withCards('nationalist', 2);
    state.activeEffects.push({
      id: 'effect-turncoat',
      kind: 'turncoatArchetype',
      sourceCardId: 'TRK003',
      ownerId: 'p1',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: { archetype: 'nationalist', playerId: 'p1' },
    });
    const view = viewFor(state, 'p1');

    expect(effectivePolicyCounts(view, 'p1').nationalist).toBe(3);
    const shakedown = powerStatuses(view, 'p1').find((power) => power.id === 'shakedown')!;
    expect(shakedown.unlocked).toBe(true);
    expect(shakedown.borrowed).toBe(true);
  });

  it('gives every modifier power no command of its own', () => {
    const powers = powerStatuses(viewFor(actionPhase(), 'p1'), 'p1');
    const modifiers = powers.filter((power) => power.submission === 'modifier').map((p) => p.id);
    expect(modifiers).toEqual(['groundswell', 'volunteers', 'landslide']);
  });

  it('pays one resource per two cards of an archetype', () => {
    const view = viewFor(withCards('reformer', 5), 'p1');
    expect(passiveIncome(view, 'p1')).toEqual({ cash: 0, influence: 0, press: 0, faith: 2 });
  });

  it('doubles a level 3 allowance while Grand Coalition is in play', () => {
    const state = withCards('nationalist', 3);
    state.activeEffects.push({
      id: 'effect-maha',
      kind: 'grandCoalition',
      sourceCardId: 'TRK006',
      ownerId: 'p1',
      targetPlayerIds: ['p1'],
      targetZoneIds: [],
      data: {},
    });
    const shakedown = powerStatuses(viewFor(state, 'p1'), 'p1')
      .find((power) => power.id === 'shakedown')!;
    expect(shakedown.usage).toEqual({ used: 0, limit: 4 });
  });
});

describe('power composers', () => {
  function withLevel(archetype: Archetype, count: number): GameState {
    const state = actionPhase();
    grantPolicy(state, 'p1', archetype, count);
    return state;
  }

  it('composes Arbitrage as one resource out and two in', () => {
    const state = withLevel('corporate', 3);
    const view = viewFor(state, 'p1');
    let draft: ActionDraft = { kind: 'arbitrage', payment: NO_RESOURCES, gain: NO_RESOURCES };
    expect(draftCommand(view, 'p1', draft).ok).toBe(false);

    draft = actionDraftReducer(draft, { type: 'resource', field: 'payment', resource: 'cash', amount: 1 });
    draft = actionDraftReducer(draft, { type: 'resource', field: 'gain', resource: 'faith', amount: 2 });

    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('names the exact Arbitrage gain a short reserve allows, before the click', () => {
    // Session 21's second item. The composer used to accept one or two and let the engine
    // name which, because the reserve was not projected. The reserve is a pile in the
    // middle of a physical table, so a seat can count it.
    const state = withLevel('corporate', 3);
    leaveInReserve(state, { cash: 0, influence: 0, press: 1, faith: 0 }, 'p3');
    const view = viewFor(state, 'p1');
    expect(view.publicReserve).toEqual({ cash: 0, influence: 0, press: 1, faith: 0 });

    // Returning influence puts it back before the gain is taken, so two are reachable: the
    // one press the reserve holds, and the influence just returned.
    const returningClout = arbitrageLimits(view, { cash: 0, influence: 1, press: 0, faith: 0 });
    expect(returningClout.required).toBe(2);
    expect(returningClout.perResource).toEqual({ cash: 0, influence: 1, press: 1, faith: 0 });

    // Returning press instead leaves the reserve holding two press and nothing else.
    const returningMedia = arbitrageLimits(view, { cash: 0, influence: 0, press: 1, faith: 0 });
    expect(returningMedia.perResource).toEqual({ cash: 0, influence: 0, press: 2, faith: 0 });

    // The gain the old composer would have sent — two of one type it cannot supply.
    const overdrawn = draftCommand(view, 'p1', {
      kind: 'arbitrage',
      payment: { cash: 0, influence: 1, press: 0, faith: 0 },
      gain: { cash: 0, influence: 0, press: 2, faith: 0 },
    });
    expect(overdrawn.ok).toBe(false);
    if (overdrawn.ok) return;
    expect(overdrawn.problem).toBe('The reserve can supply 1 press, not 2.');

    // The split the reserve can actually pay is composed and accepted.
    const outcome = draftCommand(view, 'p1', {
      kind: 'arbitrage',
      payment: { cash: 0, influence: 1, press: 0, faith: 0 },
      gain: { cash: 0, influence: 1, press: 1, faith: 0 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('refuses a Arbitrage gain whose total is wrong even when every type is available', () => {
    // M7 in this session's mutation check survived without this: the two tests above both
    // break a per-resource ceiling, so relaxing the *total* back to "one or two" was
    // invisible. The engine demands exactly `min(2, available)` and refuses anything else,
    // so a short total has to be named here too.
    const state = withLevel('corporate', 3);
    leaveInReserve(state, { cash: 0, influence: 0, press: 1, faith: 0 }, 'p3');
    const view = viewFor(state, 'p1');
    const payment = { cash: 0, influence: 1, press: 0, faith: 0 };
    expect(arbitrageLimits(view, payment).required).toBe(2);

    // One influence is inside every ceiling and is still the wrong total.
    const short = draftCommand(view, 'p1', { kind: 'arbitrage', payment, gain: payment });
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.problem).toBe('Take exactly 2 resources; 1 chosen.');
    expect(refused(state, 'p1', { type: 'UseProspecting', payment, gain: payment }).code)
      .toBe('RESOURCE_RESERVE_EXHAUSTED');
  });

  it('asks for one rather than two when that is all Arbitrage can take', () => {
    const state = withLevel('corporate', 3);
    leaveInReserve(state, NO_RESOURCES, 'p3');
    const view = viewFor(state, 'p1');
    const payment = { cash: 1, influence: 0, press: 0, faith: 0 };

    // Only the returned resource is available, so the engine's `min(2, available)` is one.
    expect(arbitrageLimits(view, payment).required).toBe(1);

    const two = draftCommand(view, 'p1', {
      kind: 'arbitrage',
      payment,
      gain: { cash: 2, influence: 0, press: 0, faith: 0 },
    });
    expect(two.ok).toBe(false);
    if (two.ok) return;
    expect(two.problem).toBe('The reserve can supply 1 cash, not 2.');

    // Taking nothing is inside every ceiling and is the wrong total too.
    const none = draftCommand(view, 'p1', { kind: 'arbitrage', payment, gain: NO_RESOURCES });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.problem).toBe('Take exactly 1 resource; 0 chosen.');

    const outcome = draftCommand(view, 'p1', { kind: 'arbitrage', payment, gain: payment });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('refuses Shakedown against a resource the opponent does not hold', () => {
    const state = withLevel('nationalist', 3);
    setResources(state, 'p2', { cash: 0, influence: 2, press: 0, faith: 0 });
    const view = viewFor(state, 'p1');

    const empty = draftCommand(view, 'p1', { kind: 'shakedown', opponentId: 'p2', resource: 'cash' });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problem).toBe('Bikram holds no cash.');

    const outcome = draftCommand(view, 'p1', { kind: 'shakedown', opponentId: 'p2', resource: 'influence' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('holds Outreach to two voters of one opponent in one zone', () => {
    const state = withLevel('reformer', 5);
    const areas = zoneSlots('north');
    place(state, 'p2', areas[0]!.slotId);
    place(state, 'p2', areas[1]!.slotId);
    place(state, 'p3', areas[2]!.slotId);
    place(state, 'p2', zoneSlots('south')[0]!.slotId);
    const view = viewFor(state, 'p1');

    let draft: ActionDraft = { kind: 'outreach', voterIds: [], payment: NO_PAYMENT };
    const first = view.slots.find((slot) => slot.slotId === areas[0]!.slotId)!;
    draft = actionDraftReducer(draft, {
      type: 'pick',
      slotId: first.slotId,
      voterId: first.voter!.id,
    });

    // With one voter chosen, only that opponent's other voters in that zone remain.
    const remaining = draftTargeting(view, 'p1', draft)!.slotIds;
    expect([...remaining]).toEqual([areas[1]!.slotId]);

    const second = view.slots.find((slot) => slot.slotId === areas[1]!.slotId)!;
    draft = actionDraftReducer(draft, {
      type: 'pick',
      slotId: second.slotId,
      voterId: second.voter!.id,
    });
    for (const [resource, amount] of [['faith', 2], ['cash', 2]] as const) {
      draft = actionDraftReducer(draft, { type: 'resource', field: 'payment', resource, amount });
    }

    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => accepted(state, 'p1', outcome.command)).not.toThrow();
  });

  it('never offers this seat’s own voter to Crackdown, and the engine refuses one', () => {
    const state = actionPhase();
    const mine = zoneSlots('north')[0]!;
    place(state, 'p1', mine.slotId);
    place(state, 'p2', zoneSlots('north')[1]!.slotId);
    const view = viewFor(state, 'p1');

    const targets = draftTargeting(view, 'p1', { kind: 'crackdown', voterId: null, payment: NO_RESOURCES })!;
    expect(targets.slotIds.has(mine.slotId)).toBe(false);

    const ownVoterId = view.slots.find((slot) => slot.slotId === mine.slotId)!.voter!.id;
    expect(refused(state, 'p1', {
      type: 'UsePayback',
      voterId: ownVoterId,
      payment: { cash: 1, influence: 0, press: 0, faith: 0 },
    }).code).toBe('POWER_NOT_UNLOCKED');
  });
});

describe('prompt targeting', () => {
  it('rings exactly the voters a majority selection may mark', () => {
    const state = actionPhase();
    const areas = zoneSlots('northWest');
    const threshold = CORE_BOARD.zones.find((zone) => zone.id === 'northWest')!.majorityThreshold;

    // One short of the threshold on the board, and the last voter in hand: placing it is
    // what opens the majority selection.
    for (let index = 0; index < threshold - 1; index += 1) {
      place(state, 'p1', areas[index]!.slotId);
    }
    const last = state.voters.find(
      (voter) => voter.ownerId === 'p1' && voter.location.kind === 'supply',
    )!;
    last.location = { kind: 'pending', groupId: 'group-majority' };
    state.pendingVoterGroups.push({
      id: 'group-majority',
      ownerId: 'p1',
      controllerId: 'p1',
      voterIds: [last.id],
      origin: { kind: 'eviction' },
      sameZone: true,
      deadlineTurnOrdinal: 1,
    });

    const marked = accepted(state, 'p1', {
      type: 'PlaceVoterGroup',
      groupId: 'group-majority',
      slotIds: [areas[threshold - 1]!.slotId],
    });
    expect(marked.pendingInteraction?.kind).toBe('majoritySelection');

    const view = viewFor(marked, 'p1');
    expect(view.prompt?.kind).toBe('majoritySelection');
    if (view.prompt?.kind !== 'majoritySelection') return;

    const targeting = promptTargeting(view, 'p1');
    expect(targeting?.slotIds.size).toBe(view.prompt.eligibleVoterIds.length);
    expect([...(targeting?.slotIds ?? [])].sort()).toEqual(
      areas.slice(0, threshold).map((slot) => slot.slotId).sort(),
    );
  });

  it('rings nothing when the seat is not answering a majority selection', () => {
    expect(promptTargeting(viewFor(actionPhase(), 'p1'), 'p1')).toBeNull();
  });
});

describe('the resource stepper', () => {
  it('never drops below zero and never keeps a fraction', () => {
    expect(withResource(NO_RESOURCES, 'cash', -3)).toEqual(NO_RESOURCES);
    expect(withResource(NO_RESOURCES, 'influence', 2.7).influence).toBe(2);
  });
});

/**
 * The session's exit criterion, checked end to end.
 *
 * Every command below is the one a composer would build from the projection: the setup
 * quota, the payment allocation, the placement slots, the majority selection. Nothing
 * reaches the engine that a player could not have produced from the controls.
 */
describe('a match driven only by composed commands', () => {
  /** Pay the named resources, then cover the `?` icons with whatever is left. */
  function allocate(cost: Cost, held: ResourceVectorDto): ResourceVectorDto | null {
    const payment = { ...NO_RESOURCES };
    const left = { ...held };
    for (const resource of RESOURCE_ORDER) {
      if (left[resource] < cost[resource]) return null;
      payment[resource] = cost[resource];
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

  it('runs from creation through several ordinary turns', () => {
    let state = createGame(config, CORE_CONTENT, 5);

    const ballots: readonly (readonly [string, string])[] = [['p1', 'p2'], ['p2', 'p3'], ['p3', 'p2']];
    for (const [voter, candidate] of ballots) {
      state = accepted(state, voter, { type: 'VoteForFirstPlayer', candidateId: candidate });
    }

    // Spread the quota across types, the way a player reaching for a mixed market price
    // would: every printed voter price names two or more resources.
    for (const seatId of turnOrderIds(viewFor(state, 'p1'))) {
      const quota = startingResourceQuota(viewFor(state, seatId), seatId);
      const opening = { ...NO_RESOURCES };
      for (let taken = 0; taken < quota; taken += 1) {
        opening[RESOURCE_ORDER[taken % RESOURCE_ORDER.length]!] += 1;
      }
      state = accepted(state, seatId, { type: 'ChooseStartingResources', resources: opening });
    }
    expect(state.status).toBe('active');
    expect(state.turn.ordinal).toBe(1);

    let purchases = 0;
    let placements = 0;
    let boughtThisTurn = -1;

    for (let step = 0; step < 200 && state.turn.ordinal <= 9; step += 1) {
      const decision = viewFor(state, 'p1').pendingDecision;
      const actor = decision?.responsiblePlayerIds[0] ?? state.turn.activePlayerId!;
      const view = viewFor(state, actor);
      const prompt = view.prompt;

      if (prompt?.kind === 'policyAnswer') {
        state = accepted(state, actor, { type: 'CommitPolicyAnswer', answerIndex: 0 });
        continue;
      }
      if (prompt?.kind === 'capDiscard') {
        const held = view.players.find((player) => player.id === actor)!.resources;
        let remaining = prompt.excess;
        const discard = { ...NO_RESOURCES };
        for (const resource of RESOURCE_ORDER) {
          const take = Math.min(remaining, held[resource]);
          discard[resource] = take;
          remaining -= take;
        }
        state = accepted(state, actor, { type: 'DiscardExcessResources', resources: discard });
        continue;
      }
      if (prompt?.kind === 'majoritySelection') {
        state = accepted(state, actor, {
          type: 'SubmitChoice',
          interactionId: prompt.interactionId,
          selection: { kind: 'voters', voterIds: [...prompt.eligibleVoterIds].slice(0, prompt.required) },
        });
        continue;
      }
      // A card-driven choice belongs to the campaign composers, so the walk stops here
      // rather than reaching past what this session built.
      if (prompt?.kind === 'choice') break;

      const group = view.pendingVoterGroups.find((candidate) => candidate.controllerId === actor);
      if (group !== undefined) {
        let draft: ActionDraft = { kind: 'place', groupId: group.id, slotIds: [] };
        for (let picked = 0; picked < group.count; picked += 1) {
          const legal = legalPlacementSlotIds(view, actor, group, (draft as { slotIds: readonly string[] }).slotIds);
          // Prefer a quiet area: a volatile one would queue a news, and answering a
          // news is a campaign composer this session did not build.
          const choice = [...legal].find(
            (slotId) => view.slots.find((slot) => slot.slotId === slotId)?.volatile === false,
          ) ?? [...legal][0];
          if (choice === undefined) break;
          draft = actionDraftReducer(draft, { type: 'pick', slotId: choice, voterId: null });
        }
        const outcome = draftCommand(view, actor, draft);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) break;
        state = accepted(state, actor, outcome.command);
        placements += 1;
        continue;
      }

      const held = view.players.find((player) => player.id === actor)!.resources;
      const affordable = view.voterCards.find((card) => {
        const cost = purchaseCost(view, actor, card.id);
        return cost !== null && allocate(cost, held) !== null;
      });
      if (affordable !== undefined && boughtThisTurn !== state.turn.ordinal) {
        const payment = allocate(purchaseCost(view, actor, affordable.id)!, held)!;
        const outcome = draftCommand(view, actor, {
          kind: 'influence',
          cardId: affordable.id,
          groundswell: false,
          payment: { resources: payment, discounts: NO_RESOURCES },
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) break;
        state = accepted(state, actor, outcome.command);
        boughtThisTurn = state.turn.ordinal;
        purchases += 1;
        continue;
      }

      state = accepted(state, actor, { type: 'RequestEndTurn' });
    }

    expect(state.turn.ordinal).toBeGreaterThanOrEqual(4);
    expect(purchases).toBeGreaterThan(0);
    expect(placements).toBeGreaterThan(0);
    expect(state.voters.filter((voter) => voter.location.kind === 'board').length).toBeGreaterThan(0);
  });
});


describe('the payment breakdown behind the steppers', () => {
  const held: ResourceVectorDto = { cash: 3, influence: 1, press: 2, faith: 0 };

  it('lists only the types the price names when the price has no ? part', () => {
    const cost: Cost = { cash: 2, influence: 1, press: 0, faith: 0, generic: 0 };
    const breakdown = paymentBreakdown(cost, NO_PAYMENT, held, 0);
    expect(breakdown.rows.map((row) => row.resource)).toEqual(['cash', 'influence']);
    expect(breakdown.generic).toBeNull();
  });

  it('adds every held type when the price has a ? part, and reports the ? figure', () => {
    const cost: Cost = { cash: 1, influence: 0, press: 0, faith: 0, generic: 2 };
    const breakdown = paymentBreakdown(cost, NO_PAYMENT, held, 0);
    // Faith is not held and not named, so it is not offered; the other three are.
    expect(breakdown.rows.map((row) => row.resource)).toEqual(['cash', 'influence', 'press']);
    // The named shortfall is reported on its own row first; the ? line waits its turn.
    expect(breakdown.generic).toEqual({ required: 2, covered: 0, problem: null });
    expect(breakdown.rows.find((row) => row.resource === 'cash')?.problem)
      .toBe('This price needs 1 cash; 0 allocated.');

    const named = paymentBreakdown(
      cost,
      { resources: { cash: 1, influence: 0, press: 0, faith: 0 }, discounts: NO_RESOURCES },
      held,
      0,
    );
    expect(named.rows.every((row) => row.problem === null)).toBe(true);
    expect(named.generic).toEqual({
      required: 2,
      covered: 0,
      problem: 'Allocate 2 more for the ? icons.',
    });
  });

  it('puts the shortfall on the row that is short and nowhere else', () => {
    const cost: Cost = { cash: 2, influence: 1, press: 0, faith: 0, generic: 0 };
    const payment = { resources: { cash: 2, influence: 0, press: 0, faith: 0 }, discounts: NO_RESOURCES };
    const breakdown = paymentBreakdown(cost, payment, held, 0);
    expect(breakdown.rows.find((row) => row.resource === 'cash')?.problem).toBeNull();
    expect(breakdown.rows.find((row) => row.resource === 'influence')?.problem)
      .toBe('This price needs 1 influence; 0 allocated.');
    expect(breakdown.problem).toBe('This price needs 1 influence; 0 allocated.');
  });

  it('keeps a type listed while something is allocated to it, so it can be taken back', () => {
    const cost: Cost = { cash: 2, influence: 1, press: 0, faith: 0, generic: 0 };
    const payment = { resources: { cash: 2, influence: 1, press: 1, faith: 0 }, discounts: NO_RESOURCES };
    const breakdown = paymentBreakdown(cost, payment, held, 0);
    expect(breakdown.rows.map((row) => row.resource)).toEqual(['cash', 'influence', 'press']);
    expect(breakdown.problem).toBe('Remove 1; this price is 3 in total.');
  });

  it('agrees with paymentProblem on the first problem, in the engine’s order', () => {
    const cost: Cost = { cash: 2, influence: 1, press: 0, faith: 0, generic: 1 };
    const payment = { resources: { cash: 4, influence: 0, press: 0, faith: 0 }, discounts: NO_RESOURCES };
    // Overdrawn cash is reported before the influence shortfall, as the engine checks them.
    expect(paymentBreakdown(cost, payment, held, 0).problem).toBe('You hold 3 cash, not 4.');
    expect(paymentProblem(cost, payment, held, 0)).toBe('You hold 3 cash, not 4.');
  });
});

describe('why a control is disabled', () => {
  it('offers the action when the engine lists it', () => {
    const view = viewFor(actionPhase(), 'p1');
    expect(actionAvailability(view, 'p1', 'InfluenceVoterCard')).toEqual({ can: true, reason: null });
    expect(endTurnAvailability(view, 'p1')).toEqual({ can: true, reason: null });
  });

  it('names the active seat for a seat whose turn it is not', () => {
    const view = viewFor(actionPhase(), 'p2');
    expect(actionAvailability(view, 'p2', 'InfluenceVoterCard')).toEqual({
      can: false,
      reason: 'It is Asha’s turn, not yours.',
    });
    expect(endTurnAvailability(view, 'p2').can).toBe(false);
  });

  it('names the pending decision, and whose it is', () => {
    const state = createGame(config, CORE_CONTENT, 5);
    const view = viewFor(state, 'p1');
    expect(actionAvailability(view, 'p1', 'RequestEndTurn').reason)
      .toBe('Answer your prompt first: Voting for the first player.');
    const voted = accepted(state, 'p1', { type: 'VoteForFirstPlayer', candidateId: 'p2' });
    expect(actionAvailability(viewFor(voted, 'p1'), 'p1', 'RequestEndTurn').reason)
      .toBe('Waiting on Bikram and Chandni: Voting for the first player.');
  });

  it('refuses the end of a turn while a voter group is due, before the engine has to', () => {
    const state = actionPhase();
    const card = state.voterDeck.market[0]!;
    const cost = CORE_CONTENT.voterCards.find((candidate) => candidate.id === card)!.cost;
    const bought = accepted(state, 'p1', {
      type: 'InfluenceVoterCard',
      cardId: card,
      payment: {
        resources: {
          cash: cost.cash + cost.generic,
          influence: cost.influence,
          press: cost.press,
          faith: cost.faith,
        },
        discounts: NO_RESOURCES,
      },
    });
    const view = viewFor(bought, 'p1');
    expect(view.legalActions).toContain('RequestEndTurn');
    expect(endTurnAvailability(view, 'p1')).toEqual({
      can: false,
      reason: 'Place or discard the waiting voter group first.',
    });
    expect(refused(bought, 'p1', { type: 'RequestEndTurn' }).code).toBe('MANDATORY_CHOICE_PENDING');
  });

  it('says the match is over once it is', () => {
    const state = actionPhase();
    state.status = 'finished';
    state.turn.phase = 'finished';
    const view = viewFor(state, 'p1');
    expect(endTurnAvailability(view, 'p1')).toEqual({ can: false, reason: 'The match is over.' });
  });
});

describe('when the campaign panel opens on its own', () => {
  it('stays closed with nothing waiting and opens for an offer to answer', () => {
    const state = actionPhase();
    expect(campaignAttention(viewFor(state, 'p2'), 'p2', { kind: 'none' })).toBe(false);
    const offered = accepted(state, 'p1', {
      type: 'ProposeTrade',
      opponentId: 'p2',
      giveResources: { cash: 1, influence: 0, press: 0, faith: 0 },
      receiveResources: { cash: 0, influence: 1, press: 0, faith: 0 },
      giveTrickIds: [],
      receiveTrickIds: [],
    });
    expect(campaignAttention(viewFor(offered, 'p2'), 'p2', { kind: 'none' })).toBe(true);
    // The proposer is waiting on an answer, not being asked for one.
    expect(campaignAttention(viewFor(offered, 'p1'), 'p1', { kind: 'none' })).toBe(false);
  });

  it('opens while a campaign action is being composed', () => {
    const view = viewFor(actionPhase(), 'p1');
    expect(campaignAttention(view, 'p1', {
      kind: 'trade',
      opponentId: 'p2',
      giveResources: NO_RESOURCES,
      receiveResources: NO_RESOURCES,
      giveTrickIds: [],
    })).toBe(true);
  });
});
