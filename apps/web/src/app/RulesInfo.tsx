/**
 * The rulebook, reachable from every screen.
 *
 * It is a guided tour rather than a reference: one page, read top to bottom in the order
 * a new player needs it — what you are playing for, the island, your first turn, the
 * powers, redistricting, the cards, how it ends — with the house rules and the build
 * facts folded away at the end for whoever wants them. Every chapter teaches with a
 * picture drawn from the match screen's own vocabulary, so a rule met here is recognised
 * on the board.
 *
 * A chapter list follows the reader, as pills on a phone and a rail on a desktop, so a
 * player who already knows the game can jump to redistricting without scrolling past the
 * turn order. The list bookmarks; it never hides a chapter, so an in-page find searches
 * the whole book.
 *
 * Every sentence restates a rule the engine enforces. Nothing here is a strategy tip and
 * nothing predicts a ruling the engine has not made.
 */
import { useMemo, useRef, type ReactNode } from 'react';

import { CORE_BOARD } from '@gerrymander/content';

import { PARTY_BY_ID, RESOURCE_ASSETS } from '../assets/manifest';
import { BOARD_FACTS, BoardArtwork } from '../board/BoardArtwork';

import { PageFrame } from './PageFrame';
import { ADJUDICATIONS, BACK_COST_VALUES, DECK_SIZES, KNOWN_LIMITS } from './edition';
import { ADVISORY_FILTERS } from './setup';
import { ROUTES } from './routes';
import { Callout } from './rules/Callout';
import {
  ArchetypeTrackDiagram,
  DistrictFillDiagram,
  EXAMPLE_PARTY,
  Figure,
  GerrymanderDiagram,
  PolicyCardDiagram,
  RIVAL_PARTY,
  ScoreDiagram,
  TrickBackDiagram,
  VoterCardDiagram,
} from './rules/diagrams';
import {
  JumpNav,
  NextChapter,
  ProgressBar,
  sectionId,
  useActiveChapter,
  useOpenOnHash,
  useRevealOnScroll,
  type ChapterLink,
} from './rules/navigation';

import './rules/rulebook.css';

const CHAPTERS: readonly ChapterLink[] = [
  { id: 'goal', short: 'The goal', title: 'What you are playing for' },
  { id: 'island', short: 'The island', title: 'The island and its nine districts' },
  { id: 'first-turn', short: 'Your turn', title: 'Your first turn' },
  { id: 'power', short: 'Powers', title: 'Growing power' },
  { id: 'redistricting', short: 'Redistricting', title: 'Redistricting and gerrymandering' },
  { id: 'cards', short: 'Tricks', title: 'Dirty Tricks, Breaking News, trades and reactions' },
  { id: 'ending', short: 'Winning', title: 'How the game ends' },
  { id: 'computer', short: 'The computer', title: 'Playing against the computer' },
  { id: 'house-rules', short: 'House rules', title: 'Appendix: house rules', appendix: true },
  { id: 'about', short: 'This build', title: 'Appendix: about this build', appendix: true },
];

const CHAPTER_IDS = CHAPTERS.map((chapter) => chapter.id);

/** The archetype each resource belongs to, in the order the mat lists them. */
const RESOURCE_ARCHETYPES = [
  { resource: 'cash', archetype: 'Corporate' },
  { resource: 'influence', archetype: 'Nationalist' },
  { resource: 'press', archetype: 'Populist' },
  { resource: 'faith', archetype: 'Reformer' },
] as const;

/**
 * The eight powers as the player mat names and describes them. The wording is the mat's
 * own, so a player who reads it here meets the same sentence on the mat.
 */
const POWERS: readonly { archetype: string; level: 3 | 5; name: string; effect: string }[] = [
  { archetype: 'Corporate', level: 3, name: 'Arbitrage', effect: 'Return one resource to the reserve and take two of your choice.' },
  { archetype: 'Corporate', level: 5, name: 'Demolition', effect: 'Evict a voter from a non-volatile area.' },
  { archetype: 'Nationalist', level: 3, name: 'Shakedown', effect: 'Take one resource of your choice from an opponent.' },
  { archetype: 'Nationalist', level: 5, name: 'Crackdown', effect: 'Pay one resource to discard an opponent voter from a non-volatile area.' },
  { archetype: 'Populist', level: 3, name: 'Groundswell', effect: 'A voter card you influence yields one extra voter for the same price.' },
  { archetype: 'Populist', level: 5, name: 'Landslide', effect: 'Each zone you hold rights in authorizes a second move, and a marked voter may move.' },
  { archetype: 'Reformer', level: 3, name: 'Volunteers', effect: 'Remove resources from a price you are paying instead of spending them.' },
  { archetype: 'Reformer', level: 5, name: 'Outreach', effect: 'Pay 2 faith and 2 of your choice to convert two of one opponent’s voters in one zone.' },
];

const RESOURCE_CAP = 12;

function partyName(partyId: string): string {
  return PARTY_BY_ID.get(partyId)?.displayName ?? partyId;
}

/** A party's name with its emblem, for the worked examples. */
function Party({ partyId }: { partyId: string }) {
  const party = PARTY_BY_ID.get(partyId);
  if (party === undefined) return <strong>{partyId}</strong>;
  return (
    <span className="rb-party" style={{ '--party': party.color } as React.CSSProperties}>
      <img src={party.url} alt="" aria-hidden="true" width={18} height={18} />
      <strong>{party.displayName}</strong>
    </span>
  );
}

/** A resource named with its icon, inline in a sentence. */
function Resource({ id, count }: { id: keyof typeof RESOURCE_ASSETS; count?: number }) {
  const asset = RESOURCE_ASSETS[id];
  return (
    <span className="rb-resource">
      <img src={asset.url} alt="" aria-hidden="true" width={18} height={18} />
      {count === undefined ? asset.label : `${count} ${asset.label}`}
    </span>
  );
}

/**
 * One chapter of the tour: numbered, headed, and closed by the link to the next.
 *
 * The heading takes focus when a pill sends the reader here, so it has `tabIndex={-1}`
 * and the section is labelled by it.
 */
function Chapter({ index, lede, children }: { index: number; lede: ReactNode; children: ReactNode }) {
  const chapter = CHAPTERS[index]!;
  const next = CHAPTERS[index + 1];
  const headingId = `${sectionId(chapter.id)}-heading`;
  return (
    <section
      id={sectionId(chapter.id)}
      className={chapter.appendix ? 'rb-chapter rb-chapter--appendix' : 'rb-chapter'}
      aria-labelledby={headingId}
    >
      <header className="rb-chapter__head">
        <p className="rb-chapter__n">{chapter.appendix ? 'Appendix' : `Chapter ${index + 1}`}</p>
        <h2 id={headingId} className="rb-chapter__title" tabIndex={-1}>{chapter.title}</h2>
        <p className="rb-chapter__lede">{lede}</p>
      </header>
      <div className="rb-chapter__body">{children}</div>
      <NextChapter chapter={next} />
    </section>
  );
}

/* ------------------------------------------------------------- the chapters */

function GoalChapter() {
  return (
    <Chapter
      index={0}
      lede={
        <>
          Gerrymander is a race for the nine districts of one island. Fill a district’s
          threshold with your own voters and you hold it; when all nine are held, the party
          with the most majority voters wins.
        </>
      }
    >
      <p>
        You play a party. Each turn you answer a policy question, take the resources your
        stance earns, spend them on voters in the market and put those voters on the map.
        Your rivals do the same, on the same map, and the districts you are racing for are
        the ones they are racing for too.
      </p>
      <Figure caption={`The island. Every plaque names a district and reads threshold over capacity: the voters you need to hold it, over the voter areas it has. Nine districts, ${BOARD_FACTS.slots} areas.`} wide>
        <div className="rb-boardwrap">
          <BoardArtwork title="The island: nine districts, each with a plaque showing its threshold and capacity" />
        </div>
      </Figure>
      <h3>Before the first turn</h3>
      <p>
        Everyone votes for who goes first. Nobody may vote for themselves, and a tie is voted
        again. Turns then go clockwise from the winner. Each player takes starting resources
        in turn order: the first player takes any one resource, the second any two, and so on.
      </p>
    </Chapter>
  );
}

function IslandChapter() {
  const zones = CORE_BOARD.zones;
  return (
    <Chapter
      index={1}
      lede="Nine districts, one island. Each one shows how many of your voters it takes to hold it, and every rule about the map follows from where the borders touch."
    >
      <p>
        Central sits at the heart of the island. North and South belt it, and the other six
        districts lie around the coast. Two districts are <strong>neighbours</strong> exactly
        when their borders touch on the map, so Central touches only North and South, and North
        touches six districts.
      </p>
      <Figure
        wide
        caption="Central and its two neighbours, North and South, highlighted. The dashed rings are volatile areas."
      >
        <div className="rb-boardwrap">
          <BoardArtwork
            highlightedZones={['central', 'north', 'south']}
            title="The island with Central, North and South highlighted, showing that Central borders only those two"
          />
        </div>
      </Figure>

      <h3>Threshold and capacity</h3>
      <p>
        A district’s plaque reads two numbers. The <strong>threshold</strong> is how many of
        your own voters it takes to hold the district. The <strong>capacity</strong> is how
        many voter areas it has in total. Central is the smallest, at 5 of 9; North and South
        are the largest, at 11 of 21.
      </p>
      <ul className="rb-zones" aria-label="The nine districts, with threshold and capacity">
        {zones.map((zone) => (
          <li key={zone.id} className="rb-zone">
            <span className="rb-zone__name">{zone.displayName}</span>
            <span className="rb-zone__plaque">
              <span className="rb-zone__threshold">{zone.majorityThreshold}</span>
              <span className="rb-zone__cap">/{zone.capacity}</span>
            </span>
            <span className="rb-zone__volatile">{zone.volatileAreas} volatile</span>
          </li>
        ))}
      </ul>

      <h3>Holding a district</h3>
      <p>
        Reach a district’s threshold with your own voters and the district is yours. Exactly
        that many of your voters are <strong>marked as the majority</strong>, drawn with a ring
        and a tick, and the marks stay where they are as the board changes. Each marked voter is
        one point at the end of the game.
      </p>
      <Figure caption="A district with threshold six. Four Kite voters are not yet a majority. Six are, and they are marked. A seventh Kite voter in the same district is not marked and scores nothing.">
        <DistrictFillDiagram />
      </Figure>
      <Callout kind="example" title="Central, threshold 5">
        <p>
          <Party partyId={EXAMPLE_PARTY} /> holds 4 voters in Central. One more Kite voter there
          marks five of them as Central’s majority, and Kite holds the district. A sixth Kite
          voter placed in Central adds nothing to Kite’s score.
        </p>
      </Callout>
      <Callout kind="mistake">
        <p>
          Voters above the threshold don’t score, and voters in a district you don’t hold don’t
          score either. Only marked voters count.
        </p>
      </Callout>

      <h3>Volatile areas</h3>
      <p>
        {BOARD_FACTS.volatileSlots} of the {BOARD_FACTS.slots} areas are drawn with a dashed
        ring. They are <strong>volatile</strong>: a voter placed there is fixed for the rest of
        the game, and its owner is dealt a <strong>Breaking News</strong> card that resolves at
        the end of the turn. Every district has at least one; North and South have two.
      </p>
    </Chapter>
  );
}

function FirstTurnChapter() {
  return (
    <Chapter
      index={2}
      lede="A turn is a short story with a fixed shape: take your income, answer a question, spend what you have on voters, put them on the map, and end. Here it is, walked through once."
    >
      <ol className="rb-steps" aria-label="The shape of a turn">
        <li className="rb-step"><span className="rb-step__n">1</span><span>Passive income</span></li>
        <li className="rb-step"><span className="rb-step__n">2</span><span>Answer the question</span></li>
        <li className="rb-step"><span className="rb-step__n">3</span><span>Buy and place voters, act</span></li>
        <li className="rb-step"><span className="rb-step__n">4</span><span>End the turn</span></li>
      </ol>

      <h3>Your turn opens with income you didn’t ask for</h3>
      <p>
        Every two policy cards you hold in the same archetype pay you one resource of that
        archetype’s type. It arrives on its own at the start of your turn; you neither choose it
        nor skip it. On your first turn you hold no policy cards, so there is nothing yet.
      </p>

      <h3>Then the table asks you a question</h3>
      <p>
        A policy card is drawn and you see a question with two answers. What you don’t see is
        what each answer pays: the archetype it builds and the resources it earns are hidden
        until you commit. Pick the answer you want to stand behind. The card is then kept face
        up under that answer’s archetype and pays you the resources it shows. If you would
        rather answer a different question, pay any 4 resources to redraw, as often as you can
        pay.
      </p>
      <Figure caption="A policy card. Each of its two answers belongs to one of the four archetypes: Corporate, Nationalist, Populist or Reformer. Committing an answer adds that card to the archetype’s track and pays the resources printed under the answer.">
        <PolicyCardDiagram />
      </Figure>

      <h3>Count what you hold</h3>
      <p>
        There are four resources, one for each archetype. You may hold at most{' '}
        {RESOURCE_CAP} in total; the moment you hold more, you discard down to {RESOURCE_CAP}.
      </p>
      <ul className="rb-resources" aria-label="The four resources and their archetypes">
        {RESOURCE_ARCHETYPES.map(({ resource, archetype }) => (
          <li key={resource} className="rb-resources__item" style={{ '--rb-accent': `var(--${resource})` } as React.CSSProperties}>
            <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={30} height={30} />
            <span className="rb-resources__text">
              <strong>{RESOURCE_ASSETS[resource].label}</strong>
              <span className="rb-resources__sub">{archetype}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="rb-aside">
        A <strong>?</strong> in a price means any one resource of your choice. It is a wildcard
        payment, not a fifth resource.
      </p>

      <h3>Now spend</h3>
      <p>
        The market shows voter cards face up. Each one says how many voters it brings and what
        it costs. Pay the price and the voters are yours to place, and you may buy as many
        cards as you can afford. Every voter from one card goes into <strong>one district</strong>,
        each on an empty area.
      </p>
      <Figure caption="A voter card: two voters for two Cash and one Influence. Both voters go into the same district.">
        <VoterCardDiagram />
      </Figure>
      <Callout kind="example" title="A first purchase">
        <p>
          <Party partyId={EXAMPLE_PARTY} /> holds <Resource id="cash" count={3} /> and{' '}
          <Resource id="influence" count={2} />. Kite pays <Resource id="cash" count={2} /> and{' '}
          <Resource id="influence" count={1} /> for a two-voter card and places both voters in
          North West. Kite ends the turn with <Resource id="cash" count={1} /> and{' '}
          <Resource id="influence" count={1} />.
        </p>
      </Callout>
      <Callout kind="mistake">
        <p>
          A card’s voters can’t be split across districts. Two voters from one card go into one
          district together, never one here and one there.
        </p>
      </Callout>

      <h3>Do anything else you can</h3>
      <p>
        In any order, on the same turn: use a power you have unlocked, use redistricting rights
        once in each district you hold them in, buy a Dirty Trick face down or play one from your
        hand, and trade with another player. The next chapters cover each of these.
      </p>

      <h3>End your turn</h3>
      <p>
        Voters you bought but did not place are <strong>lost</strong>. Any Breaking News card
        dealt to you this turn resolves now, and play passes clockwise.
      </p>
      <Callout kind="mistake">
        <p>
          Unplaced voters are lost when the turn ends. Don’t buy a card whose voters you have no
          empty district for.
        </p>
      </Callout>
    </Chapter>
  );
}

function PowerChapter() {
  return (
    <Chapter
      index={3}
      lede="Every answer you commit is a card on one of four tracks. The tracks pay you, and at three and five cards they hand you a power."
    >
      <p>
        Each archetype is a track of the policy cards you have kept under it. Two cards on a
        track pay one resource of that archetype’s type at the start of every turn; four pay
        two. Three cards unlock the archetype’s <strong>first power</strong>, and five its{' '}
        <strong>second</strong>. Lose the cards and the income and the power go with them.
      </p>
      <Figure caption="A Nationalist track at three cards. Two cards pay one Influence a turn, three unlock Shakedown, four pay two Influence a turn, and five unlock Crackdown.">
        <ArchetypeTrackDiagram />
      </Figure>
      <Callout kind="example" title="Three answers as a Nationalist">
        <p>
          <Party partyId={EXAMPLE_PARTY} /> has committed three Nationalist answers. Kite takes{' '}
          <Resource id="influence" count={1} /> at the start of every turn and may use Shakedown.
          A fourth Nationalist card would raise the income to two; a fifth would unlock Crackdown.
        </p>
      </Callout>
      <h3>The eight powers</h3>
      <p>Your mat lists all eight and names the ones you have unlocked. These are its words.</p>
      <ul className="rb-powers">
        {POWERS.map((power) => (
          <li key={power.name} className="rb-power" style={{ '--rb-accent': `var(--${RESOURCE_ARCHETYPES.find((entry) => entry.archetype === power.archetype)?.resource ?? 'cash'})` } as React.CSSProperties}>
            <span className="rb-power__meta">
              <span className="rb-power__archetype">{power.archetype}</span>
              <span className="rb-power__level">{power.level} cards</span>
            </span>
            <strong className="rb-power__name">{power.name}</strong>
            <span className="rb-power__effect">{power.effect}</span>
          </li>
        ))}
      </ul>
    </Chapter>
  );
}

function RedistrictingChapter() {
  return (
    <Chapter
      index={4}
      lede="The party with the most voters in a district gets to redraw it a little: one voter, once a turn, across a border that touches."
    >
      <p>
        Hold <strong>strictly the most</strong> voters in a district and you gain its{' '}
        <strong>redistricting rights</strong>. A tie gives them to nobody. Once a turn, in each
        district you hold rights in, you may move one voter — yours or a rival’s — into, out of
        or within that district.
      </p>
      <p>
        A move goes between that district and one of its neighbours, or between two of its
        neighbours that also touch each other. Neighbours are districts whose borders touch on
        the map, so the rights in North reach six districts and the rights in Central reach two.
      </p>
      <Figure caption="Kite holds the rights in Central and moves a Cog voter across the shared border into North. The Kite voter marked as part of a majority stays where it is.">
        <GerrymanderDiagram />
      </Figure>
      <Figure wide caption="West and its neighbours. Rights in West let a voter move between West and any of the highlighted districts, or between two of them that touch each other.">
        <div className="rb-boardwrap">
          <BoardArtwork
            highlightedZones={['west', 'northWest', 'north', 'south', 'southWest']}
            showVolatile={false}
            title="The island with West and its four neighbours highlighted"
          />
        </div>
      </Figure>
      <Callout kind="example" title="Rights in Central">
        <p>
          <Party partyId={EXAMPLE_PARTY} /> has 3 voters in Central and <Party partyId={RIVAL_PARTY} /> has
          2, so Kite holds Central’s rights. This turn Kite may move one Cog voter out of Central
          into North or South, or bring one Kite voter in from either of them.
        </p>
      </Callout>
      <Callout kind="mistake">
        <p>
          A voter marked as part of a majority can’t be gerrymandered, and a voter on a volatile
          area is fixed for the game. The rights move unmarked voters only; the one exception is
          the Populist second power, Landslide, which lets a marked voter move.
        </p>
      </Callout>
    </Chapter>
  );
}

function CardsChapter() {
  return (
    <Chapter
      index={5}
      lede="Three more kinds of card cross the table, and two of them can interrupt someone else’s turn."
    >
      <h3>Dirty Tricks</h3>
      <p>
        A Dirty Trick is bought <strong>face down</strong> for the price printed on its back —{' '}
        {BACK_COST_VALUES.join(' or ')} resources in this set — so nobody, you included, knows
        which card you took until you hold it. Play it on your own turn, or as a reaction when
        the card says so. A card that names an exact number of targets needs that many legal
        targets; without them it is refused and stays in your hand.
      </p>
      <Figure caption={`A Dirty Trick, face down. The back shows the price, ${BACK_COST_VALUES.join(' or ')} of any resource, and nothing else.`}>
        <TrickBackDiagram prices={BACK_COST_VALUES} />
      </Figure>

      <h3>Breaking News</h3>
      <p>
        Breaking News is dealt by the board, not bought: placing a voter on a volatile area
        deals one to you. A card dealt during a turn resolves when that turn ends, and if
        several were dealt they resolve in the order they arrived.
      </p>

      <h3>Trades</h3>
      <p>
        A trade must involve the player whose turn it is, must move something both ways, and
        needs both sides to agree. Resources and Dirty Tricks can be traded; voters and policy
        cards cannot. Each side must give at least one resource, so a trade can’t be tricks
        alone.
      </p>

      <h3>Reactions</h3>
      <p>
        Some cards open a window in which other players may react, and a few open an auction.
        Reaction windows go around the table clockwise: each eligible player acts or passes in
        turn, and the order messages arrive in never decides.
      </p>
      <Callout kind="example" title="A trade">
        <p>
          On <Party partyId={EXAMPLE_PARTY} />’s turn, Kite offers <Resource id="press" count={2} /> to{' '}
          <Party partyId={RIVAL_PARTY} /> for <Resource id="cash" count={1} /> and a Dirty Trick
          from Cog’s hand. Both sides give a resource, so the trade is legal; it happens only
          if Cog accepts.
        </p>
      </Callout>
    </Chapter>
  );
}

function EndingChapter() {
  return (
    <Chapter
      index={6}
      lede="The game has two ways to end and one way to score: a point for every voter marked as part of a majority."
    >
      <h3>Every district is held</h3>
      <p>
        When all nine districts are held, the game ends. The engine checks at the end of each
        turn, so the turn in which the ninth majority arrives is played out first.
      </p>
      <h3>The board fills</h3>
      <p>
        If the last empty area is taken before every district is held, the turn that fills it
        is that player’s final turn. Every other player then takes one more turn in order, and
        the game is scored where it stands. An area that empties later does not cancel or
        restart this.
      </p>
      <h3>Who wins</h3>
      <p>
        Count your voters that are marked as a majority. The party with the most wins. Players
        tied on that count all win; nothing else breaks a tie.
      </p>
      <Figure caption="Three parties at the end of a game, scored on marked voters. Kite has the most and wins.">
        <ScoreDiagram
          rows={[
            { partyId: 'kite', name: partyName('kite'), score: 31 },
            { partyId: 'cog', name: partyName('cog'), score: 27 },
            { partyId: 'sprout', name: partyName('sprout'), score: 22 },
          ]}
        />
      </Figure>
      <Callout kind="mistake">
        <p>
          The number of districts you hold, the voters you have on the board and the resources
          you have left decide nothing. Only marked voters score.
        </p>
      </Callout>
    </Chapter>
  );
}

/**
 * What a computer seat knows, stated plainly.
 *
 * A person sitting down against the computer is entitled to know whether it is reading
 * their hand. It is not, and the answer is structural rather than a promise:
 * `@gerrymander/computer` does not depend on the engine, so it cannot reach the
 * authoritative state at all.
 */
function ComputerChapter() {
  return (
    <Chapter
      index={7}
      lede="A computer seat plays from the same table you do. It reads its own view of the match and submits the same commands your controls do. It never sees the state behind the table."
    >
      <div className="rb-sees" role="img" aria-label="Two lists. What the computer sees: the board, the market, every seat’s resources and score, the public history. What it does not see: your voter cards, your kept policy cards, your dirty tricks, and what a policy answer pays.">
        <div className="rb-sees__col rb-sees__col--yes">
          <p className="rb-sees__head">It sees, like you</p>
          <ul>
            <li>The board</li>
            <li>The market</li>
            <li>Every seat’s resources and score</li>
            <li>The public history</li>
          </ul>
        </div>
        <div className="rb-sees__col rb-sees__col--no">
          <p className="rb-sees__head">It never sees</p>
          <ul>
            <li>Your voter cards</li>
            <li>Your kept policy cards</li>
            <li>Your Dirty Tricks</li>
            <li>What a policy answer pays</li>
          </ul>
        </div>
      </div>
      <ul className="rb-facts">
        <li>
          <strong>It sees what you see of the table.</strong> The board, the market, every
          seat’s resources and score, and the public history. All of it is public to everyone,
          you included.
        </li>
        <li>
          <strong>It does not see any hand but its own.</strong> Your voter cards, your kept
          policy cards and your dirty tricks are not in its view, so no difficulty can read them.
        </li>
        <li>
          <strong>It does not know what a policy answer pays.</strong> The reward and the
          archetype of an answer are hidden from a seat until it commits, and hidden from the
          computer on the same terms. All three difficulties answer the policy question on a
          coin flip.
        </li>
        <li>
          <strong>It obeys every refusal.</strong> A computer submits commands and the engine
          decides them. It applies no rule of its own, and a command the engine refuses is a
          defect to report rather than something it works around.
        </li>
      </ul>
      <p className="rb-aside">
        Difficulty changes how well a seat uses public information, and nothing else. Easy buys
        cheap voters and spreads them around. Medium goes for the cheapest majorities and uses
        its powers. Hard targets whoever is leading and times the end of the game.
      </p>
    </Chapter>
  );
}

function HouseRulesChapter() {
  return (
    <Chapter
      index={8}
      lede={`Where a table might argue, the engine applies one ruling to every match. These are the ${ADJUDICATIONS.length} rulings. Open the ones you want to read.`}
    >
      <ul className="rb-rulings">
        {ADJUDICATIONS.map((entry) => (
          <li key={entry.id}>
            <details className="rb-ruling">
              <summary className="rb-ruling__summary">
                <span className="rb-ruling__id">{entry.id}</span>
                <span className="rb-ruling__issue">{entry.issue}</span>
              </summary>
              <p className="rb-ruling__body">{entry.ruling}</p>
            </details>
          </li>
        ))}
      </ul>
    </Chapter>
  );
}

function AboutChapter() {
  return (
    <Chapter
      index={9}
      lede="What this build filters and what it cannot do, for whoever wants to know before a match."
    >
      <details className="rb-details">
        <summary className="rb-details__summary">Content filters</summary>
        <p>
          Some cards carry an advisory mark. The lobby offers a filter for each mark; a filter
          removes every card carrying that mark before the decks are shuffled.
        </p>
        <ul className="rb-facts">
          {ADVISORY_FILTERS.map((filter) => (
            <li key={filter.advisory}>
              <strong>{filter.label} ({filter.printedMark}).</strong> {filter.description}
            </li>
          ))}
        </ul>
      </details>
      <details className="rb-details">
        <summary className="rb-details__summary">What this build cannot do</summary>
        <ul className="rb-facts">
          {KNOWN_LIMITS.map((limit) => (
            <li key={limit.title}>
              <strong>{limit.title}.</strong> {limit.detail}
            </li>
          ))}
        </ul>
      </details>
      <p className="rb-aside">
        This set has {DECK_SIZES.voter} voter cards, {DECK_SIZES.policy} policy cards,{' '}
        {DECK_SIZES.news} Breaking News cards and {DECK_SIZES.trick} Dirty Tricks.
      </p>
    </Chapter>
  );
}

/* ---------------------------------------------------------------- the page */

export function RulesInfo() {
  const book = useRef<HTMLDivElement>(null);
  const active = useActiveChapter(CHAPTER_IDS);
  useRevealOnScroll(book);
  useOpenOnHash(CHAPTER_IDS);
  const chapters = useMemo(() => CHAPTERS, []);

  return (
    <PageFrame
      title="How to play"
      lede="The rules as a guided tour, from the goal to the last turn. Read it top to bottom, or jump to the chapter you need."
      back={{ href: ROUTES.home, label: 'Title screen' }}
    >
      <ProgressBar />
      <div className="rb-layout">
        <JumpNav chapters={chapters} active={active} />
        <div className="rb-book" ref={book}>
          <GoalChapter />
          <IslandChapter />
          <FirstTurnChapter />
          <PowerChapter />
          <RedistrictingChapter />
          <CardsChapter />
          <EndingChapter />
          <ComputerChapter />
          <HouseRulesChapter />
          <AboutChapter />
          <p className="rb-hint">
            To learn these rules by playing them instead, start the{' '}
            <a href={ROUTES.tutorial}>guided tutorial against the computer</a>.
          </p>
        </div>
      </div>
    </PageFrame>
  );
}
