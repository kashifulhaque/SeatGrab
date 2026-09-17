// @vitest-environment jsdom
/**
 * `MatchShell` itself, rendered.
 *
 * Session 21 took the pass-and-play half of the render decision Session 18 answered for
 * `OnlineRoom`. The brief's question was what rendering asserts that `handoff.test.ts` and
 * `action-model.test.ts` do not, and there is an answer, which is why this file exists.
 *
 * `handoff.test.ts` proves the state machine exhaustively: it walks every reachable state
 * against the whole action alphabet and shows that `revealedSeatId` answers with a seat
 * only through that seat's own cover. What it cannot prove is that this screen asks it.
 * A `MatchShell` that read `handoff.seatId` directly, or that drew the seat panel from
 * `coveredSeatId`, would pass every test in that file and publish one seat's hand to the
 * table. That gate is a rendering fact of exactly the kind Session 18 accepted for the
 * `NO_PROJECTION` narrowing, so it is asserted the same way:
 *
 * - **Nothing private is in the document on the shared surface**, and nothing private is
 *   in it while a cover is up. The cover is the state a player is looking at while the
 *   device changes hands, so it is the one that matters.
 * - **A revealed seat sees its own cards and no other seat's.** The two seats here hold
 *   different tricks on purpose: an assertion that p1's panel appears would pass on
 *   a screen that drew every seat's panel at once.
 * - **A finished match offers no composer.** `MatchShell` computes `finished` from the
 *   public projection and hands it to `SeatSurface`, which withholds both composers. The
 *   engine has cleared the interaction stack and `getLegalActions` answers with nothing,
 *   so every control a composer could draw would be one the engine refuses.
 *   `results-model.test.ts` derives the standings; nothing asserted that the controls go.
 *
 * Like `online-room.test.tsx` this drives the production wiring through the seam the real
 * code reaches for — here the snapshot store `MatchShell` resumes from — rather than
 * through module mocks, and it carries the same `@vitest-environment jsdom` docblock,
 * which is why there is still no Vitest configuration file. It asserts which panel is on
 * screen and which control exists, never how either looks. Section 13 work is still owed
 * browser evidence, and a render test is not it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CORE_CONTENT, createGame, type GameConfig, type GameState } from '@gerrymander/engine';

import { MatchShell } from '../src/app/MatchShell';
import { createMemoryStore, summarize, buildEnvelope, writeDocument } from '../src/local';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const MATCH_ID = 'shell-1';

const config: GameConfig = {
  matchId: MATCH_ID,
  players: [
    { id: 'p1', displayName: 'Asha', partyId: 'kite' },
    { id: 'p2', displayName: 'Bikram', partyId: 'cog' },
    { id: 'p3', displayName: 'Chandni', partyId: 'sprout' },
  ],
  contentAdvisories: [],
  tiePolicy: 'jointWinners',
};

/** A card in each seat's hand, so "this seat's own" is distinguishable from "a seat's". */
const P1_CARD = 'TRK006';
const P2_CARD = 'TRK016';
const P1_TITLE = 'Grand Coalition';
const P2_TITLE = 'Musical Chairs';
/** Resource figures no other seat and no other type shares, so a wrong seat shows. */
const P1_CASH = 7;
const P2_INFLUENCE = 9;

/**
 * A saved match in p1's action phase, with a different trick in each seat's hand.
 *
 * The cards are taken off the real draw pile rather than invented, because the engine
 * asserts no card is in two places at once and `readDocument` re-runs those invariants
 * when this screen resumes the save.
 */
function savedMatch(
  status: 'active' | 'finished',
  settings: GameConfig = config,
  activePlayerId = 'p1',
): GameState {
  const state = createGame(settings, CORE_CONTENT, 31);
  state.status = status;
  state.turn.activePlayerId = activePlayerId;
  state.turn.order = ['p1', 'p2', 'p3'];
  state.turn.ordinal = 1;
  state.turn.phase = status === 'finished' ? 'finished' : 'action';
  state.pendingInteraction = null;
  state.interactionStack = [];
  for (const [playerId, cardId] of [['p1', P1_CARD], ['p2', P2_CARD]] as const) {
    const index = state.trickDeck.drawPile.indexOf(cardId);
    if (index < 0) throw new Error(`fixture trick ${cardId} is not in the draw pile`);
    state.trickDeck.drawPile.splice(index, 1);
    state.players.find((player) => player.id === playerId)!.trickHand.push(cardId);
  }
  // Distinct resource holdings, taken out of the reserve so the supply still reconciles:
  // p1 holds cash and nothing else, p2 holds influence and nothing else. A status bar that
  // drew the wrong seat's resources, or every seat's, is then distinguishable from one
  // that drew the revealed seat's.
  state.players.find((player) => player.id === 'p1')!.resources.cash = P1_CASH;
  state.publicReserve.cash -= P1_CASH;
  state.players.find((player) => player.id === 'p2')!.resources.influence = P2_INFLUENCE;
  state.publicReserve.influence -= P2_INFLUENCE;
  return state;
}

let container: HTMLDivElement;
let root: Root;

async function render(
  status: 'active' | 'finished' = 'active',
  settings: GameConfig = config,
  activePlayerId = 'p1',
): Promise<void> {
  const store = createMemoryStore();
  const state = savedMatch(status, settings, activePlayerId);
  const savedAt = new Date(Date.UTC(2026, 0, 1));
  await store.write({
    summary: summarize(buildEnvelope(state, savedAt)),
    document: writeDocument(state, savedAt),
  });
  await act(async () => {
    root.render(<MatchShell matchId={MATCH_ID} store={store} storeError={null} />);
  });
}

function text(): string {
  return container.textContent ?? '';
}

/** The pinned status bar's own text, which is where "your resources" is printed. */
function statusBar(): string {
  return container.querySelector('.status-bar')?.textContent ?? '';
}

function buttonLabelled(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => (candidate.textContent ?? '').includes(label));
  if (button === undefined) throw new Error(`No button labelled ${label}. Screen: ${text()}`);
  return button;
}

async function click(label: string): Promise<void> {
  const button = buttonLabelled(label);
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the pass-and-play privacy cover, rendered', () => {
  it('draws nothing private on the shared surface', async () => {
    await render();
    // The table is drawn, so this is a screen that has loaded rather than one that failed.
    expect(text()).toContain('Match settings');
    expect(text()).toContain('Pass the device');
    expect(container.querySelector('.board--live')).not.toBeNull();

    // And no seat's private surface is in the document.
    expect(text()).not.toContain('Trades, reactions, and debts');
    expect(text()).not.toContain(P1_TITLE);
    expect(text()).not.toContain(P2_TITLE);

    // The status bar names who is acting and draws nobody's resources as "yours".
    expect(statusBar()).toContain('Asha is acting');
    expect(container.querySelector('.status-bar__resources')).toBeNull();
  });

  it('draws nothing private while the cover is up', async () => {
    // The state a player is looking at while the device changes hands.
    await render();
    await click('Pass to Asha');

    expect(text()).toContain('Pass the device to Asha');
    expect(text()).toContain('I am Asha — show my cards');
    expect(text()).not.toContain('Trades, reactions, and debts');
    expect(text()).not.toContain(P1_TITLE);
    expect(text()).not.toContain(P2_TITLE);
    expect(container.querySelector('.status-bar__resources')).toBeNull();
  });

  it('draws the revealed seat’s own cards and no other seat’s', async () => {
    await render();
    await click('Pass to Asha');
    await click('I am Asha');

    expect(text()).toContain('Trades, reactions, and debts');
    expect(text()).toContain(P1_TITLE);
    // The assertion the gate is actually for: p2's card is in the same saved state, one
    // `viewFor` call away, and must not be on the screen.
    expect(text()).not.toContain(P2_TITLE);
  });

  it('draws only the revealed seat’s resources in the status bar', async () => {
    await render();
    await click('Pass to Asha');
    await click('I am Asha');

    // Asha's cash are in the bar, labelled as hers.
    const resources = container.querySelector('.status-bar__resources');
    expect(resources).not.toBeNull();
    expect(resources?.getAttribute('aria-label')).toBe('Asha’s resources');
    expect(resources?.textContent).toContain(`Cash ${P1_CASH}`);
    // Bikram's influence is public — the seat list shows it — but it is not "your resources".
    expect(resources?.textContent).not.toContain(String(P2_INFLUENCE));
    expect(text()).toContain(String(P2_INFLUENCE));
  });

  it('puts the cover back before the next seat’s surface, never straight across', async () => {
    await render();
    await click('Pass to Asha');
    await click('I am Asha');
    expect(text()).toContain(P1_TITLE);

    // Passing to the other seat covers first. Neither hand is on screen in between.
    await click('Pass to Bikram');
    expect(text()).toContain('Pass the device to Bikram');
    expect(text()).not.toContain(P1_TITLE);
    expect(text()).not.toContain(P2_TITLE);

    await click('I am Bikram');
    expect(text()).toContain(P2_TITLE);
    expect(text()).not.toContain(P1_TITLE);
  });

  it('conceals back to the cover rather than to the shared surface', async () => {
    await render();
    await click('Pass to Asha');
    await click('I am Asha');
    await click('Hide my cards');

    expect(text()).toContain('Pass the device to Asha');
    expect(text()).not.toContain(P1_TITLE);
  });
});

describe('a finished match, rendered', () => {
  it('draws the results and offers no composer to a revealed seat', async () => {
    await render('finished');
    expect(text()).toContain('Final scores');

    await click('Pass to Asha');
    await click('I am Asha');

    // The seat can still look over its own kept cards behind the cover.
    expect(text()).toContain(P1_TITLE);
    expect(text()).toContain('Player mat');

    // And every control a composer would draw is gone, because the engine refuses them all.
    expect(text()).toContain('nothing is waiting on you and no action is offered');
    expect(text()).not.toContain('Buy a trick');
    expect(text()).not.toContain(`Play ${P1_TITLE}`);
    expect(text()).not.toContain('Trades, reactions, and debts');
    expect(buttonLabelled('End turn').disabled).toBe(true);
  });
});

/**
 * A table of one person and two computers.
 *
 * The seats and the state are the same as every other case here, so the two hands are
 * still distinguishable; only who plays them changes. The person is p1, whose turn it is.
 */
const soloConfig: GameConfig = {
  ...config,
  players: [
    { id: 'p1', displayName: 'Asha', partyId: 'kite', controller: 'human' },
    { id: 'p2', displayName: 'Bikram', partyId: 'cog', controller: 'computer', difficulty: 'easy' },
    { id: 'p3', displayName: 'Chandni', partyId: 'sprout', controller: 'computer', difficulty: 'medium' },
  ],
};

describe('a table of one person and two computers', () => {
  it('opens on the person’s own seat with no cover and nothing to pass', async () => {
    await render('active', soloConfig);

    // No cover was drawn on the way in, and none can be raised: there is nobody to pass to.
    expect(container.querySelector('.cover-screen')).toBeNull();
    expect(text()).not.toContain('Pass the device');
    expect(text()).not.toContain('Pass to');
    expect(text()).not.toContain('Hide my cards');

    // The person's own panel is on screen, because it opened there.
    expect(text()).toContain('Trades, reactions, and debts');
    expect(text()).toContain(P1_TITLE);
    const resources = container.querySelector('.status-bar__resources');
    expect(resources?.getAttribute('aria-label')).toBe('Asha’s resources');
  });

  it('plays a computer’s turn without ever drawing its private data', async () => {
    // p2 is a computer and it is p2's turn, so the driver has something to do at once.
    await render('active', soloConfig, 'p2');
    // p2 holds a trick in the same saved state, one `viewFor` call away. A computer seat
    // never reveals, so it is never in the document.
    expect(text()).not.toContain(P2_TITLE);
    expect(statusBar()).toContain('thinking');

    // Let the driver run. The pace is read from storage and defaults to Normal, so this
    // waits past the pause rather than assuming Fast.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });

    // It acted: the turn has moved on from the computer that was thinking.
    expect(statusBar()).not.toContain('Bikram (computer) is thinking');
    expect(text()).not.toContain(P2_TITLE);
    expect(container.querySelector('.cover-screen')).toBeNull();
    // The person's own panel is still the only private one on screen.
    expect(text()).toContain(P1_TITLE);
    expect(text()).not.toContain('could not find a legal move');
  });

  it('marks a computer seat in words wherever the table names one', async () => {
    await render('active', soloConfig);
    // The board's own roster prints every seat, and marks the two computers in words
    // rather than only with an icon.
    const roster = container.querySelectorAll('.seat-row__badge');
    const badges = [...roster].map((badge) => badge.textContent);
    expect(badges.filter((badge) => badge === 'computer')).toHaveLength(2);
  });
});
