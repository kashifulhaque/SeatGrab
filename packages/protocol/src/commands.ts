import { z } from 'zod';

const id = z.string().min(1);

export const ResourceVectorSchema = z.object({
  cash: z.int().nonnegative(),
  influence: z.int().nonnegative(),
  press: z.int().nonnegative(),
  faith: z.int().nonnegative(),
});
export type ResourceVectorDto = z.infer<typeof ResourceVectorSchema>;

export const PaymentSchema = z.object({
  resources: ResourceVectorSchema,
  discounts: ResourceVectorSchema.optional(),
});
export type PaymentDto = z.infer<typeof PaymentSchema>;

export const ChoiceSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), optionId: id }),
  z.object({ kind: z.literal('players'), playerIds: z.array(id) }),
  z.object({ kind: z.literal('voters'), voterIds: z.array(id) }),
  z.object({ kind: z.literal('slots'), slotIds: z.array(id) }),
  z.object({ kind: z.literal('cards'), cardIds: z.array(id) }),
  z.object({ kind: z.literal('resources'), resources: ResourceVectorSchema }),
  z.object({ kind: z.literal('pass') }),
]);
export type ChoiceSelection = z.infer<typeof ChoiceSelectionSchema>;

export const GameCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('VoteForFirstPlayer'), candidateId: id }),
  z.object({ type: z.literal('ChooseStartingResources'), resources: ResourceVectorSchema }),
  z.object({ type: z.literal('CommitPolicyAnswer'), answerIndex: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ type: z.literal('RedrawPolicy'), payment: PaymentSchema }),
  z.object({
    type: z.literal('InfluenceVoterCard'),
    cardId: id,
    payment: PaymentSchema,
    groundswell: z.boolean().optional(),
  }),
  z.object({ type: z.literal('PlaceVoterGroup'), groupId: id, slotIds: z.array(id).min(1) }),
  z.object({ type: z.literal('ConfirmPendingVoterDiscard'), groupIds: z.array(id).min(1) }),
  z.object({
    type: z.literal('Gerrymander'),
    rightsZoneId: id,
    voterId: id,
    destinationSlotId: id,
    landslideUse: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
  z.object({ type: z.literal('UseProspecting'), payment: ResourceVectorSchema, gain: ResourceVectorSchema }),
  z.object({ type: z.literal('UseDonations'), opponentId: id, resource: z.enum(['cash', 'influence', 'press', 'faith']) }),
  z.object({ type: z.literal('UseBreakingGround'), voterId: id }),
  z.object({ type: z.literal('UsePayback'), voterId: id, payment: ResourceVectorSchema }),
  z.object({ type: z.literal('UseToughLove'), voterIds: z.tuple([id, id]), payment: PaymentSchema }),
  z.object({ type: z.literal('BuyTrick'), payment: PaymentSchema }),
  z.object({ type: z.literal('PlayTrick'), cardId: id, mode: id.optional() }),
  z.object({ type: z.literal('PlayReaction'), cardId: id, targetEffectId: id, mode: id.optional() }),
  z.object({ type: z.literal('PassPriority'), interactionId: id }),
  z.object({
    type: z.literal('ProposeTrade'),
    opponentId: id,
    giveResources: ResourceVectorSchema,
    receiveResources: ResourceVectorSchema,
    giveTrickIds: z.array(id),
    receiveTrickIds: z.array(id),
  }),
  z.object({ type: z.literal('AcceptTrade'), tradeId: id }),
  z.object({ type: z.literal('RejectTrade'), tradeId: id }),
  z.object({ type: z.literal('CancelTrade'), tradeId: id }),
  z.object({ type: z.literal('SubmitChoice'), interactionId: id, selection: ChoiceSelectionSchema }),
  z.object({ type: z.literal('SubmitVote'), interactionId: id, optionId: id }),
  z.object({ type: z.literal('PlaceBid'), interactionId: id, amount: z.int().nonnegative() }),
  z.object({ type: z.literal('PassAuction'), interactionId: id }),
  z.object({ type: z.literal('PayDebt'), debtId: id, payment: ResourceVectorSchema }),
  z.object({ type: z.literal('PayObligation'), obligationId: id, selection: ChoiceSelectionSchema }),
  z.object({ type: z.literal('BuyHeldVoter'), sourceCardId: id, voterId: id, payment: ResourceVectorSchema }),
  z.object({ type: z.literal('StealBase'), sourceCardId: id, voterIds: z.tuple([id, id, id]) }),
  z.object({ type: z.literal('DiscardExcessResources'), resources: ResourceVectorSchema }),
  z.object({ type: z.literal('ReassignJumla'), archetype: z.enum(['corporate', 'nationalist', 'populist', 'reformer']) }),
  z.object({ type: z.literal('AcquireJumla'), ownerId: id, payment: ResourceVectorSchema }),
  z.object({ type: z.literal('RequestEndTurn') }),
]);
export type GameCommand = z.infer<typeof GameCommandSchema>;

export const CommandEnvelopeSchema = z.object({
  matchId: id,
  commandId: id,
  expectedRevision: z.int().nonnegative(),
  command: GameCommandSchema,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const ENGINE_ERROR_CODES = [
  'INVALID_COMMAND',
  'NOT_YOUR_TURN',
  'WRONG_PHASE',
  'MANDATORY_CHOICE_PENDING',
  'INSUFFICIENT_RESOURCES',
  'RESOURCE_RESERVE_EXHAUSTED',
  'PURCHASE_BLOCKED_BY_DEBT',
  'INVALID_DISCOUNT',
  'POWER_NOT_UNLOCKED',
  'POWER_USAGE_EXHAUSTED',
  'CARD_NO_LONGER_AVAILABLE',
  'NO_GERRYMANDERING_RIGHTS',
  'GERRYMANDER_ALLOWANCE_EXHAUSTED',
  'VOLATILE_VOTER_IMMUNE',
  'MAJORITY_VOTER_PROTECTED',
  'VOTER_GROUP_MUST_STAY_TOGETHER',
  'INVALID_TARGET_SET',
  'STALE_REVISION',
  'CONTENT_NOT_EXECUTABLE',
  'INVARIANT_VIOLATION',
] as const;
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];
