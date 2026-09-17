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

import { CORE_CONTENT } from '@gerrymander/engine';

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
import { isTutorialMatchId, newTutorialMatchId, tutorialSetupDraft } from './tutorial';
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
        <h2 id="tutorial-heading">Learn by playing a real match</h2>
        <p className="panel__lede">
          You play one seat against two Easy computers. A coach explains each rule exactly
          when you need it, without changing the game or taking a turn for you.
        </p>

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
                <span className="cta__sub">Resume where you stopped</span>
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
                {unfinished === undefined ? 'Start learning' : 'Start a new tutorial'}
              </span>
              <span className="cta__sub">
                {starting ? 'Dealing the cards…' : 'You and two computer opponents'}
              </span>
            </span>
          </button>
        </div>

        <details className="settings">
          <summary>How the tutorial works</summary>
          <ul className="facts-list">
            <li>It uses the real board, cards, rules, and saves.</li>
            <li>The coach never blocks a control and can be folded away.</li>
            <li>You can leave at any time and continue from this browser.</li>
          </ul>
          {unfinished === undefined ? null : (
            <p className="hint">
              Starting a new tutorial keeps the earlier save. You can delete it from the title screen.
            </p>
          )}
        </details>
      </section>
    </PageFrame>
  );
}
