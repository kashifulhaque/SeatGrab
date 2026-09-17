/**
 * Rules, content pack and house rules, reachable from every screen.
 *
 * The title screen names the content pack and the supported player counts; this page is
 * the long form, including every ruling the engine applies where a table might otherwise
 * argue.
 *
 * It is a rulebook rather than a page of prose. The material is cut into six chapters and
 * only one is drawn at a time, so a player looking up how redistricting works reads a
 * screen about redistricting instead of scrolling past the turn order and the version
 * table to reach it. The chapter buttons are a `tablist`, so a screen reader and the
 * arrow keys move through them the way they move through any tab strip.
 *
 * Every chapter is in the markup only while it is chosen. That keeps the house rules
 * table — the longest thing here — out of the page until somebody asks for it, and it
 * means an in-page find searches the chapter on screen rather than all six at once.
 */
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';

import { RESOURCE_ASSETS } from '../assets/manifest';

import { Glyph, type GlyphName } from './Glyph';
import { PageFrame } from './PageFrame';
import { ADJUDICATIONS, BACK_COST_VALUES, DECK_SIZES, INSTALLED_CAMPAIGN, KNOWN_LIMITS } from './edition';
import { ADVISORY_FILTERS, MAX_SEATS, MIN_SEATS } from './setup';
import { ROUTES } from './routes';
import { LOCAL_MODE_NOTICE } from '../local';

type ChapterId = 'win' | 'turn' | 'board' | 'cards' | 'computer' | 'house' | 'set';

const CHAPTERS: readonly { id: ChapterId; glyph: GlyphName; label: string; blurb: string }[] = [
  { id: 'win', glyph: 'trophy', label: 'How you win', blurb: 'The goal, and what actually scores' },
  { id: 'turn', glyph: 'turn', label: 'Your turn', blurb: 'The four steps, in order' },
  { id: 'board', glyph: 'map', label: 'The board', blurb: 'Zones, redistricting, volatile areas' },
  { id: 'cards', glyph: 'cards', label: 'Cards', blurb: 'Resources, archetypes, tricks, trades' },
  { id: 'computer', glyph: 'play', label: 'The computer', blurb: 'What it can and cannot see' },
  { id: 'house', glyph: 'gavel', label: 'House rules', blurb: `${ADJUDICATIONS.length} rulings the engine applies` },
  { id: 'set', glyph: 'gear', label: 'This set', blurb: 'Decks, filters and limits' },
];

/** The archetype each resource belongs to, in the order the mat lists them. */
const RESOURCE_ARCHETYPES = [
  { resource: 'cash', archetype: 'Corporate' },
  { resource: 'influence', archetype: 'Nationalist' },
  { resource: 'press', archetype: 'Populist' },
  { resource: 'faith', archetype: 'Reformer' },
] as const;

/** The four steps of a turn, each one card rather than one line of a list. */
const TURN_STEPS: readonly { title: string; body: string }[] = [
  {
    title: 'Passive income',
    body: 'Take one resource for every two policy cards you hold in the same archetype. This is '
      + 'automatic: you do not choose it and you cannot skip it.',
  },
  {
    title: 'Answer a policy question',
    body: 'Draw a card and choose one of its two answers. The card is kept under that answer’s '
      + 'archetype and pays the resources it shows. You may pay any four resources first to draw '
      + 'a different card. Holding more than 12 resources after this, you discard down to 12.',
  },
  {
    title: 'Act, in any order',
    body: 'Buy voter cards from the market and place each card’s voters together in one zone. Use '
      + 'archetype powers you have unlocked. Use redistricting rights once per zone you hold them '
      + 'in. Buy a Dirty Trick face down, or play one from your hand. Trade with another player.',
  },
  {
    title: 'End the turn',
    body: 'Voters you bought but did not place are lost. Any Breaking News card dealt to you this '
      + 'turn resolves now, and play passes clockwise.',
  },
];

function WinChapter() {
  return (
    <>
      <div className="rule-cards">
        <article className="rule-card rule-card--lead">
          <h3>The goal</h3>
          <p>
            Each of the {DECK_SIZES.zones} zones shows a threshold. Reach it with your own voters
            and you hold the zone. The game ends the moment every zone is held.
          </p>
        </article>
        <article className="rule-card">
          <h3>What scores</h3>
          <p>
            The winner is the player with the most <strong>scoring voters</strong> — not the most
            zones, resources or voters on the board. A voter scores only if it is one of the
            voters filling a zone’s threshold for you.
          </p>
        </article>
        <article className="rule-card">
          <h3>What does not</h3>
          <p>
            Voters stacked above a zone’s threshold score nothing. Voters in a zone you do not hold
            score nothing. Leftover resources score nothing.
          </p>
        </article>
        <article className="rule-card">
          <h3>Before the first turn</h3>
          <p>
            Players vote for who goes first; nobody may vote for themselves, and a tie is voted
            again. Turns then go clockwise. The first player takes any one resource, the second any
            two, and so on.
          </p>
        </article>
        <article className="rule-card">
          <h3>Ties</h3>
          <p>
            Players tied on scoring voters all win. This build applies no tiebreaker on resources,
            zones or total voters.
          </p>
        </article>
      </div>
    </>
  );
}

function TurnChapter() {
  return (
    <ol className="step-cards">
      {TURN_STEPS.map((step, index) => (
        <li key={step.title} className="step-card">
          <span className="step-card__number" aria-hidden="true">
            {index + 1}
          </span>
          <div>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function BoardChapter() {
  return (
    <div className="rule-cards">
      <article className="rule-card rule-card--lead">
        <h3>Zones and areas</h3>
        <p>
          The board holds {DECK_SIZES.zones} zones made up of {DECK_SIZES.slots} voter areas. When
          you buy a voter card, all of its voters go into one zone — never split between two.
        </p>
      </article>
      <article className="rule-card">
        <h3>Holding a zone</h3>
        <p>
          Reach a zone’s threshold with your own voters and the zone is yours. Exactly that many of
          your voters are marked as the majority; marks stay where they are as the board changes.
        </p>
      </article>
      <article className="rule-card">
        <h3>Redistricting rights</h3>
        <p>
          Hold strictly the most voters in a zone and you gain its redistricting rights. Once a
          turn you may move one voter — yours or a rival’s — into, out of or within that zone. A
          voter already marked as part of a majority cannot be moved this way.
        </p>
      </article>
      <article className="rule-card">
        <h3>Volatile areas</h3>
        <p>
          An area drawn with a dashed ring is volatile. A voter placed there is fixed for the rest
          of the game, and its owner is dealt a Breaking News card that resolves at the end of the
          turn.
        </p>
      </article>
    </div>
  );
}

function CardsChapter() {
  return (
    <>
      <div className="rule-cards">
        <article className="rule-card rule-card--lead">
          <h3>Resources</h3>
          <ul className="resource-keys">
            {RESOURCE_ARCHETYPES.map(({ resource, archetype }) => (
              <li key={resource}>
                <img
                  src={RESOURCE_ASSETS[resource].url}
                  alt=""
                  aria-hidden="true"
                  width={26}
                  height={26}
                />
                <span>
                  <strong>{RESOURCE_ASSETS[resource].label}</strong>
                  <span className="small">{archetype}</span>
                </span>
              </li>
            ))}
          </ul>
          <p>
            A <strong>?</strong> in a price means any one resource. You may hold at most 12
            resources; above that you discard down immediately.
          </p>
        </article>
        <article className="rule-card">
          <h3>Archetypes and powers</h3>
          <p>
            Every answer you keep is a card for its archetype. Each pair of cards in one archetype
            pays one resource of that type at the start of your turn. Three cards unlock that
            archetype’s first power, five its second. Lose the cards and the power goes with them.
          </p>
        </article>
        <article className="rule-card">
          <h3>Voter cards</h3>
          <p>
            The market shows voter cards for sale. Pay a card’s price to take its voters, then
            place all of them in one zone on the same turn. Buy as many cards as you can afford.
          </p>
        </article>
        <article className="rule-card">
          <h3>Dirty Tricks</h3>
          <p>
            A Dirty Trick is bought face down for the price printed on its back —{' '}
            {BACK_COST_VALUES.join(' or ')} resources in this set — so nobody knows what you took.
            Play it on your own turn, or as a reaction when the card says so.
          </p>
        </article>
        <article className="rule-card">
          <h3>Breaking News</h3>
          <p>
            Breaking News is dealt by the board, not bought. A card dealt during a turn resolves
            when that turn ends.
          </p>
        </article>
        <article className="rule-card">
          <h3>Trades</h3>
          <p>
            A trade must involve the player whose turn it is, must move something both ways, and
            needs both sides to agree. Resources and Dirty Tricks can be traded; voters and policy
            cards cannot.
          </p>
        </article>
      </div>
    </>
  );
}

function HouseChapter() {
  return (
    <>
      <p className="panel__lede">
        Where a table might argue, the engine applies one ruling to every match. These are those
        rulings.
      </p>
      <ul className="ruling-list">
        {ADJUDICATIONS.map((entry) => (
          <li key={entry.id} className="ruling">
            <p className="ruling__head">
              <span className="ruling__id">{entry.id}</span>
              <span className="ruling__issue">{entry.issue}</span>
            </p>
            <p className="ruling__body">{entry.ruling}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function SetChapter() {
  return (
    <>
      <dl className="facts">
        <div>
          <dt>Set</dt>
          <dd>{INSTALLED_CAMPAIGN.displayName}</dd>
        </div>
        <div>
          <dt>Content pack</dt>
          <dd>
            {INSTALLED_CAMPAIGN.contentPackId} {INSTALLED_CAMPAIGN.contentVersion}
          </dd>
        </div>
        <div>
          <dt>Ruleset</dt>
          <dd>
            {INSTALLED_CAMPAIGN.rulesetId} {INSTALLED_CAMPAIGN.rulesetVersion}
          </dd>
        </div>
        <div>
          <dt>Board</dt>
          <dd>
            {INSTALLED_CAMPAIGN.boardId} {INSTALLED_CAMPAIGN.boardVersion}
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>{INSTALLED_CAMPAIGN.engineVersion}</dd>
        </div>
        <div>
          <dt>Save schema</dt>
          <dd>{INSTALLED_CAMPAIGN.schemaVersion}</dd>
        </div>
        <div>
          <dt>Players</dt>
          <dd>
            {MIN_SEATS}–{MAX_SEATS}
          </dd>
        </div>
        <div>
          <dt>Voter cards</dt>
          <dd>{DECK_SIZES.voter}</dd>
        </div>
        <div>
          <dt>Policy cards</dt>
          <dd>{DECK_SIZES.policy}</dd>
        </div>
        <div>
          <dt>Breaking News</dt>
          <dd>{DECK_SIZES.news}</dd>
        </div>
        <div>
          <dt>Dirty Tricks</dt>
          <dd>{DECK_SIZES.trick}</dd>
        </div>
        <div>
          <dt>Dirty Trick prices</dt>
          <dd>{BACK_COST_VALUES.join(' or ')}</dd>
        </div>
        <div>
          <dt>Zones</dt>
          <dd>{DECK_SIZES.zones}</dd>
        </div>
        <div>
          <dt>Voter areas</dt>
          <dd>{DECK_SIZES.slots}</dd>
        </div>
      </dl>
      <p className="hint">
        A saved match records these versions. A save whose content pack, board or save schema
        differs from this build is named and refused rather than loaded into the wrong deck.
      </p>

      <h3 className="chapter__subhead">Content filters</h3>
      <p className="panel__lede">
        Some cards carry an advisory mark. The lobby offers a filter for each mark; a filter
        removes every card carrying that mark before the decks are shuffled.
      </p>
      <ul className="disclosures">
        {ADVISORY_FILTERS.map((filter) => (
          <li key={filter.advisory}>
            <strong>
              {filter.label} ({filter.printedMark})
            </strong>
            <span>{filter.description}</span>
          </li>
        ))}
      </ul>

      <h3 className="chapter__subhead">What this build cannot do</h3>
      <ul className="disclosures">
        {KNOWN_LIMITS.map((limit) => (
          <li key={limit.title}>
            <strong>{limit.title}</strong>
            <span>{limit.detail}</span>
          </li>
        ))}
      </ul>
      <p className="notice">{LOCAL_MODE_NOTICE}</p>
    </>
  );
}

/**
 * What a computer seat knows, stated plainly.
 *
 * A person sitting down against the computer is entitled to know whether it is reading
 * their hand. It is not, and the answer is structural rather than a promise:
 * `@seatgrab/computer` does not depend on the engine, so it cannot reach the
 * authoritative state at all.
 */
function ComputerChapter() {
  return (
    <>
      <p className="panel__lede">
        A computer seat plays from the same table you do. It reads its own projection — the
        one thing the engine sends to a seat — and submits the same commands your controls
        do. It never sees the state behind the table.
      </p>
      <ul className="disclosures">
        <li>
          <strong>It sees what you see of the table</strong>
          <span>
            The board, the market, every seat&rsquo;s resources and score, and the public
            history. All of it is public to everyone, you included.
          </span>
        </li>
        <li>
          <strong>It does not see any hand but its own</strong>
          <span>
            Your voter cards, your kept policy cards and your dirty tricks are not in its
            projection, so no difficulty can read them.
          </span>
        </li>
        <li>
          <strong>It does not know what a policy answer pays</strong>
          <span>
            The reward and the archetype of an answer are hidden from a seat until it
            commits, and hidden from the computer on the same terms. All three difficulties
            answer the policy question on a coin flip.
          </span>
        </li>
        <li>
          <strong>It obeys every refusal</strong>
          <span>
            A computer submits commands and the engine decides them. It applies no rule of
            its own, and a command the engine refuses is a defect to report rather than
            something it works around.
          </span>
        </li>
      </ul>
      <p className="small">
        Difficulty changes how well a seat uses public information, and nothing else. Easy
        buys cheap voters and spreads them around. Medium goes for the cheapest majorities
        and uses its powers. Hard targets whoever is leading and times the end of the game.
      </p>
    </>
  );
}

const CHAPTER_BODIES: Record<ChapterId, () => React.JSX.Element> = {
  win: WinChapter,
  turn: TurnChapter,
  board: BoardChapter,
  cards: CardsChapter,
  computer: ComputerChapter,
  house: HouseChapter,
  set: SetChapter,
};

export function RulesInfo() {
  const [chapter, setChapter] = useState<ChapterId>('win');
  const strip = useRef<HTMLDivElement>(null);

  /**
   * Left and right move between chapters, Home and End jump to the ends — the behaviour
   * a tab strip is expected to have. The moved-to button is focused as well as selected,
   * because selection alone would leave the focus ring behind on the old chapter.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const order = CHAPTERS.map((entry) => entry.id);
      const at = order.indexOf(chapter);
      const step =
        event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      let next: ChapterId | undefined;
      if (step !== 0) next = order[(at + step + order.length) % order.length];
      else if (event.key === 'Home') next = order[0];
      else if (event.key === 'End') next = order[order.length - 1];
      if (next === undefined) return;
      event.preventDefault();
      setChapter(next);
      strip.current?.querySelector<HTMLButtonElement>(`#chapter-tab-${next}`)?.focus();
    },
    [chapter],
  );

  const active = CHAPTERS.find((entry) => entry.id === chapter) ?? CHAPTERS[0]!;
  const Body = CHAPTER_BODIES[active.id];

  return (
    <PageFrame
      title="How to play"
      lede="The rules, the board, the cards, and every ruling this build makes for you."
      back={{ href: ROUTES.home, label: 'Title screen' }}
    >
      <div
        className="chapter-strip"
        role="tablist"
        aria-label="Rulebook chapters"
        ref={strip}
        onKeyDown={onKeyDown}
      >
        {CHAPTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            id={`chapter-tab-${entry.id}`}
            className={`chapter-tab${entry.id === chapter ? ' chapter-tab--active' : ''}`}
            role="tab"
            aria-selected={entry.id === chapter}
            aria-controls="chapter-panel"
            tabIndex={entry.id === chapter ? 0 : -1}
            onClick={() => setChapter(entry.id)}
          >
            <Glyph name={entry.glyph} size={24} />
            <span className="chapter-tab__label">{entry.label}</span>
            <span className="chapter-tab__blurb">{entry.blurb}</span>
          </button>
        ))}
      </div>

      <section
        className="panel chapter"
        id="chapter-panel"
        role="tabpanel"
        aria-labelledby={`chapter-tab-${active.id}`}
        tabIndex={-1}
      >
        <h2>{active.label}</h2>
        <Body />
      </section>

      <p className="hint">
        To learn these rules by playing them instead, start the{' '}
        <a href={ROUTES.tutorial}>guided tutorial against the computer</a>.
      </p>
    </PageFrame>
  );
}
