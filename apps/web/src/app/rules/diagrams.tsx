/**
 * The rulebook's teaching pictures.
 *
 * Each one is a small inline SVG drawn from the vocabulary the match screen already uses:
 * the party emblems, the resource icons, the plaque, the dashed volatile ring, the
 * majority ring and tick. A reader who has met a rule here recognises it on the board.
 *
 * Every figure is `role="img"` with an `aria-label` that says what it shows, so the
 * picture never carries a fact the text does not. The animations are decoration and
 * start when the figure scrolls into view; `rulebook.css` turns them off under
 * `prefers-reduced-motion`.
 */
import type { ReactNode } from 'react';

import { PARTY_BY_ID, RESOURCE_ASSETS, type CostIconId } from '../../assets/manifest';

/** The party every example is told from. It exists in every roster, so it is always drawn. */
export const EXAMPLE_PARTY = 'kite';
/** The rival in every example. */
export const RIVAL_PARTY = 'cog';

function partyColor(partyId: string): string {
  return PARTY_BY_ID.get(partyId)?.color ?? 'var(--trim)';
}

function partyUrl(partyId: string): string | undefined {
  return PARTY_BY_ID.get(partyId)?.url;
}

/** One voter token: a coloured disc with the party emblem, as the live board draws it. */
export function Token({
  x,
  y,
  r,
  partyId,
  delay = 0,
  majority = false,
  dim = false,
}: {
  x: number;
  y: number;
  r: number;
  partyId: string;
  /** Stagger index; the stylesheet turns it into an animation delay. */
  delay?: number;
  majority?: boolean;
  dim?: boolean;
}) {
  const url = partyUrl(partyId);
  return (
    <g
      className={`rb-token${dim ? ' rb-token--dim' : ''}`}
      style={{ '--rb-delay': delay } as React.CSSProperties}
    >
      <circle cx={x} cy={y} r={r} fill={partyColor(partyId)} />
      {url === undefined ? null : (
        <image
          href={url}
          x={x - r * 0.78}
          y={y - r * 0.78}
          width={r * 1.56}
          height={r * 1.56}
          preserveAspectRatio="xMidYMid meet"
        />
      )}
      {majority ? (
        <g className="rb-majority">
          <circle className="rb-majority__ring" cx={x} cy={y} r={r + 4} />
          <path className="rb-majority__tick" d={`M${x + r - 1} ${y - r - 5}l4 8 8-13`} />
        </g>
      ) : null}
    </g>
  );
}

/** An empty voter area, optionally with the dashed volatile ring. */
function Slot({ x, y, r, volatile = false }: { x: number; y: number; r: number; volatile?: boolean }) {
  return (
    <g>
      <circle className="rb-slot" cx={x} cy={y} r={r} />
      {volatile ? <circle className="rb-slot-volatile" cx={x} cy={y} r={r + 5} /> : null}
    </g>
  );
}

/** The dark plaque with a gold rule that every district on the board wears. */
function Plaque({ x, y, w, h, title, value }: { x: number; y: number; w: number; h: number; title: string; value: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className="rb-plaque" x={-w / 2} y={-h / 2} width={w} height={h} rx={6} />
      <text className="rb-plaque__name" y={-4}>{title}</text>
      <text className="rb-plaque__value" y={16}>{value}</text>
    </g>
  );
}

function ResourceIcon({ id, x, y, size }: { id: CostIconId; x: number; y: number; size: number }) {
  return <image href={RESOURCE_ASSETS[id].url} x={x} y={y} width={size} height={size} />;
}

/**
 * A district filling toward its threshold, then held.
 *
 * Left: four Kite voters in a six-threshold district. Right: the same district once the
 * sixth voter lands, with exactly six marked and a seventh unmarked because it scores
 * nothing.
 */
export function DistrictFillDiagram() {
  const r = 15;
  const slots = (ox: number) =>
    [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      x: ox + 34 + (i % 4) * 44 + (i >= 4 ? 22 : 0),
      y: 58 + Math.floor(i / 4) * 44,
    }));
  const left = slots(0);
  const right = slots(250);
  return (
    <svg
      className="rb-diagram"
      viewBox="0 0 450 190"
      role="img"
      aria-label="Two views of one district with threshold six. Before: four Kite voters, plaque reads Kite 4, need 6. After: six Kite voters marked with rings and ticks and a seventh Kite voter without a mark; plaque reads Kite holds it, 6 score."
    >
      <path className="rb-district" d="M14 26h190a10 10 0 0 1 10 10v128a10 10 0 0 1-10 10H14a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z" />
      <path className="rb-district rb-district--held" d="M264 26h176a10 10 0 0 1 10 10v128a10 10 0 0 1-10 10H264a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z" />
      {left.map((s, i) => <Slot key={`l${i}`} x={s.x} y={s.y} r={r} volatile={i === 6} />)}
      {left.slice(0, 4).map((s, i) => <Token key={`lt${i}`} x={s.x} y={s.y} r={r} partyId={EXAMPLE_PARTY} delay={i} />)}
      <Plaque x={109} y={152} w={124} h={40} title="KITE 4" value="NEED 6" />

      <path className="rb-arrow" d="M218 100h28" markerEnd="url(#rb-arrowhead)" />

      {right.map((s, i) => <Slot key={`r${i}`} x={s.x} y={s.y} r={r} volatile={i === 6} />)}
      {right.map((s, i) => (
        <Token key={`rt${i}`} x={s.x} y={s.y} r={r} partyId={EXAMPLE_PARTY} delay={i + 4} majority={i < 6} dim={i === 6} />
      ))}
      <Plaque x={352} y={152} w={140} h={40} title="KITE HOLDS IT" value="6 SCORE" />
      <defs>
        <marker id="rb-arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0l8 4-8 4z" fill="currentColor" />
        </marker>
      </defs>
    </svg>
  );
}

/** A voter card: how many voters it brings and what it costs. */
export function VoterCardDiagram() {
  return (
    <svg
      className="rb-diagram rb-diagram--card"
      viewBox="0 0 370 200"
      role="img"
      aria-label="A voter card labelled two voters, priced at two Cash and one Influence. Callouts read: voters you place, all in one district; the price, paid from what you hold."
    >
      <rect className="rb-card" x="20" y="14" width="150" height="172" rx="12" />
      <text className="rb-card__eyebrow" x="95" y="40">VOTER CARD</text>
      <Token x={72} y={84} r={18} partyId={EXAMPLE_PARTY} delay={0} />
      <Token x={118} y={84} r={18} partyId={EXAMPLE_PARTY} delay={1} />
      <text className="rb-card__big" x="95" y="128">2 voters</text>
      <line className="rb-card__rule" x1="36" y1="140" x2="154" y2="140" />
      <ResourceIcon id="cash" x={46} y={150} size={26} />
      <ResourceIcon id="cash" x={78} y={150} size={26} />
      <ResourceIcon id="influence" x={110} y={150} size={26} />

      <path className="rb-arrow" d="M186 84h22" markerEnd="url(#rb-arrowhead2)" />
      <text className="rb-note" x="212" y="78">Voters you get.</text>
      <text className="rb-note" x="212" y="96">All go in one district.</text>
      <path className="rb-arrow" d="M186 163h22" markerEnd="url(#rb-arrowhead2)" />
      <text className="rb-note" x="212" y="158">The price, paid from</text>
      <text className="rb-note" x="212" y="176">what you hold.</text>
      <defs>
        <marker id="rb-arrowhead2" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0l8 4-8 4z" fill="currentColor" />
        </marker>
      </defs>
    </svg>
  );
}

/** A five-step archetype track with its income and power marks. */
function Track({ x, y, width, label, filled, accent, tint }: { x: number; y: number; width: number; label: string; filled: number; accent: string; tint?: boolean }) {
  const step = width / 5;
  return (
    <g transform={`translate(${x} ${y})`} className={tint ? 'rb-track rb-track--tint' : 'rb-track'}>
      <text className="rb-track__label" x="0" y="-8">{label}</text>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} style={{ '--rb-delay': i } as React.CSSProperties} className={i < filled ? 'rb-track__step rb-track__step--on' : 'rb-track__step'}>
          <rect x={i * step} y={0} width={step - 6} height={22} rx={5} className={i < filled ? 'rb-track__cell rb-track__cell--on' : 'rb-track__cell'} style={i < filled ? { fill: accent } : undefined} />
          <text className="rb-track__n" x={i * step + (step - 6) / 2} y={16}>{i + 1}</text>
        </g>
      ))}
    </g>
  );
}

/** A policy question with two answers feeding two archetype tracks. */
export function PolicyCardDiagram() {
  return (
    <svg
      className="rb-diagram"
      viewBox="0 0 420 250"
      role="img"
      aria-label="A policy card asks a question and offers two answers, Yes and No. An arrow from Yes leads to the Corporate track, and an arrow from No leads to the Populist track. Committing an answer adds one card to that track and pays the resources it hides."
    >
      <rect className="rb-card" x="20" y="10" width="380" height="96" rx="12" />
      <text className="rb-card__eyebrow" x="210" y="34">POLICY QUESTION</text>
      <text className="rb-card__q" x="210" y="56">Should the state scrap rent caps?</text>
      <rect className="rb-answer" x="36" y="68" width="166" height="28" rx="7" />
      <text className="rb-answer__text" x="119" y="87">Yes, let the market decide</text>
      <rect className="rb-answer" x="218" y="68" width="166" height="28" rx="7" />
      <text className="rb-answer__text" x="301" y="87">No, keep the caps</text>

      <path className="rb-arrow" d="M119 100v40" markerEnd="url(#rb-arrowhead3)" />
      <path className="rb-arrow" d="M301 100v40" markerEnd="url(#rb-arrowhead3)" />
      <text className="rb-note" x="128" y="128">+1 card, pays its resources</text>

      <Track x={36} y={166} width={166} label="CORPORATE · CASH" filled={2} accent="var(--cash)" />
      <Track x={218} y={166} width={166} label="POPULIST · PRESS" filled={1} accent="var(--press)" tint />
      <text className="rb-note" x="36" y="228">Two cards on one track pay one resource a turn.</text>
      <defs>
        <marker id="rb-arrowhead3" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0l8 4-8 4z" fill="currentColor" />
        </marker>
      </defs>
    </svg>
  );
}

/** One archetype track at three cards, with the income and power marks called out. */
export function ArchetypeTrackDiagram() {
  const step = 76;
  return (
    <svg
      className="rb-diagram"
      viewBox="0 0 420 170"
      role="img"
      aria-label="An archetype track with five steps, three of them filled. Marks above read: at two cards, one resource each turn; at three cards, first power unlocked; at four cards, two resources each turn; at five cards, second power unlocked."
    >
      <text className="rb-track__label" x="20" y="88">NATIONALIST · INFLUENCE</text>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} style={{ '--rb-delay': i } as React.CSSProperties} className={i < 3 ? 'rb-track__step rb-track__step--on' : 'rb-track__step'}>
          <rect x={20 + i * step} y={98} width={step - 8} height={36} rx={7} className={i < 3 ? 'rb-track__cell rb-track__cell--on' : 'rb-track__cell'} style={i < 3 ? { fill: 'var(--influence)' } : undefined} />
          <text className="rb-track__n rb-track__n--big" x={20 + i * step + (step - 8) / 2} y={122}>{i + 1}</text>
        </g>
      ))}
      <g className="rb-mark">
        <path className="rb-mark__line" d="M130 96V54" />
        <text className="rb-mark__text" x="130" y="30">2 cards</text>
        <text className="rb-mark__sub" x="130" y="46">+1 a turn</text>
      </g>
      <g className="rb-mark rb-mark--power">
        <path className="rb-mark__line" d="M206 96V54" />
        <text className="rb-mark__text" x="206" y="30">3 cards</text>
        <text className="rb-mark__sub" x="206" y="46">first power</text>
      </g>
      <g className="rb-mark">
        <path className="rb-mark__line" d="M282 96V54" />
        <text className="rb-mark__text" x="282" y="30">4 cards</text>
        <text className="rb-mark__sub" x="282" y="46">+2 a turn</text>
      </g>
      <g className="rb-mark rb-mark--power">
        <path className="rb-mark__line" d="M358 96V54" />
        <text className="rb-mark__text" x="358" y="30">5 cards</text>
        <text className="rb-mark__sub" x="358" y="46">second power</text>
      </g>
      <text className="rb-note" x="20" y="160">Lose a card and the track drops with it, powers included.</text>
    </svg>
  );
}

/** A redistricting move: one voter crossing a shared border, and a marked one that cannot. */
export function GerrymanderDiagram() {
  const r = 14;
  return (
    <svg
      className="rb-diagram"
      viewBox="0 0 420 215"
      role="img"
      aria-label="Two districts that share a border, Central and North. Kite holds redistricting rights in Central, shown by a rights badge. A Cog voter in Central is moved across the border into North, drawn with an arrow labelled one move a turn. A Kite voter marked with a majority ring stays where it is, labelled marked, cannot be moved."
    >
      <path className="rb-district rb-district--held" d="M14 30h190a10 10 0 0 1 10 10v150a10 10 0 0 1-10 10H14a10 10 0 0 1-10-10V40a10 10 0 0 1 10-10z" />
      <path className="rb-district" d="M214 30h192a10 10 0 0 1 10 10v150a10 10 0 0 1-10 10H214V30z" />
      <Plaque x={92} y={52} w={110} h={36} title="CENTRAL" value="5/9" />
      <Plaque x={310} y={52} w={110} h={36} title="NORTH" value="11/21" />
      <g className="rb-badge" transform="translate(180 52)">
        <rect x="-26" y="-11" width="52" height="22" rx="11" />
        <text y="4">RIGHTS</text>
      </g>

      <Slot x={50} y={118} r={r} />
      <Slot x={90} y={118} r={r} />
      <Slot x={130} y={118} r={r} />
      <Slot x={50} y={158} r={r} />
      <Slot x={90} y={158} r={r} />
      <Slot x={130} y={158} r={r} />
      <Token x={50} y={118} r={r} partyId={EXAMPLE_PARTY} delay={0} majority />
      <Token x={90} y={118} r={r} partyId={EXAMPLE_PARTY} delay={1} />
      <Token x={50} y={158} r={r} partyId={EXAMPLE_PARTY} delay={2} />
      <text className="rb-note rb-note--tiny" x="109" y="190">Marked: cannot be moved</text>

      <Slot x={260} y={118} r={r} />
      <Slot x={300} y={118} r={r} />
      <Slot x={340} y={118} r={r} volatile />
      <Slot x={380} y={118} r={r} />
      <Slot x={260} y={158} r={r} />
      <Slot x={300} y={158} r={r} />
      <Slot x={340} y={158} r={r} />
      <Slot x={380} y={158} r={r} />
      <Token x={300} y={118} r={r} partyId={RIVAL_PARTY} delay={0} />
      <g className="rb-mover">
        <Token x={130} y={158} r={r} partyId={RIVAL_PARTY} delay={0} />
      </g>
      <path className="rb-arrow rb-arrow--move" d="M150 158h92" markerEnd="url(#rb-arrowhead4)" />
      <text className="rb-note rb-note--tiny" x="196" y="146">one move a turn</text>
      <defs>
        <marker id="rb-arrowhead4" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0l8 4-8 4z" fill="currentColor" />
        </marker>
      </defs>
    </svg>
  );
}

/** A Dirty Trick, face down, showing only the price on its back. */
export function TrickBackDiagram({ prices }: { prices: readonly number[] }) {
  return (
    <svg
      className="rb-diagram rb-diagram--card"
      viewBox="0 0 370 200"
      role="img"
      aria-label={`A face-down Dirty Trick card. Its back shows only the price, ${prices.join(' or ')} of any resource. A callout reads: you pay the price on the back and see the card only once you hold it.`}
    >
      <rect className="rb-card rb-card--back" x="20" y="14" width="150" height="172" rx="12" />
      <rect className="rb-card__inner" x="32" y="26" width="126" height="148" rx="8" />
      <text className="rb-card__eyebrow rb-card__eyebrow--light" x="95" y="56">DIRTY TRICK</text>
      <text className="rb-card__big rb-card__big--light" x="95" y="112">{prices[prices.length - 1] ?? 5}</text>
      <ResourceIcon id="generic" x={82} y={124} size={26} />
      <text className="rb-card__eyebrow rb-card__eyebrow--light" x="95" y="168">FACE DOWN</text>
      <path className="rb-arrow" d="M186 100h22" markerEnd="url(#rb-arrowhead5)" />
      <text className="rb-note" x="212" y="86">Pay the price on the back.</text>
      <text className="rb-note" x="212" y="104">Nobody sees which card</text>
      <text className="rb-note" x="212" y="122">you took.</text>
      <defs>
        <marker id="rb-arrowhead5" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0l8 4-8 4z" fill="currentColor" />
        </marker>
      </defs>
    </svg>
  );
}

/** Final scores: three parties and how many of their voters are marked as majorities. */
export function ScoreDiagram({ rows }: { rows: readonly { partyId: string; name: string; score: number }[] }) {
  const max = Math.max(...rows.map((row) => row.score), 1);
  return (
    <svg
      className="rb-diagram"
      viewBox="0 0 420 150"
      role="img"
      aria-label={`Final scores. ${rows.map((row) => `${row.name} ${row.score}`).join(', ')}. The party with the most majority voters wins.`}
    >
      {rows.map((row, i) => {
        const y = 22 + i * 42;
        const width = 40 + (row.score / max) * 240;
        return (
          <g key={row.partyId} className="rb-score-row" style={{ '--rb-delay': i } as React.CSSProperties}>
            <Token x={24} y={y + 10} r={14} partyId={row.partyId} delay={i} majority={i === 0} />
            <rect className="rb-score-bar" x={50} y={y} width={width} height={22} rx={6} style={{ fill: partyColor(row.partyId) }} />
            <text className="rb-score__name" x={58} y={y + 16}>{row.name}</text>
            <text className="rb-score__n" x={58 + width + 8} y={y + 16}>{row.score}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** A figure with a visible caption, so every picture says what it teaches. */
export function Figure({ children, caption, wide = false }: { children: ReactNode; caption: ReactNode; wide?: boolean }) {
  return (
    <figure className={wide ? 'rb-figure rb-figure--wide' : 'rb-figure'}>
      {children}
      <figcaption className="rb-figure__caption">{caption}</figcaption>
    </figure>
  );
}
