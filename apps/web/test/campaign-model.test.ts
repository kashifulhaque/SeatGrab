/**
 * The campaign model: card-driven choices, reactions, trades, debts and Cult theft.
 *
 * These cover the half of the game that arrives through a prompt rather than through a
 * button this screen owns, and they hold themselves to the same bar as the ordinary
 * action tests next door:
 *
 * 1. A composed command must actually be accepted. Every test that builds one finishes by
 *    handing it to `applyCommand`, because a well-typed command the engine refuses is
 *    worse than none at all.
 * 2. A candidate set the composer offers must be one the engine agrees with. Where a rule
 *    is mirrored — a volatile voter is immune, a majority voter cannot be imprisoned,
 *    Boomerang answers only some tricks — the test drives the engine with an excluded
 *    target and expects the refusal.
 * 3. Every operation the protocol can open must produce a control, or be one of the three
 *    the screen hand-builds. The fixture below is keyed by `ChoicePromptOp`, so a new
 *    operation cannot be added to the contract without this file failing to compile.
 */
import { describe, expect, it } from 'vitest';

import { CORE_BOARD, type Archetype } from '@seatgrab/content';
import {
  CORE_CONTENT,
  applyCommand,
  beginEffect,
  createGame,
  projectGame,
  startAuction,
  type GameConfig,
  type GameState,
} from '@seatgrab/engine';
import type {
  ChoicePromptOp,
  GameCommand,
  PlayerView,
  StructuredChoicePromptView,
} from '@seatgrab/protocol';

import {
  NO_RESOURCES,
  RESOURCE_ORDER,
  actionDraftReducer,
  blockedZoneIds,
  boardVoters,
  choiceCommand,
  choiceDraftMatches,
  choiceModel,
  choiceTargeting,
  draftCommand,
  handCards,
  openChoiceDraft,
  promptTargeting,
  protectedZoneIds,
  reactionCardIds,
  stealBaseSlotIds,
  stealableCultCards,
  tradeOffers,
  tradeWindowOpen,
  type ActionDraft,
  type ChoiceDraft,
  type DraftAction,
} from '../src/app/actions';

const config: GameConfig = {
  matchId: 'campaign-model',
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

function actionPhase(seed = 77): GameState {
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

const steadySlots = CORE_BOARD.slots.filter((slot) => !slot.volatile);
const volatileSlots = CORE_BOARD.slots.filter((slot) => slot.volatile);

/** Fill a zone to its printed threshold with one seat's marked voters. */
function giveMajority(state: GameState, ownerId: string, zoneId: string): void {
  const zone = CORE_BOARD.zones.find((candidate) => candidate.id === zoneId);
  if (zone === undefined) throw new Error(`fixture named no zone ${zoneId}`);
  const slots = steadySlots.filter((slot) => slot.zoneId === zoneId).slice(0, zone.majorityThreshold);
  if (slots.length < zone.majorityThreshold) throw new Error(`${zoneId} has too few quiet areas`);
  for (const slot of slots) place(state, ownerId, slot.slotId, true);
}

/** Fill the quiet areas of the board so a card that takes several voters has targets. */
function populate(state: GameState, owners: readonly string[], count: number): void {
  for (let index = 0; index < count; index += 1) {
    const slot = steadySlots[index];
    const owner = owners[index % owners.length];
    if (slot === undefined || owner === undefined) throw new Error('fixture ran out of board');
    place(state, owner, slot.slotId);
  }
}

function putInHand(state: GameState, playerId: string, cardId: string): void {
  const index = state.trickDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture trick ${cardId} missing from the draw pile`);
  state.trickDeck.drawPile.splice(index, 1);
  state.players.find((player) => player.id === playerId)!.trickHand.push(cardId);
}

function playCard(state: GameState, playerId: string, cardId: string, mode?: string): GameState {
  putInHand(state, playerId, cardId);
  return accepted(state, playerId, {
    type: 'PlayTrick',
    cardId,
    ...(mode === undefined ? {} : { mode }),
  });
}

/**
 * Begin a news against a seat without routing it through a volatile placement.
 *
 * The card leaves the draw pile first. The engine asserts after every command that no
 * card is both in a deck and in flight, so a fixture that skips the draw fails an
 * invariant rather than the rule it meant to test.
 */
function playNews(state: GameState, ownerId: string, cardId: string): GameState {
  const next = structuredClone(state);
  const card = CORE_CONTENT.newsCards.find((candidate) => candidate.id === cardId);
  if (card === undefined) throw new Error(`fixture news ${cardId} missing`);
  const index = next.newsDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture news ${cardId} is not in the draw pile`);
  next.newsDeck.drawPile.splice(index, 1);
  const error = beginEffect(next, { ownerId, card }, CORE_CONTENT);
  if (error !== null) throw new Error(error);
  return next;
}

function promptOf(state: GameState, playerId: string): StructuredChoicePromptView {
  const prompt = viewFor(state, playerId).prompt;
  if (prompt?.kind !== 'choice') {
    throw new Error(`Expected a choice prompt for ${playerId}, saw ${prompt?.kind ?? 'none'}`);
  }
  return prompt;
}

/** Compose one choice the way the screen does: open a draft, dispatch picks, submit. */
function compose(
  state: GameState,
  playerId: string,
  steps: readonly DraftAction[],
): { draft: ChoiceDraft; prompt: StructuredChoicePromptView; view: PlayerView } {
  const view = viewFor(state, playerId);
  const prompt = promptOf(state, playerId);
  let draft: ActionDraft = openChoiceDraft(prompt);
  for (const step of steps) draft = actionDraftReducer(draft, step);
  if (!choiceDraftMatches(draft, prompt)) throw new Error('the draft stopped answering the prompt');
  return { draft, prompt, view };
}

function pickVoters(voterIds: readonly string[]): readonly DraftAction[] {
  return voterIds.map((id) => ({ type: 'choiceToggle', list: 'voters', id, limit: 8 }) as const);
}

describe('a two-stage choice under one interaction', () => {
  it('follows Skimming from its opponent to its resource and is accepted at each step', () => {
    let state = playCard(actionPhase(), 'p1', 'TRK001');

    const first = compose(state, 'p1', [
      { type: 'choiceToggle', list: 'players', id: 'p2', limit: 1 },
    ]);
    expect(first.prompt.context.op).toBe('chaiOpponent');
    const opponentOutcome = choiceCommand(first.view, 'p1', first.prompt, first.draft);
    expect(opponentOutcome.ok).toBe(true);
    if (!opponentOutcome.ok) return;
    state = accepted(state, 'p1', opponentOutcome.command);

    const second = compose(state, 'p1', [{ type: 'choiceOption', optionId: 'press' }]);
    expect(second.prompt.context.op).toBe('chaiResource');
    expect(second.prompt.interactionId).toBe(first.prompt.interactionId);
    const resourceOutcome = choiceCommand(second.view, 'p1', second.prompt, second.draft);
    expect(resourceOutcome.ok).toBe(true);
    if (!resourceOutcome.ok) return;
    state = accepted(state, 'p1', resourceOutcome.command);

    expect(state.pendingInteraction).toBeNull();
    expect(state.activeEffects.some((effect) => effect.kind === 'skimming')).toBe(true);
  });

  it('stops answering once the interaction moves to its next question', () => {
    const state = playCard(actionPhase(), 'p1', 'TRK001');
    const opened = openChoiceDraft(promptOf(state, 'p1'));
    const next = accepted(state, 'p1', {
      type: 'SubmitChoice',
      interactionId: opened.interactionId,
      selection: { kind: 'players', playerIds: ['p2'] },
    });
    expect(choiceDraftMatches(opened, promptOf(next, 'p1'))).toBe(false);
  });
});

describe('a choice that takes voters off the board', () => {
  function imprisonState(): GameState {
    const state = actionPhase();
    populate(state, ['p2', 'p3'], 8);
    const marked = state.voters.find(
      (voter) => voter.ownerId === 'p2' && voter.location.kind === 'board',
    );
    if (marked?.location.kind === 'board') marked.location = { ...marked.location, majority: true };
    const volatileSlot = volatileSlots[0];
    if (volatileSlot === undefined) throw new Error('fixture found no volatile area');
    place(state, 'p3', volatileSlot.slotId);
    return playCard(state, 'p1', 'TRK012');
  }

  it('offers only non-volatile, non-majority voters, and composes five of them', () => {
    const state = imprisonState();
    const prompt = promptOf(state, 'p1');
    const view = viewFor(state, 'p1');
    const model = choiceModel(view, 'p1', prompt, null);
    const control = model.controls[0];
    expect(control?.select).toBe('board');
    if (control?.select !== 'board') return;

    const offered = new Set(control.options.map((option) => option.id));
    for (const entry of boardVoters(view)) {
      if (entry.volatile || entry.majority) expect(offered.has(entry.voterId)).toBe(false);
    }
    expect(offered.size).toBeGreaterThanOrEqual(5);

    const chosen = [...offered].slice(0, 5);
    const { draft } = compose(state, 'p1', pickVoters(chosen));
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = accepted(state, 'p1', outcome.command);
    expect(after.activeEffects.some((effect) => effect.kind === 'dragnet')).toBe(true);
  });

  it('counts the shortfall rather than offering a confirm the engine would refuse', () => {
    const state = imprisonState();
    const prompt = promptOf(state, 'p1');
    const view = viewFor(state, 'p1');
    const model = choiceModel(view, 'p1', prompt, null);
    const control = model.controls[0];
    if (control?.select !== 'board') throw new Error('expected a board control');
    const two = [...control.options].slice(0, 2).map((option) => option.id);
    const { draft } = compose(state, 'p1', pickVoters(two));
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toBe('Choose 3 more voters.');
  });

  it('agrees with the engine that a voter it left out cannot be taken', () => {
    const state = imprisonState();
    const prompt = promptOf(state, 'p1');
    const view = viewFor(state, 'p1');
    const model = choiceModel(view, 'p1', prompt, null);
    const control = model.controls[0];
    if (control?.select !== 'board') throw new Error('expected a board control');
    const offered = new Set(control.options.map((option) => option.id));
    const excluded = boardVoters(view).find((entry) => !offered.has(entry.voterId));
    if (excluded === undefined) throw new Error('fixture offered every voter');
    const rest = [...offered].slice(0, 4);
    const failure = refused(state, 'p1', {
      type: 'SubmitChoice',
      interactionId: prompt.interactionId,
      selection: { kind: 'voters', voterIds: [...rest, excluded.voterId] },
    });
    expect(failure.code).toBe('INVALID_TARGET_SET');
  });

  it('rings exactly the areas the list offers, before anything is picked', () => {
    const state = imprisonState();
    const view = viewFor(state, 'p1');
    const prompt = promptOf(state, 'p1');
    const model = choiceModel(view, 'p1', prompt, null);
    const control = model.controls[0];
    if (control?.select !== 'board') throw new Error('expected a board control');
    expect(promptTargeting(view, 'p1')?.slotIds).toEqual(control.slotIds);
    expect(choiceTargeting(view, 'p1', prompt, null)?.slotIds).toEqual(control.slotIds);
  });

  it('drops a picked area out of the ring so it cannot be chosen twice', () => {
    const state = imprisonState();
    const view = viewFor(state, 'p1');
    const prompt = promptOf(state, 'p1');
    const first = boardVoters(view).find((entry) => !entry.volatile && !entry.majority);
    if (first === undefined) throw new Error('fixture found no eligible voter');
    const { draft } = compose(state, 'p1', pickVoters([first.voterId]));
    const ringed = choiceTargeting(view, 'p1', prompt, draft)?.slotIds ?? new Set<string>();
    expect(ringed.has(first.slotId)).toBe(false);
  });
});

describe('a choice that takes a composite option', () => {
  it('joins the player and the zone the way Blacklist reads them', () => {
    const state = playCard(actionPhase(), 'p1', 'TRK011');
    const { draft, prompt, view } = compose(state, 'p1', [
      { type: 'choiceToggle', list: 'players', id: 'p3', limit: 1 },
      { type: 'choiceOption', optionId: 'northWest' },
    ]);
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.command.type !== 'SubmitChoice') return;
    expect(outcome.command.selection).toEqual({ kind: 'option', optionId: 'p3|northWest' });

    const after = accepted(state, 'p1', outcome.command);
    expect(blockedZoneIds(viewFor(after, 'p3'), 'p3').has('northWest')).toBe(true);
    expect(blockedZoneIds(viewFor(after, 'p2'), 'p2').size).toBe(0);
  });

  it('names the half that is still missing', () => {
    const state = playCard(actionPhase(), 'p1', 'TRK011');
    const { draft, prompt, view } = compose(state, 'p1', [
      { type: 'choiceToggle', list: 'players', id: 'p3', limit: 1 },
    ]);
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toBe('Choose the zone they may not place in.');
  });
});

describe('a choice that takes resources', () => {
  it('composes the four Cornerstone grants and is accepted', () => {
    const state = playCard(actionPhase(), 'p1', 'TRK017');
    const { draft, prompt, view } = compose(state, 'p1', [
      { type: 'resource', field: 'selection', resource: 'cash', amount: 3 },
      { type: 'resource', field: 'selection', resource: 'faith', amount: 1 },
    ]);
    expect(prompt.context.op).toBe('cornerstoneGain');
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = accepted(state, 'p1', outcome.command);
    expect(after.players.find((player) => player.id === 'p1')?.resources.cash).toBe(9);
  });

  it('counts an allocation that is short before offering a confirm', () => {
    const state = playCard(actionPhase(), 'p1', 'TRK017');
    const { draft, prompt, view } = compose(state, 'p1', [
      { type: 'resource', field: 'selection', resource: 'cash', amount: 1 },
    ]);
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toBe('Take 3 more.');
  });
});

describe('the reaction window', () => {
  it('offers Veto against anything and composes an accepted reaction', () => {
    const state = actionPhase();
    putInHand(state, 'p2', 'TRK004');
    const played = playCard(state, 'p1', 'TRK006');
    const prompt = promptOf(played, 'p2');
    expect(prompt.context.op).toBe('trickPriority');

    const view = viewFor(played, 'p2');
    expect(reactionCardIds(view, 'p2', 'TRK006', 'p1')).toEqual(['TRK004']);
    const after = accepted(played, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK004',
      targetEffectId: prompt.interactionId,
    });
    expect(after.activeEffects.some((effect) => effect.kind === 'grandCoalition')).toBe(false);
  });

  it('withholds Boomerang when the reverser could not run the card it would take over', () => {
    // Roll Purge is reversible, but a Boomerang re-runs it with the reactor as
    // owner and the original player as its only legal target. p2 holds no Gerrymandering
    // Rights, so the card has nowhere to land and the engine refuses the reaction — after
    // the Boomerang has already left the hand's point of view. Offering it spends a card.
    const state = actionPhase();
    populate(state, ['p1', 'p3'], 6);
    putInHand(state, 'p2', 'TRK005');
    const played = playCard(state, 'p1', 'TRK013');
    const view = viewFor(played, 'p2');
    expect(view.zones.some((zone) => zone.rightsOwnerId === 'p2')).toBe(false);
    expect(reactionCardIds(view, 'p2', 'TRK013', 'p1')).toEqual([]);

    const prompt = promptOf(played, 'p2');
    expect(refused(played, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK005',
      targetEffectId: prompt.interactionId,
    }).message).toContain('Roll Purge needs a reachable voter');
  });

  it('offers Boomerang once the reverser holds rights over a voter of the original player', () => {
    const state = actionPhase();
    // p2 takes a majority, which carries the zone's redistricting rights, and p1 stands
    // in it — so a reversed Roll Purge has exactly the target it needs.
    giveMajority(state, 'p2', 'central');
    const spare = steadySlots.filter((slot) => slot.zoneId === 'central').slice(5, 6);
    for (const slot of spare) place(state, 'p1', slot.slotId);
    putInHand(state, 'p2', 'TRK005');
    const played = playCard(state, 'p1', 'TRK013');
    const view = viewFor(played, 'p2');
    expect(view.zones.find((zone) => zone.id === 'central')?.rightsOwnerId).toBe('p2');
    expect(reactionCardIds(view, 'p2', 'TRK013', 'p1')).toEqual(['TRK005']);

    const prompt = promptOf(played, 'p2');
    const after = accepted(played, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK005',
      targetEffectId: prompt.interactionId,
    });
    const reversed = promptOf(after, 'p2').context;
    expect(reversed.op).toBe('documentsVoters');
    if (reversed.op !== 'documentsVoters') return;
    expect(reversed.restrictToPlayerId).toBe('p1');
  });

  it('narrows a reversed Skimming to the seat that played it', () => {
    // A reversed trick may only touch the original player. Four continuations already
    // carried that restriction to the screen; `chaiOpponent` did not, so the seat was
    // offered every opponent and two of three choices were refused.
    const state = actionPhase();
    putInHand(state, 'p2', 'TRK005');
    const played = playCard(state, 'p1', 'TRK001');
    const prompt = promptOf(played, 'p2');
    const reversed = accepted(played, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK005',
      targetEffectId: prompt.interactionId,
    });

    const next = promptOf(reversed, 'p2');
    expect(next.context.op).toBe('chaiOpponent');
    if (next.context.op !== 'chaiOpponent') return;
    expect(next.context.restrictToPlayerId).toBe('p1');

    const view = viewFor(reversed, 'p2');
    const model = choiceModel(view, 'p2', next, null);
    const control = model.controls[0];
    if (control?.select !== 'players') throw new Error('Skimming offered no player control');
    expect(control.options.map((option) => option.id)).toEqual(['p1']);
    expect(model.note).toContain('Reversed');

    // The narrowing is the engine's rule, not a preference: p3 is refused.
    expect(refused(reversed, 'p2', {
      type: 'SubmitChoice',
      interactionId: next.interactionId,
      selection: { kind: 'players', playerIds: ['p3'] },
    }).message).toContain('must target the player who originally played it');

    // And the one the composer does offer is accepted.
    const { draft } = compose(reversed, 'p2', [
      { type: 'choiceToggle', list: 'players', id: 'p1', limit: 1 },
    ]);
    const outcome = choiceCommand(view, 'p2', next, draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(promptOf(accepted(reversed, 'p2', outcome.command), 'p2').context.op)
      .toBe('chaiResource');
  });

  it('withholds Boomerang against a trick the engine will not reverse', () => {
    const state = actionPhase();
    putInHand(state, 'p2', 'TRK004');
    putInHand(state, 'p2', 'TRK005');
    const played = playCard(state, 'p1', 'TRK006');
    const view = viewFor(played, 'p2');

    // Grand Coalition is not on the engine's reversible list; Skimming is.
    expect(reactionCardIds(view, 'p2', 'TRK006', 'p1')).toEqual(['TRK004']);
    expect(reactionCardIds(view, 'p2', 'TRK001', 'p1')).toEqual(['TRK004', 'TRK005']);

    const prompt = promptOf(played, 'p2');
    const failure = refused(played, 'p2', {
      type: 'PlayReaction',
      cardId: 'TRK005',
      targetEffectId: prompt.interactionId,
    });
    expect(failure.code).toBe('INVALID_TARGET_SET');
  });

  it('lets the responder pass priority so the card resolves', () => {
    const state = actionPhase();
    putInHand(state, 'p2', 'TRK004');
    let played = playCard(state, 'p1', 'TRK006');
    const prompt = promptOf(played, 'p2');
    played = accepted(played, 'p2', { type: 'PassPriority', interactionId: prompt.interactionId });
    expect(played.activeEffects.some((effect) => effect.kind === 'grandCoalition')).toBe(true);
  });
});

describe('the hand', () => {
  it('reads Boomerang as a reaction rather than offering it on a turn', () => {
    const state = actionPhase();
    putInHand(state, 'p1', 'TRK005');
    const card = handCards(viewFor(state, 'p1'), 'p1')[0];
    expect(card?.title).toBe('Boomerang');
    expect(card?.blocked).toContain('only as a reaction');
    expect(refused(state, 'p1', { type: 'PlayTrick', cardId: 'TRK005' }).code)
      .toBe('WRONG_PHASE');
  });

  /**
   * The A18 guards `beginEffect` puts on a *chosen* card, mirrored into the hand.
   *
   * House rule R16 makes a fixed quantity mandatory and refuses a trick whose quantity the
   * board cannot meet — the seat chose it, so the play is refused rather than resolved
   * away. Until Session 20 the hand offered every card and let the refusal explain, which
   * is the one place in this build where a refusal costs something: `applyPlayTrick`
   * is the seat's action for the turn, and the message arrives after the click.
   *
   * Each row pairs the composer's reason with the engine's refusal on the same state, so a
   * guard that drifts from its handler fails here rather than in a played match.
   *
   * Six rows, seven guards: the Cornerstone triple conversion is a `mode` rather than an
   * ordinary play and is covered below, and so is the eighth guard, ordinary Cornerstone,
   * which counts the bank rather than the board and so needs a state these rows
   * deliberately do not build.
   */
  const A18_HAND_GUARDS: readonly { cardId: string; blocked: string; refusal: string }[] = [
    { cardId: 'TRK004', blocked: 'Veto needs an open', refusal: 'Veto needs an open' },
    {
      cardId: 'TRK007',
      blocked: 'Flip-Flop flips one of your own',
      refusal: 'Flip-Flop needs one of your own',
    },
    {
      cardId: 'TRK009',
      blocked: 'Loyal Base protects a majority',
      refusal: 'Loyal Base needs one of your own majorities',
    },
    {
      cardId: 'TRK012',
      blocked: 'Dragnet imprisons exactly five',
      refusal: 'Dragnet needs five',
    },
    {
      cardId: 'TRK013',
      blocked: 'Roll Purge needs a reachable voter',
      refusal: 'Roll Purge needs a reachable voter',
    },
    {
      cardId: 'TRK016',
      blocked: 'Musical Chairs swaps two voters',
      refusal: 'Musical Chairs needs two',
    },
  ];

  it.each(A18_HAND_GUARDS)(
    'says why $cardId cannot be played, and the engine refuses it for the same reason',
    ({ cardId, blocked, refusal }) => {
      // An empty board and an empty hand: nothing has a target, which is the state every
      // one of these guards is counting against.
      const state = actionPhase();
      putInHand(state, 'p1', cardId);
      const card = handCards(viewFor(state, 'p1'), 'p1').find(
        (entry) => entry.cardId === cardId,
      );
      expect(card?.blocked).toContain(blocked);
      expect(refused(state, 'p1', { type: 'PlayTrick', cardId }).message).toContain(refusal);
    },
  );

  it('offers each of those cards once the board can pay for it', () => {
    // The mirror image: a populated board with a majority and rights makes every guard
    // above pass, so none of them is blocking on something that is never true.
    const state = actionPhase();
    // `populate` fills the board in slot order, which starts in northWest, so the majority
    // is taken somewhere it has not already reached.
    populate(state, ['p1', 'p2', 'p3'], 12);
    giveMajority(state, 'p1', 'southEast');
    // Off the draw pile, because the engine asserts no card is in two places at once.
    const policyCardId = state.policyDeck.drawPile.shift();
    if (policyCardId === undefined) throw new Error('fixture found no Policy Card');
    const policyCard = CORE_CONTENT.policyCards.find(
      (candidate) => candidate.id === policyCardId,
    );
    if (policyCard === undefined) throw new Error('fixture drew an unknown Policy Card');
    state.players.find((player) => player.id === 'p1')!.retainedPolicy.push({
      cardId: policyCardId,
      answerIndex: 0,
      archetype: policyCard.answers[0].archetype,
    });
    // Veto alone needs an open effect rather than a board, so one is put up for it.
    const withEffect = playCard(state, 'p1', 'TRK015');
    for (const { cardId } of A18_HAND_GUARDS) putInHand(withEffect, 'p1', cardId);
    const hand = handCards(viewFor(withEffect, 'p1'), 'p1');
    for (const { cardId } of A18_HAND_GUARDS) {
      expect(hand.find((entry) => entry.cardId === cardId)?.blocked, cardId).toBeUndefined();
    }
  });

  it('says when the bank is too short for ordinary Cornerstone', () => {
    // The eighth A18 trick guard, and the last one the hand could not mirror: the
    // reserve was not projected, so this was the one refusal a seat could only discover
    // by spending its action on the click.
    const state = actionPhase();
    putInHand(state, 'p1', 'TRK017');
    // A full reserve is not short, so the card is offered.
    expect(handCards(viewFor(state, 'p1'), 'p1')[0]?.blocked).toBeUndefined();

    // Three left in the reserve. The units are parked on a seat that is not acting rather
    // than deleted, because the engine reconciles every one of them after each command.
    const holder = state.players.find((player) => player.id === 'p3')!;
    for (const resource of RESOURCE_ORDER) {
      holder.resources[resource] += state.publicReserve[resource];
      state.publicReserve[resource] = 0;
    }
    holder.resources.cash -= 3;
    state.publicReserve.cash = 3;

    const card = handCards(viewFor(state, 'p1'), 'p1')[0];
    expect(card?.blocked).toBe(
      'Cornerstone grants four resources from the bank; 3 are left in it.',
    );
    expect(refused(state, 'p1', { type: 'PlayTrick', cardId: 'TRK017' }).message)
      .toContain('Cornerstone needs four resources left in the bank');

    // A fourth resource in the reserve is enough, and the engine agrees.
    state.publicReserve.cash = 4;
    holder.resources.cash -= 1;
    expect(handCards(viewFor(state, 'p1'), 'p1')[0]?.blocked).toBeUndefined();
    expect(promptOf(
      accepted(state, 'p1', { type: 'PlayTrick', cardId: 'TRK017' }),
      'p1',
    ).context.op).toBe('cornerstoneGain');
  });

  it('keeps the Cornerstone conversion offered while a short reserve blocks the ordinary play', () => {
    // The two branches are blocked separately. Only the ordinary play grants from the
    // reserve, so a reserve too short for it says nothing about the conversion — and a
    // `blocked` that hid the mode with it would take away the seat's one legal move.
    const state = actionPhase();
    populate(state, ['p2', 'p2', 'p2'], 12);
    for (const cardId of ['TRK017', 'TRK018', 'TRK019']) putInHand(state, 'p1', cardId);
    const holder = state.players.find((player) => player.id === 'p3')!;
    for (const resource of RESOURCE_ORDER) {
      holder.resources[resource] += state.publicReserve[resource];
      state.publicReserve[resource] = 0;
    }

    const card = handCards(viewFor(state, 'p1'), 'p1')[0];
    expect(card?.blocked).toContain('0 are left in it');
    expect(card?.mode?.available).toBe(true);
    expect(promptOf(
      accepted(state, 'p1', { type: 'PlayTrick', cardId: 'TRK017', mode: 'triple' }),
      'p1',
    ).context.op).toBe('cornerstoneZone');
  });

  it('offers the Cornerstone conversion only when three are held', () => {
    const one = actionPhase();
    putInHand(one, 'p1', 'TRK017');
    expect(handCards(viewFor(one, 'p1'), 'p1')[0]?.mode?.available).toBe(false);

    const three = actionPhase();
    for (const cardId of ['TRK017', 'TRK018', 'TRK019']) putInHand(three, 'p1', cardId);
    expect(handCards(viewFor(three, 'p1'), 'p1')[0]?.mode?.available).toBe(true);
    const played = accepted(three, 'p1', {
      type: 'PlayTrick',
      cardId: 'TRK017',
      mode: 'triple',
    });
    expect(promptOf(played, 'p1').context.op).toBe('cornerstoneZone');
  });
});

describe('trades', () => {
  it('composes an offer from the active seat and lets the opponent accept it', () => {
    const state = actionPhase();
    const view = viewFor(state, 'p1');
    expect(tradeWindowOpen(view)).toBe(true);

    let draft: ActionDraft = {
      kind: 'trade',
      opponentId: 'p2',
      giveResources: NO_RESOURCES,
      receiveResources: NO_RESOURCES,
      giveTrickIds: [],
    };
    draft = actionDraftReducer(draft, { type: 'resource', field: 'give', resource: 'cash', amount: 2 });
    draft = actionDraftReducer(draft, { type: 'resource', field: 'receive', resource: 'faith', amount: 1 });
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const offered = accepted(state, 'p1', outcome.command);
    const offers = tradeOffers(viewFor(offered, 'p2'), 'p2');
    expect(offers.theirs).toHaveLength(1);
    expect(offers.mine).toHaveLength(0);
    const offerId = offers.theirs[0]?.id ?? '';

    const settled = accepted(offered, 'p2', { type: 'AcceptTrade', tradeId: offerId });
    expect(settled.players.find((player) => player.id === 'p1')?.resources.cash).toBe(4);
    expect(settled.players.find((player) => player.id === 'p2')?.resources.cash).toBe(8);
    expect(settled.tradeOffers).toHaveLength(0);
  });

  it('refuses to offer what a seat does not hold, before the engine has to', () => {
    const state = actionPhase();
    const view = viewFor(state, 'p1');
    let draft: ActionDraft = {
      kind: 'trade',
      opponentId: 'p2',
      giveResources: { ...NO_RESOURCES, cash: 9 },
      receiveResources: { ...NO_RESOURCES, faith: 1 },
      giveTrickIds: [],
    };
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toBe('You hold 6 cash, not 9.');

    draft = { ...draft, giveResources: NO_RESOURCES, receiveResources: { ...NO_RESOURCES, faith: 9 } };
    const second = draftCommand(view, 'p1', draft);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.problem).toBe('Offer at least one resource.');
  });

  it('closes the trade window when the match is waiting on a card-driven decision', () => {
    const state = playCard(actionPhase(), 'p1', 'TRK001');
    expect(tradeWindowOpen(viewFor(state, 'p1'))).toBe(false);
  });

  it('carries a trick card across with the resources', () => {
    const state = actionPhase();
    putInHand(state, 'p1', 'TRK006');
    const view = viewFor(state, 'p1');
    let draft: ActionDraft = {
      kind: 'trade',
      opponentId: 'p2',
      giveResources: { ...NO_RESOURCES, cash: 1 },
      receiveResources: { ...NO_RESOURCES, influence: 1 },
      giveTrickIds: [],
    };
    draft = actionDraftReducer(draft, { type: 'tradeCard', cardId: 'TRK006' });
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const offered = accepted(state, 'p1', outcome.command);
    const offerId = tradeOffers(viewFor(offered, 'p2'), 'p2').theirs[0]?.id ?? '';
    const settled = accepted(offered, 'p2', { type: 'AcceptTrade', tradeId: offerId });
    expect(settled.players.find((player) => player.id === 'p2')?.trickHand)
      .toContain('TRK006');
  });
});

describe('auctions and the debt they leave', () => {
  function auctionState(): GameState {
    const state = actionPhase();
    const cardId = state.trickDeck.drawPile.shift();
    if (cardId === undefined) throw new Error('fixture found no trick to auction');
    const sourceIndex = state.newsDeck.drawPile.indexOf('NEWS013');
    if (sourceIndex < 0) throw new Error('fixture news is not in the draw pile');
    state.newsDeck.drawPile.splice(sourceIndex, 1);
    startAuction(state, 'NEWS013', 'p1', cardId, 2);
    return state;
  }

  it('composes a bid at the floor and refuses one below it', () => {
    const state = auctionState();
    const prompt = promptOf(state, 'p2');
    expect(prompt.context.op).toBe('auction');
    const view = viewFor(state, 'p2');

    const low = actionDraftReducer(openChoiceDraft(prompt), { type: 'choiceBid', amount: 1 });
    if (!choiceDraftMatches(low, prompt)) throw new Error('draft stopped matching');
    const lowOutcome = choiceCommand(view, 'p2', prompt, low);
    expect(lowOutcome.ok).toBe(false);
    if (lowOutcome.ok) return;
    expect(lowOutcome.problem).toBe('A bid must be at least 2.');

    const bid = actionDraftReducer(openChoiceDraft(prompt), { type: 'choiceBid', amount: 3 });
    if (!choiceDraftMatches(bid, prompt)) throw new Error('draft stopped matching');
    const outcome = choiceCommand(view, 'p2', prompt, bid);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const after = accepted(state, 'p2', outcome.command);
    expect(promptOf(after, 'p3').context.op).toBe('auction');
  });

  it('settles into a debt the seat can then repay from its own surface', () => {
    let state = auctionState();
    state = accepted(state, 'p2', {
      type: 'PlaceBid',
      interactionId: promptOf(state, 'p2').interactionId,
      amount: 3,
    });
    state = accepted(state, 'p3', {
      type: 'PassAuction',
      interactionId: promptOf(state, 'p3').interactionId,
    });
    expect(state.pendingInteraction).toBeNull();

    const view = viewFor(state, 'p2');
    const debt = view.privateDebts?.[0];
    expect(debt?.amount).toBe(3);
    if (debt === undefined) return;

    let draft: ActionDraft = { kind: 'debt', debtId: debt.id, payment: NO_RESOURCES };
    const over = actionDraftReducer(draft, { type: 'resource', field: 'payment', resource: 'cash', amount: 5 });
    const overOutcome = draftCommand(view, 'p2', over);
    expect(overOutcome.ok).toBe(false);
    if (!overOutcome.ok) expect(overOutcome.problem).toBe('This debt is 3; remove 2.');

    draft = actionDraftReducer(draft, { type: 'resource', field: 'payment', resource: 'cash', amount: 3 });
    const outcome = draftCommand(view, 'p2', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    state.turn.activePlayerId = 'p2';
    const repaid = accepted(state, 'p2', outcome.command);
    expect(viewFor(repaid, 'p2').privateDebts).toHaveLength(0);
    expect(repaid.players.find((player) => player.id === 'p1')?.resources.cash).toBe(9);
  });
});

describe('Loyal Base', () => {
  function cultState(): GameState {
    const state = actionPhase();
    // p2 holds a marked majority to shield; p1 holds one of its own elsewhere, plus the
    // three spare voters the theft converts. A majority has to be the whole printed
    // threshold: the engine unmarks a marked voter whose owner no longer fills one.
    giveMajority(state, 'p2', 'central');
    giveMajority(state, 'p1', 'northWest');
    const spare = steadySlots
      .filter((slot) => slot.zoneId === 'east')
      .slice(0, 3)
      .map((slot) => slot.slotId);
    if (spare.length !== 3) throw new Error('fixture could not lay out the board');
    for (const slotId of spare) place(state, 'p1', slotId);
    state.turn.activePlayerId = 'p2';
    let played = playCard(state, 'p2', 'TRK009');
    const prompt = promptOf(played, 'p2');
    const zoneId = choiceModel(viewFor(played, 'p2'), 'p2', prompt, null)
      .controls[0];
    if (zoneId?.select !== 'option' || zoneId.options[0] === undefined) {
      throw new Error('fixture found no majority to shield');
    }
    played = accepted(played, 'p2', {
      type: 'SubmitChoice',
      interactionId: prompt.interactionId,
      selection: { kind: 'option', optionId: zoneId.options[0].id },
    });
    played.turn.activePlayerId = 'p1';
    return played;
  }

  it('names the card a rival holds and the zone it shields', () => {
    const state = cultState();
    const view = viewFor(state, 'p1');
    const stealable = stealableCultCards(view, 'p1');
    expect(stealable).toHaveLength(1);
    expect(stealable[0]?.ownerId).toBe('p2');
    expect(protectedZoneIds(view, 'p1').size).toBe(1);
    expect(protectedZoneIds(view, 'p2').size).toBe(0);
  });

  it('composes three of the thief’s own voters and is accepted', () => {
    const state = cultState();
    const view = viewFor(state, 'p1');
    const sourceCardId = stealableCultCards(view, 'p1')[0]?.sourceCardId ?? '';
    const legal = stealBaseSlotIds(view, 'p1', []);
    expect(legal.size).toBeGreaterThanOrEqual(3);

    let draft: ActionDraft = { kind: 'stealBase', sourceCardId, voterIds: [] };
    const short = draftCommand(view, 'p1', draft);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.problem).toBe('Choose three of your own voters; 0 chosen.');

    // The set offers marked voters too, because converting one is legal whenever the
    // thief keeps a majority elsewhere. This theft spends the spare three instead.
    const spare = [...legal].filter((slotId) =>
      view.slots.find((slot) => slot.slotId === slotId)?.voter?.majority === false);
    expect(spare.length).toBeGreaterThanOrEqual(3);
    for (const slotId of spare.slice(0, 3)) {
      const voterId = view.slots.find((slot) => slot.slotId === slotId)?.voter?.id ?? null;
      draft = actionDraftReducer(draft, { type: 'pick', slotId, voterId });
    }
    const outcome = draftCommand(view, 'p1', draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stolen = accepted(state, 'p1', outcome.command);
    expect(promptOf(stolen, 'p1').context.op).toBe('cultStolenZone');
  });

  it('never offers an opponent’s voter for the conversion', () => {
    const state = cultState();
    const view = viewFor(state, 'p1');
    for (const slotId of stealBaseSlotIds(view, 'p1', [])) {
      expect(view.slots.find((slot) => slot.slotId === slotId)?.voter?.ownerId).toBe('p1');
    }
  });
});

describe('a news that queues one decision per seat', () => {
  it('composes the Cough & Cold eviction for each responsible seat in turn', () => {
    let state = actionPhase();
    populate(state, ['p1', 'p2', 'p3'], 9);
    state = playNews(state, 'p1', 'NEWS010');

    for (let guard = 0; guard < 6 && state.pendingInteraction !== null; guard += 1) {
      const responsible = state.pendingInteraction.responsiblePlayerIds[0];
      if (responsible === undefined) break;
      const prompt = promptOf(state, responsible);
      const view = viewFor(state, responsible);
      const control = choiceModel(view, responsible, prompt, null).controls[0];
      if (control?.select === 'board') {
        for (const option of control.options) {
          expect(view.slots.find((slot) => slot.voter?.id === option.id)?.voter?.ownerId)
            .toBe(responsible);
        }
      }
      const first = control?.select === 'board'
        ? control.options[0]?.id
        : undefined;
      const steps: DraftAction[] = first === undefined
        ? [{ type: 'resource', field: 'selection', resource: 'cash', amount: 1 }]
        : [{ type: 'choiceToggle', list: 'voters', id: first, limit: 1 }];
      const { draft } = compose(state, responsible, steps);
      const outcome = choiceCommand(view, responsible, prompt, draft);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      state = accepted(state, responsible, outcome.command);
    }
    expect(state.pendingInteraction).toBeNull();
  });
});

/**
 * A rival's Loyal Base, read from both sides.
 *
 * The rule is asymmetric in a way that catches a composer twice. A Cult zone is closed to
 * *everyone but the seat that played it*, so a card that asks a seat to give up its own
 * voters must not offer the ones standing in a rival's shielded zone — and two cards do
 * not read the shield at all, so narrowing their sets is not caution, it is a legal move
 * denied. Each test here drives the engine with the composer's own answer, because the
 * only thing that settles which of the two a card is, is the engine.
 */
describe('a rival’s Loyal Base, from both sides', () => {
  /** p2 shields `central`, where p1 also stands. p1 has four more voters elsewhere. */
  function shieldedState(): GameState {
    const state = actionPhase();
    giveMajority(state, 'p2', 'central');
    // p1 in the shielded zone, and four elsewhere so a four-voter card still has a set.
    const inCentral = steadySlots.filter((slot) => slot.zoneId === 'central').slice(5, 6);
    if (inCentral.length !== 1) throw new Error('fixture found no spare central area');
    for (const slot of inCentral) place(state, 'p1', slot.slotId);
    for (const slot of steadySlots.filter((slot) => slot.zoneId === 'east').slice(0, 4)) {
      place(state, 'p1', slot.slotId);
    }
    for (const slot of steadySlots.filter((slot) => slot.zoneId === 'west').slice(0, 3)) {
      place(state, 'p3', slot.slotId);
    }
    state.turn.activePlayerId = 'p2';
    let played = playCard(state, 'p2', 'TRK009');
    const prompt = promptOf(played, 'p2');
    const control = choiceModel(viewFor(played, 'p2'), 'p2', prompt, null).controls[0];
    if (control?.select !== 'option' || control.options[0] === undefined) {
      throw new Error('fixture found no majority to shield');
    }
    played = accepted(played, 'p2', {
      type: 'SubmitChoice',
      interactionId: prompt.interactionId,
      selection: { kind: 'option', optionId: control.options[0].id },
    });
    played.turn.activePlayerId = 'p1';
    return played;
  }

  /** The one p1 voter standing inside the zone p2 shielded. */
  function shieldedVoterId(state: GameState): string {
    const view = viewFor(state, 'p1');
    const entry = boardVoters(view).find(
      (candidate) => candidate.ownerId === 'p1' && candidate.zoneId === 'central',
    );
    if (entry === undefined) throw new Error('fixture lost its shielded voter');
    return entry.voterId;
  }

  it('keeps a seat’s own shielded voter out of the set On The “High” Seas offers it', () => {
    const state = shieldedState();
    const view = viewFor(state, 'p1');
    expect(protectedZoneIds(view, 'p1').has('central')).toBe(true);
    const prompt: StructuredChoicePromptView = {
      kind: 'choice',
      interactionId: 'interaction-1',
      explanation: 'Choose four of your own non-volatile board voters to hold hostage.',
      allowed: ['voters'],
      allowPass: false,
      context: { op: 'hostageVoters', ownerId: 'p1', exactly: 4 },
    };
    const control = choiceModel(view, 'p1', prompt, null).controls[0];
    if (control?.select !== 'board') throw new Error('On The High Seas offered no control');
    expect(control.options.length).toBeGreaterThanOrEqual(4);
    expect(control.options.map((option) => option.id)).not.toContain(shieldedVoterId(state));
    for (const option of control.options) {
      expect(boardVoters(view).find((entry) => entry.voterId === option.id)?.zoneId)
        .not.toBe('central');
    }
  });

  it('offers a shielded voter to Long March, whose eviction does not read the shield', () => {
    let state = shieldedState();
    state = playCard(state, 'p1', 'TRK008');
    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const prompt = promptOf(state, 'p1');
    expect(prompt.context.op).toBe('bharatVoters');

    const view = viewFor(state, 'p1');
    const shielded = shieldedVoterId(state);
    const control = choiceModel(view, 'p1', prompt, null).controls[0];
    if (control?.select !== 'board') throw new Error('Long March offered no control');
    // The whole point: narrowing this set to the unshielded board is what left a seat
    // with fewer than the five it cannot decline, and the match stopped.
    expect(control.options.map((option) => option.id)).toContain(shielded);

    const picked = [shielded, ...control.options
      .map((option) => option.id)
      .filter((voterId) => voterId !== shielded)
      .slice(0, 4)];
    expect(picked).toHaveLength(5);
    const { draft } = compose(state, 'p1', pickVoters(picked));
    const outcome = choiceCommand(view, 'p1', prompt, draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Accepted, which is what says the engine and this set agree.
    const after = accepted(state, 'p1', outcome.command);
    expect(promptOf(after, 'p1').context.op).toBe('bharatOwners');
  });
});

/**
 * Brain Drain, whose mover is never the card's owner.
 *
 * The seat this prompt is opened for is the one *after* the seat that triggered it, and
 * the voters it may move belong to the trigger, not to itself. That makes it the only
 * board operation in the contract whose targets are somebody else's, and it is why the
 * generic fixture below cannot cover it: every fixture there names `p1` as owner and asks
 * `p1`, so an owner/viewer mix-up reads as correct.
 */
describe('a news whose mover is not its owner', () => {
  /** p1 triggers Great Leader and ends its turn, which asks p2 to move a p1 voter. */
  function greatLeaderOpen(): GameState {
    let state = actionPhase();
    populate(state, ['p1', 'p2', 'p3'], 12);
    state = playNews(state, 'p1', 'NEWS001');
    state.turn.usage.threeVoterPurchases = 1;
    return accepted(state, 'p1', { type: 'RequestEndTurn' });
  }

  it('offers the owner’s voters to the moving seat, not the moving seat’s own', () => {
    const state = greatLeaderOpen();
    const prompt = promptOf(state, 'p2');
    expect(prompt.context.op).toBe('greatLeaderMove');
    const view = viewFor(state, 'p2');
    const control = choiceModel(view, 'p2', prompt, null).controls[0];
    expect(control?.select).toBe('board');
    if (control?.select !== 'board') return;
    expect(control.options.length).toBeGreaterThan(0);
    for (const option of control.options) {
      expect(view.slots.find((slot) => slot.slotId === option.id)?.voter?.ownerId).toBe('p1');
    }
  });

  it('composes a move the engine accepts', () => {
    let state = greatLeaderOpen();
    const view = viewFor(state, 'p2');
    const prompt = promptOf(state, 'p2');
    const sources = choiceModel(view, 'p2', prompt, null).controls[0];
    if (sources?.select !== 'board') throw new Error('Great Leader offered no source control');
    const sourceSlotId = sources.options[0]?.id;
    if (sourceSlotId === undefined) throw new Error('Great Leader offered no source');
    const afterSource = compose(state, 'p2', [
      { type: 'choiceToggle', list: 'slots', id: sourceSlotId, limit: 2 },
    ]);
    const destinations = choiceModel(view, 'p2', prompt, afterSource.draft).controls[0];
    if (destinations?.select !== 'board') throw new Error('Great Leader offered no destination control');
    const destinationSlotId = destinations.options[0]?.id;
    if (destinationSlotId === undefined) throw new Error('Great Leader offered no destination');

    const movedVoterId = view.slots.find((slot) => slot.slotId === sourceSlotId)?.voter?.id;
    const { draft } = compose(state, 'p2', [
      { type: 'choiceToggle', list: 'slots', id: sourceSlotId, limit: 2 },
      { type: 'choiceToggle', list: 'slots', id: destinationSlotId, limit: 2 },
    ]);
    const outcome = choiceCommand(view, 'p2', prompt, draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    state = accepted(state, 'p2', outcome.command);
    expect(state.voters.find((voter) => voter.id === movedVoterId)?.location)
      .toMatchObject({ kind: 'board', slotId: destinationSlotId });
  });

  it('refuses the moving seat’s own voter, which is what the composer must not offer', () => {
    const state = greatLeaderOpen();
    const view = viewFor(state, 'p2');
    const own = view.slots.find((slot) => slot.voter?.ownerId === 'p2');
    const empty = view.slots.find((slot) => slot.voter === undefined);
    if (own === undefined || empty === undefined) throw new Error('fixture found no p2 voter');
    const prompt = promptOf(state, 'p2');
    expect(refused(state, 'p2', {
      type: 'SubmitChoice',
      interactionId: prompt.interactionId,
      selection: { kind: 'slots', slotIds: [own.slotId, empty.slotId] },
    }).message).toContain('Move an affected non-majority voter');
  });
});

/**
 * Every operation the contract can open, with a context this screen must handle.
 *
 * `ChoicePromptOp` keys this record, so adding an operation to `ChoicePromptContext`
 * without teaching `choiceModel` about it stops this file compiling — the same guard
 * `projection-privacy.test.ts` puts on the projection side.
 */
const PROMPT_FIXTURES: Record<ChoicePromptOp, StructuredChoicePromptView['context']> = {
  campaignVote: {
    op: 'campaignVote',
    prizeCardId: 'TRK006',
    candidateIds: ['p1', 'p2', 'p3'],
    round: 1,
    ballotsCast: 0,
    awaitingPlayerIds: ['p2'],
  },
  auction: {
    op: 'auction',
    sellerId: 'p1',
    minimumBid: 2,
    currentBid: 0,
    bidderOrder: ['p2', 'p3'],
    passedPlayerIds: [],
  },
  trickPriority: {
    op: 'trickPriority',
    playedCardId: 'TRK006',
    playedByPlayerId: 'p1',
    responderOrder: ['p2'],
    passedPlayerIds: [],
  },
  chaiOpponent: { op: 'chaiOpponent', ownerId: 'p1', eligiblePlayerIds: ['p2', 'p3'] },
  chaiResource: { op: 'chaiResource', ownerId: 'p1', opponentId: 'p2', optionIds: ['cash'] },
  turncoatTrack: { op: 'turncoatTrack', ownerId: 'p1', optionIds: ['corporate'] },
  blockOpen: { op: 'blockOpen', ownerId: 'p1', openCardIds: ['TRK006'] },
  accentFlip: { op: 'accentFlip', ownerId: 'p1', policyCardIds: [] },
  bharatVoters: { op: 'bharatVoters', ownerId: 'p1', exactly: 5 },
  bharatOwners: {
    op: 'bharatOwners',
    ownerId: 'p1',
    voterIds: ['voter-1', 'voter-2'],
    eligiblePlayerIds: ['p2', 'p3'],
  },
  cultZone: { op: 'cultZone', ownerId: 'p1', eligibleZoneIds: ['northWest'] },
  cultStolenZone: { op: 'cultStolenZone', ownerId: 'p1', eligibleZoneIds: ['northWest'] },
  notOneTarget: {
    op: 'notOneTarget',
    ownerId: 'p1',
    optionFormat: 'playerZone',
    eligiblePlayerIds: ['p2'],
    eligibleZoneIds: ['northWest'],
  },
  imprisonVoters: { op: 'imprisonVoters', ownerId: 'p1', exactly: 5 },
  hostageVoters: { op: 'hostageVoters', ownerId: 'p1', exactly: 4 },
  redevelopmentDiscard: {
    op: 'redevelopmentDiscard',
    ownerId: 'p1',
    zoneId: 'northWest',
    exactly: 2,
  },
  documentsVoters: {
    op: 'documentsVoters',
    ownerId: 'p1',
    minimum: 1,
    maximum: 4,
    rightsZoneIds: ['northWest'],
  },
  slumdogSwap: { op: 'slumdogSwap', ownerId: 'p1', allowedCounts: [2, 4, 6] },
  cornerstoneGain: { op: 'cornerstoneGain', ownerId: 'p1', resourceTotal: 4 },
  cornerstoneZone: { op: 'cornerstoneZone', ownerId: 'p1', eligibleZoneIds: ['northWest'] },
  dostiTarget: { op: 'dostiTarget', ownerId: 'p1', eligiblePlayerIds: ['p2'] },
  mansplainTarget: { op: 'mansplainTarget', ownerId: 'p1', eligiblePlayerIds: ['p2'] },
  nerosMoves: { op: 'nerosMoves', ownerId: 'p1', zoneId: 'northWest', pairs: 3 },
  poloPlayers: { op: 'poloPlayers', ownerId: 'p1', exactly: 2, eligiblePlayerIds: ['p1', 'p2'] },
  poloFallback: {
    op: 'poloFallback',
    ownerId: 'p1',
    playerIds: ['p1', 'p2'],
    optionIds: ['corporate'],
  },
  karachiKeep: { op: 'karachiKeep', ownerId: 'p1', drawnCardIds: ['TRK006'] },
  blessingsKeep: { op: 'blessingsKeep', ownerId: 'p1', drawnCardIds: ['V0001'] },
  blessingsDonate: {
    op: 'blessingsDonate',
    ownerId: 'p1',
    keptCardId: 'V0001',
    donatedCardId: 'V0002',
    eligiblePlayerIds: ['p2'],
  },
  blessingsPlace: { op: 'blessingsPlace', ownerId: 'p1', groupId: 'group-1', voterCount: 2 },
  greatLeaderMove: { op: 'greatLeaderMove', ownerId: 'p1', remainingMoves: 1 },
  floodReliefMove: { op: 'floodReliefMove', ownerId: 'p1', queuePlayerIds: ['p1'] },
  coughEvict: { op: 'coughEvict', ownerId: 'p1', exactly: 1, queuePlayerIds: ['p1'] },
  coughReward: { op: 'coughReward', ownerId: 'p1', resourceTotal: 1, queuePlayerIds: ['p1'] },
  limitsConvert: {
    op: 'limitsConvert',
    ownerId: 'p1',
    exactly: 2,
    leftPlayerId: 'p2',
    queuePlayerIds: ['p1'],
  },
  limitsReward: { op: 'limitsReward', ownerId: 'p1', resourceTotal: 2, queuePlayerIds: ['p1'] },
  goalparaCard: {
    op: 'goalparaCard',
    ownerId: 'p1',
    marketCardIds: ['V0001'],
    queuePlayerIds: ['p1'],
  },
  goalparaReward: {
    op: 'goalparaReward',
    ownerId: 'p1',
    resourceTotal: 3,
    queuePlayerIds: ['p1'],
  },
  oxyChoice: { op: 'oxyChoice', ownerId: 'p1', eligiblePlayerIds: ['p2'], queuePlayerIds: ['p1'] },
  oxyPlace: { op: 'oxyPlace', ownerId: 'p1', groupId: 'group-1' },
  donatePolicy: {
    op: 'donatePolicy',
    ownerId: 'p1',
    policyCardIds: [],
    recipientPlayerId: 'p2',
    queuePlayerIds: ['p1'],
  },
  donationReward: { op: 'donationReward', ownerId: 'p1', resourceTotal: 6 },
};

/**
 * The two whose controls have no generic shape at all: a bid is a number against a
 * moving floor, and a reaction is a card played straight out of hand. Both are drawn by
 * their own composer and derive no control here, only the note beside it.
 */
const NO_GENERIC_CONTROL: readonly ChoicePromptOp[] = ['auction', 'trickPriority'];

describe('every operation the contract can open', () => {
  const state = actionPhase();
  populate(state, ['p1', 'p2', 'p3'], 12);
  const view = viewFor(state, 'p1');

  for (const [op, context] of Object.entries(PROMPT_FIXTURES) as [
    ChoicePromptOp,
    StructuredChoicePromptView['context'],
  ][]) {
    it(`gives ${op} something to act on`, () => {
      const prompt: StructuredChoicePromptView = {
        kind: 'choice',
        interactionId: 'interaction-1',
        explanation: 'A choice is open.',
        allowed: ['option', 'players', 'voters', 'slots', 'cards', 'resources'],
        allowPass: false,
        context,
      };
      const model = choiceModel(view, 'p1', prompt, null);
      if (NO_GENERIC_CONTROL.includes(op)) {
        expect(model.controls).toHaveLength(0);
        expect(model.note).toBeTypeOf('string');
        return;
      }
      expect(model.controls.length).toBeGreaterThan(0);
      for (const control of model.controls) {
        expect(control.label.length).toBeGreaterThan(0);
      }
      // Nothing chosen yet, so every operation must say what is still missing rather
      // than offering a command the engine would refuse.
      const outcome = choiceCommand(view, 'p1', prompt, openChoiceDraft(prompt));
      expect(outcome.ok).toBe(false);
    });
  }

  it('refuses to compose anything for a continuation this build cannot describe', () => {
    const prompt: StructuredChoicePromptView = {
      kind: 'choice',
      interactionId: 'interaction-1',
      explanation: 'A choice is open.',
      allowed: ['option'],
      allowPass: false,
      context: { op: 'unsupported' },
    };
    expect(choiceModel(view, 'p1', prompt, null).controls).toHaveLength(0);
    expect(choiceCommand(view, 'p1', prompt, openChoiceDraft(prompt)).ok).toBe(false);
  });
});
