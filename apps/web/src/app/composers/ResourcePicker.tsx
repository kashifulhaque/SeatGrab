/**
 * Allocating resources by type, which almost every command in the game needs.
 *
 * A printed price is not one number. It names some resources exactly and leaves the `?`
 * icons to the payer, so the control is one counter per resource type the price can be
 * paid in, and the payer sees what they hold beside what they are spending.
 *
 * Each counter is a pair of buttons rather than a number field: a stepper is reachable
 * from the keyboard, is comfortably tappable at the 44px section 13.10 asks for, and
 * cannot be left holding text that is not a number.
 *
 * `rows` narrows the four counters to the types a price names, and carries the shortfall
 * for each one so it is drawn beside the counter that is short. Which types those are,
 * and what is short, is decided by `paymentBreakdown` in `actions.ts`; this component
 * only draws what it is handed.
 */
import { RESOURCE_TYPES, type ResourceType } from '@gerrymander/content';
import type { ResourceVectorDto } from '@gerrymander/protocol';

import { RESOURCE_ASSETS } from '../../assets/manifest';

export interface PickerRow {
  resource: ResourceType;
  /** Written under the type name: `needs 2`, `the reserve has 4`. */
  note?: string;
  /** Drawn beside the counter in the problem colour. */
  problem?: string | null;
}

export function ResourcePicker({
  legend,
  hint,
  value,
  held,
  heldLabel = 'you hold',
  rows,
  footer,
  onChange,
  disabled = false,
}: {
  legend: string;
  hint?: string;
  value: ResourceVectorDto;
  /** What the seat has, shown beside each counter. Omitted when it is not a payment. */
  held?: ResourceVectorDto;
  /** What `held` is a count of, when it is not the seat's own hand. */
  heldLabel?: string;
  /** The types to draw, with their notes and problems. Omitted draws all four. */
  rows?: readonly PickerRow[];
  /** A line under the counters: the running `?` figure, or a total. */
  footer?: { text: string; problem: boolean };
  onChange: (resource: ResourceType, amount: number) => void;
  disabled?: boolean;
}) {
  const drawn: readonly PickerRow[] = rows ?? RESOURCE_TYPES.map((resource) => ({ resource }));
  return (
    <fieldset className="picker" disabled={disabled}>
      <legend>{legend}</legend>
      {hint === undefined ? null : <p className="hint">{hint}</p>}
      {drawn.length === 0 ? <p className="field-problem">You hold nothing to pay with.</p> : null}
      <ul className="picker__rows">
        {drawn.map((row) => {
          const asset = RESOURCE_ASSETS[row.resource];
          const amount = value[row.resource];
          const problem = row.problem ?? null;
          return (
            <li key={row.resource} className={`picker__row${problem === null ? '' : ' picker__row--problem'}`}>
              <span className="picker__label">
                <img src={asset.url} alt="" aria-hidden="true" width={22} height={22} />
                <span>
                  {asset.label}
                  {held === undefined && row.note === undefined ? null : (
                    <span className="small">
                      {' '}
                      {[row.note, held === undefined ? null : `${heldLabel} ${held[row.resource]}`]
                        .filter((part) => part !== null && part !== undefined)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              </span>
              <span className="picker__stepper">
                <button
                  type="button"
                  className="button button--quiet picker__step"
                  aria-label={`One less ${asset.label}`}
                  disabled={amount <= 0}
                  onClick={() => onChange(row.resource, amount - 1)}
                >
                  −
                </button>
                <output className="picker__amount" aria-label={`${asset.label} allocated`}>
                  {amount}
                </output>
                <button
                  type="button"
                  className="button button--quiet picker__step"
                  aria-label={`One more ${asset.label}`}
                  onClick={() => onChange(row.resource, amount + 1)}
                >
                  +
                </button>
              </span>
              {problem === null ? null : (
                <span className="field-problem picker__problem" role="status">{problem}</span>
              )}
            </li>
          );
        })}
      </ul>
      {footer === undefined ? null : (
        <p className={footer.problem ? 'field-problem' : 'picker__footer'} role="status">
          {footer.text}
        </p>
      )}
    </fieldset>
  );
}
