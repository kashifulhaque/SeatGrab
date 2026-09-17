/**
 * One seat's own surface: what it is being asked, what it may do, and what it holds.
 *
 * This was the `PrivateSurface` inside `MatchShell` until Session 15 gave the same seat a
 * second screen to appear on. It is one component rather than two because the contents
 * are not a property of the transport: a seat's prompt, its mat, its committed policy
 * cards, its hand and its evicted voters are the same things whether the state is in this
 * browser or on a server, and they are drawn from a projection either way. Two copies
 * would be two places for the privacy rules to drift apart, in the part of the
 * application where drift is least affordable.
 *
 * What *is* a property of the transport is who may see this, and that stays outside:
 *
 * - Locally, one device shows several seats, so `MatchShell` renders this only for
 *   `revealedSeatId(handoff)` and puts the privacy cover in front of everything else.
 * - Online, one device holds one credential and the server never sends it another seat's
 *   private data at all. There is nothing to cover and nothing to pass.
 *
 * The column is built around one question — what should this player do now? — and
 * answers it once, at the top, in the **Now** card. The card carries `guidance` from
 * `actions.ts` as its title, and its body is whichever of these applies: the prompt the
 * match is waiting on, the action being composed, or nothing when the seat is free to
 * choose. Under it, **What you can do** lists the market cards, the trick purchase,
 * the gerrymander and the unlocked powers; it is folded shut while a prompt blocks them,
 * so a first-time player is not offered a market they cannot use before a question they
 * must answer. Trades, the mat, the hand and the rules are collapsed drawers below.
 * Nothing draws a heading over an empty state.
 *
 * Every rule below comes from `actions.ts`, and the engine re-checks all of it. Nothing
 * here decides what is legal, and nothing here rewords a refusal.
 *
 * Two things this column does about *where the player is looking*, both from a playtest
 * where a purchase opened off the top of the column and the player went looking for it:
 *
 * - When the Now card becomes a new thing — a prompt arrives, an action opens — the card
 *   is scrolled into view, takes focus and flashes once. The column is its own scrolling
 *   box under a pinned bar, so an action opening above the scroll position was silent.
 * - While an action is open, **What you can do** folds shut. The open action is then the
 *   only thing in the column, which is the point: one thing is being done, and the list
 *   the player just chose from is not competing with it. Cancelling opens the list again.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { CORE_CONTENT } from '@seatgrab/engine';
import type { GameCommand } from '@seatgrab/protocol';

import { PARTY_BY_ID } from '../assets/manifest';
import type { DrawableViewResult } from '../transport';

import { HowToPlay } from './HowToPlay';
import { Market } from './Market';
import { PartyMark } from './PartyMark';
import {
  NO_PAYMENT,
  NO_RESOURCES,
  actionAvailability,
  campaignAttention,
  guidance,
  openingPayment,
  purchaseCost,
  type ActionDraft,
  type DraftAction,
  type Targeting,
} from './actions';
import {
  CampaignComposer,
  CampaignDraftComposer,
  TrickHand,
  isCampaignDraft,
} from './composers/CampaignComposer';
import { PlayerMat } from './composers/PlayerMat';
import { PromptComposer } from './composers/PromptComposer';
import {
  PendingVoters,
  TurnComposer,
  TurnDraftComposer,
  isTurnDraft,
} from './composers/TurnComposer';

const POLICY_CARDS = new Map(CORE_CONTENT.policyCards.map((card) => [card.id, card]));

/**
 * A name for whatever the Now card is currently about.
 *
 * It changes exactly when the card's contents become a different thing to do, which is
 * when the card is worth pointing the player at. It is deliberately not the draft object:
 * editing a payment inside an open purchase is the same action, and must not re-scroll
 * the column out from under the stepper being pressed.
 */
function nowSubject(draft: ActionDraft, promptKey: string | null): string {
  if (promptKey !== null) return `prompt:${promptKey}`;
  switch (draft.kind) {
    case 'none':
      return 'free';
    case 'influence':
      return `influence:${draft.cardId}`;
    case 'place':
      return `place:${draft.groupId}`;
    case 'gerrymander':
      return `gerrymander:${draft.rightsZoneId}`;
    default:
      return draft.kind;
  }
}

/**
 * `Your turn`, said once, over the table.
 *
 * A turn arriving used to be a quiet change of wording in a pinned bar. This is the
 * announcement: it shows for a moment when the turn becomes this seat's and then leaves
 * on its own. It covers nothing — it is not a dialog, takes no focus and has no control —
 * so a player who is already acting is never interrupted by it.
 */
function TurnFanfare({ on, label }: { on: boolean; label: string }) {
  const [shown, setShown] = useState(0);
  const was = useRef(on);
  useEffect(() => {
    if (on && !was.current) setShown((count) => count + 1);
    was.current = on;
  }, [on]);
  useEffect(() => {
    if (shown === 0) return;
    const timer = setTimeout(() => setShown(0), 2000);
    return () => clearTimeout(timer);
  }, [shown]);
  if (shown === 0) return null;
  return (
    <div key={shown} className="fanfare" role="status" aria-live="polite">
      <span className="fanfare__text">{label}</span>
    </div>
  );
}

export function SeatSurface({
  result,
  seatId,
  draft,
  dispatch,
  targeting,
  submit,
  busy,
  failure,
  finished,
}: {
  result: DrawableViewResult;
  seatId: string;
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
  targeting: Targeting | null;
  submit: (command: GameCommand) => void;
  busy: boolean;
  /** The last refusal for this seat, shown exactly as it was written. */
  failure: string | null;
  /** True once the match is over. No composer is drawn; the seat may still read. */
  finished: boolean;
}) {
  const view = result.view;
  const me = view.players.find((player) => player.id === seatId);
  const prompt = result.ok ? view.prompt : undefined;
  const hasPrompt = !result.ok || prompt !== undefined;
  const composing = isTurnDraft(draft) || isCampaignDraft(draft);
  const acting = actionAvailability(view, seatId, 'InfluenceVoterCard');
  const hand = view.privateTrickIds?.length ?? 0;
  const policy = view.privatePolicyCards?.length ?? 0;
  const evicted = view.privateEvictedVoters?.length ?? 0;
  const openCardId = draft.kind === 'influence' ? draft.cardId : null;
  const held = me?.resources ?? NO_RESOURCES;
  const guide = guidance(view, seatId, draft);
  const partyColor = me === undefined ? undefined : PARTY_BY_ID.get(me.partyId)?.color;
  const campaignWaiting = result.ok && campaignAttention(view, seatId, draft);

  const nowKind = hasPrompt ? 'prompt' : composing ? 'composing' : 'free';

  // Scroll the Now card back under the player's eye whenever it becomes a new thing, and
  // flash it once so the change is seen rather than merely present. `scrollIntoView` is
  // guarded because jsdom, which the render tests use, does not implement it.
  const nowRef = useRef<HTMLElement>(null);
  const subject = nowSubject(
    draft,
    hasPrompt ? (prompt === undefined ? 'refusal' : `${prompt.kind}:${prompt.interactionId}`) : null,
  );
  const [arrivals, setArrivals] = useState(0);
  const lastSubject = useRef(subject);
  useEffect(() => {
    if (lastSubject.current === subject) return;
    lastSubject.current = subject;
    if (subject === 'free' || finished) return;
    const card = nowRef.current;
    if (card === null) return;
    card.focus?.({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    setArrivals((count) => count + 1);
  }, [finished, subject]);

  // "What you can do" folds away while an action is open, so the open action is the only
  // thing in the column. Reopening it by hand while composing is allowed and sticks.
  const [optionsOpen, setOptionsOpen] = useState(acting.can);
  const optionsState = useRef({ can: acting.can, composing });
  useEffect(() => {
    const was = optionsState.current;
    if (was.can === acting.can && was.composing === composing) return;
    optionsState.current = { can: acting.can, composing };
    setOptionsOpen(acting.can && !composing);
  }, [acting.can, composing]);

  const myTurn = !finished && !hasPrompt && view.activePlayerId === seatId;

  return (
    <div
      className="seat-surface"
      style={partyColor === undefined ? undefined : ({ '--party': partyColor } as CSSProperties)}
    >
      <TurnFanfare on={myTurn} label="Your turn" />
      <section className="panel private action-column" aria-labelledby="private-heading">
        <header className="seat-head">
          <PartyMark partyId={me?.partyId ?? ''} size={36} />
          <h2 id="private-heading" className="seat-head__name">{me?.displayName ?? seatId}</h2>
          <span className="seat-head__you">Your cards</span>
        </header>

        {failure === null ? null : (
          <p className="alert alert--error" role="alert">
            {failure}
          </p>
        )}

        {finished ? (
          <p>
            The match is over, so nothing is waiting on you and no action is offered. Your
            cards and your mat are below as they finished; the results are above.
          </p>
        ) : (
          <>
            {/* The one thing to do now, and the control that does it, in one card. */}
            <section
              ref={nowRef}
              tabIndex={-1}
              className={`now now--${nowKind}`}
              aria-labelledby="now-heading"
            >
              {arrivals === 0 ? null : (
                <span key={arrivals} className="now__flash" aria-hidden="true" />
              )}
              <p className="now__eyebrow">
                {nowKind === 'prompt' ? 'Your prompt' : nowKind === 'composing' ? 'Your action' : 'Now'}
              </p>
              <div className="now__head">
                <h3 id="now-heading" className="now__news">{guide.news}</h3>
                {nowKind === 'composing' ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => dispatch({ type: 'close' })}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
              {nowKind === 'composing' ? null : <p className="now__detail">{guide.detail}</p>}

              {nowKind === 'free' && result.ok ? (
                <PendingVoters
                  view={view}
                  seatId={seatId}
                  draft={draft}
                  dispatch={dispatch}
                  submit={submit}
                  busy={busy}
                />
              ) : null}

              {nowKind === 'prompt' ? (
                <div className="now__body">
                  <PromptComposer
                    key={prompt === undefined ? 'refusal' : `${prompt.kind}:${prompt.interactionId}`}
                    result={result}
                    seatId={seatId}
                    draft={draft}
                    dispatch={dispatch}
                    submit={submit}
                    busy={busy}
                  />
                </div>
              ) : null}

              {nowKind === 'composing' ? (
                <div className="now__body">
                  {isTurnDraft(draft) ? (
                    <TurnDraftComposer
                      view={view}
                      seatId={seatId}
                      draft={draft}
                      dispatch={dispatch}
                      targeting={targeting}
                      submit={submit}
                      busy={busy}
                    />
                  ) : (
                    <CampaignDraftComposer
                      view={view}
                      seatId={seatId}
                      draft={draft}
                      dispatch={dispatch}
                      targeting={targeting}
                      submit={submit}
                      busy={busy}
                    />
                  )}
                </div>
              ) : null}
            </section>

            {result.ok ? (
              <details
                className="drawer drawer--options"
                open={optionsOpen}
                onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
              >
                <summary>
                  <h3>What you can do</h3>
                  {composing ? (
                    <span className="small">Paused — finish or cancel above</span>
                  ) : acting.can ? (
                    <span className="small">Voter cards, a trick, powers</span>
                  ) : (
                    <span className="small">Not right now</span>
                  )}
                </summary>
                {acting.can ? null : (
                  <p id="actions-reason" className="action-block__note" role="status">
                    {acting.reason}
                  </p>
                )}
                <h4 className="options__label">Voter market</h4>
                <Market
                  view={view}
                  buy={{
                    seatId,
                    can: acting.can,
                    busy,
                    openCardId,
                    reasonId: 'actions-reason',
                    onBuy: (cardId) => {
                      // The composer opens with the printed price already allocated.
                      const cost = purchaseCost(view, seatId, cardId);
                      dispatch({
                        type: 'open',
                        draft: {
                          kind: 'influence',
                          cardId,
                          groundswell: false,
                          payment: cost === null ? NO_PAYMENT : openingPayment(cost, held),
                        },
                      });
                    },
                  }}
                />
                {acting.can ? (
                  <>
                    <h4 className="options__label">Other actions</h4>
                    <TurnComposer
                      view={view}
                      seatId={seatId}
                      draft={draft}
                      dispatch={dispatch}
                      targeting={targeting}
                      submit={submit}
                      busy={busy}
                    />
                  </>
                ) : null}
              </details>
            ) : null}

            {result.ok ? (
              <details className="drawer" open={campaignWaiting}>
                <summary>
                  <h3>Trades, reactions, and debts</h3>
                  {campaignWaiting ? <span className="drawer__flag">Waiting on you</span> : null}
                </summary>
                <CampaignComposer
                  view={view}
                  seatId={seatId}
                  draft={draft}
                  dispatch={dispatch}
                  targeting={targeting}
                  submit={submit}
                  busy={busy}
                />
              </details>
            ) : null}
          </>
        )}
      </section>

      <section className="panel private private-drawer" aria-label="Your mat and cards">
        <details className="drawer">
          <summary>
            <h3>Player mat</h3>
            <span className="small">Four archetypes · eight powers</span>
          </summary>
          <PlayerMat view={view} seatId={seatId} showUsage={view.activePlayerId === seatId} />
        </details>

        <details className="drawer">
          <summary>
            <h3>Hand</h3>
            <span className="small">
              {hand} conspirac{hand === 1 ? 'y' : 'ies'} · {policy} policy card{policy === 1 ? '' : 's'}
            </span>
          </summary>
          <h4>Trick cards</h4>
          <TrickHand view={view} seatId={seatId} submit={submit} busy={busy} readOnly={finished || !result.ok} />
          <h4>Committed policy cards</h4>
          {policy === 0 ? (
            <p className="small">None yet. Opponents only ever see your per-archetype counts.</p>
          ) : (
            <ul className="private__cards">
              {(view.privatePolicyCards ?? []).map((card, index) => {
                const definition = POLICY_CARDS.get(card.cardId);
                return (
                  <li key={`${card.cardId}-${index}`}>
                    <strong>{card.archetype}</strong>
                    {definition === undefined ? null : (
                      <>
                        <span>{definition.question}</span>
                        <span className="small">You answered: {definition.answers[card.answerIndex].text}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </details>

        {evicted === 0 ? null : (
          <details className="drawer">
            <summary>
              <h3>Evicted voters</h3>
              <span className="small">{evicted} waiting to return to your mat</span>
            </summary>
            <ul className="private__cards">
              {(view.privateEvictedVoters ?? []).map((voter) => (
                <li key={voter.id}>
                  Returns on turn {voter.availableOnTurnOrdinal}
                  {voter.availableOnTurnOrdinal <= view.turnOrdinal ? ' — due now' : ''}.
                </li>
              ))}
            </ul>
          </details>
        )}

        <HowToPlay />
      </section>
    </div>
  );
}
