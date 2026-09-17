/**
 * The live board: nine districts, 129 voter areas, and whatever is standing on them.
 *
 * `BoardArtwork` draws the empty board, which is what the lobby
 * preview wants. This component draws a match: it takes the public slices of one
 * `PlayerView` and renders the voters, the marked majorities, the volatile areas and any
 * legal targets a composer hands it. It still decides no rule — legality arrives in
 * `highlightedSlotIds`, computed by whoever knows the rule, which is never this file.
 *
 * Accessibility is not an afterthought here, because the board is the primary surface:
 *
 * - Every area is reachable from the keyboard through one roving tab stop, so the board
 *   costs one Tab press to enter rather than 129 to cross.
 * - Every area has a sentence naming its zone, its number, its occupant and whether that
 *   voter is marked. Nothing on the board is legible only as a colour: an occupied area
 *   carries its owner's emblem, and a marked voter carries a ring and a tick.
 * - The hit target is the content pack's `hitRadius`, which is larger than the
 *   drawn circle, so a small dot on a crowded map is still comfortably clickable.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { CORE_BOARD } from '@seatgrab/content';
import type { PublicPlayerView, PublicSlotView, PublicZoneView } from '@seatgrab/protocol';

import { PARTY_BY_ID } from '../assets/manifest';
import { FRAME, PLAQUE } from './BoardArtwork';
import { SLOT_GEOMETRY, SLOT_ORDINALS, describeSlot, type ZoneSummary } from '../app/table';

import {
  FIRST_SLOT_ID,
  slotAtZoneEdge,
  slotInAdjacentZone,
  slotInDirection,
  type BoardDirection,
} from './boardNavigation';

const BOARD = CORE_BOARD;
const WIDTH = 1000;
const HEIGHT = BOARD.art.aspectRatio * WIDTH;

function toDrawing(x: number, y: number): { x: number; y: number } {
  return { x: x * WIDTH, y: y * HEIGHT };
}

/**
 * Width divided by height of the board, read from the content pack's own viewBox.
 *
 * The layout needs this to size the board's frame to the drawing rather than to the
 * column, and hard-coding it in a stylesheet would put a second copy of a content-pack
 * measurement somewhere nothing would ever update it.
 */
export const BOARD_VIEW_RATIO: number = (() => {
  const [, , width, height] = BOARD.art.viewBox.split(/\s+/).map(Number);
  return width !== undefined && height !== undefined && height > 0 ? width / height : 1;
})();

/** Keeps a long name inside the plaque. The zone list always shows it in full. */
function shortName(displayName: string): string {
  const upper = displayName.toUpperCase();
  return upper.length > 11 ? `${upper.slice(0, 10)}…` : upper;
}

const ARROW_KEYS: Readonly<Record<string, BoardDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export interface TableBoardProps {
  zones: readonly PublicZoneView[];
  slots: readonly PublicSlotView[];
  players: readonly PublicPlayerView[];
  summaries: readonly ZoneSummary[];
  /** The area the player is inspecting, or `null`. */
  selectedSlotId: string | null;
  onSelectSlot: (slotId: string | null) => void;
  /**
   * Areas a pending action may legally use. Empty means no action is being composed;
   * it never means "every area is legal".
   */
  highlightedSlotIds?: ReadonlySet<string>;
  /** What the highlight means, named on the board so a highlight is never a mystery. */
  highlightLabel?: string;
}

export function TableBoard({
  zones,
  slots,
  players,
  summaries,
  selectedSlotId,
  onSelectSlot,
  highlightedSlotIds,
  highlightLabel,
}: TableBoardProps) {
  // The roving tab stop. It follows the selection when there is one so that clicking an
  // area and then using the arrow keys continues from where the player is looking.
  const [focusSlotId, setFocusSlotId] = useState<string>(selectedSlotId ?? FIRST_SLOT_ID);
  const moveRequested = useRef(false);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (selectedSlotId !== null) setFocusSlotId(selectedSlotId);
  }, [selectedSlotId]);

  // Focus follows a keyboard move, and only a keyboard move: taking focus on any other
  // render would drag the page to the board while the player is using another panel.
  useEffect(() => {
    if (!moveRequested.current) return;
    moveRequested.current = false;
    const target = svg.current?.querySelector<SVGGElement>(`[data-slot-id="${CSS.escape(focusSlotId)}"]`);
    target?.focus();
  }, [focusSlotId]);

  const moveTo = useCallback((slotId: string | null) => {
    if (slotId === null) return;
    moveRequested.current = true;
    setFocusSlotId(slotId);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>, slotId: string) => {
      const direction = ARROW_KEYS[event.key];
      if (direction !== undefined) {
        event.preventDefault();
        moveTo(slotInDirection(slotId, direction));
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        moveTo(slotAtZoneEdge(slotId, event.key === 'Home' ? 'first' : 'last'));
        return;
      }
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        moveTo(slotInAdjacentZone(slotId, event.key === 'PageDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelectSlot(slotId === selectedSlotId ? null : slotId);
      }
    },
    [moveTo, onSelectSlot, selectedSlotId],
  );

  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const highlighted = highlightedSlotIds ?? new Set<string>();

  return (
    <svg
      ref={svg}
      className="board board--live"
      viewBox={BOARD.art.viewBox}
      role="group"
      aria-label={
        `Board: ${zones.length} zones and ${slots.length} voter areas. `
        + 'Use the arrow keys to move between areas, Page Up and Page Down to change zone, '
        + 'and Enter to inspect one.'
      }
      preserveAspectRatio="xMidYMid meet"
    >
      <rect className="board__sea" x={FRAME.x} y={FRAME.y} width={FRAME.width} height={FRAME.height} rx={28} />
      <g className="board__zones">
        {BOARD.zones.map((zone) => (
          <path key={zone.id} className="board__zone" d={zone.path} />
        ))}
      </g>

      <g className="board__slots">
        {slots.map((slot) => {
          const geometry = SLOT_GEOMETRY.get(slot.slotId);
          if (geometry === undefined) return null;
          const at = toDrawing(geometry.position.x, geometry.position.y);
          const radius = geometry.radius * WIDTH;
          const hit = geometry.hitRadius * WIDTH;
          const party = slot.voter === undefined ? undefined : PARTY_BY_ID.get(
            players.find((player) => player.id === slot.voter?.ownerId)?.partyId ?? '',
          );
          const selected = slot.slotId === selectedSlotId;
          const legal = highlighted.has(slot.slotId);
          const classes = ['board__area'];
          if (selected) classes.push('board__area--selected');
          if (legal) classes.push('board__area--legal');
          return (
            <g
              key={slot.slotId}
              className={classes.join(' ')}
              data-slot-id={slot.slotId}
              role="button"
              tabIndex={slot.slotId === focusSlotId ? 0 : -1}
              aria-pressed={selected}
              aria-label={
                describeSlot(slot, zoneById.get(slot.zoneId), players)
                + (legal && highlightLabel !== undefined ? ` Legal target: ${highlightLabel}.` : '')
              }
              onKeyDown={(event) => onKeyDown(event, slot.slotId)}
              onFocus={() => setFocusSlotId(slot.slotId)}
              onClick={() => onSelectSlot(selected ? null : slot.slotId)}
            >
              {/* The hit area is invisible and larger than the drawn dot. */}
              <circle className="board__hit" cx={at.x} cy={at.y} r={hit} />
              <circle
                className={slot.voter === undefined ? 'board__slot' : 'board__slot board__slot--taken'}
                cx={at.x}
                cy={at.y}
                r={radius}
                style={party === undefined ? undefined : { fill: party.color }}
              />
              {party === undefined ? null : (
                <image
                  className="board__token"
                  href={party.url}
                  x={at.x - radius * 0.78}
                  y={at.y - radius * 0.78}
                  width={radius * 1.56}
                  height={radius * 1.56}
                  preserveAspectRatio="xMidYMid meet"
                />
              )}
              {slot.voter?.majority === true ? (
                <>
                  <circle className="board__majority-ring" cx={at.x} cy={at.y} r={radius + 4} />
                  <path
                    className="board__majority-tick"
                    d={`M${at.x + radius - 1} ${at.y - radius - 5}l4 8 8-13`}
                  />
                </>
              ) : null}
              {slot.volatile ? (
                <circle className="board__slot-volatile" cx={at.x} cy={at.y} r={radius + 8} />
              ) : null}
              {legal ? (
                <circle className="board__legal-ring" cx={at.x} cy={at.y} r={radius + 12} />
              ) : null}
              {selected ? (
                <circle className="board__selected-ring" cx={at.x} cy={at.y} r={radius + 14} />
              ) : null}
            </g>
          );
        })}
      </g>

      <g className="board__labels" aria-hidden="true">
        {BOARD.zones.map((zone) => {
          const at = toDrawing(zone.label.x, zone.label.y);
          const summary = summaryById.get(zone.id);
          const leader = summary?.majorityOwner ?? null;
          const leaderParty = leader === null ? undefined : PARTY_BY_ID.get(leader.partyId);
          return (
            <g key={zone.id} transform={`translate(${at.x} ${at.y})`}>
              {/* One plaque, one size, whatever the zone. The map reserves exactly this
                  rectangle inside every district, so a plaque that grew when a majority
                  arrived would start covering voter areas - which is exactly where a
                  label must not be. The holder is named in the zone list and in the
                  roster; here it is the party's own emblem. */}
              <path className="board__plaque" d={PLAQUE} />
              <text className="board__plaque-name" y={-7}>
                {shortName(zone.displayName)}
              </text>
              <text className="board__plaque-count" x={-4} y={17}>
                {summary === undefined ? '—' : `${summary.filled}/${zone.capacity}`}
              </text>
              <text className="board__plaque-need" x={4} y={17}>
                NEED {zone.majorityThreshold}
              </text>
              {leaderParty === undefined || leader === null ? null : (
                <image
                  className="board__plaque-holder"
                  href={leaderParty.url}
                  x={-58}
                  y={-20}
                  width={16}
                  height={16}
                  preserveAspectRatio="xMidYMid meet"
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Zone name and area number for a slot, for a caption outside the board. */
export function slotLabel(slotId: string, zones: readonly PublicZoneView[]): string {
  const geometry = BOARD.slots.find((slot) => slot.slotId === slotId);
  if (geometry === undefined) return slotId;
  const zone = zones.find((candidate) => candidate.id === geometry.zoneId);
  return `${zone?.displayName ?? geometry.zoneId}, area ${SLOT_ORDINALS.get(slotId) ?? '?'}`;
}
