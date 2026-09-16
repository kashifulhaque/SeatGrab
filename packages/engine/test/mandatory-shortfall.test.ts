/**
 * Mandatory effects whose printed quantity exceeds the legal targets available.
 *
 * A news is not played; it is dealt by a volatile area and cannot be declined. When
 * one asks for a fixed number of voters and the board does not hold that many, the
 * interaction it opens can never be answered, and — because a pending interaction blocks
 * every other command — the match stops for good. That is not a rule question. Whatever
 * the printed card means, it does not mean the table never plays again.
 *
 * `news.quarantine` already had the answer: it counts the legal targets before it
 * opens anything and resolves as no effect when there are none. Session 17 held every
 * other site that opens a mandatory choice to the same behavior, so this file has two
 * halves:
 *
 * - **News cards must never refuse.** A refusal propagates out of
 *   `beginNewsResolution` and fails the command that dealt the card, and every retry
 *   fails identically — which is a deadlock wearing a refusal's clothes. They resolve as
 *   no effect instead.
 * - **Tricks must refuse the play.** A trick is chosen, so A16's "activation is
 *   illegal" can be honored literally: the command is refused, nothing opens, and the
 *   player still holds the card.
 *
 * Every case comes in a pair. The shortfall resolves and the match stays playable, *and*
 * the card still does its work when the board can pay for it — because a guard that
 * swallows a live card is a worse defect than the one it fixes.
 *
 * Registered as adjudication A18 in `packages/content/src/ruleset.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ChoiceSelection, GameCommand } from '@seatgrab/protocol';
import {
  CORE_CONTENT,
  applyCommand,
  assertGameState,
  beginEffect,
  createGame,
  getLegalActions,
  type GameConfig,
  type GameState,
} from '../src/index';

const config: GameConfig = {
  matchId: 'mandatory-shortfall',
  players: [
    { id: 'p1', displayName: 'A', partyId: 'purple' },
    { id: 'p2', displayName: 'B', partyId: 'green' },
    { id: 'p3', displayName: 'C', partyId: 'pink' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

function activeState(seed = 613): GameState {
  const state = createGame(config, CORE_CONTENT, seed);
  state.status = 'active';
  state.turn.activePlayerId = 'p1';
  state.turn.phase = 'action';
  state.pendingInteraction = null;
  return state;
}

function accepted(state: GameState, playerId: string, command: GameCommand): GameState {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (!result.ok) throw new Error(`${result.response.code}: ${result.response.message}`);
  return result.state;
}

function refused(state: GameState, playerId: string, command: GameCommand): string {
  const result = applyCommand(state, { playerId }, command, CORE_CONTENT);
  if (result.ok) throw new Error('the command was accepted');
  return result.response.message;
}

/** Answer the open interaction, which is where `SubmitChoice` gets its id. */
function submit(state: GameState, playerId: string, selection: ChoiceSelection): GameState {
  const interactionId = state.pendingInteraction?.id;
  if (interactionId === undefined) throw new Error('no interaction is open');
  return accepted(state, playerId, { type: 'SubmitChoice', interactionId, selection });
}

function slotsIn(zoneId: string, volatile: boolean): string[] {
  return CORE_CONTENT.board.slots
    .filter((slot) => slot.zoneId === zoneId && slot.volatile === volatile)
    .map((slot) => slot.slotId);
}

function placeVoter(state: GameState, ownerId: string, slotId: string): string {
  const voter = state.voters.find(
    (candidate) => candidate.ownerId === ownerId && candidate.location.kind === 'supply',
  );
  const slot = state.slots.find((candidate) => candidate.slotId === slotId);
  if (voter === undefined || slot === undefined || slot.voterId !== null) {
    throw new Error(`fixture slot ${slotId} unavailable`);
  }
  voter.location = { kind: 'board', slotId };
  slot.voterId = voter.id;
  return voter.id;
}

/** Deal `cardId` from the volatile area `slotId`, as an ordinary turn would. */
function queueNews(state: GameState, cardId: string, ownerId: string, slotId: string): void {
  const index = state.newsDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture news ${cardId} missing`);
  state.newsDeck.drawPile.splice(index, 1);
  state.newsDeck.drawPile.unshift(cardId);
  const voterId = placeVoter(state, ownerId, slotId);
  state.newsQueue.push({
    id: `fixture-trigger-${state.nextSequence}`,
    voterId,
    slotId,
    voterOwnerId: ownerId,
    actorId: 'p1',
    turnOrdinal: state.turn.ordinal,
  });
  state.nextSequence += 1;
}

/**
 * The match is playable: somebody can act.
 *
 * A deadlock does not throw and does not corrupt the state — every invariant still
 * holds. It shows up only as this: an interaction is open, and no seat that is
 * responsible for it can produce a selection it will accept.
 */
function playable(state: GameState): boolean {
  assertGameState(state, CORE_CONTENT);
  return state.players.some((player) => getLegalActions(state, player.id).length > 0);
}

/* ------------------------------------------------------------------ tricks */

/** Begin `cardId` as its owner's own play, the way `applyPlayTrick` would. */
function begin(state: GameState, cardId: string, ownerId = 'p1', mode?: string): string | null {
  const card = CORE_CONTENT.trickCards.find((candidate) => candidate.id === cardId);
  if (card === undefined) throw new Error(`fixture trick ${cardId} missing`);
  const index = state.trickDeck.drawPile.indexOf(cardId);
  if (index >= 0) state.trickDeck.drawPile.splice(index, 1);
  const error = beginEffect(state, { ownerId, card, ...(mode === undefined ? {} : { mode }) }, CORE_CONTENT);
  // A refused play leaves the card with its owner and an accepted one may not hold it
  // either. Either way it has to be somewhere the deck invariant can count it.
  const held = state.activeEffects.some((effect) => effect.sourceCardId === cardId)
    || (state.pendingInteraction?.kind === 'choice' && state.pendingInteraction.sourceCardId === cardId)
    || state.players.some((player) => player.trickHand.includes(cardId));
  if (!held) state.trickDeck.discardPile.push(cardId);
  return error;
}

/** Put `cardId` in `playerId`'s hand, which is where a played trick comes from. */
function intoHand(state: GameState, playerId: string, cardId: string): void {
  const index = state.trickDeck.drawPile.indexOf(cardId);
  if (index < 0) throw new Error(`fixture trick ${cardId} missing`);
  state.trickDeck.drawPile.splice(index, 1);
  state.players.find((player) => player.id === playerId)!.trickHand.push(cardId);
}

/** Mark every voter in `zoneId` as a majority for its owner, so the zone is decided. */
function markZoneMajority(state: GameState, zoneId: string): void {
  const zoneSlotIds = new Set(slotsIn(zoneId, false));
  for (const voter of state.voters) {
    if (voter.location.kind === 'board' && zoneSlotIds.has(voter.location.slotId)) {
      voter.location.majority = true;
    }
  }
}

/**
 * Hold `keep` resources of each type in the reserve and park the rest with `playerId`.
 *
 * The invariant is that thirty of each type exist somewhere, so a fixture cannot simply
 * empty the reserve — the resources have to go to a seat.
 */
function drainReserve(state: GameState, playerId: string, keep: number): void {
  const holder = state.players.find((player) => player.id === playerId)!;
  for (const resource of ['cash', 'influence', 'press', 'faith'] as const) {
    const moved = state.publicReserve[resource] - keep;
    state.publicReserve[resource] -= moved;
    holder.resources[resource] += moved;
  }
}

describe('a mandatory news that cannot reach its printed quantity', () => {
  it('resolves On The High Seas as no effect when its owner has fewer than four voters', () => {
    let state = activeState();
    // Two voters on the board, and the card asks for four. This is an ordinary opening
    // position: nobody has bought much yet, and a volatile area has just triggered.
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    placeVoter(state, 'p1', slotsIn('north', false)[1]!);
    queueNews(state, 'NEWS004', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    // The news is spent and the turn moved on. Nothing is holding the match.
    expect(state.pendingInteraction?.kind).not.toBe('choice');
    expect(state.newsDeck.discardPile).toContain('NEWS004');
    expect(playable(state)).toBe(true);
    // No voter was taken hostage, because four could not be taken.
    expect(state.activeEffects.some((effect) => effect.kind === 'ransomNote')).toBe(false);
    expect(state.voters.filter((voter) => voter.location.kind === 'board')).toHaveLength(3);
  });

  it('still holds four voters when four are there to hold', () => {
    let state = activeState();
    const slots = slotsIn('north', false);
    for (let index = 0; index < 4; index += 1) placeVoter(state, 'p1', slots[index]!);
    queueNews(state, 'NEWS004', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    // The guard must not swallow the card when the board can pay it.
    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('choice');
    if (interaction?.kind !== 'choice') throw new Error('the hostage choice did not open');
    expect(interaction.continuation.op).toBe('hostageVoters');
    expect(interaction.responsiblePlayerIds).toEqual(['p1']);
  });

  it('skips a Turf War seat whose left neighbour has fewer than two voters', () => {
    let state = activeState();
    // p2 converts p3's voters and p3 converts p1's. Only p1 has two to take, so exactly
    // one seat in the clockwise queue can act and the rest must be passed over.
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    placeVoter(state, 'p1', slotsIn('north', false)[1]!);
    queueNews(state, 'NEWS014', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    const interaction = state.pendingInteraction;
    if (interaction?.kind === 'choice') {
      // Whoever was asked must be able to answer: their left neighbour has two voters.
      expect(interaction.continuation.op).toBe('limitsConvert');
      const actorId = interaction.responsiblePlayerIds[0]!;
      const leftId = state.turn.order[
        (state.turn.order.indexOf(actorId) + 1) % state.turn.order.length
      ];
      const eligible = state.voters.filter(
        (voter) => voter.ownerId === leftId && voter.location.kind === 'board',
      );
      expect(eligible.length).toBeGreaterThanOrEqual(2);
    }
    expect(playable(state)).toBe(true);
  });

  it('resolves Turf War as no effect when nobody can convert two', () => {
    let state = activeState();
    // One voter on the whole board: no seat's left neighbour owns two.
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    queueNews(state, 'NEWS014', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.pendingInteraction?.kind).not.toBe('choice');
    expect(playable(state)).toBe(true);
    expect(state.voters.filter((voter) => voter.location.kind === 'board')).toHaveLength(2);
  });

  /**
   * A06 before A18: an exhausted draw pile reshuffles its own eligible discards, and only
   * a genuinely spent family means the card does nothing.
   *
   * This is the stall Session 16 reproduced at three players, `spread`, seed 88202's
   * sibling 9043 — and it arrived as a refused `SubmitChoice` rather than a refused end
   * turn, because the volatile area that dealt the news was reached from inside
   * another card's interaction. That interaction could then never be answered.
   */
  it('recycles the voter discards for Dynasty rather than refusing', () => {
    let state = activeState();
    // A short draw pile with discards behind it: the card must still run.
    state.voterDeck.discardPile.push(...state.voterDeck.drawPile.splice(1));
    queueNews(state, 'NEWS006', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('choice');
    if (interaction?.kind !== 'choice') throw new Error('the Blessings choice did not open');
    expect(interaction.continuation.op).toBe('blessingsKeep');
    expect(playable(state)).toBe(true);
  });

  /**
   * The other half of the same stall: the cards were there, but the seat was not.
   *
   * Reproduced at three players, `spread`, seed 88202. A seat whose fifty voters are all
   * on the board or held cannot receive a freely influenced group, and no other answer to
   * the donation prompt would change that — so that half of the card resolves as nothing.
   */
  it('gives Blessings voters only to a seat that has voters left in supply', () => {
    let state = activeState();
    // p1 has nothing left in supply; p2 does. Both halves are asked for, one lands.
    const northSlots = slotsIn('north', false);
    const southSlots = slotsIn('south', false);
    const p1Voters = state.voters.filter((voter) => voter.ownerId === 'p1');
    for (const voter of p1Voters) voter.location = { kind: 'removed', reason: 'fixture' };
    queueNews(state, 'NEWS006', 'p2', slotsIn('central', true)[0]!);
    placeVoter(state, 'p2', northSlots[0]!);
    placeVoter(state, 'p3', southSlots[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const keep = state.pendingInteraction;
    if (keep?.kind !== 'choice') throw new Error('the Blessings choice did not open');
    const drawn = keep.continuation.drawn as readonly string[];
    state = submit(state, 'p2', { kind: 'cards', cardIds: [drawn[0]!] });

    // p2 keeps one card and donates the other to p1, whose supply is empty.
    state = submit(state, 'p2', { kind: 'players', playerIds: ['p1'] });

    // p2's own group is pending placement; p1 received nothing and nothing is stuck.
    expect(state.pendingVoterGroups.every((group) => group.ownerId === 'p2')).toBe(true);
    expect(playable(state)).toBe(true);
    assertGameState(state, CORE_CONTENT);
  });

  it('resolves Anonymous Tip as no effect when the trick deck cannot show three', () => {
    let state = activeState();
    // Two cards left in the family: the auction it would open needs three revealed.
    state.players[0]!.trickHand.push(...state.trickDeck.drawPile.splice(2));
    state.trickDeck.discardPile.length = 0;
    queueNews(state, 'NEWS013', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.pendingInteraction?.kind).not.toBe('choice');
    expect(state.newsDeck.discardPile).toContain('NEWS013');
    expect(playable(state)).toBe(true);
  });

  it('still opens Anonymous Tip when its three cards come from the discards', () => {
    let state = activeState();
    // Nothing to draw, but three eligible discards: A06 says recycle them.
    state.trickDeck.discardPile.push(...state.trickDeck.drawPile.splice(0));
    queueNews(state, 'NEWS013', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('choice');
    if (interaction?.kind !== 'choice') throw new Error('the Karachi choice did not open');
    expect(interaction.continuation.op).toBe('karachiKeep');
    expect(playable(state)).toBe(true);
  });

  it('resolves Data Broker as no effect when there is no prize to vote for', () => {
    let state = activeState();
    // No trick left anywhere to be the prize, so there is nothing to vote on.
    state.players[0]!.trickHand.push(...state.trickDeck.drawPile.splice(0));
    state.trickDeck.discardPile.length = 0;
    queueNews(state, 'NEWS016', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.pendingInteraction?.kind).not.toBe('choice');
    expect(playable(state)).toBe(true);
  });

  it('still opens Disqualified when the market holds a card', () => {
    let state = activeState();
    queueNews(state, 'NEWS019', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    const interaction = state.pendingInteraction;
    expect(interaction?.kind).toBe('choice');
    if (interaction?.kind !== 'choice') throw new Error('the Goalpara choice did not open');
    expect(interaction.continuation.op).toBe('goalparaCard');
    expect(state.voterDeck.market.length).toBeGreaterThan(0);
  });

  it('passes over an Supply Shortage recipient with nothing left in supply', () => {
    let state = activeState();
    // p3 has no voters left to gain. Naming them must move the queue on, not refuse:
    // every other answer p2 could give is the same shape.
    for (const voter of state.voters.filter((candidate) => candidate.ownerId === 'p3')) {
      voter.location = { kind: 'removed', reason: 'fixture' };
    }
    queueNews(state, 'NEWS020', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const first = state.pendingInteraction;
    if (first?.kind !== 'choice') throw new Error('the Supply Shortage choice did not open');
    const actorId = first.responsiblePlayerIds[0]!;

    state = submit(state, actorId, { kind: 'players', playerIds: ['p3'] });

    // Nothing is pending for p3, and whoever is next in the queue can still answer.
    expect(state.pendingVoterGroups.some((group) => group.ownerId === 'p3')).toBe(false);
    expect(playable(state)).toBe(true);
    assertGameState(state, CORE_CONTENT);
  });

  /**
   * Quarantine asked the wrong seat about protection.
   *
   * Each seat in the queue evicts one of *its own* voters, so the eviction is checked
   * against that seat — but the queue was filtered against the seat whose voter triggered
   * the news. A zone protected by a third party therefore passed the filter and then
   * refused everything the queued seat could offer.
   */
  it('leaves a Quarantine seat out of the queue when its only voter is protected', () => {
    let state = activeState();
    // p2's one voter sits in a zone p3 has closed with Loyal Base. p3 owns
    // the protection, so it holds against p2 and against the news's owner alike.
    placeVoter(state, 'p2', slotsIn('northWest', false)[0]!);
    intoHand(state, 'p3', 'TRK009');
    state.players.find((player) => player.id === 'p3')!.trickHand = [];
    state.activeEffects.push({
      id: 'fixture-cult',
      sourceCardId: 'TRK009',
      ownerId: 'p3',
      kind: 'loyalBase',
      targetPlayerIds: ['p3'],
      targetZoneIds: ['northWest'],
      data: {},
    });
    queueNews(state, 'NEWS010', 'p1', slotsIn('central', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    const interaction = state.pendingInteraction;
    if (interaction?.kind === 'choice') {
      // If anybody was asked, it is not p2 — they have nothing they could evict.
      expect(interaction.responsiblePlayerIds).not.toContain('p2');
    }
    expect(playable(state)).toBe(true);
  });

  /**
   * The same reading for Standoff, whose source count was read off the slot table.
   *
   * `moveVoter` refuses a protected voter, so a trigger zone whose occupants are all
   * closed to this seat has no legal source at all — and three is printed.
   */
  it("resolves Standoff as no effect when the trigger zone is protected", () => {
    let state = activeState();
    const slots = slotsIn('northWest', false);
    for (let index = 0; index < 4; index += 1) placeVoter(state, 'p1', slots[index]!);
    state.players.find((player) => player.id === 'p2')!.trickHand = [];
    const index = state.trickDeck.drawPile.indexOf('TRK009');
    if (index >= 0) state.trickDeck.drawPile.splice(index, 1);
    state.activeEffects.push({
      id: 'fixture-cult',
      sourceCardId: 'TRK009',
      ownerId: 'p2',
      kind: 'loyalBase',
      targetPlayerIds: ['p2'],
      targetZoneIds: ['northWest'],
      data: {},
    });
    queueNews(state, 'NEWS003', 'p1', slotsIn('northWest', true)[0]!);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    expect(state.pendingInteraction?.kind).not.toBe('choice');
    expect(playable(state)).toBe(true);
  });

  it('forgoes the Turf War reward when the reserve cannot pay two', () => {
    let state = activeState();
    // Two voters for one seat to take and an empty reserve: the conversion must happen
    // and the two-resource reward must be skipped rather than asked for.
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    placeVoter(state, 'p1', slotsIn('north', false)[1]!);
    queueNews(state, 'NEWS014', 'p1', slotsIn('central', true)[0]!);
    drainReserve(state, 'p2', 0);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('the Limits choice did not open');
    const actorId = interaction.responsiblePlayerIds[0]!;
    const leftId = state.turn.order[
      (state.turn.order.indexOf(actorId) + 1) % state.turn.order.length
    ]!;
    const targets = state.voters
      .filter((voter) => voter.ownerId === leftId && voter.location.kind === 'board')
      .slice(0, 2)
      .map((voter) => voter.id);

    state = submit(state, actorId, { kind: 'voters', voterIds: targets });

    // No reward prompt is open against an empty reserve, and the match moved on.
    const next = state.pendingInteraction;
    if (next?.kind === 'choice') expect(next.continuation.op).not.toBe('limitsReward');
    expect(playable(state)).toBe(true);
    assertGameState(state, CORE_CONTENT);
  });
});

describe('a played trick that cannot reach its printed quantity', () => {
  /**
   * A trick is chosen, so A16 applies literally: the activation is illegal and the
   * play is refused. The table is never blocked, because nothing opened.
   *
   * Each case is driven through `beginEffect` against an opening board, which is the
   * hardest position for a printed quantity, and each is paired with the smallest board
   * that makes the card legal again.
   */
  it('refuses Veto with no open trick or news effect', () => {
    const state = activeState();
    expect(begin(state, 'TRK004')).toContain('Veto needs an open');
    expect(state.pendingInteraction).toBeNull();
    expect(playable(state)).toBe(true);
  });

  it('opens Veto when an effect is there to discard', () => {
    const state = activeState();
    // Star Power is a plain persistent effect, which is all Veto needs.
    expect(begin(state, 'TRK015')).toBeNull();
    expect(begin(state, 'TRK004')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Veto did not open a choice');
    expect(interaction.continuation.op).toBe('blockOpen');
  });

  it('refuses Flip-Flop with no retained Policy Card to flip', () => {
    const state = activeState();
    state.players.find((player) => player.id === 'p1')!.retainedPolicy = [];
    expect(begin(state, 'TRK007')).toContain('Flip-Flop needs');
    expect(state.pendingInteraction).toBeNull();
  });

  it('opens Flip-Flop when its owner holds one', () => {
    const state = activeState();
    const p1 = state.players.find((player) => player.id === 'p1')!;
    const cardId = state.policyDeck.drawPile.shift()!;
    const card = CORE_CONTENT.policyCards.find((candidate) => candidate.id === cardId)!;
    p1.retainedPolicy = [{ cardId, answerIndex: 0, archetype: card.answers[0].archetype }];
    expect(begin(state, 'TRK007')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Flip-Flop did not open a choice');
    expect(interaction.continuation.op).toBe('accentFlip');
  });

  it('refuses Loyal Base with no majority of its own to protect', () => {
    const state = activeState();
    expect(begin(state, 'TRK009')).toContain('Loyal Base needs');
    expect(state.pendingInteraction).toBeNull();
  });

  it('opens Loyal Base when its owner holds a majority', () => {
    const state = activeState();
    for (const slotId of slotsIn('northWest', false).slice(0, 6)) placeVoter(state, 'p1', slotId);
    markZoneMajority(state, 'northWest');
    expect(begin(state, 'TRK009')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Cult did not open a choice');
    expect(interaction.continuation.op).toBe('cultZone');
  });

  it('refuses Dragnet with fewer than five reachable voters', () => {
    const state = activeState();
    for (const slotId of slotsIn('north', false).slice(0, 4)) placeVoter(state, 'p2', slotId);
    expect(begin(state, 'TRK012')).toContain('Dragnet needs five');
    expect(state.pendingInteraction).toBeNull();
    expect(playable(state)).toBe(true);
  });

  it('opens Dragnet when five are reachable', () => {
    const state = activeState();
    for (const slotId of slotsIn('north', false).slice(0, 5)) placeVoter(state, 'p2', slotId);
    expect(begin(state, 'TRK012')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Dragnet did not open');
    expect(interaction.continuation.op).toBe('imprisonVoters');
  });

  it('refuses Roll Purge when its owner holds no redistricting rights', () => {
    const state = activeState();
    // A voter on the board, but in nobody's rights zone: the count is tied at one each.
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    placeVoter(state, 'p2', slotsIn('north', false)[1]!);
    expect(begin(state, 'TRK013')).toContain('Roll Purge needs');
    expect(state.pendingInteraction).toBeNull();
  });

  it('opens Roll Purge when its owner leads a zone', () => {
    const state = activeState();
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    expect(begin(state, 'TRK013')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Documents did not open a choice');
    expect(interaction.continuation.op).toBe('documentsVoters');
  });

  it('refuses Musical Chairs with fewer than two swappable voters', () => {
    const state = activeState();
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    expect(begin(state, 'TRK016')).toContain('Musical Chairs needs two');
    expect(state.pendingInteraction).toBeNull();
  });

  it('opens Musical Chairs when two are swappable', () => {
    const state = activeState();
    placeVoter(state, 'p1', slotsIn('north', false)[0]!);
    placeVoter(state, 'p2', slotsIn('south', false)[0]!);
    expect(begin(state, 'TRK016')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Slumdog did not open a choice');
    expect(interaction.continuation.op).toBe('slumdogSwap');
  });

  it('refuses Cornerstone when the reserve cannot pay its four resources', () => {
    const state = activeState();
    drainReserve(state, 'p2', 0);
    expect(begin(state, 'TRK017')).toContain('Cornerstone needs four');
    expect(state.pendingInteraction).toBeNull();
  });

  it('opens Cornerstone against a reserve that can pay', () => {
    const state = activeState();
    expect(begin(state, 'TRK017')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Cornerstone did not open a choice');
    expect(interaction.continuation.op).toBe('cornerstoneGain');
  });

  /**
   * The conversion mode is the one guard that has to run before anything is spent.
   *
   * Cornerstone x3 discards the other two cards from the hand as its cost, so a refusal
   * after that point would take two cards and give nothing back.
   */
  it('refuses Cornerstone x3 with no convertible 6/11 zone, and keeps the cards', () => {
    const state = activeState();
    const p1 = state.players.find((player) => player.id === 'p1')!;
    intoHand(state, 'p1', 'TRK018');
    intoHand(state, 'p1', 'TRK019');
    // Four opponent voters in every 6/11 zone, and p1 has nothing in supply to replace
    // them with, so no zone can be converted whole.
    for (const zoneId of ['northWest', 'northEast', 'southWest', 'southEast']) {
      placeVoter(state, 'p2', slotsIn(zoneId, false)[0]!);
    }
    for (const voter of state.voters.filter((candidate) => candidate.ownerId === 'p1')) {
      voter.location = { kind: 'removed', reason: 'fixture' };
    }

    expect(begin(state, 'TRK017', 'p1', 'triple')).toContain('Cornerstone x3 needs');
    expect(state.pendingInteraction).toBeNull();
    expect(p1.trickHand).toEqual(['TRK018', 'TRK019']);
  });

  it('opens Cornerstone x3 against a zone it can convert, and spends the two cards', () => {
    const state = activeState();
    const p1 = state.players.find((player) => player.id === 'p1')!;
    intoHand(state, 'p1', 'TRK018');
    intoHand(state, 'p1', 'TRK019');
    placeVoter(state, 'p2', slotsIn('northWest', false)[0]!);

    expect(begin(state, 'TRK017', 'p1', 'triple')).toBeNull();
    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('Cornerstone x3 did not open a choice');
    expect(interaction.continuation.op).toBe('cornerstoneZone');
    expect(p1.trickHand).toEqual([]);
  });
});

describe("Long March's end-turn eviction", () => {
  /**
   * The eviction is anchored to its owner's end turn, not to a card being dealt.
   *
   * Five is printed, and the prompt blocks every command — so a board with fewer than
   * five reachable voters would refuse this seat's `RequestEndTurn` for good. Unlike a
   * dealt news, this one can simply wait: the effect stays active and fires at the
   * owner's next end turn, by which point an ordinary game has filled the board.
   */
  function withBharat(state: GameState): void {
    const index = state.trickDeck.drawPile.indexOf('TRK008');
    if (index >= 0) state.trickDeck.drawPile.splice(index, 1);
    state.activeEffects.push({
      id: 'fixture-bharat',
      sourceCardId: 'TRK008',
      ownerId: 'p1',
      kind: 'longMarch',
      targetPlayerIds: [],
      targetZoneIds: [],
      data: {},
      remainingUses: 1,
    });
  }

  it('lets its owner end a turn when the board holds fewer than five voters', () => {
    let state = activeState();
    for (const slotId of slotsIn('north', false).slice(0, 4)) placeVoter(state, 'p2', slotId);
    withBharat(state);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    // No eviction prompt, the turn moved on, and the card is still waiting its turn.
    const interaction = state.pendingInteraction;
    if (interaction?.kind === 'choice') expect(interaction.continuation.op).not.toBe('bharatVoters');
    expect(state.activeEffects.some((effect) => effect.kind === 'longMarch')).toBe(true);
    expect(playable(state)).toBe(true);
  });

  it('opens the eviction when five voters are reachable', () => {
    let state = activeState();
    for (const slotId of slotsIn('north', false).slice(0, 5)) placeVoter(state, 'p2', slotId);
    withBharat(state);

    state = accepted(state, 'p1', { type: 'RequestEndTurn' });

    const interaction = state.pendingInteraction;
    if (interaction?.kind !== 'choice') throw new Error('the Long March choice did not open');
    expect(interaction.continuation.op).toBe('bharatVoters');
    expect(interaction.responsiblePlayerIds).toEqual(['p1']);
  });

});
