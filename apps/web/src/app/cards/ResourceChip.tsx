/**
 * A resource as a coin.
 *
 * `ResourceChip` is one disc — the manifest icon on its coloured ground — with an
 * optional count badge. `ResourceStack` is the four of them in a row, which is how a
 * holding reads on a mat or a prompt. The badge number is keyed on its value so that a
 * change remounts it and the bump animation plays again; the text equivalent is always
 * in the DOM, so a screen reader hears the same figure the badge shows.
 */
import { RESOURCE_TYPES } from '@gerrymander/content';
import type { ResourceVectorDto } from '@gerrymander/protocol';

import { RESOURCE_ASSETS, type CostIconId } from '../../assets/manifest';

import './cards.css';

export type ChipSize = 'sm' | 'md' | 'lg';

const CHIP_PX: Record<ChipSize, number> = { sm: 22, md: 32, lg: 44 };

export function ResourceChip({
  resource,
  count,
  size = 'md',
  /** Draws the disc as an empty outline, for a coin not yet taken. */
  hollow = false,
  /** A text equivalent; defaults to the count and the resource name. */
  label,
  className,
}: {
  resource: CostIconId;
  count?: number;
  size?: ChipSize;
  hollow?: boolean;
  label?: string;
  className?: string;
}) {
  const asset = RESOURCE_ASSETS[resource];
  const px = CHIP_PX[size];
  const text = label ?? (count === undefined ? asset.label : `${count} ${asset.label}`);
  return (
    <span
      className={[
        'card-chip',
        `card-chip--${size}`,
        hollow ? 'card-chip--hollow' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      role="img"
      aria-label={text}
      style={{ width: px, height: px }}
    >
      {hollow ? null : <img src={asset.url} alt="" aria-hidden="true" width={px} height={px} />}
      {count === undefined ? null : (
        <span key={count} className="card-chip__count" aria-hidden="true">
          {count}
        </span>
      )}
    </span>
  );
}

/** The four resources in a row, each with its count. Zero counts stay visible but faded. */
export function ResourceStack({
  resources,
  size = 'md',
  label = 'Resources',
  className,
}: {
  resources: ResourceVectorDto;
  size?: ChipSize;
  label?: string;
  className?: string;
}) {
  const text = RESOURCE_TYPES.map((type) => `${RESOURCE_ASSETS[type].label} ${resources[type]}`).join(', ');
  return (
    <span
      className={className === undefined ? 'card-stack' : `card-stack ${className}`}
      role="group"
      aria-label={`${label}: ${text}`}
    >
      {RESOURCE_TYPES.map((type) => (
        <span key={type} className={`card-stack__item${resources[type] === 0 ? ' card-stack__item--none' : ''}`}>
          <ResourceChip resource={type} count={resources[type]} size={size} label="" />
        </span>
      ))}
    </span>
  );
}
