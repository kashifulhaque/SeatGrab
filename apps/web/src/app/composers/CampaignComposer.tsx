/**
 * Everything a seat can do with cards, offers and debts, whether or not it is its turn.
 *
 * `TurnComposer` next door is the action phase: it belongs to the seat that is acting,
 * and it stands down whenever the match is waiting on a decision. The campaign machinery
 * does not fit inside that. A trade is answered by the seat it was offered to, a debt
 * outlives the turn that created it, and both are legal while the active seat is still
 * answering an Policy Card. So these controls are drawn for every seat, all the time,
 * and each one says plainly when the window for it is shut.
 *
 * Three components, because the action column draws them in different places:
 *
 * - `TrickHand` is the seat's cards with their play buttons and blocked reasons. It
 *   lives in the private drawer, with the committed policy cards.
 * - `CampaignComposer` is trades, debts, obligations, held voters and Cult theft. It is
 *   collapsed unless `campaignAttention` says something in it is waiting.
 * - `CampaignDraftComposer` is the one campaign action being composed, drawn where every
 *   other open composer is drawn.
 *
 * One thing is deliberately narrower than the printed rules, and it is stated on screen
 * rather than hidden:
 *
 * - A trade offer can give trick cards but cannot name one to receive. An opponent's
 *   hand is secret, and this build will not put a card ID in front of a player who has
 *   not been shown the card. The opponent counters with the card instead, which reaches
 *   the same trade through two offers.
 *
 * The hand states why a card cannot be played rather than letting the engine refuse it.
 * That is not politeness: `PlayTrick` is the seat's action, and an A18 refusal — five
 * voters it cannot reach, a rights zone it does not hold — arrives after the click.
 */
import type { PlayerView, TradeOfferView } from '@gerrymander/protocol';

import {
  KHAKI_TERROR_PAYMENT,
  NO_RESOURCES,
  RESOURCE_ORDER,
  cardTitle,
  describeResources,
  describeSlotTarget,
  draftCommand,
  handCards,
  playerName,
  stealableCultCards,
  tradeOffers,
  tradeWindowOpen,
  zoneName,
  type ActionDraft,
  type DraftAction,
  type Targeting,
} from '../actions';

import { ResourcePicker } from './ResourcePicker';
import type { ComposerSubmit } from './PromptComposer';

export interface CampaignComposerProps extends ComposerSubmit {
  view: PlayerView;
  seatId: string;
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
}

export function isCampaignDraft(draft: ActionDraft): boolean {
  return draft.kind === 'trade' || draft.kind === 'debt' || draft.kind === 'stealBase';
}

function can(view: PlayerView, action: string): boolean {
  return view.legalActions.includes(action);
}

function Confirm({
  view,
  seatId,
  draft,
  submit,
  busy,
  label,
}: {
  view: PlayerView;
  seatId: string;
  draft: ActionDraft;
  label: string;
} & ComposerSubmit) {
  const outcome = draftCommand(view, seatId, draft);
  return (
    <div className="confirm">
      <p className="composer__status" role="status">
        {outcome.ok ? 'Ready.' : outcome.problem}
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

function TradeSummary({ view, offer, seatId }: { view: PlayerView; offer: TradeOfferView; seatId: string }) {
  const proposerIsMe = offer.proposerId === seatId;
  const giving = proposerIsMe ? offer.giveResources : offer.receiveResources;
  const getting = proposerIsMe ? offer.receiveResources : offer.giveResources;
  const givingCards = proposerIsMe ? offer.giveTrickIds : offer.receiveTrickIds;
  const gettingCards = proposerIsMe ? offer.receiveTrickIds : offer.giveTrickIds;
  const other = proposerIsMe ? offer.opponentId : offer.proposerId;
  return (
    <p>
      With {playerName(view, other)}: you give {describeResources(giving)}
      {givingCards.length === 0 ? '' : ` plus ${givingCards.map(cardTitle).join(', ')}`}, and you
      receive {describeResources(getting)}
      {gettingCards.length === 0 ? '' : ` plus ${gettingCards.map(cardTitle).join(', ')}`}.
    </p>
  );
}

function TradeBuilder({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'trade' }>;
  dispatch: (action: DraftAction) => void;
} & ComposerSubmit) {
  const opponents = view.players.filter((player) => player.id !== seatId);
  const opponent = view.players.find((player) => player.id === draft.opponentId);
  const hand = handCards(view, seatId);
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
  return (
    <div className="composer__body">
      <h4>Offer a trade</h4>
      <label className="field">
        <span>Who is this offered to?</span>
        <select
          className="input"
          value={draft.opponentId}
          disabled={busy}
          onChange={(event) => dispatch({ type: 'tradeOpponent', playerId: event.target.value })}
        >
          {opponents.map((player) => (
            <option key={player.id} value={player.id}>
              {player.displayName}
            </option>
          ))}
        </select>
      </label>
      <ResourcePicker
        legend="You give"
        hint="Both sides of an ordinary trade must move at least one resource."
        value={draft.giveResources}
        held={held}
        rows={RESOURCE_ORDER.filter((resource) => held[resource] > 0 || draft.giveResources[resource] > 0)
          .map((resource) => ({ resource }))}
        onChange={(resource, amount) => dispatch({ type: 'resource', field: 'give', resource, amount })}
        disabled={busy}
      />
      <ResourcePicker
        legend="You receive"
        value={draft.receiveResources}
        {...(opponent === undefined ? {} : { held: opponent.resources, heldLabel: `${opponent.displayName} holds` })}
        onChange={(resource, amount) => dispatch({ type: 'resource', field: 'receive', resource, amount })}
        disabled={busy}
      />
      {hand.length === 0 ? null : (
        <fieldset className="field">
          <span>Trick cards you throw in</span>
          <ul className="choices">
            {hand.map((card) => (
              <li key={card.cardId}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={draft.giveTrickIds.includes(card.cardId)}
                    disabled={busy}
                    onChange={() => dispatch({ type: 'tradeCard', cardId: card.cardId })}
                  />
                  <span>{card.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <p className="hint">
        You cannot ask for a named card: {opponent?.displayName ?? 'an opponent'}’s hand is secret
        and this screen will not guess at it. Ask them to offer it instead.
      </p>
      <Confirm view={view} seatId={seatId} draft={draft} submit={submit} busy={busy} label="Send this offer" />
    </div>
  );
}

function CultTheft({
  view,
  seatId,
  draft,
  targeting,
  submit,
  busy,
  dispatch,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'stealBase' }>;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
} & ComposerSubmit) {
  const holder = view.activeEffects.find((effect) => effect.sourceCardId === draft.sourceCardId);
  return (
    <div className="composer__body">
      <h4>Steal Loyal Base</h4>
      <p>
        Three of your own voters convert to {playerName(view, holder?.ownerId ?? '')}’s, and the
        card — with the protection it gives — becomes yours. You must still hold a majority of your
        own afterwards, or the engine refuses the theft.
      </p>
      {draft.voterIds.length === 0 ? null : (
        <ul className="picks">
          {draft.voterIds.map((voterId) => {
            const slot = view.slots.find((candidate) => candidate.voter?.id === voterId);
            return (
              <li key={voterId}>
                <span>{slot === undefined ? voterId : describeSlotTarget(slot.slotId)}</span>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => dispatch({ type: 'pick', slotId: slot?.slotId ?? '', voterId })}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="small">
        {targeting === null || targeting.slotIds.size === 0
          ? 'No voter of yours can be converted right now.'
          : `Choose ${3 - draft.voterIds.length} more from the ${targeting.slotIds.size} ringed`
            + ' areas on the board.'}
      </p>
      <Confirm view={view} seatId={seatId} draft={draft} submit={submit} busy={busy} label="Convert three and take the card" />
    </div>
  );
}

function DebtPayment({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: Extract<ActionDraft, { kind: 'debt' }>;
  dispatch: (action: DraftAction) => void;
} & ComposerSubmit) {
  const debt = (view.privateDebts ?? []).find((candidate) => candidate.id === draft.debtId);
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;
  return (
    <div className="composer__body">
      <h4>Repay auction debt</h4>
      <p>
        {debt === undefined
          ? 'That debt is already settled.'
          : `You owe ${playerName(view, debt.creditorPlayerId)} ${debt.amount}, from ${debt.reason}.`
            + ' Part payment is allowed; the resources go to them, not to the reserve.'}
      </p>
      <ResourcePicker
        legend={`Pay up to ${debt?.amount ?? 0}`}
        value={draft.payment}
        held={held}
        rows={RESOURCE_ORDER.filter((resource) => held[resource] > 0 || draft.payment[resource] > 0)
          .map((resource) => ({ resource }))}
        onChange={(resource, amount) => dispatch({ type: 'resource', field: 'payment', resource, amount })}
        disabled={busy}
      />
      <Confirm view={view} seatId={seatId} draft={draft} submit={submit} busy={busy} label="Pay this much" />
    </div>
  );
}

/** The one campaign action being composed. Draws nothing for any other draft. */
export function CampaignDraftComposer({
  view,
  seatId,
  draft,
  dispatch,
  targeting,
  submit,
  busy,
}: CampaignComposerProps) {
  if (draft.kind === 'trade') {
    return <TradeBuilder view={view} seatId={seatId} draft={draft} dispatch={dispatch} submit={submit} busy={busy} />;
  }
  if (draft.kind === 'debt') {
    return <DebtPayment view={view} seatId={seatId} draft={draft} dispatch={dispatch} submit={submit} busy={busy} />;
  }
  if (draft.kind === 'stealBase') {
    return (
      <CultTheft
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
  return null;
}

/**
 * This seat's trick hand, with a play button per card and the reason a card cannot
 * be played. `readOnly` draws the cards without controls, for a finished match.
 */
export function TrickHand({
  view,
  seatId,
  submit,
  busy,
  readOnly = false,
}: { view: PlayerView; seatId: string; readOnly?: boolean } & ComposerSubmit) {
  const hand = handCards(view, seatId);
  if (hand.length === 0) {
    return <p className="small">No trick cards. Others see how many you hold, never which.</p>;
  }
  return (
    <>
      <ul className="hand">
        {hand.map((card) => (
          <li key={card.cardId} className="hand__card">
            <h5>{card.title}</h5>
            <p className="small">{card.rulesText}</p>
            {readOnly ? null : (
              <div className="actions">
                {/*
                  * The two branches are reported separately, because they are blocked
                  * separately: a reserve too short for ordinary Cornerstone says nothing
                  * about its triple conversion, so a blocked ordinary play must not take
                  * the mode button off the screen with it.
                  */}
                {card.blocked === undefined ? (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || !can(view, 'PlayTrick')}
                    onClick={() => submit({ type: 'PlayTrick', cardId: card.cardId })}
                  >
                    Play {card.title}
                  </button>
                ) : (
                  <p className="field-problem">{card.blocked}</p>
                )}
                {card.mode === undefined ? null : (
                  <>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !can(view, 'PlayTrick') || !card.mode.available}
                      onClick={() => submit({
                        type: 'PlayTrick',
                        cardId: card.cardId,
                        mode: card.mode?.id ?? '',
                      })}
                    >
                      {card.mode.label}
                    </button>
                    {card.mode.available ? null : (
                      <span className="small">{card.mode.requirement}</span>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {readOnly || can(view, 'PlayTrick') ? null : (
        <p className="hint">
          A trick is played in your own action phase, or while you are answering an Policy
          Card. It is not your window right now.
        </p>
      )}
    </>
  );
}

/** Trades, debts, obligations, held voters and Cult theft. The hand is `TrickHand`. */
export function CampaignComposer({
  view,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: CampaignComposerProps) {
  const offers = tradeOffers(view, seatId);
  const debts = view.privateDebts ?? [];
  const obligations = view.privateObligations ?? [];
  const heldVoters = view.privateHeldVoters ?? [];
  const cults = stealableCultCards(view, seatId);
  const tradeWindow = tradeWindowOpen(view);
  const open = (next: ActionDraft) => () => dispatch({ type: 'open', draft: next });
  const firstOpponentId = view.players.find((player) => player.id !== seatId)?.id ?? '';

  return (
    <div className="composer">
      {offers.theirs.length === 0 ? null : (
        <section className="composer__group composer__group--urgent">
          <h4>Offered to you</h4>
          <ul className="effects">
            {offers.theirs.map((offer) => (
              <li key={offer.id}>
                <TradeSummary view={view} offer={offer} seatId={seatId} />
                <div className="actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || !can(view, 'AcceptTrade')}
                    onClick={() => submit({ type: 'AcceptTrade', tradeId: offer.id })}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !can(view, 'RejectTrade')}
                    onClick={() => submit({ type: 'RejectTrade', tradeId: offer.id })}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {offers.mine.length === 0 ? null : (
        <section className="composer__group">
          <h4>Waiting on an answer</h4>
          <ul className="effects">
            {offers.mine.map((offer) => (
              <li key={offer.id}>
                <TradeSummary view={view} offer={offer} seatId={seatId} />
                <div className="actions">
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={busy || !can(view, 'CancelTrade')}
                    onClick={() => submit({ type: 'CancelTrade', tradeId: offer.id })}
                  >
                    Withdraw this offer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={busy || !tradeWindow || draft.kind === 'trade'}
          aria-pressed={draft.kind === 'trade'}
          onClick={open({
            kind: 'trade',
            opponentId: firstOpponentId,
            giveResources: NO_RESOURCES,
            receiveResources: NO_RESOURCES,
            giveTrickIds: [],
          })}
        >
          {view.activePlayerId === seatId ? 'Offer a trade' : 'Offer the active player a trade'}
        </button>
        {tradeWindow ? null : (
          <span className="hint">
            Trading is open during the active seat’s before-answer and action windows, and every
            trade must include that seat.
          </span>
        )}
      </div>

      {debts.length === 0 ? null : (
        <section className="composer__group composer__group--urgent">
          <h4>Auction debts</h4>
          <p className="hint">
            An unpaid debt blocks your purchases. It is repaid on your own turn.
          </p>
          <div className="actions">
            {debts.map((debt) => (
              <button
                key={debt.id}
                type="button"
                className="button button--primary"
                disabled={busy || !can(view, 'PayDebt')}
                onClick={open({ kind: 'debt', debtId: debt.id, payment: NO_RESOURCES })}
              >
                Pay {playerName(view, debt.creditorPlayerId)} — {debt.amount} outstanding
              </button>
            ))}
          </div>
        </section>
      )}

      {obligations.length === 0 ? null : (
        <section className="composer__group composer__group--urgent">
          <h4>Card obligations</h4>
          <div className="actions">
            {obligations.map((obligation) => (
              <button
                key={obligation.id}
                type="button"
                className="button button--primary"
                disabled={busy || !can(view, 'PayObligation')}
                onClick={() => submit({
                  type: 'PayObligation',
                  obligationId: obligation.id,
                  selection: { kind: 'resources', resources: KHAKI_TERROR_PAYMENT },
                })}
              >
                Settle {cardTitle(obligation.sourceCardId)} — one of each resource
              </button>
            ))}
          </div>
          <p className="hint">
            Relief Fund takes one cash, one influence, one press and one faith, and nothing else.
          </p>
        </section>
      )}

      {heldVoters.length === 0 ? null : (
        <section className="composer__group">
          <h4>Your voters an opponent holds</h4>
          {heldVoters.map((held) => (
            <div key={held.voterId} className="actions">
              <span>
                Held by {playerName(view, held.holderId)} through {cardTitle(held.sourceCardId)}.
              </span>
              {RESOURCE_ORDER.map((resource) => (
                <button
                  key={resource}
                  type="button"
                  className="button"
                  disabled={busy
                    || !can(view, 'BuyHeldVoter')
                    || (view.players.find((player) => player.id === seatId)?.resources[resource] ?? 0) < 1}
                  onClick={() => submit({
                    type: 'BuyHeldVoter',
                    sourceCardId: held.sourceCardId,
                    voterId: held.voterId,
                    payment: { ...NO_RESOURCES, [resource]: 1 },
                  })}
                >
                  Buy back for 1 {resource}
                </button>
              ))}
            </div>
          ))}
          <p className="hint">
            A voter bought back waits on your mat and is placed like any other group.
          </p>
        </section>
      )}

      {cults.length === 0 ? null : (
        <section className="composer__group">
          <h4>Loyal Base</h4>
          {cults.map((cult) => (
            <div key={cult.sourceCardId} className="actions">
              <button
                type="button"
                className="button"
                disabled={busy || !can(view, 'StealBase')}
                onClick={open({ kind: 'stealBase', sourceCardId: cult.sourceCardId, voterIds: [] })}
              >
                Steal it from {playerName(view, cult.ownerId)}
              </button>
              <span className="small">
                It currently shields {cult.zoneIds.map(zoneName).join(', ') || 'no zone'} from you.
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
