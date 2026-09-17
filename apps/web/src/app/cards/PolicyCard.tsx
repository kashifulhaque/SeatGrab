/**
 * A policy card: one question, two answers.
 *
 * The prompt version is wide, with the question in the header band and the two answers
 * as large panels a thumb can hit — side by side where there is room, stacked on a phone.
 * Which archetype each answer feeds and what it pays stay hidden until the answer is
 * committed, so the panels show only the text and a letter. That is the rule, and the
 * card says so under the panels rather than leaving a player to wonder why the panels
 * are unmarked.
 *
 * The committed version is what a kept card looks like: the archetype colours the band,
 * the question is small and the chosen answer is what stands out.
 */
import type { Archetype } from '@gerrymander/content';

import { ARCHETYPE_LABELS, archetypeStyle } from './archetypes';

import './cards.css';

const LETTERS = ['A', 'B'] as const;

export interface PolicyAnswerText {
  text: string;
}

export function PolicyCard({
  question,
  answers,
  onChoose,
  busy = false,
  revealed,
  index = 0,
}: {
  question: string;
  answers: readonly PolicyAnswerText[];
  onChoose: (index: 0 | 1) => void;
  busy?: boolean;
  /** Present for a card already committed: draws it revealed instead of as a prompt. */
  revealed?: { archetype: Archetype; answerIndex: 0 | 1 } | undefined;
  index?: number;
}) {
  if (revealed !== undefined) {
    return (
      <PolicyCardCommitted
        question={question}
        answers={answers}
        archetype={revealed.archetype}
        answerIndex={revealed.answerIndex}
        index={index}
      />
    );
  }
  return (
    <div
      className="card card--policy card--wide"
      role="group"
      aria-label="Policy question"
      style={{ '--card-index': index } as React.CSSProperties}
    >
      <div className="card__face">
        <div className="card__band card-policy__band">
          <span className="card__eyebrow">Policy question</span>
          <p className="card-policy__question">{question}</p>
        </div>
        <div className="card-policy__answers">
          {answers.slice(0, 2).map((answer, i) => {
            const answerIndex: 0 | 1 = i === 0 ? 0 : 1;
            return (
              <button
                key={`${answerIndex}-${answer.text}`}
                type="button"
                className="card-policy__answer"
                disabled={busy}
                onClick={() => onChoose(answerIndex)}
              >
                <span className="card-policy__letter" aria-hidden="true">{LETTERS[answerIndex]}</span>
                <span className="card-policy__text">{answer.text}</span>
                <span className="card-policy__cta">Choose this answer</span>
              </button>
            );
          })}
        </div>
        <p className="card-policy__note">
          Which archetype each answer feeds, and what it pays, stay hidden until you choose.
          Your answer is final.
        </p>
      </div>
    </div>
  );
}

/** A kept policy card: archetype band, the question small, the chosen answer large. */
export function PolicyCardCommitted({
  question,
  answers,
  archetype,
  answerIndex,
  index = 0,
}: {
  question: string;
  answers: readonly PolicyAnswerText[];
  archetype: Archetype;
  answerIndex: 0 | 1;
  index?: number;
}) {
  const chosen = answers[answerIndex]?.text ?? '';
  return (
    <div
      className="card card--policy card--committed"
      role="group"
      aria-label={`${ARCHETYPE_LABELS[archetype]} policy card`}
      style={{ ...archetypeStyle(archetype), '--card-index': index } as React.CSSProperties}
    >
      <div className="card__face">
        <div className="card__band card-policy__band card-policy__band--archetype">
          <span className="card__eyebrow">{ARCHETYPE_LABELS[archetype]}</span>
          <span className="card-policy__question card-policy__question--small">{question}</span>
        </div>
        <div className="card-policy__chosen">
          <span className="card-policy__letter" aria-hidden="true">{LETTERS[answerIndex]}</span>
          <span>
            <span className="card__eyebrow">You answered</span>
            <span className="card-policy__text">{chosen}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
