import type { BoardZoneId, Archetype, ResourceType, ResourceVector } from '@gerrymander/content';
import type {
  ChoicePromptOp,
  ChoiceSelection,
  ComputerDifficulty,
  SeatController,
  VisibleEvent,
} from '@gerrymander/protocol';

export const GAME_SCHEMA_VERSION = 1;
export const BASE_RESOURCE_CAP = 12;
export const RESOURCE_SUPPLY_PER_TYPE = 30;
export const VOTER_SUPPLY_PER_PLAYER = 50;

export type PlayerId = string;
export type VoterId = string;
export type CardId = string;
export type SlotId = string;

export interface GameConfig {
  matchId: string;
  players: readonly {
    id: PlayerId;
    displayName: string;
    partyId: string;
    /** Absent means `human`, so a config written before the field existed still loads. */
    controller?: SeatController;
    /** Present if and only if `controller` is `computer`. */
    difficulty?: ComputerDifficulty;
  }[];
  contentAdvisories: readonly ('sensitive' | 'trigger')[];
  tiePolicy: 'jointWinners';
}

export interface RetainedPolicyCard {
  cardId: CardId;
  answerIndex: 0 | 1;
  archetype: Archetype;
}

export interface Debt {
  id: string;
  creditorPlayerId: PlayerId;
  amount: number;
  reason: string;
}

export interface Obligation {
  id: string;
  kind: string;
  sourceCardId: CardId;
  data: Readonly<Record<string, string | number | readonly string[]>>;
}

export interface PlayerState {
  id: PlayerId;
  displayName: string;
  partyId: string;
  seat: number;
  connected: boolean;
  resources: ResourceVector;
  retainedPolicy: RetainedPolicyCard[];
  trickHand: CardId[];
  debts: Debt[];
  obligations: Obligation[];
}

export type VoterLocation =
  | { kind: 'supply' }
  | { kind: 'board'; slotId: SlotId; majority: boolean }
  | { kind: 'pending'; groupId: string }
  | { kind: 'evicted'; availableOnTurnOrdinal: number; controllerId?: PlayerId }
  | { kind: 'removed'; reason: string };

export interface VoterState {
  id: VoterId;
  ownerId: PlayerId;
  location: VoterLocation;
}

export interface SlotState {
  slotId: SlotId;
  voterId: VoterId | null;
}

export interface DeckState {
  drawPile: CardId[];
  discardPile: CardId[];
}

export interface VoterDeckState extends DeckState {
  market: CardId[];
  marketRevision: number;
}

export interface PendingVoterGroup {
  id: string;
  ownerId: PlayerId;
  controllerId: PlayerId;
  voterIds: VoterId[];
  origin: { kind: 'voterCard'; cardId: CardId } | { kind: 'effect'; sourceCardId: CardId } | { kind: 'eviction' };
  sameZone: boolean;
  allowedZoneIds?: BoardZoneId[];
  deadlineTurnOrdinal: number;
}

export interface NewsTrigger {
  id: string;
  voterId: VoterId;
  slotId: SlotId;
  voterOwnerId: PlayerId;
  actorId: PlayerId;
  turnOrdinal: number;
}

export interface ActiveEffect {
  id: string;
  sourceCardId: CardId;
  ownerId: PlayerId;
  kind: string;
  targetPlayerIds: PlayerId[];
  targetZoneIds: BoardZoneId[];
  remainingUses?: number;
  expiresAfterPlayerTurn?: { playerId: PlayerId; completedTurn: number };
  data: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

export interface TradeOffer {
  id: string;
  proposerId: PlayerId;
  opponentId: PlayerId;
  giveResources: ResourceVector;
  receiveResources: ResourceVector;
  giveTrickIds: CardId[];
  receiveTrickIds: CardId[];
  createdRevision: number;
}

export interface UsageCounters {
  arbitrage: number;
  shakedown: number;
  demolition: number;
  crackdown: number;
  groundswellCardIds: CardId[];
  volunteers: number;
  outreach: number;
  threeVoterPurchases: number;
  gerrymandersByRightsZone: Partial<Record<BoardZoneId, number>>;
}

export interface TurnState {
  activePlayerId: PlayerId | null;
  order: PlayerId[];
  ordinal: number;
  completedTurns: Record<PlayerId, number>;
  phase:
    | 'firstPlayerElection'
    | 'startingResources'
    | 'beforeAnswer'
    | 'policyAnswer'
    | 'resourceCap'
    | 'action'
    | 'endTurn'
    | 'newsResolution'
    | 'finished';
  usage: UsageCounters;
}

export interface FirstPlayerVoteInteraction {
  id: string;
  kind: 'firstPlayerVote';
  responsiblePlayerIds: PlayerId[];
  ballots: Record<PlayerId, PlayerId>;
  round: number;
}

export interface StartingResourcesInteraction {
  id: string;
  kind: 'startingResources';
  responsiblePlayerIds: PlayerId[];
  remainingPlayerIds: PlayerId[];
}

export interface PolicyAnswerInteraction {
  id: string;
  kind: 'policyAnswer';
  responsiblePlayerIds: [PlayerId];
  playerId: PlayerId;
  cardId: CardId;
}

export interface CapDiscardInteraction {
  id: string;
  kind: 'capDiscard';
  responsiblePlayerIds: [PlayerId];
  playerId: PlayerId;
  excess: number;
  continuation: 'resumeAction' | 'continueSetup' | 'continueEffect';
  remainingPlayerIds?: PlayerId[];
  resumePhase?: TurnState['phase'];
}

export interface MajoritySelectionInteraction {
  id: string;
  kind: 'majoritySelection';
  responsiblePlayerIds: [PlayerId];
  playerId: PlayerId;
  zoneId: BoardZoneId;
  required: number;
  eligibleVoterIds: VoterId[];
  continuation: 'action' | 'endTurn' | 'effect';
}

/**
 * Server-only working data for an open choice. Nothing here is a wire contract:
 * `projectChoiceContext` decides, per operation, which values a client may see.
 */
export type ChoiceContinuation =
  Readonly<Record<string, string | number | boolean | readonly string[]>>
  & { readonly op: ChoicePromptOp };

export interface ChoiceInteraction {
  id: string;
  kind: 'choice';
  responsiblePlayerIds: PlayerId[];
  explanation: string;
  allowed: readonly ChoiceSelection['kind'][];
  allowPass: boolean;
  sourceCardId?: CardId;
  continuation: ChoiceContinuation;
}

export type PendingInteraction =
  | FirstPlayerVoteInteraction
  | StartingResourcesInteraction
  | PolicyAnswerInteraction
  | CapDiscardInteraction
  | MajoritySelectionInteraction
  | ChoiceInteraction;

export interface FullBoardEndgame {
  latchedOnTurnOrdinal: number;
  remainingFinalPlayerIds: PlayerId[];
}

export interface EndgameState {
  normalEndCandidate: boolean;
  fullBoard?: FullBoardEndgame;
  reason?: 'allMajorities' | 'fullBoardFinalTurns';
  finalScores?: Record<PlayerId, number>;
  winners?: PlayerId[];
}

export interface RandomState {
  value: number;
  draws: number;
}

export interface GameEvent extends VisibleEvent {
  visibility: 'public' | 'server' | { playerIds: PlayerId[] };
}

export interface GameState {
  schemaVersion: typeof GAME_SCHEMA_VERSION;
  engineVersion: string;
  matchId: string;
  revision: number;
  config: GameConfig;
  content: {
    contentPackId: string;
    contentVersion: string;
    rulesetId: string;
    rulesetVersion: string;
    boardId: string;
    boardVersion: string;
  };
  status: 'setup' | 'active' | 'finished';
  players: PlayerState[];
  publicReserve: ResourceVector;
  voters: VoterState[];
  slots: SlotState[];
  voterDeck: VoterDeckState;
  policyDeck: DeckState;
  newsDeck: DeckState;
  trickDeck: DeckState;
  pendingVoterGroups: PendingVoterGroup[];
  newsQueue: NewsTrigger[];
  activeEffects: ActiveEffect[];
  turn: TurnState;
  interactionStack: PendingInteraction[];
  endTurnContext: { playerId: PlayerId } | null;
  tradeOffers: TradeOffer[];
  pendingInteraction: PendingInteraction | null;
  endgame: EndgameState;
  random: RandomState;
  events: GameEvent[];
  nextSequence: number;
}

export const EMPTY_RESOURCES: ResourceVector = {
  cash: 0,
  influence: 0,
  press: 0,
  faith: 0,
};

export function resourceTotal(resources: ResourceVector): number {
  return resources.cash + resources.influence + resources.press + resources.faith;
}

export function resourceEntries(resources: ResourceVector): readonly [ResourceType, number][] {
  return [
    ['cash', resources.cash],
    ['influence', resources.influence],
    ['press', resources.press],
    ['faith', resources.faith],
  ];
}
