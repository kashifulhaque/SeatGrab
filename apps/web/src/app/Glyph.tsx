/**
 * The line glyphs the title screen and the rules screen draw on their tiles and step
 * cards.
 *
 * They are original single-path drawings rather than bundled assets: each one is a
 * decoration beside a label that already says the same thing, so they are `aria-hidden`
 * and never carry meaning on their own. Keeping them inline means they inherit the
 * surrounding colour, which is what lets one tile invert on hover without a second file.
 */
export type GlyphName =
  | 'play'
  | 'resume'
  | 'book'
  | 'archive'
  | 'globe'
  | 'gear'
  | 'trophy'
  | 'turn'
  | 'map'
  | 'cards'
  | 'gavel'
  | 'host'
  | 'join';

/** One `d` attribute per glyph, drawn in a 24×24 box as strokes with no fill. */
const PATHS: Record<GlyphName, readonly string[]> = {
  play: ['M8 5.5 19 12 8 18.5Z'],
  resume: ['M4 12a8 8 0 1 0 2.5-5.8', 'M3 4v4h4', 'M11 9.5 15.5 12 11 14.5Z'],
  book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z', 'M8 8h7', 'M8 12h5'],
  archive: ['M3.5 6.5h17v4h-17Z', 'M5 10.5v9h14v-9', 'M10 14.5h4'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M3.4 9.5h17.2', 'M3.4 14.5h17.2', 'M12 3c-5 6-5 12 0 18', 'M12 3c5 6 5 12 0 18'],
  gear: [
    'M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z',
    'M12 2.6 13.4 5a8 8 0 0 1 2.2.9l2.6-.8 1.7 3-1.9 1.9a8 8 0 0 1 0 2l1.9 1.9-1.7 3-2.6-.8a8 8 0 0 1-2.2.9L12 21.4 10.6 19a8 8 0 0 1-2.2-.9l-2.6.8-1.7-3 1.9-1.9a8 8 0 0 1 0-2L4.1 8.1l1.7-3 2.6.8A8 8 0 0 1 10.6 5Z',
  ],
  trophy: ['M7 4h10v5a5 5 0 0 1-10 0Z', 'M7 5.5H4V8a3 3 0 0 0 3 3', 'M17 5.5h3V8a3 3 0 0 1-3 3', 'M12 14v4', 'M8.5 20h7'],
  turn: ['M4 12a8 8 0 1 1 3 6.2', 'M3 13.5 4 19l5.2-1.6', 'M12 7.5V12l3 1.8'],
  map: ['M3.5 6.5 9 4.5v13L3.5 19.5Z', 'M9 4.5l6 2v13l-6-2Z', 'M15 6.5l5.5-2v13L15 19.5Z'],
  cards: ['M8.5 7.5h9v12h-9Z', 'M6 5.5 14 4l.6 3', 'M11 12h4', 'M11 15h3'],
  gavel: ['M4 19.5h8', 'M6.5 16.5 13 10', 'M11.5 5.5 17 11l-2.5 2.5L9 8Z', 'M16 4.5 19.5 8'],
  host: ['M12 4.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Z', 'M12 8.5v7', 'M8.5 12h7'],
  join: ['M10 7.5 14.5 12 10 16.5', 'M14 12H3.5', 'M8 4.5h10a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-3'],
};

export function Glyph({ name, size = 24 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
