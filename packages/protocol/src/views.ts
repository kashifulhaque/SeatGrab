import type { EngineErrorCode, ResourceVectorDto } from './commands.js';

export interface PublicPlayerView {
  id: string;
  displayName: string;
  partyId: string;
  seat: number;
  resources: ResourceVectorDto;
  resourceCap: number;
  policyCounts: Record<'corporate' | 'nationalist' | 'populist' | 'reformer', number>;
  trickHandCount: number;
  score: number;
  connected: boolean;
}

export interface PublicSlotView {
  slotId: string;
  zoneId: string;
  volatile: boolean;
  voter?: { id: string; ownerId: string; majority: boolean };
}

export interface PublicZoneView {
  id: string;
  displayName: string;
  capacity: number;
  majorityThreshold: number;
  counts: Record<string, number>;
  majorityOwnerId?: string;
  rightsOwnerId?: string;
}

/** The unresolved card ID and rewards are intentionally absent. */
export interface HiddenPolicyPromptView {
  kind: 'policyAnswer';
  interactionId: string;
  question: string;
  answers: readonly [{ text: string }, { text: string }];
}

/**
 * Typed prompt payloads for every choice interaction the engine can open.
 *
 * Each variant carries only the values a responsible client needs to render the
 * prompt and submit a legal command. Server-only continuation fields—handler
 * identifiers, deck references, internal effect identifiers, submitted ballots,
 * and secret card selections—are never part of this contract.
 */
export type ChoicePromptContext =
  /** Vote for the player who receives the revealed trick. Ballots stay secret. */
  | {
    op: 'campaignVote';
    prizeCardId: string;
    candidateIds: readonly string[];
    round: number;
    ballotsCast: number;
    awaitingPlayerIds: readonly string[];
  }
  /** Bid on a trick the seller chose in secret. The card ID stays hidden. */
  | {
    op: 'auction';
    sellerId: string;
    minimumBid: number;
    currentBid: number;
    currentBidderId?: string;
    bidderOrder: readonly string[];
    passedPlayerIds: readonly string[];
  }
  /** React to a card another player just played, or pass priority. */
  | {
    op: 'trickPriority';
    playedCardId: string;
    playedByPlayerId: string;
    responderOrder: readonly string[];
    passedPlayerIds: readonly string[];
  }
  | {
    op: 'chaiOpponent';
    ownerId: string;
    eligiblePlayerIds: readonly string[];
    restrictToPlayerId?: string;
  }
  | { op: 'chaiResource'; ownerId: string; opponentId: string; optionIds: readonly string[] }
  | { op: 'turncoatTrack'; ownerId: string; optionIds: readonly string[] }
  | { op: 'blockOpen'; ownerId: string; openCardIds: readonly string[] }
  | { op: 'accentFlip'; ownerId: string; policyCardIds: readonly string[] }
  | { op: 'bharatVoters'; ownerId: string; exactly: number; restrictToPlayerId?: string }
  | {
    op: 'bharatOwners';
    ownerId: string;
    voterIds: readonly string[];
    eligiblePlayerIds: readonly string[];
    restrictToPlayerId?: string;
  }
  | { op: 'cultZone'; ownerId: string; eligibleZoneIds: readonly string[] }
  | { op: 'cultStolenZone'; ownerId: string; eligibleZoneIds: readonly string[] }
  | {
    op: 'notOneTarget';
    ownerId: string;
    /** Submit `optionId` as `playerId|zoneId`. */
    optionFormat: 'playerZone';
    eligiblePlayerIds: readonly string[];
    eligibleZoneIds: readonly string[];
    restrictToPlayerId?: string;
  }
  | { op: 'imprisonVoters'; ownerId: string; exactly: number; restrictToPlayerId?: string }
  | { op: 'hostageVoters'; ownerId: string; exactly: number }
  | { op: 'redevelopmentDiscard'; ownerId: string; zoneId: string; exactly: number }
  | {
    op: 'documentsVoters';
    ownerId: string;
    minimum: number;
    maximum: number;
    rightsZoneIds: readonly string[];
    restrictToPlayerId?: string;
  }
  | { op: 'slumdogSwap'; ownerId: string; allowedCounts: readonly number[] }
  | { op: 'cornerstoneGain'; ownerId: string; resourceTotal: number }
  | { op: 'cornerstoneZone'; ownerId: string; eligibleZoneIds: readonly string[] }
  | { op: 'dostiTarget'; ownerId: string; eligiblePlayerIds: readonly string[] }
  | { op: 'mansplainTarget'; ownerId: string; eligiblePlayerIds: readonly string[] }
  | { op: 'nerosMoves'; ownerId: string; zoneId: string; pairs: number }
  | { op: 'poloPlayers'; ownerId: string; exactly: number; eligiblePlayerIds: readonly string[] }
  | { op: 'poloFallback'; ownerId: string; playerIds: readonly string[]; optionIds: readonly string[] }
  | { op: 'karachiKeep'; ownerId: string; drawnCardIds: readonly string[] }
  | { op: 'blessingsKeep'; ownerId: string; drawnCardIds: readonly string[] }
  | {
    op: 'blessingsDonate';
    ownerId: string;
    keptCardId: string;
    donatedCardId: string;
    eligiblePlayerIds: readonly string[];
  }
  | { op: 'blessingsPlace'; ownerId: string; groupId: string; voterCount: number }
  | { op: 'greatLeaderMove'; ownerId: string; remainingMoves: number }
  | { op: 'floodReliefMove'; ownerId: string; queuePlayerIds: readonly string[] }
  | { op: 'coughEvict'; ownerId: string; exactly: number; queuePlayerIds: readonly string[] }
  | { op: 'coughReward'; ownerId: string; resourceTotal: number; queuePlayerIds: readonly string[] }
  | {
    op: 'limitsConvert';
    ownerId: string;
    exactly: number;
    leftPlayerId?: string;
    queuePlayerIds: readonly string[];
  }
  | { op: 'limitsReward'; ownerId: string; resourceTotal: number; queuePlayerIds: readonly string[] }
  | { op: 'goalparaCard'; ownerId: string; marketCardIds: readonly string[]; queuePlayerIds: readonly string[] }
  | { op: 'goalparaReward'; ownerId: string; resourceTotal: number; queuePlayerIds: readonly string[] }
  | {
    op: 'oxyChoice';
    ownerId: string;
    eligiblePlayerIds: readonly string[];
    queuePlayerIds: readonly string[];
  }
  | { op: 'oxyPlace'; ownerId: string; groupId: string }
  | {
    op: 'donatePolicy';
    ownerId: string;
    policyCardIds: readonly string[];
    recipientPlayerId?: string;
    queuePlayerIds: readonly string[];
  }
  | { op: 'donationReward'; ownerId: string; resourceTotal: number }
  /**
   * The engine opened a continuation this contract does not describe. Clients
   * must refuse to render it rather than guess at the missing fields.
   */
  | { op: 'unsupported' };

/**
 * Every continuation the engine may open. The engine's `ChoiceInteraction` is
 * typed against this union, so a new continuation cannot reach a client until
 * `ChoicePromptContext` describes the fields it is allowed to expose.
 */
export type ChoicePromptOp = Exclude<ChoicePromptContext['op'], 'unsupported'>;

export interface ChoicePromptView {
  kind: 'choice';
  interactionId: string;
  explanation: string;
  allowed: readonly string[];
  allowPass: boolean;
  sourceCardId?: string;
}
export interface StructuredChoicePromptView extends ChoicePromptView {
  context: ChoicePromptContext;
}

export interface SetupPromptView {
  kind: 'firstPlayerVote' | 'startingResources';
  interactionId: string;
  remainingPlayerIds: readonly string[];
}

export interface CapPromptView {
  kind: 'capDiscard';
  interactionId: string;
  excess: number;
}

export interface MajorityPromptView {
  kind: 'majoritySelection';
  interactionId: string;
  zoneId: string;
  required: number;
  eligibleVoterIds: readonly string[];
}

export type PlayerPromptView =
  | HiddenPolicyPromptView
  | StructuredChoicePromptView
  | SetupPromptView
  | CapPromptView
  | MajorityPromptView;

export interface TradeOfferView {
  id: string;
  proposerId: string;
  opponentId: string;
  giveResources: ResourceVectorDto;
  receiveResources: ResourceVectorDto;
  giveTrickIds: readonly string[];
  receiveTrickIds: readonly string[];
}

/**
 * The settings frozen into a match when it was created.
 *
 * A client must never need the authoritative state to describe the table it is sitting
 * at. The local adapter happens to hold that state in the same process, but an online
 * client has no such access, so every immutable fact a screen reports comes from here.
 */
export interface MatchSetupView {
  matchId: string;
  playerCount: number;
  tiePolicy: 'jointWinners';
  contentAdvisories: readonly ('sensitive' | 'trigger')[];
  contentPackId: string;
  contentVersion: string;
  rulesetId: string;
  rulesetVersion: string;
  boardId: string;
  boardVersion: string;
  engineVersion: string;
  schemaVersion: number;
}

/**
 * Who the match is waiting on, as a public fact.
 *
 * The decision owner is often not the active player: a reaction, an auction bid, or a
 * campaign vote all move the pending decision elsewhere. Section 13.4 requires the table
 * to keep that conspicuous, and deriving it by projecting every seat's private view
 * would move private data into a client for a fact anyone at a physical table can see.
 *
 * Only the neutral shape of the decision is published. What the deciding seat must
 * actually choose between stays in that seat's own `prompt`.
 */
export interface PendingDecisionView {
  interactionId: string;
  kind: 'firstPlayerVote' | 'startingResources' | 'policyAnswer' | 'capDiscard'
    | 'majoritySelection' | 'choice';
  /** Seats the match is waiting on. Never empty while a decision is pending. */
  responsiblePlayerIds: readonly string[];
  /** One engine-authored line naming the decision. Carries no hidden card or ballot. */
  summary: string;
  /** The card that opened the decision, when one did and it was played face up. */
  sourceCardId?: string;
}

/**
 * How much of each per-turn allowance the active seat has already spent this turn.
 *
 * Everyone at a physical table watches a power being used, so these counts are public.
 * They carry no card identity: `groundswell` is a count of cards influenced with the
 * power, not a list of them, because the list would say nothing the market does not
 * already say and would grow into a second copy of the purchase log.
 *
 * The matching limits are not published, because a client can already derive them: the
 * printed limits are fixed, Grand Coalition doubles the level 3 ones and appears in
 * `activeEffects`, and Landslide depends on a seat's own Populist count.
 */
export interface TurnUsageView {
  arbitrage: number;
  shakedown: number;
  groundswell: number;
  volunteers: number;
  demolition: number;
  crackdown: number;
  outreach: number;
  /** Gerrymanders already authorized by each rights zone, keyed by zone ID. */
  gerrymandersByZoneId: Readonly<Record<string, number>>;
}

export interface PlayerView {
  matchId: string;
  revision: number;
  status: 'setup' | 'active' | 'finished';
  activePlayerId?: string;
  phase: string;
  /** Immutable match settings. Present in every projection, public and private. */
  setup: MatchSetupView;
  /** The decision the match is waiting on, or absent when it is waiting on none. */
  pendingDecision?: PendingDecisionView;
  players: readonly PublicPlayerView[];
  /**
   * How many turns have begun, which is what every group deadline is measured against.
   *
   * A pending group is due once this figure has reached its `deadlineTurnOrdinal`, and an
   * evicted voter returns once it has reached that voter's `availableOnTurnOrdinal`. Both
   * of those were published with nothing to compare them to.
   */
  turnOrdinal: number;
  /**
   * What is left in the bank.
   *
   * At a physical table the reserve is a pile in the middle that everyone can count, so
   * it is public here too. Several rules read it and used to be discoverable only by
   * refusal: Arbitrage takes two unless the reserve is shorter than that, ordinary Four
   * Pillars needs four left in it, and every fixed grant is capped per type by what the
   * reserve still holds.
   */
  publicReserve: ResourceVectorDto;
  zones: readonly PublicZoneView[];
  slots: readonly PublicSlotView[];
  voterMarket: readonly string[];
  pendingVoterGroups: readonly {
    id: string;
    ownerId: string;
    controllerId: string;
    count: number;
    sameZone: boolean;
    /**
     * The turn ordinal by which this group must be placed or discarded.
     *
     * A group is due once `turnOrdinal` has reached this figure, and the engine requires
     * every due group in one `ConfirmPendingVoterDiscard`. Every group the engine creates
     * today carries the ordinal it was created on, so a controller in its own action
     * phase always faces the whole set — but that is an argument about today's call
     * sites, not an invariant, and a future group with a later deadline would break it
     * silently. Publishing the figure lets a screen check instead of assume.
     */
    deadlineTurnOrdinal: number;
    /**
     * Zones this group may be placed in, when the card that created it named a set.
     *
     * Absent means unrestricted, exactly as it is absent on the engine's own group. A
     * composer narrows placement to these zones rather than offering an area the engine
     * will refuse.
     */
    allowedZoneIds?: readonly string[];
  }[];
  voterCards: readonly {
    id: string;
    voters: number;
    cost: ResourceVectorDto & { generic: number };
  }[];
  activeEffects: readonly {
    id: string;
    sourceCardId: string;
    title: string;
    /**
     * The engine's own name for what this effect does, beside the card's printed title.
     *
     * A client that has to price a purchase or count an allowance needs to recognize a
     * specific effect, and the title is the wrong handle for it: it is display text from
     * the content pack, so retitling a card would silently change a quoted price. The
     * kind is the value the engine's own rules match on, and it is no more secret than
     * the title — the effect is face up either way.
     */
    kind: string;
    ownerId: string;
    targetPlayerIds: readonly string[];
    targetZoneIds: readonly string[];
    remainingUses?: number;
  }[];
  /** Turncoat placements, with the exact price a rival must pay to acquire each one. */
  turncoatHoldings: readonly {
    effectId: string;
    ownerId: string;
    archetype: 'corporate' | 'nationalist' | 'populist' | 'reformer';
    acquisitionCost: number;
  }[];
  deckCounts: { policy: number; voter: number; news: number; trick: number };
  /**
   * The price on the back of the top trick, and what this seat would actually pay.
   *
   * A trick is bought face down off the top of the draw pile, and its price is on the
   * back where everyone can read it. `printed` is that back price, wholly generic and 4
   * or 5. `payable` is `printed` plus this seat's Leaked Tapes surcharge, which is the
   * figure a seat actually has to hand over.
   */
  trickMarket?: {
    printed: ResourceVectorDto & { generic: number };
    payable: ResourceVectorDto & { generic: number };
  };
  /** The active seat's spent per-turn allowances. Reset when a turn begins. */
  turnUsage: TurnUsageView;
  legalActions: readonly string[];
  privateDebts?: readonly { id: string; creditorPlayerId: string; amount: number; reason: string }[];
  privateObligations?: readonly { id: string; kind: string; sourceCardId: string }[];
  privateEvictedVoters?: readonly { id: string; availableOnTurnOrdinal: number }[];
  prompt?: PlayerPromptView;
  privateTrickIds?: readonly string[];
  privateTradeOffers?: readonly TradeOfferView[];
  /** Committed Policy Cards belonging to the viewer, in the order they were kept. */
  privatePolicyCards?: readonly {
    cardId: string;
    answerIndex: 0 | 1;
    archetype: 'corporate' | 'nationalist' | 'populist' | 'reformer';
  }[];
  /**
   * Voter tokens the viewer still has in supply, and never another seat's.
   *
   * Every purchase, every free placement and every conversion draws from this pile, and a
   * seat that has run it down is refused a card it can otherwise pay for. A player at a
   * physical table can see their own pile, so a composer should state the figure rather
   * than discover it by refusal.
   *
   * It is on the viewer's own seat rather than on `PublicPlayerView` because publishing it
   * would publish something else by subtraction. A seat's 50 tokens are on the board, in
   * supply, in a pending group, evicted, or held by a rival; the board and the pending
   * groups are already public, and the other two are deliberately not — `privateEvicted-
   * Voters` and `privateHeldVoters` are each shown only to the voters' owner. A public
   * supply figure would hand every viewer `evicted + held` for every seat, which is the
   * count those two fields exist to keep private. `projection-privacy.test.ts` scans for
   * leaked identifiers and would not have caught that, so the reasoning is recorded here.
   */
  privateVoterSupply?: number;
  /** Voters of the viewer that an opponent holds, with the exact buyback price. */
  privateHeldVoters?: readonly {
    voterId: string;
    sourceCardId: string;
    holderId: string;
    buybackCost: number;
  }[];
  history: readonly VisibleEvent[];
  /**
   * Why the match ended, present only once it has.
   *
   * `allMajorities` is the ordinary end: every zone has its majority.
   * `fullBoardFinalTurns` is the other one: the board filled before all nine majorities
   * existed, every seat took its last turn, and the match was scored where it stood.
   */
  endReason?: 'allMajorities' | 'fullBoardFinalTurns';
  finalScores?: Readonly<Record<string, number>>;
  winners?: readonly string[];
}

/**
 * One seat's whole view of a match, as both transports return it.
 *
 * This is the answer to "what is the state", whether it was asked for over HTTP, sent
 * in the welcome of a WebSocket connection, or broadcast after another seat's command.
 * There is exactly one shape so a client never has to reconcile two.
 *
 * `promptProblem` is non-null when the engine opened a continuation `ChoicePromptContext`
 * does not describe. A client must refuse such a prompt rather than render an empty one;
 * the browser's local adapter reports the same condition as `UNSUPPORTED_PROMPT`.
 */
export interface SeatView {
  /** `projectGame` for this seat, and never for another. */
  view: PlayerView;
  legalActions: readonly string[];
  /** The highest stored event sequence, to pass back for a catch-up read. */
  eventCursor: number;
  promptProblem: string | null;
}

export interface VisibleEvent {
  id: string;
  type: string;
  message: string;
  actorId?: string;
}

export type CommandSuccess = {
  ok: true;
  revision: number;
  events: readonly VisibleEvent[];
};

export type CommandFailure = {
  ok: false;
  code: EngineErrorCode;
  message: string;
  revision: number;
};

export type CommandResponse = CommandSuccess | CommandFailure;
