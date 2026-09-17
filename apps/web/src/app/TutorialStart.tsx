/**
 * The tutorial's front door: what the guided match is, and the control that starts it.
 *
 * Starting a tutorial is starting an ordinary local match, so this screen does what the
 * lobby does — build a draft, freeze it into a `GameConfig`, hand it to `createLocalMatch`
 * — with the draft fixed rather than edited. The seats, the parties and the Easy
 * difficulty are not choices a first-time player benefits from making, and every one of
 * them is still available from the lobby afterwards.
 *
 * An unfinished tutorial in this browser is offered back rather than replaced. Losing a
 * half-played first match to a second press of the same button is the failure this screen
 * exists to avoid; the person can still start a fresh one from the same place.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { CORE_CONTENT } from '@seatgrab/engine';

import {
  createLocalMatch,
  listLocalMatches,
  randomSeed,
  type LocalMatchSummary,
  type LocalSnapshotStore,
} from '../local';

import { Glyph } from './Glyph';
import { PageFrame } from './PageFrame';
import { ROUTES, navigate } from './routes';
import { toGameConfig } from './setup';
import { isTutorialMatchId, newTutorialMatchId, tutorialSetupDraft, TUTORIAL_LESSONS } from './tutorial';
import { describeError } from './useLocalStore';

export function TutorialStart({
  store,
  storeError,
}: {
  store: LocalSnapshotStore | null;
  storeError: string | null;
}) {
  const [saves, setSaves] = useState<readonly LocalMatchSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (store === null) return;
    let cancelled = false;
    void listLocalMatches(store).then(
      (found) => {
        if (!cancelled) setSaves(found);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(describeError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  const unfinished = useMemo(
    () => (saves ?? []).find(
      (save) => isTutorialMatchId(save.matchId)
        && save.unreadableReason === null
        && save.status !== 'finished',
    ),
    [saves],
  );

  const start = useCallback(() => {
    if (store === null) return;
    setFailure(null);
    setStarting(true);
    const matchId = newTutorialMatchId(new Date(), Math.random());
    void (async () => {
      try {
        const config = toGameConfig(tutorialSetupDraft(), matchId);
        await createLocalMatch({ store, content: CORE_CONTENT }, config, randomSeed());
        navigate(ROUTES.match(matchId));
      } catch (error) {
        setFailure(describeError(error));
        setStarting(false);
      }
    })();
  }, [store]);

  return (
    <PageFrame
      title="Learn to play"
      lede="A guided first match against two computer opponents. The coach explains each rule at
        the moment the table asks for it."
      back={{ href: ROUTES.home, label: 'Home' }}
    >
      {storeError === null ? null : (
        <p className="alert alert--error" role="alert">
          This browser will not open the save database: {storeError} A tutorial match cannot be
          started, because a match that cannot be saved would be lost at the next reload.
        </p>
      )}
      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}

      <section className="panel" aria-labelledby="tutorial-heading">
        <h2 id="tutorial-heading">What you are about to play</h2>
        <p className="panel__lede">
          Nothing here is a simulation. The tutorial is a real match on the real board, with the
          same cards and the same rules as every other match, so everything you learn carries
          over to a table of your own.
        </p>
        <ul className="facts-list">
          <li>
            <strong>Three seats.</strong> You take one; two computers at Easy take the others.
          </li>
          <li>
            <strong>{TUTORIAL_LESSONS.length} lessons.</strong> Each one appears when the rule it
            teaches comes up, and goes away once you have used it.
          </li>
          <li>
            <strong>Your own pace.</strong> The coach never takes a turn for you and never blocks
            a control. Fold it away at any point, or start the lessons again.
          </li>
          <li>
            <strong>Saved as you go.</strong> The match is stored in this browser, so you can
            leave it and come back to it from the title screen.
          </li>
        </ul>

        <div className="cta-row">
          {unfinished === undefined ? null : (
            <button
              type="button"
              className="cta cta--small cta--resume"
              onClick={() => navigate(ROUTES.match(unfinished.matchId))}
            >
              <Glyph name="resume" size={26} />
              <span className="cta__text">
                <span className="cta__label">Continue</span>
                <span className="cta__sub">Your tutorial match, at revision {unfinished.revision}</span>
              </span>
            </button>
          )}
          <button
            type="button"
            className="cta cta--small cta--primary"
            disabled={store === null || starting}
            onClick={start}
          >
            <Glyph name="play" size={26} />
            <span className="cta__text">
              <span className="cta__label">
                {unfinished === undefined ? 'Start the tutorial' : 'Start a new one'}
              </span>
              <span className="cta__sub">
                {starting ? 'Dealing the cards…' : 'You and two computers, coached from the first turn'}
              </span>
            </span>
          </button>
        </div>
        <p className="hint">
          Starting a new tutorial leaves any earlier one in your saved matches. Delete it from the
          title screen when you are done with it.
        </p>
      </section>
    </PageFrame>
  );
}
