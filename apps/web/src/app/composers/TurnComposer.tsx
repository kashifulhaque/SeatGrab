/**
 * Everything a seat can do on its own turn, composed one action at a time.
 *
 * Section 13.7 wants a purchase or a target built in steps, with the final cost, the
 * voter yield, the legal placements and any effect standing in the way all visible before
 * a resource moves. That shape repeats for every action here: open one, see its targets
 * ringed on the board, watch what is still missing, then confirm.
 *
 * A step that wants a place on the map is composed against the map. `BoardTarget` says so
 * in words, counts what is ringed, reads the picks back as chips and keeps the list of
 * areas folded underneath as the alternative. Placing a card's voters goes further and
 * asks for the *zone* first, because that is the choice the rule actually makes — all of
 * a card's voters go in one zone — and ringing all 126 empty areas at once buried it.
 *
 * What this file does not do is decide anything. `actions.ts` derives every legal target
 * and every shortfall from the projection, and the engine re-checks all of it: a refusal
 * is shown as the engine wrote it rather than reworded here.
 *
 * Two components, because the action column draws them in different places:
 *
 * - `TurnComposer` is the list of what the seat can do this turn: waiting voter groups,
 *   the trick purchase, the gerrymander, and the unlocked powers that are commands.
 *   The three market cards are not here — `Market` draws them once, above this list, and
 *   each card is its own purchase button. Locked powers are not here either; the player
 *   mat lists them with their requirements.
 * - `TurnDraftComposer` is the one action being composed, drawn above the list so the
 *   thing the seat is doing is the first thing under its prompt.
 *
 * One action here buys something nobody can see, and one set of them lives next door:
 *
 * - `BuyTrick` takes the top card of a face-down pile, so its panel shows a price and
 *   no card. The price is 4 or 5 resources of any type, read from the card's back.
 * - Trades, trick play, debts, obligations, held-voter buyback and Cult theft are in
 *   `CampaignComposer`. They are not action-phase actions: a trade is answered by the seat
 *   it was offered to, and a debt outlives the turn that made it, so both have to be
 *   reachable when this composer has stood down.
 */
import { ARCHETYPES, type Cost, type Archetype, type ResourceType } from '@seatgrab/content';
import type { PlayerView, ResourceVectorDto } from '@seatgrab/protocol';

import { CostIcons } from '../CostIcons';
import {
  NO_PAYMENT,
  NO_RESOURCES,
  RESOURCE_ORDER,
  actionAvailability,
  affordability,
  describeResources,
  describeSlotTarget,
  draftCommand,
  dueGroupIds,
  gerrymanderAllowance,
  gerrymanderRightsZoneIds,
  hasElectionFever,
  legalPlacementSlotIds,
  volunteersRemaining,
  level3Limit,
  openingPayment,
  paymentBreakdown,
  placementZoneIds,
  powerStatuses,
  arbitrageLimits,
  trickCost,
  purchaseCost,
  voterSupply,
  zoneName,
  type ActionDraft,
  type DraftAction,
  type PaymentDraft,
  type PowerId,
  type Targeting,
} from '../actions';

import { useViewport } from '../useViewport';

import { ResourcePicker, type PickerRow } from './ResourcePicker';
import type { ComposerSubmit } from './PromptComposer';

/**
 * Actions the engine will accept that no control anywhere can yet compose.
 *
 * Session 11 emptied this. It stays because the next action added to the engine should
 * appear here, named, rather than being silently unreachable from the screen.
 */
const DEFERRED_ACTIONS: Readonly<Record<string, string>> = {};

/** Draft kinds this file composes. Everything else is a prompt or a campaign action. */
const TURN_DRAFTS: ReadonlySet<ActionDraft['kind']> = new Set<ActionDraft['kind']>([
  'influence', 'trick', 'place', 'gerrymander',
  'arbitrage', 'shakedown', 'demolition', 'crackdown', 'outreach', 'turncoatAcquire',
]);

export function isTurnDraft(draft: ActionDraft): boolean {
  return TURN_DRAFTS.has(draft.kind);
}

export interface TurnComposerProps extends ComposerSubmit {
  view: PlayerView;
  seatId: string;
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
  /** The legal areas for the open draft, so the list and the board agree exactly. */
  targeting: Targeting | null;
}

function can(view: PlayerView, action: string): boolean {
  return view.legalActions.includes(action);
}

/**
 * A list of legal areas, in printed board order.
 *
 * The board highlights the same set at the same time, and the board is the control this
 * step is built around. This list is the fallback beside it: a phone in portrait cannot
 * make 129 areas comfortably tappable, and reading a target as a sentence is sometimes
 * faster than finding it on a map. Focusing or hovering an option scrolls the board into
 * view, so the map and the list stay one control.
 */
function TargetSelect({
  view,
  label,
  slotIds,
  onPick,
  disabled = false,
}: {
  view: PlayerView;
  label: string;
  slotIds: ReadonlySet<string>;
  onPick: (slotId: string) => void;
  disabled?: boolean;
}) {
  const ordered = view.slots.filter((slot) => slotIds.has(slot.slotId));
  const showBoard = () => {
    document.querySelector('.board-frame')?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <label className="field">
      <span>{label}</span>
      <select
        className="input"
        value=""
        disabled={disabled || ordered.length === 0}
        onFocus={showBoard}
        onMouseEnter={showBoard}
        onChange={(event) => {
          if (event.target.value !== '') onPick(event.target.value);
        }}
      >
        <option value="">
          {ordered.length === 0 ? 'No area is legal here' : `Choose one of ${ordered.length}`}
        </option>
        {ordered.map((slot) => (
          <option key={slot.slotId} value={slot.slotId}>
            {describeSlotTarget(slot.slotId)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One area already chosen, shown so it can be read back and undone. */
export interface ChosenTarget {
  /** Stable across renders: the slot for a destination, the voter for a source. */
  id: string;
  label: string;
  /** Absent when the pick can no longer be undone from here. */
  onRemove?: (() => void) | undefined;
}

/**
 * Choosing an area, with the board as the control.
 *
 * The playtest that prompted this met a bare `<select>` of up to 129 options for a step
 * whose whole point is a place on a map, and could not tell that the ringed areas beside
 * it were the same thing. So the instruction now names the board first and says how many
 * areas are ringed; the picks read back as chips that can be taken off one at a time; and
 * the list is folded underneath as the alternative rather than presented as the control.
 *
 * It decides nothing. `slotIds` is the legal set the board is already ringing, computed
 * once in `actions.ts`, and every pick goes straight back to the draft reducer.
 */
function BoardTarget({
  view,
  call,
  slotIds,
  onPick,
  chosen,
  progress,
  listLabel,
  disabled = false,
}: {
  view: PlayerView;
  /** What choosing an area means here, said as an instruction. */
  call: string;
  slotIds: ReadonlySet<string>;
  onPick: (slotId: string) => void;
  chosen: readonly ChosenTarget[];
  /** How far through a multi-pick step this is. Absent for a single pick. */
  progress?: { done: number; total: number };
  listLabel: string;
  disabled?: boolean;
}) {
  const count = slotIds.size;
  // Three states, and the difference matters: still choosing, finished choosing, and
  // nothing legal to choose. The last one is a problem and the middle one is not, and an
  // earlier draft of this drew both in red.
  const done = progress !== undefined && progress.done >= progress.total;
  const stuck = count === 0 && !done;
  // On a phone the board is a different tab, so the map is a trip away rather than a
  // glance away: the sentence says which tab, and the list opens where the player is
  // standing instead of asking to be unfolded.
  const phone = useViewport() === 'phone';
  const where = phone ? 'on the Board tab' : 'on the board';
  return (
    <div className="target">
      <p
        className={`target__call${stuck ? ' target__call--none' : ''}${done ? ' target__call--done' : ''}`}
      >
        <span className="target__pin" aria-hidden="true" />
        <span>
          {done
            ? call
            : stuck
              ? `No area on the board can take this. ${call}`
              : count > 40
                ? `${call} Tap a ringed area ${where}, or pick one from the list below.`
                : `${call} Tap one of the ${count} ringed area${count === 1 ? '' : 's'} ${where}`
                  + ', or pick one from the list below.'}
        </span>
      </p>
      {progress === undefined ? null : (
        <p className="target__progress" role="status">
          <span className="target__pips" aria-hidden="true">
            {Array.from({ length: progress.total }, (_, index) => (
              <span
                key={index}
                className={`target__pip${index < progress.done ? ' target__pip--done' : ''}`}
              />
            ))}
          </span>
          {progress.done} of {progress.total} placed
        </p>
      )}
      {chosen.length === 0 ? null : (
        <ul className="picks">
          {chosen.map((pick) => (
            <li key={pick.id}>
              <span>{pick.label}</span>
              {pick.onRemove === undefined ? null : (
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={disabled}
                  onClick={pick.onRemove}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="target__list" open={phone && !done}>
        <summary>Rather pick from a list?</summary>
        <TargetSelect
          view={view}
          label={listLabel}
          slotIds={slotIds}
          onPick={onPick}
          disabled={disabled}
        />
      </details>
    </div>
  );
}

function Confirm({
  view,
  seatId,
  draft,
  submit,
  busy,
  label,
  paymentProblem = null,
}: {
  view: PlayerView;
  seatId: string;
  draft: ActionDraft;
  label: string;
  /**
   * The problem the price picker above is already showing beside its stepper. When the
   * draft's only problem is that one, the status line points up instead of repeating it.
   */
  paymentProblem?: string | null;
} & ComposerSubmit) {
  const outcome = draftCommand(view, seatId, draft);
  return (
    <div className="confirm">
      <p className="composer__status" role="status">
        {outcome.ok
          ? 'Ready.'
          : outcome.problem === paymentProblem
            ? 'Finish the payment above.'
            : outcome.problem}
      </p>
      <button
        type="button"
        className="button button--primary"
        disabled={busy || !outcome.ok}
        onClick={() => {
          if (outcome.ok) submit(outcome.command);
        }}
      >
        {label}
      </button>
    </div>
  );
}

/**
 * The steppers for one price, drawn only for the types the price can be paid in, each
 * carrying its own shortfall. The arithmetic is `paymentBreakdown`'s.
 */
function PricePicker({
  legend,
  cost,
  payment,
  held,
  maximumDiscount,
  dispatch,
  busy,
}: {
  legend: string;
  cost: Cost;
  payment: PaymentDraft;
  held: ResourceVectorDto;
  maximumDiscount: number;
  dispatch: (action: DraftAction) => void;
  busy: boolean;
}) {
  const breakdown = paymentBreakdown(cost, payment, held, maximumDiscount);
  const rows: PickerRow[] = breakdown.rows.map((row) => ({
    resource: row.resource,
    note: row.named > 0 ? `needs ${row.named}` : 'for a ?',
    problem: row.problem,
  }));
  const footer = breakdown.generic === null
    ? breakdown.problem !== null && breakdown.rows.every((row) => row.problem === null)
      ? { text: breakdown.problem, problem: true }
      : undefined
    : {
      text: `? × ${breakdown.generic.required}: ${breakdown.generic.covered} of ${breakdown.generic.required} covered, any type.`
        + (breakdown.generic.problem === null ? '' : ` ${breakdown.generic.problem}`),
      problem: breakdown.generic.problem !== null,
    };
  return (
    <>
      <ResourcePicker
        legend={legend}
        value={payment.resources}
        held={held}
        rows={rows}
        {...(footer === undefined ? {} : { footer })}
        onChange={(resource, amount) => dispatch({ type: 'resource', field: 'payment', resource, amount })}
        disabled={busy}
      />
      {maximumDiscount > 0 ? (
        <ResourcePicker
          legend={`Volunteers — remove up to ${maximumDiscount}`}
          hint="Removed resources are not spent. They come off the price instead."
          value={payment.discounts}
          rows={breakdown.rows.map((row) => ({ resource: row.resource }))}
          {...(breakdown.discountProblem === null ? {} : { footer: { text: breakdown.discountProblem, problem: true } })}
          onChange={(resource, amount) => dispatch({ type: 'resource', field: 'discount', resource, amount })}
          disabled={busy}
        />
      ) : null}
    </>
  );
}

/**
 * Buying the top trick: a price with no card attached to it.
 *
 * Every other purchase here shows what it buys. This one cannot, and that is the rule
 * rather than a gap — the top card of the pile is sold face down and shows only
 * its cost on the back. So the panel shows the price, the surcharge if one applies, and
 * what the seat is committing to blind.
 */
function BuyTrick({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'trick' }>;
  dispatch: (action: DraftAction) => void;
} & ComposerSubmit) {
  const market = view.trickMarket;
  const cost = trickCost(view);
  if (market === undefined || cost === null) {
    return <p className="field-problem">The trick draw pile is empty.</p>;
  }
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
  const surcharge = cost.generic - market.printed.generic;

  return (
    <div className="composer__body">
      <h4>Buy a trick</h4>
      <p>
        The back shows <CostIcons cost={market.printed} />, payable with any mix of resources
        {surcharge > 0
          ? `, plus ${surcharge} more for an effect on you — ${cost.generic} in total.`
          : '.'}{' '}
        The card stays face down until it is yours: nobody knows which of the{' '}
        {view.deckCounts.trick} remaining tricks this is.
      </p>
      <PricePicker
        legend="Pay"
        cost={cost}
        payment={draft.payment}
        held={held}
        maximumDiscount={volunteersRemaining(view, seatId)}
        dispatch={dispatch}
        busy={busy}
      />
      <p className="hint">
        It goes into your hand, not into play. Play it on your own turn, or right before an
        opponent answers their Policy Card.
      </p>
      <Confirm
        view={view}
        seatId={seatId}
        draft={draft}
        submit={submit}
        busy={busy}
        label="Pay and draw"
        paymentProblem={paymentBreakdown(cost, draft.payment, held, volunteersRemaining(view, seatId)).problem}
      />
    </div>
  );
}

function Influence({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'influence' }>;
  dispatch: (action: DraftAction) => void;
} & ComposerSubmit) {
  const card = view.voterCards.find((candidate) => candidate.id === draft.cardId);
  const cost = purchaseCost(view, seatId, draft.cardId);
  if (card === undefined || cost === null) {
    return <p className="field-problem">That voter card has left the market.</p>;
  }
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
  const viral = powerStatuses(view, seatId).find((power) => power.id === 'groundswell');
  const viralAvailable = viral?.unlocked === true
    && (viral.usage === undefined || viral.usage.used < viral.usage.limit);
  const voters = card.voters + (draft.groundswell ? 1 : 0);
  const surcharged = cost.generic > card.cost.generic;
  const roomy = placementZoneIds(view, voters);
  const supply = voterSupply(view);

  return (
    <div className="composer__body">
      <h4>Buy {card.voters} voter{card.voters === 1 ? '' : 's'}</h4>
      <p>
        <CostIcons cost={card.cost} />
        {surcharged ? ' plus one more for an effect on you.' : ''}
      </p>
      {viralAvailable ? (
        <label className="choice">
          <input
            type="checkbox"
            checked={draft.groundswell}
            disabled={busy}
            onChange={(event) => dispatch({ type: 'groundswell', on: event.target.checked })}
          />
          <span>
            Groundswell — one extra voter for the same price
            {viral?.usage === undefined ? '' : ` (${viral.usage.used} of ${viral.usage.limit} used)`}
          </span>
        </label>
      ) : null}

      <PricePicker
        legend="Pay"
        cost={cost}
        payment={draft.payment}
        held={held}
        maximumDiscount={volunteersRemaining(view, seatId)}
        dispatch={dispatch}
        busy={busy}
      />

      <p className="small">
        {voters === 1 ? 'One voter arrives' : `${voters} voters arrive together`} and must go in one
        zone.{' '}
        {roomy.length === 0
          ? 'No zone has room for the whole group, so the voters would be discarded.'
          : `Zones with room: ${roomy.map(zoneName).join(', ')}.`}
      </p>
      {supply === null || supply >= voters ? null : (
        <p className="field-problem">
          {supply === 0
            ? 'You have no voter tokens left on your mat, so nothing can be placed.'
            : `You have ${supply} voter token${supply === 1 ? '' : 's'} left on your mat; this card needs ${voters}.`}
        </p>
      )}
      <Confirm
        view={view}
        seatId={seatId}
        draft={draft}
        submit={submit}
        busy={busy}
        label="Confirm purchase"
        paymentProblem={paymentBreakdown(cost, draft.payment, held, volunteersRemaining(view, seatId)).problem}
      />
    </div>
  );
}

function Placement({
  view,
  seatId,
  draft,
  dispatch,
  targeting,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'place' }>;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
} & ComposerSubmit) {
  const group = view.pendingVoterGroups.find((candidate) => candidate.id === draft.groupId);
  if (group === undefined) return <p className="field-problem">That group is no longer waiting.</p>;
  const placed = draft.slotIds.length;
  const zoneId = draft.zoneId ?? null;

  // The zones this group could still go in, with the room each has left. Read off the
  // same legal set the board rings, so a zone offered here is a zone the engine accepts.
  const open = legalPlacementSlotIds(view, seatId, group, []);
  const room = new Map<string, number>();
  for (const slot of view.slots) {
    if (open.has(slot.slotId)) room.set(slot.zoneId, (room.get(slot.zoneId) ?? 0) + 1);
  }
  const choices = view.zones.filter((zone) => (room.get(zone.id) ?? 0) > 0);

  return (
    <div className="composer__body">
      <h4>Place {group.count} voter{group.count === 1 ? '' : 's'}</h4>

      {zoneId === null ? (
        <>
          <p className="small">
            {group.sameZone
              ? `All ${group.count} go in one zone. Choose it first; the board then rings that zone’s`
                + ' free areas and nothing else.'
              : 'Choose a zone to place in. You may come back and choose another for the rest.'}
          </p>
          <p className="target__call">
            <span className="target__pin" aria-hidden="true" />
            <span>
              Tap any ringed area on the board in the zone you want, or choose a zone here.
            </span>
          </p>
          {choices.length === 0 ? (
            <p className="field-problem">
              No zone has room for {group.sameZone ? 'the whole group' : 'another voter'}. These
              voters are lost when the turn ends.
            </p>
          ) : (
            <ul className="zone-choices">
              {choices.map((zone) => (
                <li key={zone.id}>
                  <button
                    type="button"
                    className="button zone-choice"
                    disabled={busy}
                    onClick={() => dispatch({ type: 'placeZone', zoneId: zone.id })}
                  >
                    <span className="zone-choice__name">{zone.displayName}</span>
                    <span className="zone-choice__room">
                      {room.get(zone.id)} free · {zone.majorityThreshold} holds it
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="placement__zone">
            <span>
              Placing in <strong>{zoneName(zoneId)}</strong>
            </span>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => dispatch({ type: 'placeZone', zoneId: null })}
            >
              Change zone
            </button>
          </p>
          <BoardTarget
            view={view}
            call={placed >= group.count
              ? 'Every voter has an area.'
              : `Choose where a voter stands in ${zoneName(zoneId)}.`}
            slotIds={targeting?.slotIds ?? new Set()}
            onPick={(slotId) => dispatch({ type: 'pick', slotId, voterId: null })}
            chosen={draft.slotIds.map((slotId) => ({
              id: slotId,
              label: describeSlotTarget(slotId),
              onRemove: () => dispatch({ type: 'pick', slotId, voterId: null }),
            }))}
            progress={{ done: placed, total: group.count }}
            listLabel="Add an area"
            disabled={busy}
          />
        </>
      )}
      <Confirm view={view} seatId={seatId} draft={draft} submit={submit} busy={busy} label="Place these voters" />
    </div>
  );
}

function Gerrymander({
  view,
  seatId,
  draft,
  dispatch,
  targeting,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'gerrymander' }>;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
} & ComposerSubmit) {
  const zones = gerrymanderRightsZoneIds(view, seatId);
  const allowance = gerrymanderAllowance(view, seatId, draft.rightsZoneId);
  const fever = hasElectionFever(view, seatId);
  const sourceSlot = draft.voterId === null
    ? null
    : view.slots.find((slot) => slot.voter?.id === draft.voterId) ?? null;

  return (
    <div className="composer__body">
      <h4>Gerrymander</h4>
      <label className="field">
        <span>Zone authorizing the move</span>
        <select
          className="input"
          value={draft.rightsZoneId}
          disabled={busy}
          onChange={(event) => dispatch({ type: 'rightsZone', zoneId: event.target.value })}
        >
          {zones.map((zoneId) => (
            <option key={zoneId} value={zoneId}>
              {zoneName(zoneId)}
            </option>
          ))}
        </select>
      </label>
      <p className={allowance.used >= allowance.limit ? 'field-problem' : 'small'}>
        {allowance.used} of {allowance.limit} move{allowance.limit === 1 ? '' : 's'} used from this
        zone this turn.
        {fever
          ? ' Landslide gives it a second move and lets a marked voter travel.'
          : ' A marked voter cannot be moved without Landslide.'}
      </p>

      {sourceSlot === null ? (
        <BoardTarget
          view={view}
          call="Step 1 of 2 — choose the voter to move."
          slotIds={targeting?.slotIds ?? new Set()}
          onPick={(slotId) => dispatch({
            type: 'pick',
            slotId,
            voterId: view.slots.find((slot) => slot.slotId === slotId)?.voter?.id ?? null,
          })}
          chosen={[]}
          listLabel="Voter to move"
          disabled={busy}
        />
      ) : (
        <BoardTarget
          view={view}
          call={`Step 2 of 2 — choose where the voter in ${describeSlotTarget(sourceSlot.slotId)}`
            + `${sourceSlot.voter?.ownerId === seatId ? ' (one of yours)' : ' (an opponent’s)'} moves to.`}
          slotIds={targeting?.slotIds ?? new Set()}
          onPick={(slotId) => dispatch({ type: 'pick', slotId, voterId: null })}
          chosen={[
            {
              id: sourceSlot.slotId,
              label: `Moving: ${describeSlotTarget(sourceSlot.slotId)}`,
              onRemove: () => dispatch({
                type: 'pick',
                slotId: sourceSlot.slotId,
                voterId: sourceSlot.voter?.id ?? null,
              }),
            },
            ...(draft.destinationSlotId === null
              ? []
              : [{ id: draft.destinationSlotId, label: `To: ${describeSlotTarget(draft.destinationSlotId)}` }]),
          ]}
          listLabel="Where it moves to"
          disabled={busy}
        />
      )}
      <Confirm view={view} seatId={seatId} draft={draft} submit={submit} busy={busy} label="Move this voter" />
    </div>
  );
}

function VoterPick({
  view,
  label,
  call,
  dispatch,
  targeting,
  chosen,
  busy,
}: {
  view: PlayerView;
  label: string;
  /** What choosing a voter means here, said as an instruction over the board. */
  call: string;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
  /** Voter IDs already chosen, listed back so a pick can be undone. */
  chosen: readonly string[];
  busy: boolean;
}) {
  return (
    <BoardTarget
      view={view}
      call={call}
      slotIds={targeting?.slotIds ?? new Set()}
      onPick={(slotId) => dispatch({
        type: 'pick',
        slotId,
        voterId: view.slots.find((slot) => slot.slotId === slotId)?.voter?.id ?? null,
      })}
      chosen={chosen.map((voterId) => {
        const slot = view.slots.find((candidate) => candidate.voter?.id === voterId);
        return {
          id: voterId,
          label: slot === undefined ? voterId : describeSlotTarget(slot.slotId),
          onRemove: slot === undefined
            ? undefined
            : () => dispatch({ type: 'pick', slotId: slot.slotId, voterId }),
        };
      })}
      listLabel={label}
      disabled={busy}
    />
  );
}

function PowerComposer({
  view,
  seatId,
  draft,
  dispatch,
  targeting,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
} & ComposerSubmit) {
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
  const confirm = (label: string) => (
    <Confirm view={view} seatId={seatId} draft={draft} submit={submit} busy={busy} label={label} />
  );
  const heldRows = (): PickerRow[] =>
    RESOURCE_ORDER.filter((resource) => held[resource] > 0).map((resource) => ({ resource }));

  switch (draft.kind) {
    case 'arbitrage': {
      // The returned resource reaches the reserve before the gain is taken, so both
      // figures move as the payment above is edited.
      const limits = arbitrageLimits(view, draft.payment);
      return (
        <div className="composer__body">
          <h4>Arbitrage</h4>
          <p>Return one resource to the bank and take two of your choice.</p>
          <ResourcePicker
            legend="Return one"
            value={draft.payment}
            held={held}
            rows={heldRows()}
            onChange={(resource, amount) => dispatch({ type: 'resource', field: 'payment', resource, amount })}
            disabled={busy}
          />
          <ResourcePicker
            legend={`Take ${limits.required}`}
            {...(limits.required === 2
              ? {}
              : {
                hint: limits.required === 1
                  ? `The reserve is down to ${describeResources(limits.perResource)}, so this takes`
                    + ' one resource rather than two.'
                  : 'The reserve is empty. Choose the resource you are returning above: it goes'
                    + ' back before you take anything, so there is always one to take.',
              })}
            value={draft.gain}
            held={limits.perResource}
            heldLabel="the reserve has"
            onChange={(resource, amount) => dispatch({ type: 'resource', field: 'gain', resource, amount })}
            disabled={busy}
          />
          {confirm('Use Arbitrage')}
        </div>
      );
    }

    case 'shakedown': {
      const opponents = view.players.filter((player) => player.id !== seatId);
      return (
        <div className="composer__body">
          <h4>Shakedown</h4>
          <p>Take one resource of your choice straight out of an opponent’s hand.</p>
          <label className="field">
            <span>From</span>
            <select
              className="input"
              value={draft.opponentId}
              disabled={busy}
              onChange={(event) => dispatch({ type: 'donationOpponent', playerId: event.target.value })}
            >
              {opponents.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.displayName} — holds {describeResources(player.resources)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Take</span>
            <select
              className="input"
              value={draft.resource}
              disabled={busy}
              onChange={(event) =>
                dispatch({ type: 'donationResource', resource: event.target.value as ResourceType })}
            >
              {RESOURCE_ORDER.map((resource) => (
                <option key={resource} value={resource}>
                  {resource}
                </option>
              ))}
            </select>
          </label>
          {confirm('Use Shakedown')}
        </div>
      );
    }

    case 'demolition':
      return (
        <div className="composer__body">
          <h4>Demolition</h4>
          <p>
            Evict a voter from a non-volatile area. Your own voter comes back to your mat to be
            placed again; an opponent’s waits until their next turn.
          </p>
          <VoterPick
            view={view}
            label="Voter to evict"
            call="Choose the voter to evict."
            dispatch={dispatch}
            targeting={targeting}
            chosen={draft.voterId === null ? [] : [draft.voterId]}
            busy={busy}
          />
          {confirm('Evict this voter')}
        </div>
      );

    case 'crackdown':
      return (
        <div className="composer__body">
          <h4>Crackdown</h4>
          <p>Pay one resource to discard an opponent voter from a non-volatile area.</p>
          <VoterPick
            view={view}
            label="Opponent voter to discard"
            call="Choose the opponent voter to discard."
            dispatch={dispatch}
            targeting={targeting}
            chosen={draft.voterId === null ? [] : [draft.voterId]}
            busy={busy}
          />
          <ResourcePicker
            legend="Pay one"
            value={draft.payment}
            held={held}
            rows={heldRows()}
            onChange={(resource, amount) => dispatch({ type: 'resource', field: 'payment', resource, amount })}
            disabled={busy}
          />
          {confirm('Pay and discard')}
        </div>
      );

    case 'outreach':
      return (
        <div className="composer__body">
          <h4>Outreach</h4>
          <p>
            Convert two of one opponent’s voters in one zone into yours. The first voter you
            choose decides whose voters and which zone the second may come from.
          </p>
          <VoterPick
            view={view}
            label="Voter to convert"
            call="Choose a voter to convert. Two, from one opponent, in one zone."
            dispatch={dispatch}
            targeting={targeting}
            chosen={draft.voterIds}
            busy={busy}
          />
          <PricePicker
            legend="Pay 2 faith and 2 of your choice"
            cost={{ cash: 0, influence: 0, press: 0, faith: 2, generic: 2 }}
            payment={draft.payment}
            held={held}
            maximumDiscount={volunteersRemaining(view, seatId)}
            dispatch={dispatch}
            busy={busy}
          />
          {confirm('Pay and convert')}
        </div>
      );

    case 'turncoatAcquire': {
      const holding = view.turncoatHoldings.find((candidate) => candidate.ownerId === draft.ownerId);
      const owner = view.players.find((player) => player.id === draft.ownerId);
      return (
        <div className="composer__body">
          <h4>Acquire Turncoat</h4>
          <p>
            Turncoat sits on {owner?.displayName ?? draft.ownerId}’s {holding?.archetype} track and
            costs exactly {holding?.acquisitionCost ?? 0} resources — the level it is standing on.
            The resources go to its owner, not to the reserve.
          </p>
          <ResourcePicker
            legend={`Pay ${holding?.acquisitionCost ?? 0}`}
            value={draft.payment}
            held={held}
            rows={heldRows()}
            onChange={(resource, amount) => dispatch({ type: 'resource', field: 'payment', resource, amount })}
            disabled={busy}
          />
          {confirm('Acquire Turncoat')}
        </div>
      );
    }

    default:
      return null;
  }
}

/** Which draft each command power opens, so the menu and the composer cannot disagree. */
const POWER_DRAFTS: Partial<Record<PowerId, ActionDraft>> = {
  arbitrage: { kind: 'arbitrage', payment: NO_RESOURCES, gain: NO_RESOURCES },
  demolition: { kind: 'demolition', voterId: null },
  crackdown: { kind: 'crackdown', voterId: null, payment: NO_RESOURCES },
  outreach: { kind: 'outreach', voterIds: [], payment: NO_PAYMENT },
};

/** The one action being composed. Draws nothing for a prompt or campaign draft. */
export function TurnDraftComposer({
  view,
  seatId,
  draft,
  dispatch,
  targeting,
  submit,
  busy,
}: TurnComposerProps) {
  if (!isTurnDraft(draft)) return null;
  if (draft.kind === 'influence') {
    return <Influence view={view} seatId={seatId} draft={draft} dispatch={dispatch} submit={submit} busy={busy} />;
  }
  if (draft.kind === 'trick') {
    return <BuyTrick view={view} seatId={seatId} draft={draft} dispatch={dispatch} submit={submit} busy={busy} />;
  }
  if (draft.kind === 'place') {
    return (
      <Placement
        view={view}
        seatId={seatId}
        draft={draft}
        dispatch={dispatch}
        targeting={targeting}
        submit={submit}
        busy={busy}
      />
    );
  }
  if (draft.kind === 'gerrymander') {
    return (
      <Gerrymander
        view={view}
        seatId={seatId}
        draft={draft}
        dispatch={dispatch}
        targeting={targeting}
        submit={submit}
        busy={busy}
      />
    );
  }
  return (
    <PowerComposer
      view={view}
      seatId={seatId}
      draft={draft}
      dispatch={dispatch}
      targeting={targeting}
      submit={submit}
      busy={busy}
    />
  );
}

/**
 * The voter groups this seat must place before its turn can end.
 *
 * It is exported because `SeatSurface` draws it inside the Now card whenever the seat is
 * free: a group that is due *is* the one thing to do, and a button for it at the foot of
 * a folded list was one a player did not find.
 */
export function PendingVoters({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: Omit<TurnComposerProps, 'targeting'>) {
  const pending = view.pendingVoterGroups.filter((group) => group.controllerId === seatId);
  if (pending.length === 0) return null;
  const due = dueGroupIds(view, seatId);
  return (
    <section className="composer__group composer__group--urgent">
      <h4>Voters waiting to be placed</h4>
      <p className="hint">The turn cannot end while a group is due.</p>
      <div className="actions">
        {pending.map((group) => (
          <button
            key={group.id}
            type="button"
            className="button button--primary"
            disabled={busy}
            aria-pressed={draft.kind === 'place' && draft.groupId === group.id}
            onClick={() => dispatch({
              type: 'open',
              draft: { kind: 'place', groupId: group.id, slotIds: [], zoneId: null },
            })}
          >
            Place {group.count} voter{group.count === 1 ? '' : 's'}
          </button>
        ))}
        <button
          type="button"
          className="button"
          disabled={busy || due.length === 0}
          onClick={() => submit({ type: 'ConfirmPendingVoterDiscard', groupIds: [...due] })}
        >
          Discard all
        </button>
      </div>
    </section>
  );
}

/**
 * What the seat can do this turn, as a list of controls.
 *
 * Drawn only when the action phase is this seat's: the caller writes the one-line reason
 * otherwise, from `actionAvailability`, so this never has to say "not your turn" itself.
 */
export function TurnComposer({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: TurnComposerProps) {
  const pending = view.pendingVoterGroups.filter((group) => group.controllerId === seatId);
  const due = dueGroupIds(view, seatId);
  const rightsZones = gerrymanderRightsZoneIds(view, seatId);
  const powers = powerStatuses(view, seatId);
  const turncoatMine = view.turncoatHoldings.find((holding) => holding.ownerId === seatId);
  const turncoatTheirs = view.turncoatHoldings.filter((holding) => holding.ownerId !== seatId);
  const price = trickCost(view);
  const trick = actionAvailability(view, seatId, 'BuyTrick');
  const gerrymander = actionAvailability(view, seatId, 'Gerrymander');
  const deferred = [...new Set(
    view.legalActions.flatMap((action) => {
      const label = DEFERRED_ACTIONS[action];
      return label === undefined ? [] : [label];
    }),
  )];

  const open = (next: ActionDraft) => () => dispatch({ type: 'open', draft: next });
  const isOpen = (kind: ActionDraft['kind']) => draft.kind === kind;
  const unlocked = powers.filter((power) => power.unlocked);
  const shakedownLimit = level3Limit(view, seatId, 2);
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
  const trickAfford = price === null
    ? null
    : affordability(price, held, volunteersRemaining(view, seatId));

  return (
    <div className="composer">
      {/* The waiting groups are drawn in the Now card while the seat is free, which is
          where a player looks for the one thing the turn cannot end without. This copy
          keeps them reachable while some other action is open. */}
      {draft.kind === 'none' ? null : (
        <PendingVoters view={view} seatId={seatId} draft={draft} dispatch={dispatch} submit={submit} busy={busy} />
      )}

      <ul className="action-list">
        <li>
          <button
            type="button"
            className={`button ${isOpen('trick') ? 'button--primary' : ''}`}
            disabled={busy || !trick.can || price === null}
            aria-pressed={isOpen('trick')}
            onClick={open({
              kind: 'trick',
              payment: price === null ? NO_PAYMENT : openingPayment(price, held),
            })}
          >
            Buy a trick
          </button>
          <span className="small">
            {price === null
              ? 'The trick draw pile is empty.'
              : trick.reason
                ?? `${price.generic} resources of any type, for a card you see only once it is yours.`
                  + (trickAfford === null || trickAfford.short === null
                    ? ''
                    : ` ${trickAfford.short}`)}
          </span>
        </li>

        {rightsZones.length === 0 ? (
          <li>
            <button type="button" className="button" disabled aria-describedby="gerrymander-reason">
              Gerrymander
            </button>
            <span id="gerrymander-reason" className="small">
              You hold redistricting rights nowhere. Rights go to the seat with strictly the most
              voters in a zone.
            </span>
          </li>
        ) : (
          rightsZones.map((zoneId) => {
            const allowance = gerrymanderAllowance(view, seatId, zoneId);
            const openHere = draft.kind === 'gerrymander' && draft.rightsZoneId === zoneId;
            return (
              <li key={zoneId}>
                <button
                  type="button"
                  className={`button ${openHere ? 'button--primary' : ''}`}
                  disabled={busy || !gerrymander.can}
                  aria-pressed={openHere}
                  onClick={open({
                    kind: 'gerrymander',
                    rightsZoneId: zoneId,
                    voterId: null,
                    destinationSlotId: null,
                  })}
                >
                  Gerrymander from {zoneName(zoneId)}
                </button>
                <span className="small">
                  {gerrymander.reason ?? `${allowance.limit - allowance.used} of ${allowance.limit} move${allowance.limit === 1 ? '' : 's'} left this turn.`}
                </span>
              </li>
            );
          })
        )}

        {unlocked.map((power) => {
          const target = power.id === 'shakedown'
            ? {
              kind: 'shakedown' as const,
              opponentId: view.players.find((player) => player.id !== seatId)?.id ?? '',
              resource: 'cash' as const,
            }
            : POWER_DRAFTS[power.id];
          const used = power.id === 'shakedown' ? view.turnUsage.shakedown : power.usage?.used;
          const limit = power.id === 'shakedown' ? shakedownLimit : power.usage?.limit;
          const exhausted = used !== undefined && limit !== undefined && used >= limit;
          if (power.submission === 'modifier' || target === undefined) {
            return (
              <li key={power.id} className="action-list__note">
                <strong>{power.label}</strong>
                <span className="small">
                  {power.id === 'groundswell'
                    ? 'Unlocked. Tick it inside a voter purchase.'
                    : power.id === 'volunteers'
                      ? 'Unlocked. Remove resources from a price as you pay it.'
                      : 'Unlocked. A second move under your rights, and marked voters may move.'}
                </span>
              </li>
            );
          }
          return (
            <li key={power.id}>
              <button
                type="button"
                className={`button ${isOpen(target.kind) ? 'button--primary' : ''}`}
                disabled={busy || exhausted}
                aria-pressed={isOpen(target.kind)}
                onClick={open(target)}
              >
                {power.label}
              </button>
              <span className="small">
                {exhausted
                  ? `Used ${used} of ${limit} this turn.`
                  : power.effect}
              </span>
            </li>
          );
        })}
      </ul>

      {turncoatMine === undefined && turncoatTheirs.length === 0 ? null : (
        <section className="composer__group">
          <h4>Turncoat</h4>
          {turncoatMine === undefined ? null : (
            <>
              <p className="small">
                An extra Policy Card on your {turncoatMine.archetype} track. You may move it to
                another Archetype at the end of your turn.
              </p>
              <div className="actions">
                {ARCHETYPES.filter((archetype) => archetype !== turncoatMine.archetype).map(
                  (archetype: Archetype) => (
                    <button
                      key={archetype}
                      type="button"
                      className="button"
                      disabled={busy || !can(view, 'ReassignJumla')}
                      onClick={() => submit({ type: 'ReassignJumla', archetype })}
                    >
                      Move Turncoat to {archetype}
                    </button>
                  ),
                )}
              </div>
            </>
          )}
          {turncoatTheirs.map((holding) => {
            const owner = view.players.find((player) => player.id === holding.ownerId);
            return (
              <div key={holding.effectId} className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || !can(view, 'AcquireJumla')}
                  onClick={open({
                    kind: 'turncoatAcquire',
                    ownerId: holding.ownerId,
                    payment: NO_RESOURCES,
                  })}
                >
                  Acquire Turncoat from {owner?.displayName ?? holding.ownerId} · {holding.acquisitionCost}
                </button>
              </div>
            );
          })}
        </section>
      )}

      {deferred.length === 0 ? null : (
        <p className="notice">
          The engine would also accept: {deferred.join(', ')}. No control composes those yet.
        </p>
      )}
    </div>
  );
}
