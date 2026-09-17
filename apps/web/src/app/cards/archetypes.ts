/**
 * How the four archetypes are named and coloured on a card.
 *
 * Each archetype pays one resource, so it borrows that resource's colour: a Corporate
 * band is the Cash green, a Reformer band the Faith violet. A player learns four colours
 * once and reads them on the status bar, the price strips and the policy cards alike.
 * The colour is a CSS variable name rather than a hex value so the theme stays in
 * `app.css`.
 */
import { ARCHETYPE_RESOURCE, type Archetype } from '@gerrymander/content';

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  corporate: 'Corporate',
  nationalist: 'Nationalist',
  populist: 'Populist',
  reformer: 'Reformer',
};

/** The `var(--…)` expression that colours this archetype, for an inline style. */
export function archetypeColor(archetype: Archetype): string {
  return `var(--${ARCHETYPE_RESOURCE[archetype]})`;
}

/** Inline style that sets the card's archetype colour token. */
export function archetypeStyle(archetype: Archetype): Record<string, string> {
  return { '--card-archetype': archetypeColor(archetype) };
}
