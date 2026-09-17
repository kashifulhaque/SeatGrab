/**
 * One seat's own surface: what it is being asked, what it may do, and what it holds.
 *
 * It is one component rather than two because the contents are not a property of the
 * transport: a seat's prompt, its mat, its committed policy cards, its hand and its
 * evicted voters are the same things whether the state is in this browser or on a
 * server, and they are drawn from a projection either way. Two copies would be two
 * places for the privacy rules to drift apart, in the part of the application where
 * drift is least affordable.
 *
 * What *is* a property of the transport is who may see this, and that stays outside:
 *
 * - Locally, one device shows several seats, so `MatchShell` renders this only for
 *   `revealedSeatId(handoff)` and puts the privacy cover in front of everything else.
 * - Online, one device holds one credential and the server never sends it another seat's
 *   private data at all. There is nothing to cover and nothing to pass.
 *
 * The surface is the body of the action sheet. The sheet's header carries the one line
 * that says what to do — `guidance(view, seatId, draft).news` — and End turn, so this
 * body never repeats the heading: it goes straight to the thing. The body is whichever
 * of these applies: the prompt the match is waiting on, the action being composed, or,
 * when the seat is free to choose, the market with the other actions under it. Trades,
 * the mat and the hand are collapsed drawers below. Nothing draws a heading over an empty
 * state, and nothing here explains a control the composer already explains.
 *
 * `seatSheet` builds what the layout needs from the same props: the headline, the tray of
 * waiting voters, the body and a subject key. Both shells call it, so the two screens
 * cannot compose the seat differently.
 *
 * Every rule below comes from `actions.ts`, and the engine re-checks all of it. Nothing
 * here decides what is legal, and nothing here rewords a refusal.
 */
import { useEffect, useRef, useState } from 'react';

import { CORE_CONTENT } from '@gerrymander/engine';
import type { GameCommand } from '@gerrymander/protocol';

import type { DrawableViewResult } from '../transport';

import { Market } from './Market';
import { PolicyCardCommitted } from './cards';
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
import { VoterTray } from './match/VoterTray';
import type { SeatSheet } from './TableSurface';

const POLICY_CARDS = new Map(CORE_CONTENT.policyCards.map((card) => [card.id, card]));

/**
 * A name for whatever the sheet is currently about.
 *
 * It changes exactly when the body becomes a different thing to do, which is when the
 * sheet is worth opening for the player. It is deliberately not the draft object: editing
 * a payment inside an open purchase is the same action, and must not re-scroll the sheet
 * out from under the stepper being pressed.
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
 * This is the announcement: it shows for a moment when the turn becomes this seat's and
 * then leaves on its own. It covers nothing — it is not a dialog, takes no focus and has
 * no control — so a player who is already acting is never interrupted by it.
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

export interface SeatSurfaceProps {
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
}

function promptKeyOf(result: DrawableViewResult): string | null {
  if (!result.ok) return 'refusal';
  const prompt = result.view.prompt;
  return prompt === undefined ? null : `${prompt.kind}:${prompt.interactionId}`;
}

/** What the layout needs from a revealed seat, built once from the same props. */
export function seatSheet(props: SeatSurfaceProps): SeatSheet {
  const { result, seatId, draft, dispatch, busy, finished } = props;
  const guide = guidance(result.view, seatId, draft);
  const subject = finished ? 'finished' : nowSubject(draft, promptKeyOf(result));
  return {
    seatId,
    news: guide.news,
    subject,
    ...(finished || !result.ok
      ? {}
      : { tray: <VoterTray view={result.view} seatId={seatId} draft={draft} dispatch={dispatch} busy={busy} /> }),
    body: <SeatSurface key={seatId} {...props} />,
  };
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
}: SeatSurfaceProps) {
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
  const campaignWaiting = result.ok && campaignAttention(view, seatId, draft);

  const nowKind = hasPrompt ? 'prompt' : composing ? 'composing' : 'free';

  // Scroll the current thing back under the player's eye whenever it becomes a new thing,
  // and flash it once so the change is seen rather than merely present. `scrollIntoView`
  // is guarded because jsdom, which the render tests use, does not implement it.
  const nowRef = useRef<HTMLElement>(null);
  const subject = nowSubject(draft, promptKeyOf(result));
  const [arrivals, setArrivals] = useState(0);
  const lastSubject = useRef(subject);
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  useEffect(() => {
    if (lastSubject.current === subject) return;
    lastSubject.current = subject;
    if (subject === 'free' || finished) return;
    const card = nowRef.current;
    if (card === null) return;
    card.focus?.({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    setArrivals((count) => count + 1);
  }, [finished, reducedMotion, subject]);

  const myTurn = !finished && !hasPrompt && view.activePlayerId === seatId;

  return (
    <div className="ms-seat" data-seat-surface={seatId}>
      <TurnFanfare on={myTurn} label="Your turn" />

      {failure === null ? null : (
        <p className="alert alert--error ms-seat__failure" role="alert">
          {failure}
        </p>
      )}

      {finished ? (
        <p className="ms-seat__finished">
          The match is over, so nothing is waiting on you and no action is offered. Your
          cards and your mat are below as they finished; the results are above.
        </p>
      ) : (
        <>
          {nowKind === 'prompt' ? (
            <section
              ref={nowRef}
              tabIndex={-1}
              className="ms-now ms-now--prompt"
              aria-label="Your prompt"
              data-coach-anchor="prompt"
            >
              {arrivals === 0 ? null : <span key={arrivals} className="ms-now__flash" aria-hidden="true" />}
              <PromptComposer
                key={prompt === undefined ? 'refusal' : `${prompt.kind}:${prompt.interactionId}`}
                result={result}
                seatId={seatId}
                draft={draft}
                dispatch={dispatch}
                submit={submit}
                busy={busy}
              />
            </section>
          ) : null}

          {nowKind === 'composing' ? (
            <section
              ref={nowRef}
              tabIndex={-1}
              className="ms-now ms-now--composing"
              aria-label="Your action"
              data-coach-anchor="composer"
            >
              {arrivals === 0 ? null : <span key={arrivals} className="ms-now__flash" aria-hidden="true" />}
              <div className="ms-now__bar">
                <span className="ms-now__eyebrow">Your action</span>
                <button
                  type="button"
                  className="button button--quiet ms-now__cancel"
                  onClick={() => dispatch({ type: 'close' })}
                >
                  Cancel
                </button>
              </div>
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
            </section>
          ) : null}

          {nowKind === 'free' && result.ok ? (
            <>
              <p className="ms-seat__detail">{guide.detail}</p>
              <PendingVoters
                view={view}
                seatId={seatId}
                draft={draft}
                dispatch={dispatch}
                submit={submit}
                busy={busy}
              />
              <section className="ms-market" aria-labelledby="market-heading" data-coach-anchor="market">
                <h3 id="market-heading" className="ms-seat__label">Voter market</h3>
                {acting.can ? null : (
                  <p id="actions-reason" className="ms-seat__note" role="status">
                    {acting.reason}
                  </p>
                )}
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
              </section>
              {acting.can ? (
                <details className="drawer ms-drawer" data-coach-anchor="other-actions">
                  <summary>
                    <h3>Other actions</h3>
                    <span className="small">A trick, redistricting, powers</span>
                  </summary>
                  <TurnComposer
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
          ) : null}

          {result.ok ? (
            <details className="drawer ms-drawer" open={campaignWaiting} data-coach-anchor="trades">
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

      <details className="drawer ms-drawer" data-coach-anchor="mat">
        <summary>
          <h3>Player mat</h3>
          <span className="small">Four archetypes · eight powers</span>
        </summary>
        <PlayerMat view={view} seatId={seatId} showUsage={view.activePlayerId === seatId} />
      </details>

      <details className="drawer ms-drawer" data-coach-anchor="hand">
        <summary>
          <h3>Hand</h3>
          <span className="small">
            {hand} trick card{hand === 1 ? '' : 's'} · {policy} policy card{policy === 1 ? '' : 's'}
          </span>
        </summary>
        <h4>Trick cards</h4>
        <TrickHand view={view} seatId={seatId} submit={submit} busy={busy} readOnly={finished || !result.ok} />
        <h4>Committed policy cards</h4>
        {policy === 0 ? (
          <p className="small">None yet. Opponents only ever see your per-archetype counts.</p>
        ) : (
          <ul className="card-committed-list">
            {(view.privatePolicyCards ?? []).map((card, index) => {
              const definition = POLICY_CARDS.get(card.cardId);
              return (
                <li key={`${card.cardId}-${index}`}>
                  {definition === undefined ? (
                    <strong>{card.archetype}</strong>
                  ) : (
                    <PolicyCardCommitted
                      question={definition.question}
                      answers={definition.answers}
                      archetype={card.archetype}
                      answerIndex={card.answerIndex}
                      index={index}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </details>

      {evicted === 0 ? null : (
        <details className="drawer ms-drawer">
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
    </div>
  );
}
