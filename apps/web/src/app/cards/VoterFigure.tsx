/**
 * One voter, drawn as a person.
 *
 * The figure is an original two-path silhouette — a head and a pair of shoulders — so a
 * card that grants two voters shows two people, not the numeral 2 beside a word. It is
 * decoration beside text that already says the count, so it is hidden from assistive
 * technology and takes its colour from `currentColor`, which lets a party token recolour
 * it without a second file.
 */
export function VoterFigure({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className === undefined ? 'card-figure' : `card-figure ${className}`}
      viewBox="0 0 24 32"
      width={size * 0.75}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="7.5" r="6" fill="currentColor" />
      <path
        d="M1.5 31c0-8.2 4.6-13.5 10.5-13.5S22.5 22.8 22.5 31Z"
        fill="currentColor"
      />
    </svg>
  );
}
