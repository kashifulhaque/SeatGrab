/**
 * Content schemas for the SeatGrab core set.
 *
 * Everything here is data the engine reads: board topology, card costs, card effects and
 * card text. Nothing in a record depends on how it is drawn.
 */

export const BOARD_ZONE_IDS = [
  'northWest',
  'north',
  'northEast',
  'west',
  'central',
  'east',
  'southWest',
  'south',
  'southEast',
] as const;
export type BoardZoneId = (typeof BOARD_ZONE_IDS)[number];

/** One voter area on the board. */
export interface BoardSlot {
  slotId: string;
  zoneId: BoardZoneId;
  /** Normalized coordinates: `x` is a fraction of board width, `y` of board height. */
  position: { x: number; y: number };
  /** Drawn radius and minimum hit radius, as fractions of board width. */
  radius: number;
  hitRadius: number;
  volatile: boolean;
}

/** Rules and rendering metadata for one zone. */
export interface BoardZone {
  id: BoardZoneId;
  displayName: string;
  capacity: number;
  majorityThreshold: number;
  volatileAreas: number;
  adjacency: readonly BoardZoneId[];
  /** Where the zone plaque is drawn, normalized like a slot position. */
  label: { x: number; y: number };
  /**
   * Closed SVG outline of the zone in the drawing units described by `BoardArt`.
   * Rendering only; legality never depends on this path.
   */
  path: string;
}

/**
 * How the board is drawn.
 *
 * Drawing units are board-width per-mille: a normalized point (x, y) is drawn at
 * (x * 1000, y * aspectRatio * 1000) and a normalized radius at radius * 1000.
 */
export interface BoardArt {
  /** Board height divided by board width. */
  aspectRatio: number;
  /** The SVG `viewBox` that frames the whole board, as `minX minY width height`. */
  viewBox: string;
}

/** A legal directed move authorized by redistricting rights in the first zone. */
export type MovementTriple = readonly [
  rightsZone: BoardZoneId,
  sourceZone: BoardZoneId,
  destinationZone: BoardZoneId,
];

/** Static topology and slot map for one board. */
export interface BoardDefinition {
  id: string;
  version: string;
  zones: readonly BoardZone[];
  slots: readonly BoardSlot[];
  movementTriples: readonly MovementTriple[];
  art: BoardArt;
}

export const RESOURCE_TYPES = ['cash', 'influence', 'press', 'faith'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Counts of each resource type. Always nonnegative integers. */
export type ResourceVector = Record<ResourceType, number>;

/**
 * A price. `generic` is the number of wildcard units, each payable with any one resource
 * of the payer's choice. It is not a fifth resource type.
 */
export interface Cost extends ResourceVector {
  generic: number;
}

/** One voter card. Each card has a unique ID, so the deck is a list of instances. */
export interface VoterCard {
  id: string;
  /** Voters granted on purchase: 1, 2 or 3. */
  voters: 1 | 2 | 3;
  cost: Cost;
}

export const ARCHETYPES = ['corporate', 'nationalist', 'populist', 'reformer'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** The resource each archetype pays passive income in. */
export const ARCHETYPE_RESOURCE: Record<Archetype, ResourceType> = {
  corporate: 'cash',
  nationalist: 'influence',
  populist: 'press',
  reformer: 'faith',
};

/**
 * A content advisory a table can filter on before the decks are shuffled.
 * - `sensitive`: adult themes.
 * - `trigger`: violence, disaster, abuse of power or similar distressing themes.
 */
export type ContentAdvisory = 'sensitive' | 'trigger';

export type EffectDeck = 'news' | 'trick';

/** One Breaking News or Dirty Trick card. */
export interface EffectCard {
  id: string;
  deck: EffectDeck;
  title: string;
  /** How many cards in the deck share this title. */
  copies: number;
  /** A one-line narrative hook that carries no rules. */
  flavorText: string;
  /** The rules text. `\n` separates lines, including `OR` branches. */
  rulesText: string;
  /** Executable handler key; copies share one handler. */
  handlerId: string;
  advisory?: ContentAdvisory;
  /** Removed from the deck in a two-player game. */
  twoPlayerExcluded: boolean;
  /** Counters the card tracks on itself, such as held voters or marked players. */
  markerSlots: number;
  /**
   * The face-down purchase price of a Dirty Trick. Wholly generic and always 4 or 5.
   * Breaking News cards are never bought, so the field is absent on that deck.
   */
  backCost?: Cost;
}

/** One answer face of a policy card. */
export interface PolicyAnswer {
  /** The archetype this answer develops. */
  archetype: Archetype;
  text: string;
  /** Resources paid for choosing this answer: 2 of the archetype's own and 1 of a third. */
  reward: ResourceVector;
}

/** One policy card: a single question with exactly two answers. */
export interface PolicyCard {
  id: string;
  question: string;
  answers: readonly [PolicyAnswer, PolicyAnswer];
  advisory?: ContentAdvisory;
}
