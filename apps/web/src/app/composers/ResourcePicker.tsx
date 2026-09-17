/**
 * Allocating resources by type, which almost every command in the game needs.
 *
 * A printed price is not one number. It names some resources exactly and leaves the `?`
 * icons to the payer, so the control is one counter per resource type the price can be
 * paid in, and the payer sees what they hold beside what they are spending.
 *
 * Each row is the resource as a coin, with the count held as its badge, and a stepper of
 * two round 44px buttons around the amount. A stepper rather than a number field is
 * reachable from the keyboard, comfortably tappable and cannot be left holding text that
 * is not a number. The amount is keyed on its value so a change remounts it and the bump
 * plays again.
 *
 * `rows` narrows the four counters to the types a price names, and carries the shortfall
 * for each one so it is drawn beside the counter that is short. Which types those are,
 * and what is short, is decided by `paymentBreakdown` in `actions.ts`; this component
 * only draws what it is handed.
 */
import { RESOURCE_TYPES, type ResourceType } from '@gerrymander/content';
import type { ResourceVectorDto } from '@gerrymander/protocol';

import { RESOURCE_ASSETS } from '../../assets/manifest';
import { ResourceChip } from '../cards/ResourceChip';

import '../cards/cards.css';

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
    <fieldset className="card-picker" disabled={disabled}>
      <legend>{legend}</legend>
      {hint === undefined ? null : <p className="hint">{hint}</p>}
      {drawn.length === 0 ? <p className="field-problem">You hold nothing to pay with.</p> : null}
      <ul className="card-picker__rows">
        {drawn.map((row) => {
          const asset = RESOURCE_ASSETS[row.resource];
          const amount = value[row.resource];
          const problem = row.problem ?? null;
          const heldCount = held === undefined ? undefined : held[row.resource];
          const notes = [row.note, heldCount === undefined ? null : `${heldLabel} ${heldCount}`]
            .filter((part) => part !== null && part !== undefined);
          return (
            <li key={row.resource} className={`card-picker__row${problem === null ? '' : ' card-picker__row--problem'}`}>
              <ResourceChip
                resource={row.resource}
                size="md"
                {...(heldCount === undefined ? {} : { count: heldCount })}
                label={heldCount === undefined ? asset.label : `${asset.label}, ${heldLabel} ${heldCount}`}
              />
              <span className="card-picker__label">
                <span className="card-picker__name">{asset.label}</span>
                {notes.length === 0 ? null : (
                  <span className="card-picker__note">{notes.join(' · ')}</span>
                )}
              </span>
              <span className="card-picker__stepper">
                <button
                  type="button"
                  className="card-picker__step"
                  aria-label={`One less ${asset.label}`}
                  disabled={amount <= 0}
                  onClick={() => onChange(row.resource, amount - 1)}
                >
                  −
                </button>
                <output key={amount} className="card-picker__amount" aria-label={`${asset.label} allocated`}>
                  {amount}
                </output>
                <button
                  type="button"
                  className="card-picker__step"
                  aria-label={`One more ${asset.label}`}
                  onClick={() => onChange(row.resource, amount + 1)}
                >
                  +
                </button>
              </span>
              {problem === null ? null : (
                <span className="field-problem card-picker__problem" role="status">{problem}</span>
              )}
            </li>
          );
        })}
      </ul>
      {footer === undefined ? null : (
        <p className={footer.problem ? 'field-problem' : 'card-picker__footer'} role="status">
          {footer.text}
        </p>
      )}
    </fieldset>
  );
}
