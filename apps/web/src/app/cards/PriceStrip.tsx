/**
 * A printed price as a row of coins, one per unit.
 *
 * The coins are the manifest's resource discs, with the pale `?` disc for a wildcard
 * unit, in the order the resources are always listed. The strip is decorative: whoever
 * draws it also says the price in words, through `costToText`.
 */
import type { Cost } from '@gerrymander/content';

import { RESOURCE_ASSETS, type CostIconId } from '../../assets/manifest';

import './cards.css';

const PRICE_ORDER: readonly CostIconId[] = ['cash', 'influence', 'press', 'faith', 'generic'];

export function PriceStrip({ cost, size = 18 }: { cost: Cost; size?: number }) {
  return (
    <span className="card-price" aria-hidden="true">
      {PRICE_ORDER.flatMap((id) =>
        Array.from({ length: cost[id] }, (_unused, index) => (
          <img
            key={`${id}-${index}`}
            className="card-price__coin"
            src={RESOURCE_ASSETS[id].url}
            alt=""
            width={size}
            height={size}
          />
        )))}
    </span>
  );
}
