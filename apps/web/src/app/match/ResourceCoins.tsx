/**
 * The revealed seat's four resources as coins, in the top bar.
 *
 * Paying for something should be visible in the bar that says what you hold, so each
 * count is keyed on its figure — a change mounts a fresh node and the stylesheet's pop
 * plays — and a floating delta ("+2", "−3") rises out of the coin and fades. The delta is
 * computed from the previous render, so it says what just happened rather than what the
 * projection says now; the count says that.
 *
 * Privacy: the caller passes the revealed seat and nothing else. Resource counts are
 * public — the seats strip shows every seat's — but this list is labelled as "yours", so
 * it must never carry another seat's figures. `match-shell.test.tsx` asserts both the
 * `aria-label` and the "Cash 7" text pattern.
 */
import { useEffect, useRef, useState } from 'react';

import type { PublicPlayerView, ResourceVectorDto } from '@gerrymander/protocol';

import { RESOURCE_ASSETS } from '../../assets/manifest';

const RESOURCE_ORDER = ['cash', 'influence', 'press', 'faith'] as const;

interface Delta {
  resource: (typeof RESOURCE_ORDER)[number];
  amount: number;
  /** Fresh on every change, so the same delta twice still remounts and replays. */
  tick: number;
}

export function ResourceCoins({ me }: { me: PublicPlayerView }) {
  const previous = useRef<{ seatId: string; resources: ResourceVectorDto } | null>(null);
  const [deltas, setDeltas] = useState<readonly Delta[]>([]);
  const tick = useRef(0);

  useEffect(() => {
    const was = previous.current;
    previous.current = { seatId: me.id, resources: me.resources };
    // A different seat is a different "you"; nothing changed hands.
    if (was === null || was.seatId !== me.id) return;
    const changed = RESOURCE_ORDER.flatMap((resource) => {
      const amount = me.resources[resource] - was.resources[resource];
      if (amount === 0) return [];
      tick.current += 1;
      return [{ resource, amount, tick: tick.current }];
    });
    if (changed.length === 0) return;
    setDeltas(changed);
    const timer = setTimeout(() => setDeltas([]), 1400);
    return () => clearTimeout(timer);
  }, [me]);

  const total = me.resources.cash + me.resources.influence + me.resources.press + me.resources.faith;
  const over = total > me.resourceCap;

  return (
    <ul className="status-bar__resources ms-coins" aria-label={`${me.displayName}’s resources`}>
      {RESOURCE_ORDER.map((resource) => {
        const delta = deltas.find((entry) => entry.resource === resource);
        return (
          <li key={resource} className={`ms-coin ms-coin--${resource}`}>
            <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={20} height={20} />
            <span className="visually-hidden">{RESOURCE_ASSETS[resource].label} </span>
            <span
              key={`n${me.resources[resource]}`}
              className={`ms-coin__count${delta === undefined ? '' : ' ms-coin__count--changed'}`}
            >
              {me.resources[resource]}
            </span>
            {delta === undefined ? null : (
              <span
                key={`d${delta.tick}`}
                className={`ms-coin__delta ${delta.amount > 0 ? 'ms-coin__delta--up' : 'ms-coin__delta--down'}`}
                aria-hidden="true"
              >
                {delta.amount > 0 ? `+${delta.amount}` : `−${Math.abs(delta.amount)}`}
              </span>
            )}
          </li>
        );
      })}
      <li
        className={`ms-coins__cap${over ? ' ms-coins__cap--over' : ''}`}
        title="Resources held, of the most you may hold"
      >
        <span className="visually-hidden">Held </span>
        {total}
        <span className="ms-coins__cap-of">/{me.resourceCap}</span>
      </li>
    </ul>
  );
}
