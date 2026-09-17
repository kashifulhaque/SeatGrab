/**
 * A row of coin outlines that fill as resources are chosen.
 *
 * The starting-resource quota and the cap discard are both "take exactly N": a player
 * sees N empty rings, and each resource they pick drops a coin into the next ring. A pick
 * past N is drawn outside the rings in the problem colour rather than hidden, because the
 * engine will refuse it and the player should see why before pressing Submit.
 */
import { RESOURCE_TYPES } from '@gerrymander/content';
import type { ResourceVectorDto } from '@gerrymander/protocol';

import { ResourceChip, type ChipSize } from './ResourceChip';

import './cards.css';

export function CoinSlots({
  slots,
  filled,
  size = 'md',
  label,
}: {
  /** How many coins the prompt asks for. */
  slots: number;
  /** What has been chosen so far. */
  filled: ResourceVectorDto;
  size?: ChipSize;
  /** The group's accessible name, for example `Starting resources`. */
  label: string;
}) {
  const coins = RESOURCE_TYPES.flatMap((type) =>
    Array.from({ length: filled[type] }, (_unused, index) => ({ type, key: `${type}-${index}` })));
  const total = coins.length;
  const empty = Math.max(0, slots - total);
  return (
    <span
      className="card-coins"
      role="group"
      aria-label={`${label}: ${total} of ${slots} chosen`}
    >
      {coins.map((coin, index) => (
        <span
          key={coin.key}
          className={`card-coins__slot card-coins__slot--filled${index >= slots ? ' card-coins__slot--over' : ''}`}
          style={{ '--card-index': index } as React.CSSProperties}
        >
          <ResourceChip resource={coin.type} size={size} />
        </span>
      ))}
      {Array.from({ length: empty }, (_unused, index) => (
        <span key={`empty-${index}`} className="card-coins__slot">
          <ResourceChip resource="generic" size={size} hollow label="empty" />
        </span>
      ))}
    </span>
  );
}
