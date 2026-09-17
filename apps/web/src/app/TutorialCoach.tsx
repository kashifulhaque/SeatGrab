/**
 * The coach: one card on the match screen that teaches the rule the table is asking for.
 *
 * It draws whatever `nextLesson` returns and nothing else. Every decision about which
 * lesson that is lives in `tutorial.ts`, so this component holds only what a component
 * has to hold: which lessons the reader has marked as read, and whether the card is
 * folded away.
 *
 * It is a panel rather than a dialog on purpose. A first-time player needs to read the
 * rule and look at the board it is about at the same time, and a modal would make that a
 * sequence of two things. Nothing here blocks a control, and the card is never in the way
 * of the seat's own column.
 *
 * The coach is read-only. It never submits a command, never enables or disables a
 * control, and never predicts a ruling: the match underneath is the ordinary match, and a
 * player who ignores the card entirely can still play every legal move.
 */
import { useCallback, useEffect, useState } from 'react';

import type { PlayerView } from '@seatgrab/protocol';

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

  // A different match has its own record of what has been read.
  useEffect(() => {
    setRead(readLessons(matchId));
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
        <p className="coach__eyebrow">
          <Glyph name="book" size={16} />
          Tutorial · {completed} of {TUTORIAL_LESSONS.length} lessons behind you
        </p>
        <p className="coach__quiet-line">
          {placement === null
            ? 'Nothing to explain right now. Keep playing; the coach returns when a new rule comes up.'
            : 'The coach is folded away.'}
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
      </section>
    );
  }

  const { lesson, total } = placement;
  return (
    <section className="coach" aria-labelledby="coach-heading">
      <p className="coach__eyebrow">
        <Glyph name="book" size={16} />
        Tutorial · lesson {Math.min(completed + 1, total)} of {total}
      </p>
      <h2 id="coach-heading" className="coach__title">
        {lesson.title}
      </h2>
      {lesson.body.map((paragraph) => (
        <p key={paragraph} className="coach__body">
          {paragraph}
        </p>
      ))}
      {lesson.task === undefined ? null : (
        <p className="coach__task">
          <span className="coach__task-label">Do this</span>
          {lesson.task}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => markRead(lesson.id)}
        >
          Got it
        </button>
        <button type="button" className="button button--quiet" onClick={() => setFolded(true)}>
          Fold the coach away
        </button>
      </div>
    </section>
  );
}
