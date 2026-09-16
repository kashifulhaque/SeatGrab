/**
 * Keyboard movement across the 129 printed voter areas.
 *
 * A board is a map, not a list, so arrow keys have to mean "the next area that way" and
 * not "the next record in the file". The geometry is fixed by the content pack, so the
 * whole thing is a pure function of a slot ID and a direction, and it is tested as one.
 *
 * Scoring: among the areas that actually lie in the requested direction, prefer the
 * nearest one along that axis, and penalise sideways drift so a press of Right does not
 * jump diagonally across the map when a closer area sits straight ahead.
 */
import { CORE_BOARD, type BoardZoneId } from '@seatgrab/content';

export type BoardDirection = 'left' | 'right' | 'up' | 'down';

/** How much a sideways offset counts against a candidate, relative to forward distance. */
const DRIFT_PENALTY = 2.5;

interface Placed {
  slotId: string;
  zoneId: BoardZoneId;
  x: number;
  y: number;
}

const PLACED: readonly Placed[] = CORE_BOARD.slots.map((slot) => ({
  slotId: slot.slotId,
  zoneId: slot.zoneId,
  x: slot.position.x,
  // Normalized y is board-height fractions; multiplying by the aspect ratio puts both
  // axes in the same units, so "nearest" means the same thing horizontally and
  // vertically on a board that is half as wide as it is tall.
  y: slot.position.y * CORE_BOARD.art.aspectRatio,
}));

const BY_ID = new Map(PLACED.map((slot) => [slot.slotId, slot]));

/** The slot an arrow key moves to, or `null` when the board ends in that direction. */
export function slotInDirection(fromSlotId: string, direction: BoardDirection): string | null {
  const from = BY_ID.get(fromSlotId);
  if (from === undefined) return null;
  let best: { slotId: string; score: number } | null = null;
  for (const candidate of PLACED) {
    if (candidate.slotId === fromSlotId) continue;
    const dx = candidate.x - from.x;
    const dy = candidate.y - from.y;
    const forward = direction === 'right' ? dx
      : direction === 'left' ? -dx
        : direction === 'down' ? dy
          : -dy;
    if (forward <= 0) continue;
    const drift = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = forward + DRIFT_PENALTY * drift;
    if (best === null || score < best.score) {
      best = { slotId: candidate.slotId, score };
    }
  }
  return best?.slotId ?? null;
}

/** First or last area of the zone a slot belongs to, for Home and End. */
export function slotAtZoneEdge(fromSlotId: string, edge: 'first' | 'last'): string | null {
  const from = BY_ID.get(fromSlotId);
  if (from === undefined) return null;
  const inZone = PLACED.filter((slot) => slot.zoneId === from.zoneId);
  const chosen = edge === 'first' ? inZone[0] : inZone[inZone.length - 1];
  return chosen?.slotId ?? null;
}

/** First area of the next or previous zone, for Page Down and Page Up. */
export function slotInAdjacentZone(fromSlotId: string, step: 1 | -1): string | null {
  const from = BY_ID.get(fromSlotId);
  if (from === undefined) return null;
  const zoneIds = CORE_BOARD.zones.map((zone) => zone.id);
  const index = zoneIds.indexOf(from.zoneId);
  if (index < 0) return null;
  const nextZone = zoneIds[(index + step + zoneIds.length) % zoneIds.length];
  return PLACED.find((slot) => slot.zoneId === nextZone)?.slotId ?? null;
}

/** The first area on the board, used as the initial keyboard position. */
export const FIRST_SLOT_ID: string = PLACED[0]?.slotId ?? '';
