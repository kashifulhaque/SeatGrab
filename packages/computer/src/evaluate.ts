/**
 * A static evaluation of a projection from one seat's point of view, and the projected
 * outcomes the policies score against it.
 *
 * `evaluate` is a number, higher is better for the seat. Every term reads the public
 * projection plus the seat's own private fields, so it can be asked about any seat at the
 * table from any seat's view. The projections below (`afterPlacement`, `afterMove`,
 * `afterRemoval`, `afterConversion`, `afterResources`) are approximations of what the
 * engine would do, good enough to rank candidates; they never replace `applyCommand`.
 *
 * The constants are the tunable part and live in one place. Record the first tournament's
 * figures before touching them.
 */
import { ARCHETYPES } from '@gerrymander/content';
import type { PlayerView, PublicSlotView, PublicZoneView, ResourceVectorDto } from '@gerrymander/protocol';
import { RESOURCE_ORDER, effectivePolicyCounts, passiveIncome, totalOf } from '@gerrymander/seat';

export const WEIGHTS = {
  /** Points already locked in a zone this seat holds, per threshold voter. */
  locked: 1,
  /** Points locked by a rival, per threshold voter. */
  rivalLocked: 0.5,
  /** An undecided zone this seat can still win, scaled by how far along it is. */
  potential: 0.6,
  /** An undecided zone where a rival is within two voters of the threshold. */
  threat: 0.4,
  /** Redistricting rights in a zone. */
  rights: 1.5,
  /** Each held resource up to the cap. */
  resource: 0.25,
  /** Each held resource over the cap, which the cap phase discards. */
  overCap: 1,
  /** Each unit of passive income. */
  income: 0.5,
  /** A track sitting one card from a power. */
  nearPower: 1,
  /** Each trick card in hand. */
  trick: 1,
} as const;

/** Empty areas of a zone, from the slot table. */
export function emptySlotsIn(view: PlayerView, zoneId: string): number {
  return view.slots.filter((slot) => slot.zoneId === zoneId && slot.voter === undefined).length;
}

/** The largest count any seat other than `seatId` holds in a zone. */
export function rivalMax(zone: PublicZoneView, seatId: string): number {
  return Math.max(0, ...Object.entries(zone.counts)
    .filter(([ownerId]) => ownerId !== seatId)
    .map(([, count]) => count));
}

export function evaluate(view: PlayerView, seatId: string): number {
  const me = view.players.find((player) => player.id === seatId);
  if (me === undefined) return 0;
  let score = 0;

  for (const zone of view.zones) {
    const threshold = zone.majorityThreshold;
    const mine = zone.counts[seatId] ?? 0;
    if (zone.majorityOwnerId === seatId) {
      score += WEIGHTS.locked * threshold;
    } else if (zone.majorityOwnerId !== undefined) {
      score -= WEIGHTS.rivalLocked * threshold;
    } else {
      if (mine + emptySlotsIn(view, zone.id) >= threshold) {
        score += WEIGHTS.potential * threshold * (mine / threshold) ** 2;
      }
      if (rivalMax(zone, seatId) >= threshold - 2) {
        score -= WEIGHTS.threat * threshold;
      }
    }
    if (zone.rightsOwnerId === seatId) score += WEIGHTS.rights;
  }

  const held = totalOf(me.resources);
  score += WEIGHTS.resource * Math.min(held, me.resourceCap);
  score -= WEIGHTS.overCap * Math.max(0, held - me.resourceCap);

  score += WEIGHTS.income * totalOf(passiveIncome(view, seatId));
  const counts = effectivePolicyCounts(view, seatId);
  for (const archetype of ARCHETYPES) {
    if (counts[archetype] === 2 || counts[archetype] === 4) score += WEIGHTS.nearPower;
  }

  const hand = view.privateTrickIds !== undefined && view.players.some((player) => player.id === seatId)
    && isOwnView(view, seatId)
    ? view.privateTrickIds.length
    : me.trickHandCount;
  score += WEIGHTS.trick * hand;

  return score;
}

/**
 * Whether this view is the seat's own projection.
 *
 * The public fields are the same in every projection, so the only difference the
 * evaluator cares about is whether the private hand is this seat's. A view that carries a
 * private supply figure carries it for exactly one seat, and `trickHandCount` agrees with
 * `privateTrickIds` for that seat; for any other seat the public count is the truth.
 */
function isOwnView(view: PlayerView, seatId: string): boolean {
  const me = view.players.find((player) => player.id === seatId);
  return me !== undefined && view.privateTrickIds !== undefined
    && view.privateTrickIds.length === me.trickHandCount;
}

/** Every seat's evaluation from this view, best first. */
export function standings(view: PlayerView): readonly { seatId: string; value: number }[] {
  return view.players
    .map((player) => ({ seatId: player.id, value: evaluate(view, player.id) }))
    .sort((left, right) => right.value - left.value || left.seatId.localeCompare(right.seatId));
}

/** The rival with the highest evaluation, or `null` at a table of one. */
export function leadingRivalId(view: PlayerView, seatId: string): string | null {
  return standings(view).find((entry) => entry.seatId !== seatId)?.seatId ?? null;
}

/** True when no rival evaluates higher than this seat. */
export function leads(view: PlayerView, seatId: string): boolean {
  const mine = evaluate(view, seatId);
  return view.players.every((player) => player.id === seatId || evaluate(view, player.id) <= mine);
}

/* ------------------------------------------------------------- projections */

/**
 * Rebuild every zone's counts, rights and majority from a slot table.
 *
 * Rights go to the seat with strictly the most voters. A majority already held stays held;
 * an undecided zone becomes held by the first seat whose count reaches the threshold,
 * which is what `reconcileMajorities` does before it asks which voters to mark.
 */
function recompute(view: PlayerView, slots: readonly PublicSlotView[]): PlayerView {
  const zones = view.zones.map((zone) => {
    const counts: Record<string, number> = {};
    for (const slot of slots) {
      if (slot.zoneId !== zone.id || slot.voter === undefined) continue;
      counts[slot.voter.ownerId] = (counts[slot.voter.ownerId] ?? 0) + 1;
    }
    const ranked = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    const top = ranked[0];
    const second = ranked[1];
    const rightsOwnerId = top !== undefined && top[1] > 0 && (second === undefined || second[1] < top[1])
      ? top[0]
      : undefined;
    const majorityOwnerId = zone.majorityOwnerId
      ?? ranked.find(([, count]) => count >= zone.majorityThreshold)?.[0];
    const projected: PublicZoneView = {
      id: zone.id,
      displayName: zone.displayName,
      capacity: zone.capacity,
      majorityThreshold: zone.majorityThreshold,
      counts,
    };
    if (rightsOwnerId !== undefined) projected.rightsOwnerId = rightsOwnerId;
    if (majorityOwnerId !== undefined) projected.majorityOwnerId = majorityOwnerId;
    return projected;
  });
  return { ...view, zones, slots };
}

/** The view after this seat places a voter on each of `slotIds`. */
export function afterPlacement(view: PlayerView, seatId: string, slotIds: readonly string[]): PlayerView {
  const wanted = new Set(slotIds);
  return recompute(view, view.slots.map((slot) =>
    wanted.has(slot.slotId) && slot.voter === undefined
      ? { ...slot, voter: { id: `projected-${slot.slotId}`, ownerId: seatId, majority: false } }
      : slot));
}

/** The view after one voter moves to an empty area. */
export function afterMove(view: PlayerView, voterId: string, destinationSlotId: string): PlayerView {
  const source = view.slots.find((slot) => slot.voter?.id === voterId);
  if (source?.voter === undefined) return view;
  const voter = source.voter;
  return recompute(view, view.slots.map((slot) => {
    if (slot.slotId === source.slotId) {
      const { voter: _moved, ...emptied } = slot;
      return emptied;
    }
    if (slot.slotId === destinationSlotId && slot.voter === undefined) return { ...slot, voter };
    return slot;
  }));
}

/** The view after these voters leave the board. */
export function afterRemoval(view: PlayerView, voterIds: readonly string[]): PlayerView {
  const wanted = new Set(voterIds);
  return recompute(view, view.slots.map((slot) => {
    if (slot.voter === undefined || !wanted.has(slot.voter.id)) return slot;
    const { voter: _removed, ...emptied } = slot;
    return emptied;
  }));
}

/** The view after these voters become this seat's, standing where they are. */
export function afterConversion(view: PlayerView, seatId: string, voterIds: readonly string[]): PlayerView {
  const wanted = new Set(voterIds);
  return recompute(view, view.slots.map((slot) =>
    slot.voter !== undefined && wanted.has(slot.voter.id)
      ? { ...slot, voter: { ...slot.voter, ownerId: seatId, majority: false } }
      : slot));
}

/** The view after this seat's holdings change by `delta`, never below zero. */
export function afterResources(view: PlayerView, seatId: string, delta: ResourceVectorDto): PlayerView {
  return {
    ...view,
    players: view.players.map((player) => {
      if (player.id !== seatId) return player;
      const resources = { ...player.resources };
      for (const resource of RESOURCE_ORDER) {
        resources[resource] = Math.max(0, resources[resource] + delta[resource]);
      }
      return { ...player, resources };
    }),
  };
}

/** `-vector`, for paying a price through `afterResources`. */
export function negate(vector: ResourceVectorDto): ResourceVectorDto {
  return {
    cash: -vector.cash,
    influence: -vector.influence,
    press: -vector.press,
    faith: -vector.faith,
  };
}

/** How much better `projected` is than `view` for this seat. */
export function gain(view: PlayerView, seatId: string, projected: PlayerView): number {
  return evaluate(projected, seatId) - evaluate(view, seatId);
}
