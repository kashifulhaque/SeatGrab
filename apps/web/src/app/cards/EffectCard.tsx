import type { ReactNode } from 'react';

import type { CardSize } from './VoterCard';

import './cards.css';

export function EffectCard({
  deck,
  title,
  rulesText,
  flavorText,
  size = 'md',
  footer,
}: {
  deck: 'news' | 'trick';
  title: string;
  rulesText: string;
  flavorText?: string | undefined;
  size?: CardSize;
  footer?: ReactNode;
}) {
  const label = deck === 'news' ? 'Breaking News' : 'Dirty Trick';
  const lines = rulesText.split('\n');
  return (
    <span
      className={`card card--effect card--${deck} card--${size}`}
      role="group"
      aria-label={`${label}: ${title}`}
    >
      <span className="card__face">
        <span className="card__band">
          <span className="card__eyebrow">{label}</span>
          <span className="card__title">{title}</span>
        </span>
        <span className="card-effect__rules">
          {lines.map((line, index) => (
            line.trim() === 'OR'
              ? <span key={index} className="card-effect__or">or</span>
              : <span key={index} className="card-effect__line">{line}</span>
          ))}
        </span>
        {flavorText === undefined ? null : (
          <span className="card-effect__flavor">{flavorText}</span>
        )}
      </span>
      {footer === undefined ? null : <span className="card__footer">{footer}</span>}
    </span>
  );
}
