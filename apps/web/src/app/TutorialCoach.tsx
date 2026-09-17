/**
 * The coach: one card on the match screen that teaches the rule the table is asking for.
 *
 * It draws whatever `nextLesson` returns and nothing else. Every decision about which
 * lesson that is lives in `tutorial.ts`, so this component holds only what a component
 * has to hold: which lessons the reader has marked as read, and whether the card is
 * folded away.
 *
 * It is a panel rather than a dialog on purpose. A first-time player needs to read the
 * rule and look at the board it is about at the same time. On phones the compact panel
 * attaches to the action sheet; wider screens keep it above the table.
 *
 * The current rule is collapsible. Its first paragraph and pointer are enough for the
 * immediate action; later paragraphs remain available without standing between the
 * player and the board.
 *
 * The coach is read-only. It never submits a command, never enables or disables a
 * control, and never predicts a ruling: the match underneath is the ordinary match, and a
 * player who ignores the card entirely can still play every legal move.
 */
import { useCallback, useEffect, useState } from 'react';

import type { PlayerView } from '@gerrymander/protocol';

import { Glyph } from './Glyph';
import { ROUTES } from './routes';
import {
  lessonsCompleted,
  nextLesson,
  readLessons,
  tutorialFacts,
  writeLessons,
  TUTORIAL_LESSONS,
} from './tutorial';
import { useViewport } from './useViewport';

export function TutorialCoach({
  matchId,
  view,
  seatId,
}: {
  matchId: string;
  /** The seat's own projection. The coach reads no other seat's. */
  view: PlayerView;
  seatId: string;
}) {
  const [read, setRead] = useState<ReadonlySet<string>>(() => readLessons(matchId));
  const [folded, setFolded] = useState(false);
  const phone = useViewport() === 'phone';

  // A different match has its own record and must not inherit the previous coach's fold.
  useEffect(() => {
    setRead(readLessons(matchId));
    setFolded(false);
  }, [matchId]);

  const markRead = useCallback(
    (lessonId: string) => {
      setRead((current) => {
        const next = new Set(current);
        next.add(lessonId);
        writeLessons(matchId, next);
        return next;
      });
    },
    [matchId],
  );

  const replay = useCallback(() => {
    const empty: ReadonlySet<string> = new Set();
    setRead(empty);
    writeLessons(matchId, empty);
    setFolded(false);
  }, [matchId]);

  const facts = tutorialFacts(view, seatId);
  const placement = nextLesson(facts, read);
  const completed = lessonsCompleted(facts, read);

  if (placement === null || folded) {
    return (
      <section className="coach coach--quiet" aria-label="Tutorial">
        <details className="coach__quiet-controls">
          <summary>
            <Glyph name="book" size={16} />
            {folded ? 'Show tutorial coach' : `Tutorial · ${completed} lessons read`}
          </summary>
          <p className="coach__quiet-line">
            {placement === null
              ? 'Keep playing. The coach returns when a new rule comes up.'
              : 'The current lesson is folded away; every game control remains available.'}
          </p>
          <div className="actions">
            {folded ? (
              <button type="button" className="button" onClick={() => setFolded(false)}>
                Show the coach
              </button>
            ) : null}
            <button type="button" className="button button--quiet" onClick={replay}>
              Start the lessons again
            </button>
            <a className="button button--quiet" href={ROUTES.rules}>
              Read the full rules
            </a>
          </div>
        </details>
      </section>
    );
  }

  const { lesson, total } = placement;
  return (
    <section className="coach" aria-labelledby="coach-heading">
      <details key={`${matchId}:${lesson.id}`} className="coach__lesson" open={phone ? undefined : true}>
        <summary>
          <span className="coach__eyebrow">
            <Glyph name="book" size={16} />
            Tutorial · lesson {Math.min(completed + 1, total)} of {total}
          </span>
          <span id="coach-heading" className="coach__title">{lesson.title}</span>
        </summary>
        <div className="coach__content">
          <p className="coach__body">{lesson.body[0]}</p>
          {lesson.task === undefined ? null : (
            <p className="coach__task">
              <span className="coach__task-label">Find it</span>
              {lesson.task}
            </p>
          )}
          {lesson.body.length < 2 ? null : (
            <details className="coach__more">
              <summary>More on this rule</summary>
              {lesson.body.slice(1).map((paragraph) => (
                <p key={paragraph} className="coach__body">
                  {paragraph}
                </p>
              ))}
            </details>
          )}
          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => markRead(lesson.id)}
            >
              I understand
            </button>
            <button type="button" className="button button--quiet" onClick={() => setFolded(true)}>
              Fold the coach away
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}
