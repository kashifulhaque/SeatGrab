/**
 * A printed price, drawn with the manifest icons and always spelled out in text.
 *
 * The `?` icon is a wildcard payment, not a fifth resource, so it is labelled as one.
 *
 * This lives beside the production screens rather than with the content review, because
 * the voter market on the table shows the same printed prices. A shared component must
 * never sit inside a development-only directory: `check_build_privacy.mjs` requires
 * every module under `review/` to compile away to nothing.
 */
import { RESOURCE_TYPES } from '@seatgrab/content';
import type { Cost } from '@seatgrab/content';

import { RESOURCE_ASSETS } from '../assets/manifest';
import type { CostIconId } from '../assets/manifest';

const ICON_ORDER: readonly CostIconId[] = [...RESOURCE_TYPES, 'generic'];

export function costToText(cost: Cost): string {
  const parts = ICON_ORDER.filter((id) => cost[id] > 0).map(
    // `5 Any one resource` reads as a typo; the wildcard part is said as a quantity.
    (id) => (id === 'generic' ? `${cost[id]} of any type` : `${cost[id]} ${RESOURCE_ASSETS[id].label}`),
  );
  return parts.length ? parts.join(', ') : 'free';
}

export function CostIcons({ cost }: { cost: Cost }) {
  const text = costToText(cost);
  return (
    <span className="cost" role="img" aria-label={text}>
      {ICON_ORDER.flatMap((id) =>
        Array.from({ length: cost[id] }, (_unused, index) => (
          <img
            key={`${id}-${index}`}
            className="cost__icon"
            src={RESOURCE_ASSETS[id].url}
            alt=""
            aria-hidden="true"
            width={20}
            height={20}
          />
        )),
      )}
      <span className="cost__text">{text}</span>
    </span>
  );
}
