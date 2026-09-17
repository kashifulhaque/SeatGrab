/**
 * The controls that answer whatever the match is waiting on this seat for.
 *
 * Session 09 described each prompt in words and stopped there. This replaces the
 * description with a control, and keeps three things exactly as they were:
 *
 * 1. A prompt is rendered only from `LocalMatch.viewFor`. When the adapter refuses one,
 *    the refusal is drawn in place of the prompt, never a control beside it.
 * 2. Nothing here is private to anyone but the seat this is drawn for, and it is drawn
 *    only for `revealedSeatId(handoff)`.
 * 3. The hidden half of an Policy Card — which archetype an answer feeds and what it
 *    pays — stays hidden until the answer is committed, per section 13.5.
 *
 * Session 11 added the card-driven choices. All 41 of them arrive through one typed
 * contract — `allowed` names the selection kinds the interaction accepts and the context
 * variant carries the eligible sets — so one generic composer answers most of them, and
 * only the three with a shape of their own are hand-built: the auction, the campaign
 * vote, and the reaction window. A choice that picks areas rings them on the board below,
 * because its draft lives in `MatchShell` beside every other action draft.
 */
import { useEffect, useState } from 'react';

import type { GameCommand, PlayerView, ResourceVectorDto, StructuredChoicePromptView } from '@gerrymander/protocol';

import type { DrawableViewResult } from '../../transport';
import {
  NO_RESOURCES,
  RESOURCE_ORDER,
  cardRules,
  cardTitle,
  choiceCommand,
  choiceDraftMatches,
  choiceModel,
  describeSlotTarget,
  openChoiceDraft,
  playerName,
  reactionCardIds,
  startingResourceQuota,
  totalOf,
  withResource,
  zoneName,
  type ActionDraft,
  type ChoiceControl,
  type ChoiceDraft,
  type ChoiceOption,
  type DraftAction,
} from '../actions';

import { ResourcePicker } from './ResourcePicker';

export interface ComposerSubmit {
  /** Sends one command and reports the engine's refusal, if it refuses. */
  submit: (command: GameCommand) => void;
  /** True while a command is in flight, so a control cannot be pressed twice. */
  busy: boolean;
}

function Refusal({ message }: { message: string }) {
  return (
    <div className="alert alert--error" role="alert">
      <strong>This prompt cannot be shown.</strong> {message}
    </div>
  );
}

function FirstPlayerVote({
  view,
  seatId,
  submit,
  busy,
}: { view: PlayerView; seatId: string } & ComposerSubmit) {
  const candidates = view.players.filter((player) => player.id !== seatId);
  return (
    <div className="composer">
      <p>
        <strong>Vote for the first player.</strong> Nobody may vote for themselves, and a tied
        round is rerun until one seat leads alone.
      </p>
      <div className="actions">
        {candidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => submit({ type: 'VoteForFirstPlayer', candidateId: candidate.id })}
          >
            Vote for {candidate.displayName}
          </button>
        ))}
      </div>
    </div>
  );
}

function StartingResources({
  view,
  seatId,
  submit,
  busy,
}: { view: PlayerView; seatId: string } & ComposerSubmit) {
  const quota = startingResourceQuota(view, seatId);
  const [chosen, setChosen] = useState<ResourceVectorDto>(NO_RESOURCES);
  const total = totalOf(chosen);
  const problem = total === quota
    ? null
    : total < quota
      ? `Take ${quota - total} more.`
      : `Take ${total - quota} fewer.`;
  return (
    <div className="composer">
      <p>
        <strong>Take your starting resources.</strong> The first player takes one, the next two,
        and so on clockwise. This seat takes {quota}.
      </p>
      <ResourcePicker
        legend={`Choose ${quota} resource${quota === 1 ? '' : 's'}`}
        value={chosen}
        onChange={(resource, amount) => setChosen(withResource(chosen, resource, amount))}
        disabled={busy}
      />
      <p className="composer__status" role="status">
        {problem ?? `Taking ${total} of ${quota}.`}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || problem !== null}
          onClick={() => submit({ type: 'ChooseStartingResources', resources: chosen })}
        >
          Take these resources
        </button>
      </div>
    </div>
  );
}

function PolicyAnswer({
  prompt,
  held,
  submit,
  busy,
}: {
  prompt: Extract<PlayerView['prompt'], { kind: 'policyAnswer' }>;
  held: ResourceVectorDto;
} & ComposerSubmit) {
  const [redrawing, setRedrawing] = useState(false);
  const [payment, setPayment] = useState<ResourceVectorDto>(NO_RESOURCES);
  const paid = totalOf(payment);
  const overdrawn = RESOURCE_ORDER.find((resource) => payment[resource] > held[resource]);
  const redrawProblem = overdrawn !== undefined
    ? `You hold ${held[overdrawn]} ${overdrawn}, not ${payment[overdrawn]}.`
    : paid === 4
      ? null
      : paid < 4
        ? `A redraw costs four resources; allocate ${4 - paid} more.`
        : `A redraw costs four resources; remove ${paid - 4}.`;

  return (
    <div className="composer">
      <p className="prompt__question">{prompt.question}</p>
      <p className="hint">
        Which archetype each answer feeds, and what it pays, stay hidden until you choose. Your
        answer is final.
      </p>
      <ol className="prompt__answers">
        {prompt.answers.map((answer, index) => (
          <li key={answer.text}>
            <span>{answer.text}</span>
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() =>
                submit({ type: 'CommitPolicyAnswer', answerIndex: index === 0 ? 0 : 1 })}
            >
              Choose this answer
            </button>
          </li>
        ))}
      </ol>

      {redrawing ? (
        <>
          <ResourcePicker
            legend="Pay four resources to redraw"
            hint="A redraw discards this card and draws another. There is no discount on it."
            value={payment}
            held={held}
            onChange={(resource, amount) => setPayment(withResource(payment, resource, amount))}
            disabled={busy}
          />
          <p className="composer__status" role="status">{redrawProblem ?? 'Ready to redraw.'}</p>
          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy || redrawProblem !== null}
              onClick={() => submit({
                type: 'RedrawPolicy',
                payment: { resources: payment, discounts: NO_RESOURCES },
              })}
            >
              Pay and redraw
            </button>
            <button type="button" className="button button--quiet" onClick={() => setRedrawing(false)}>
              Keep this question
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="button" onClick={() => setRedrawing(true)}>
            Redraw for four resources
          </button>
        </div>
      )}
    </div>
  );
}

function CapDiscard({
  prompt,
  held,
  submit,
  busy,
}: {
  prompt: Extract<PlayerView['prompt'], { kind: 'capDiscard' }>;
  held: ResourceVectorDto;
} & ComposerSubmit) {
  const [discard, setDiscard] = useState<ResourceVectorDto>(NO_RESOURCES);
  const total = totalOf(discard);
  const overdrawn = RESOURCE_ORDER.find((resource) => discard[resource] > held[resource]);
  const problem = overdrawn !== undefined
    ? `You hold ${held[overdrawn]} ${overdrawn}, not ${discard[overdrawn]}.`
    : total === prompt.excess
      ? null
      : total < prompt.excess
        ? `Discard ${prompt.excess - total} more.`
        : `Discard ${total - prompt.excess} fewer.`;
  return (
    <div className="composer">
      <p>
        <strong>You are over your resource cap.</strong> Discard {prompt.excess} before anything
        else happens. The cap counts every type together, not each type separately.
      </p>
      <ResourcePicker
        legend={`Discard ${prompt.excess}`}
        value={discard}
        held={held}
        onChange={(resource, amount) => setDiscard(withResource(discard, resource, amount))}
        disabled={busy}
      />
      <p className="composer__status" role="status">{problem ?? 'Ready to discard.'}</p>
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || problem !== null}
          onClick={() => submit({ type: 'DiscardExcessResources', resources: discard })}
        >
          Discard these resources
        </button>
      </div>
    </div>
  );
}

function MajoritySelection({
  view,
  prompt,
  submit,
  busy,
}: {
  view: PlayerView;
  prompt: Extract<PlayerView['prompt'], { kind: 'majoritySelection' }>;
} & ComposerSubmit) {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const areaOf = (voterId: string): string => {
    const slot = view.slots.find((candidate) => candidate.voter?.id === voterId);
    return slot === undefined ? voterId : describeSlotTarget(slot.slotId);
  };
  const problem = chosen.length === prompt.required
    ? null
    : `Mark ${prompt.required} voter${prompt.required === 1 ? '' : 's'}; ${chosen.length} chosen.`;
  return (
    <div className="composer">
      <p>
        <strong>Mark your majority in {zoneName(prompt.zoneId)}.</strong> Choose exactly{' '}
        {prompt.required} of your {prompt.eligibleVoterIds.length} voters there. A marked voter
        scores and can no longer be moved by an ordinary gerrymander.
      </p>
      <ul className="choices">
        {prompt.eligibleVoterIds.map((voterId) => (
          <li key={voterId}>
            <label className="choice">
              <input
                type="checkbox"
                checked={chosen.includes(voterId)}
                disabled={busy || (chosen.length >= prompt.required && !chosen.includes(voterId))}
                onChange={() =>
                  setChosen(chosen.includes(voterId)
                    ? chosen.filter((id) => id !== voterId)
                    : [...chosen, voterId])}
              />
              <span>{areaOf(voterId)}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="composer__status" role="status">{problem ?? 'Ready to mark the majority.'}</p>
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || problem !== null}
          onClick={() => submit({
            type: 'SubmitChoice',
            interactionId: prompt.interactionId,
            selection: { kind: 'voters', voterIds: [...chosen] },
          })}
        >
          Mark these voters
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------- card-driven choices */

interface ChoiceProps extends ComposerSubmit {
  view: PlayerView;
  seatId: string;
  prompt: StructuredChoicePromptView;
  draft: ChoiceDraft;
  dispatch: (action: DraftAction) => void;
}

/** A list of candidates, one line each, chosen with a checkbox. */
function OptionList({
  legend,
  options,
  chosen,
  limit,
  onToggle,
  disabled,
}: {
  legend: string;
  options: readonly ChoiceOption[];
  chosen: readonly string[];
  limit: number;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="field">
      <span>{legend}</span>
      {options.length === 0 ? (
        <p className="field-problem">Nothing here is a legal choice.</p>
      ) : (
        <ul className="choices">
          {options.map((option) => (
            <li key={option.id}>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={chosen.includes(option.id)}
                  disabled={disabled || (chosen.length >= limit && !chosen.includes(option.id))}
                  onChange={() => onToggle(option.id)}
                />
                <span>
                  {option.label}
                  {option.detail === undefined ? null : (
                    <span className="hint"> {option.detail}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** What has been picked so far, in the order it was picked, each removable. */
function Picks({
  legend,
  entries,
  onRemove,
  disabled,
}: {
  legend: string;
  entries: readonly ChoiceOption[];
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <p className="composer__status">{legend}</p>
      <ul className="picks">
        {entries.map((entry, index) => (
          <li key={`${entry.id}-${index}`}>
            <span>
              {index + 1}. {entry.label}
            </span>
            <button
              type="button"
              className="button button--quiet"
              disabled={disabled}
              onClick={() => onRemove(entry.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function labelOfPick(
  view: PlayerView,
  control: Extract<ChoiceControl, { select: 'board' }>,
  id: string,
): string {
  if (control.of === 'slots') return describeSlotTarget(id);
  const slot = view.slots.find((candidate) => candidate.voter?.id === id);
  return slot === undefined ? id : describeSlotTarget(slot.slotId);
}

function ChoiceControls({
  view,
  seatId,
  prompt,
  draft,
  dispatch,
  busy,
}: Omit<ChoiceProps, 'submit'>) {
  const model = choiceModel(view, seatId, prompt, draft);
  return (
    <>
      {model.controls.map((control, index) => {
        switch (control.select) {
          case 'option':
            return (
              <label className="field" key={`option-${index}`}>
                <span>{control.label}</span>
                <select
                  className="input"
                  value={draft.optionId ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({
                      type: 'choiceOption',
                      optionId: event.target.value === '' ? null : event.target.value,
                    })}
                >
                  <option value="">
                    {control.options.length === 0 ? 'Nothing is legal here' : 'Choose one…'}
                  </option>
                  {control.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );

          case 'players':
            return (
              <OptionList
                key={`players-${index}`}
                legend={control.label}
                options={control.options}
                chosen={draft.playerIds}
                limit={control.maximum}
                disabled={busy}
                onToggle={(id) =>
                  dispatch({ type: 'choiceToggle', list: 'players', id, limit: control.maximum })}
              />
            );

          case 'cards':
            return (
              <OptionList
                key={`cards-${index}`}
                legend={control.label}
                options={control.options}
                chosen={draft.cardIds}
                limit={control.maximum}
                disabled={busy}
                onToggle={(id) =>
                  dispatch({ type: 'choiceToggle', list: 'cards', id, limit: control.maximum })}
              />
            );

          case 'assign':
            return (
              <fieldset className="field" key={`assign-${index}`}>
                <span>{control.label}</span>
                <ul className="picks">
                  {control.rows.map((row, rowIndex) => (
                    <li key={row.id}>
                      <span>{row.label}</span>
                      <select
                        className="input"
                        aria-label={`Recipient for ${row.label}`}
                        value={draft.playerIds[rowIndex] ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          dispatch({
                            type: 'choiceAssign',
                            index: rowIndex,
                            playerId: event.target.value,
                          })}
                      >
                        <option value="">Choose a recipient…</option>
                        {control.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </fieldset>
            );

          case 'board': {
            const chosen = control.of === 'voters' ? draft.voterIds : draft.slotIds;
            const list = control.of === 'voters' ? 'voters' : 'slots';
            return (
              <div key={`board-${index}`}>
                <Picks
                  legend={`Chosen so far: ${chosen.length}`}
                  entries={chosen.map((id) => ({ id, label: labelOfPick(view, control, id) }))}
                  disabled={busy}
                  onRemove={(id) =>
                    dispatch({ type: 'choiceToggle', list, id, limit: control.maximum })}
                />
                <OptionList
                  legend={control.label}
                  options={control.options}
                  chosen={[]}
                  limit={control.maximum}
                  disabled={busy || chosen.length >= control.maximum}
                  onToggle={(id) =>
                    dispatch({ type: 'choiceToggle', list, id, limit: control.maximum })}
                />
                <p className="hint">
                  The same areas are ringed on the board below; choosing one there does the same
                  thing.
                </p>
              </div>
            );
          }

          case 'resources':
            return (
              <ResourcePicker
                key={`resources-${index}`}
                legend={control.label}
                value={draft.resources}
                onChange={(resource, amount) =>
                  dispatch({ type: 'resource', field: 'selection', resource, amount })}
                disabled={busy}
              />
            );
        }
      })}
      {model.note === undefined ? null : <p className="hint">{model.note}</p>}
    </>
  );
}

/**
 * The generic composer, which answers every choice that is not an auction, a vote or a
 * reaction window.
 *
 * `explanation` is shown exactly as the engine wrote it. It is authored to be read by a
 * player, the privacy tests scan it, and rewording it here would put this screen between
 * a ruling and the person it is addressed to.
 */
function GenericChoice({ view, seatId, prompt, draft, dispatch, submit, busy }: ChoiceProps) {
  const outcome = choiceCommand(view, seatId, prompt, draft);
  return (
    <div className="composer">
      <p className="prompt__question">{prompt.explanation}</p>
      {prompt.sourceCardId === undefined ? null : (
        <p className="hint">From {cardTitle(prompt.sourceCardId)}.</p>
      )}
      <ChoiceControls
        view={view}
        seatId={seatId}
        prompt={prompt}
        draft={draft}
        dispatch={dispatch}
        busy={busy}
      />
      <p className="composer__status" role="status">
        {outcome.ok ? 'Ready.' : outcome.problem}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !outcome.ok}
          onClick={() => {
            if (outcome.ok) submit(outcome.command);
          }}
        >
          Submit this choice
        </button>
        {prompt.allowPass ? (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => submit({
              type: 'SubmitChoice',
              interactionId: prompt.interactionId,
              selection: { kind: 'pass' },
            })}
          >
            Pass on this
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The campaign vote. The ballot is secret, so it never leaves this seat's surface. */
function CampaignVote({ view, seatId, prompt, draft, dispatch, submit, busy }: ChoiceProps) {
  if (prompt.context.op !== 'campaignVote') return null;
  const context = prompt.context;
  const outcome = choiceCommand(view, seatId, prompt, draft);
  return (
    <div className="composer">
      <p className="prompt__question">{prompt.explanation}</p>
      <p className="hint">
        Round {context.round}. {context.ballotsCast} ballot{context.ballotsCast === 1 ? '' : 's'}{' '}
        cast. Nobody sees who you voted for, and a tie reruns the whole round.
      </p>
      <ul className="choices">
        {context.candidateIds
          .filter((candidateId) => candidateId !== seatId)
          .map((candidateId) => (
            <li key={candidateId}>
              <label className="choice">
                <input
                  type="radio"
                  name={`ballot-${prompt.interactionId}`}
                  checked={draft.optionId === candidateId}
                  disabled={busy}
                  onChange={() => dispatch({ type: 'choiceOption', optionId: candidateId })}
                />
                <span>{playerName(view, candidateId)}</span>
              </label>
            </li>
          ))}
      </ul>
      <p className="composer__status" role="status">
        {outcome.ok ? 'Ready to cast.' : outcome.problem}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !outcome.ok}
          onClick={() => {
            if (outcome.ok) submit(outcome.command);
          }}
        >
          Cast this ballot
        </button>
      </div>
    </div>
  );
}

/** One round of bidding. The card being sold stays hidden; only the price is public. */
function Auction({ view, seatId, prompt, draft, dispatch, submit, busy }: ChoiceProps) {
  if (prompt.context.op !== 'auction') return null;
  const context = prompt.context;
  const floor = Math.max(context.minimumBid, context.currentBid + 1);
  const cap = view.players.find((player) => player.id === seatId)?.resourceCap ?? 0;
  const outcome = choiceCommand(view, seatId, prompt, draft);
  return (
    <div className="composer">
      <p className="prompt__question">{prompt.explanation}</p>
      <p className="hint">
        {playerName(view, context.sellerId)} is selling a trick only they have seen.{' '}
        {context.currentBidderId === undefined || context.currentBid === 0
          ? `No bid yet; the reserve is ${context.minimumBid}.`
          : `${playerName(view, context.currentBidderId)} leads at ${context.currentBid}.`}{' '}
        A winning bid becomes a debt to the seller, and an unpaid debt blocks your purchases.
      </p>
      <label className="field">
        <span>Your bid — at least {floor}, and never more than your cap of {cap}</span>
        <span className="picker__stepper">
          <button
            type="button"
            className="button button--quiet picker__step"
            aria-label="Lower the bid"
            disabled={busy || draft.bid <= 0}
            onClick={() => dispatch({ type: 'choiceBid', amount: draft.bid - 1 })}
          >
            −
          </button>
          <output className="picker__amount" aria-label="Bid">{draft.bid}</output>
          <button
            type="button"
            className="button button--quiet picker__step"
            aria-label="Raise the bid"
            disabled={busy}
            onClick={() => dispatch({ type: 'choiceBid', amount: draft.bid + 1 })}
          >
            +
          </button>
        </span>
      </label>
      <p className="composer__status" role="status">
        {outcome.ok ? `Ready to bid ${draft.bid}.` : outcome.problem}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !outcome.ok}
          onClick={() => {
            if (outcome.ok) submit(outcome.command);
          }}
        >
          Place this bid
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => submit({ type: 'PassAuction', interactionId: prompt.interactionId })}
        >
          Pass — I am out of this auction
        </button>
      </div>
      {context.passedPlayerIds.length === 0 ? null : (
        <p className="hint">
          Already out: {context.passedPlayerIds.map((id) => playerName(view, id)).join(', ')}.
        </p>
      )}
    </div>
  );
}

/**
 * The reaction window, which moves the decision to a seat whose turn it is not.
 *
 * Only Veto and Boomerang can answer, and Boomerang only answers the tricks the engine
 * lists as reversible, so a card it would refuse is not offered.
 */
function ReactionWindow({ view, seatId, prompt, submit, busy }: Omit<ChoiceProps, 'draft' | 'dispatch'>) {
  if (prompt.context.op !== 'trickPriority') return null;
  const context = prompt.context;
  const playable = reactionCardIds(view, seatId, context.playedCardId, context.playedByPlayerId);
  return (
    <div className="composer">
      <p className="prompt__question">{prompt.explanation}</p>
      <p className="hint">
        {playerName(view, context.playedByPlayerId)} played {cardTitle(context.playedCardId)}:{' '}
        {cardRules(context.playedCardId) ?? 'its rules text is not in this content pack.'}
      </p>
      {playable.length === 0 ? (
        <p className="notice">
          You hold nothing that answers this card. Passing lets it resolve.
        </p>
      ) : (
        <ul className="choices">
          {playable.map((cardId) => (
            <li key={cardId}>
              <span>
                <strong>{cardTitle(cardId)}</strong>
                <span className="hint"> {cardRules(cardId)}</span>
              </span>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => submit({
                  type: 'PlayReaction',
                  cardId,
                  targetEffectId: prompt.interactionId,
                })}
              >
                Play {cardTitle(cardId)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => submit({ type: 'PassPriority', interactionId: prompt.interactionId })}
        >
          Pass priority
        </button>
      </div>
      {context.passedPlayerIds.length === 0 ? null : (
        <p className="hint">
          Already passed: {context.passedPlayerIds.map((id) => playerName(view, id)).join(', ')}.
        </p>
      )}
    </div>
  );
}

/**
 * Opens the draft this prompt is answered with, then hands off to its composer.
 *
 * The draft belongs to `MatchShell` rather than to this component because the board below
 * rings the areas it may still take, and because passing the device clears it — which is
 * exactly what a secret ballot and a secret Karachi selection need.
 */
function ChoicePrompt({
  view,
  seatId,
  prompt,
  draft,
  dispatch,
  submit,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  prompt: StructuredChoicePromptView;
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
} & ComposerSubmit) {
  const matched = choiceDraftMatches(draft, prompt);
  useEffect(() => {
    if (!matched) dispatch({ type: 'open', draft: openChoiceDraft(prompt) });
  }, [dispatch, matched, prompt]);

  if (prompt.context.op === 'trickPriority') {
    return (
      <ReactionWindow view={view} seatId={seatId} prompt={prompt} submit={submit} busy={busy} />
    );
  }
  if (!choiceDraftMatches(draft, prompt)) {
    return <p role="status">Opening this decision…</p>;
  }
  const shared = { view, seatId, prompt, draft, dispatch, submit, busy };
  if (prompt.context.op === 'campaignVote') return <CampaignVote {...shared} />;
  if (prompt.context.op === 'auction') return <Auction {...shared} />;
  return <GenericChoice {...shared} />;
}

export function PromptComposer({
  result,
  seatId,
  draft,
  dispatch,
  submit,
  busy,
}: {
  result: DrawableViewResult;
  seatId: string;
  /** The open action draft, which a card-driven choice is answered through. */
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
} & ComposerSubmit) {
  if (!result.ok) return <Refusal message={result.message} />;

  const view = result.view;
  const prompt = view.prompt;
  const held = view.players.find((player) => player.id === seatId)?.resources ?? NO_RESOURCES;

  if (prompt === undefined) return <p>Nothing is waiting on this seat right now.</p>;

  switch (prompt.kind) {
    case 'firstPlayerVote':
      return <FirstPlayerVote view={view} seatId={seatId} submit={submit} busy={busy} />;
    case 'startingResources':
      return <StartingResources view={view} seatId={seatId} submit={submit} busy={busy} />;
    case 'policyAnswer':
      return <PolicyAnswer prompt={prompt} held={held} submit={submit} busy={busy} />;
    case 'capDiscard':
      return <CapDiscard prompt={prompt} held={held} submit={submit} busy={busy} />;
    case 'majoritySelection':
      return <MajoritySelection view={view} prompt={prompt} submit={submit} busy={busy} />;
    case 'choice':
      return (
        <ChoicePrompt
          view={view}
          seatId={seatId}
          prompt={prompt}
          draft={draft}
          dispatch={dispatch}
          submit={submit}
          busy={busy}
        />
      );
  }
}
