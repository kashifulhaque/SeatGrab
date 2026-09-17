import { RESOURCE_TYPES, type Cost, type ResourceVector } from '@gerrymander/content';
import type { PaymentDto } from '@gerrymander/protocol';
import { resourceEntries, resourceTotal, type GameState, type PlayerState } from '../model/state.js';

export type PaymentValidation =
  | { ok: true; discountsUsed: number }
  | { ok: false; message: string };

export function validatePayment(
  player: PlayerState,
  cost: Cost,
  payment: PaymentDto,
  maximumDiscount = 0,
): PaymentValidation {
  const discounts = payment.discounts ?? { cash: 0, influence: 0, press: 0, faith: 0 };
  const discountsUsed = resourceTotal(discounts);
  if (discountsUsed > maximumDiscount) {
    return { ok: false, message: 'Payment uses more discount than is available.' };
  }
  const printedTotal = cost.cash + cost.influence + cost.press + cost.faith + cost.generic;
  if (resourceTotal(payment.resources) + discountsUsed !== printedTotal) {
    return { ok: false, message: 'Payment and discount total do not match the printed cost.' };
  }
  let genericCovered = 0;
  for (const resource of RESOURCE_TYPES) {
    const offered = payment.resources[resource];
    const discounted = discounts[resource];
    if (!Number.isSafeInteger(offered) || !Number.isSafeInteger(discounted) || discounted < 0) {
      return { ok: false, message: `Payment contains an invalid ${resource} amount.` };
    }
    const covered = offered + discounted;
    if (covered < cost[resource]) {
      return { ok: false, message: `Payment does not cover required ${resource}.` };
    }
    if (offered > player.resources[resource]) {
      return { ok: false, message: `Player does not hold enough ${resource}.` };
    }
    genericCovered += covered - cost[resource];
  }
  return genericCovered === cost.generic
    ? { ok: true, discountsUsed }
    : { ok: false, message: 'Payment does not allocate the generic cost exactly.' };
}

export function spendToReserve(state: GameState, player: PlayerState, payment: ResourceVector): PlayerState[] {
  const interceptors = new Map<string, PlayerState>();
  for (const [resource, amount] of resourceEntries(payment)) {
    player.resources[resource] -= amount;
    const interception = state.activeEffects.find(
      (effect) => effect.kind === 'skimming'
        && effect.targetPlayerIds.includes(player.id)
        && effect.data.resource === resource,
    );
    const interceptor = state.players.find((candidate) => candidate.id === interception?.ownerId);
    if (interceptor === undefined) {
      state.publicReserve[resource] += amount;
    } else {
      interceptor.resources[resource] += amount;
      interceptors.set(interceptor.id, interceptor);
    }
  }
  return [...interceptors.values()];
}

export function returnToReserve(state: GameState, player: PlayerState, resources: ResourceVector): void {
  for (const [resource, amount] of resourceEntries(resources)) {
    player.resources[resource] -= amount;
    state.publicReserve[resource] += amount;
  }
}

/** Apply the finite-reserve policy: fixed grants may be partially fulfilled per type. */
export function grantFromReserve(state: GameState, player: PlayerState, requested: ResourceVector): ResourceVector {
  const granted: ResourceVector = { cash: 0, influence: 0, press: 0, faith: 0 };
  for (const [resource, amount] of resourceEntries(requested)) {
    const actual = Math.min(amount, state.publicReserve[resource]);
    state.publicReserve[resource] -= actual;
    player.resources[resource] += actual;
    granted[resource] = actual;
  }
  return granted;
}
