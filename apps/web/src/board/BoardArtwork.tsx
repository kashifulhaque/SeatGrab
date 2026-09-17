/**
 * The drawn board: the sea, nine district outlines and all 129 voter areas.
 *
 * Every coordinate comes from `CORE_BOARD`. The component draws; it decides
 * nothing. Zone legality, capacity and movement stay with the engine, and this file must
 * never become a second source of truth for them.
 */
import { CORE_BOARD } from '@gerrymander/content';
import type { BoardZoneId } from '@gerrymander/content';

const BOARD = CORE_BOARD;
const WIDTH = 1000;
const HEIGHT = BOARD.art.aspectRatio * WIDTH;

/** The board's own frame, read from its viewBox so the backing panel always fills it. */
export const FRAME = (() => {
  const [x = 0, y = 0, width = WIDTH, height = HEIGHT] = BOARD.art.viewBox.split(/\s+/).map(Number);
  return { x, y, width, height };
})();

/** Normalized board coordinates to drawing units. See `BoardArt`. */
export function toDrawing(x: number, y: number): { x: number; y: number } {
  return { x: x * WIDTH, y: y * HEIGHT };
}

/**
 * The plaque every district wears, 124 by 54 drawing units.
 *
 * `scripts/generate_board.py` keeps a clear rectangle this size inside each district, so
 * the size is a fact the map depends on: changing it here means regenerating the board.
 */
export const PLAQUE = 'M-62-27H62q6 0 6 6V21q0 6-6 6H-62q-6 0-6-6V-21q0-6 6-6z';

export interface BoardArtworkProps {
  /** Zones drawn as selected. Everything else renders in the resting style. */
  highlightedZones?: readonly BoardZoneId[];
  /** Draw the printed threshold plaque over each zone. */
  showLabels?: boolean;
  /** Draw a ring on the 11 volatile areas. */
  showVolatile?: boolean;
  /** Accessible name for the whole figure. */
  title?: string;
}

export function BoardArtwork({
  highlightedZones = [],
  showLabels = true,
  showVolatile = true,
  title = 'Gerrymander board: an island of nine districts and 129 voter areas',
}: BoardArtworkProps) {
  const highlighted = new Set(highlightedZones);
  return (
    <svg
      className="board"
      viewBox={BOARD.art.viewBox}
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect className="board__sea" x={FRAME.x} y={FRAME.y} width={FRAME.width} height={FRAME.height} rx={28} />
      <g className="board__zones">
        {BOARD.zones.map((zone) => (
          <path
            key={zone.id}
            className={
              highlighted.has(zone.id)
                ? 'board__zone board__zone--highlighted'
                : 'board__zone'
            }
            d={zone.path}
          />
        ))}
      </g>
      <g className="board__slots">
        {BOARD.slots.map((slot) => {
          const at = toDrawing(slot.position.x, slot.position.y);
          const radius = slot.radius * WIDTH;
          return (
            <g key={slot.slotId}>
              <circle className="board__slot" cx={at.x} cy={at.y} r={radius} />
              {showVolatile && slot.volatile ? (
                <circle
                  className="board__slot-volatile"
                  cx={at.x}
                  cy={at.y}
                  r={radius + 5}
                />
              ) : null}
            </g>
          );
        })}
      </g>
      {showLabels ? (
        <g className="board__labels">
          {BOARD.zones.map((zone) => {
            const at = toDrawing(zone.label.x, zone.label.y);
            return (
              <g key={zone.id} transform={`translate(${at.x} ${at.y})`}>
                <path className="board__plaque" d={PLAQUE} />
                <text className="board__plaque-name" y={-7}>
                  {zone.displayName.toUpperCase()}
                </text>
                <text className="board__plaque-threshold" y={17}>
                  {zone.majorityThreshold}/{zone.capacity}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}

/** Aspect ratio and slot totals, for a caption that has to state what is drawn. */
export const BOARD_FACTS = {
  viewBox: BOARD.art.viewBox,
  zones: BOARD.zones.length,
  slots: BOARD.slots.length,
  volatileSlots: BOARD.slots.filter((slot) => slot.volatile).length,
  movementTriples: BOARD.movementTriples.length,
  aspectRatio: BOARD.art.aspectRatio,
} as const;
