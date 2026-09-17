/**
 * The two asides the rulebook uses beside its prose.
 *
 * An example walks one rule through with named parties, so a reader can check their
 * understanding against a concrete board. A common mistake names the way a rule trips
 * people at the table; every one restates something the engine refuses, never a strategy
 * tip. Both are drawn as a labelled aside so they read as commentary on the rule rather
 * than as the rule itself.
 */
import type { ReactNode } from 'react';

export function Callout({ kind, title, children }: { kind: 'example' | 'mistake'; title?: string; children: ReactNode }) {
  const label = kind === 'example' ? 'Example' : 'Common mistake';
  return (
    <aside className={`rb-callout rb-callout--${kind}`}>
      <p className="rb-callout__label">
        <span className="rb-callout__glyph" aria-hidden="true">{kind === 'example' ? '›' : '!'}</span>
        {label}
        {title === undefined ? null : <span className="rb-callout__title">{title}</span>}
      </p>
      <div className="rb-callout__body">{children}</div>
    </aside>
  );
}
