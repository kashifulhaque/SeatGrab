/**
 * The lobby's setup model.
 *
 * The session's exit criterion is that a browser user can create and enter a local
 * three- or five-player setup without editing code, so the tests end where the screen
 * does: a draft built only from the lobby's own operations is handed to `createGame` and
 * to the local adapter, and the resulting match is inspected.
 */
import { describe, expect, it } from 'vitest';

import { CORE_CONTENT, createGame } from '@seatgrab/engine';

import { PARTY_IDENTITIES } from '../src/assets/parties';
import { createLocalMatch, createMemoryStore, listLocalMatches, randomSeed } from '../src/local';
import {
  MAX_SEATS,
  MIN_SEATS,
  addSeat,
  advisoryImpact,
  assignParty,
  defaultSetupDraft,
  moveSeat,
  newMatchId,
  removeSeat,
  renameSeat,
  toGameConfig,
  toggleAdvisory,
  validateSetup,
  type SetupDraft,
} from '../src/app/setup';

function grow(draft: SetupDraft, to: number): SetupDraft {
  let current = draft;
  while (current.seats.length < to) current = addSeat(current);
  return current;
}

describe('the lobby setup model', () => {
  it('opens on the smallest legal table, already valid', () => {
    const draft = defaultSetupDraft();
    expect(draft.seats).toHaveLength(MIN_SEATS);
    expect(validateSetup(draft)).toEqual([]);
    expect(new Set(draft.seats.map((seat) => seat.partyId)).size).toBe(MIN_SEATS);
    expect(new Set(draft.seats.map((seat) => seat.displayName)).size).toBe(MIN_SEATS);
  });

  it('grows to the largest legal table and stops, keeping parties distinct', () => {
    const full = grow(defaultSetupDraft(), MAX_SEATS);
    expect(full.seats).toHaveLength(MAX_SEATS);
    expect(new Set(full.seats.map((seat) => seat.partyId)).size).toBe(MAX_SEATS);
    expect(validateSetup(full)).toEqual([]);
    expect(addSeat(full)).toBe(full);
  });

  it('refuses to shrink below the smallest legal table', () => {
    const draft = defaultSetupDraft();
    const first = draft.seats[0];
    expect(first).toBeDefined();
    expect(removeSeat(draft, first!.key)).toBe(draft);

    const four = addSeat(draft);
    expect(removeSeat(four, first!.key).seats).toHaveLength(MIN_SEATS);
  });

  it('swaps parties rather than letting two seats hold one', () => {
    const draft = defaultSetupDraft();
    const [one, two] = draft.seats;
    expect(one && two).toBeTruthy();
    const swapped = assignParty(draft, one!.key, two!.partyId);
    expect(swapped.seats[0]?.partyId).toBe(two!.partyId);
    expect(swapped.seats[1]?.partyId).toBe(one!.partyId);
    expect(validateSetup(swapped)).toEqual([]);
  });

  it('reorders seats and clamps at both ends', () => {
    const draft = defaultSetupDraft();
    const last = draft.seats[MIN_SEATS - 1];
    expect(last).toBeDefined();
    expect(moveSeat(draft, last!.key, 1)).toBe(draft);

    const moved = moveSeat(draft, last!.key, -1);
    expect(moved.seats.map((seat) => seat.key)).toEqual([
      draft.seats[0]?.key,
      draft.seats[2]?.key,
      draft.seats[1]?.key,
    ]);
  });

  it('rejects a blank name and two seats sharing one, whatever the case', () => {
    const draft = defaultSetupDraft();
    const [one, two] = draft.seats;
    const blank = renameSeat(draft, one!.key, '   ');
    expect(validateSetup(blank).map((problem) => problem.field)).toContain('displayName');

    const clashing = renameSeat(renameSeat(draft, one!.key, 'Asha'), two!.key, 'asha');
    const problems = validateSetup(clashing);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.seatKey).toBe(two!.key);
    expect(problems[0]?.field).toBe('displayName');
  });

  it('numbers the engine seats from the clockwise order and trims the names', () => {
    const draft = renameSeat(defaultSetupDraft(), defaultSetupDraft().seats[0]!.key, 'ignored');
    const named = draft.seats.reduce(
      (current, seat, index) => renameSeat(current, seat.key, `  Player ${'ABC'[index]}  `),
      draft,
    );
    const config = toGameConfig(named, 'local-test');
    expect(config.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p3']);
    expect(config.players.map((player) => player.displayName)).toEqual([
      'Player A',
      'Player B',
      'Player C',
    ]);
    expect(config.tiePolicy).toBe('jointWinners');
    expect(config.matchId).toBe('local-test');
  });

  it('refuses to freeze an invalid draft into a config', () => {
    const draft = defaultSetupDraft();
    const blank = renameSeat(draft, draft.seats[0]!.key, '');
    expect(() => toGameConfig(blank, 'local-test')).toThrow(/not ready to start/);
  });

  it('counts exactly the cards an advisory filter removes', () => {
    const none = advisoryImpact(CORE_CONTENT, []);
    expect(none).toEqual({ policy: 0, news: 0, trick: 0, total: 0 });

    const both = advisoryImpact(CORE_CONTENT, ['sensitive', 'trigger']);
    const marked = [
      ...CORE_CONTENT.policyCards,
      ...CORE_CONTENT.newsCards,
      ...CORE_CONTENT.trickCards,
    ].filter((card) => card.advisory !== undefined).length;
    expect(both.total).toBe(marked);
    expect(both.total).toBeGreaterThan(0);

    const sensitive = advisoryImpact(CORE_CONTENT, ['sensitive']);
    const trigger = advisoryImpact(CORE_CONTENT, ['trigger']);
    expect(sensitive.total + trigger.total).toBe(both.total);
  });

  it('toggles advisory filters on and off in the lobby’s own order', () => {
    const draft = defaultSetupDraft();
    expect(draft.advisories).toEqual([]);
    const trigger = toggleAdvisory(draft, 'trigger');
    expect(trigger.advisories).toEqual(['trigger']);
    const both = toggleAdvisory(trigger, 'sensitive');
    expect(both.advisories).toEqual(['sensitive', 'trigger']);
    expect(toggleAdvisory(both, 'trigger').advisories).toEqual(['sensitive']);
  });

  it('mints a distinct, readable match ID', () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    expect(newMatchId(now, 0.5)).toMatch(/^local-[0-9a-z]+-[0-9a-z]{4}$/);
    expect(newMatchId(now, 0.1)).not.toBe(newMatchId(now, 0.9));
  });

  it('removes the filtered cards from the decks the engine shuffles', () => {
    const draft = toggleAdvisory(defaultSetupDraft(), 'trigger');
    const filtered = createGame(toGameConfig(draft, 'local-filtered'), CORE_CONTENT, 7);
    const unfiltered = createGame(
      toGameConfig(defaultSetupDraft(), 'local-unfiltered'),
      CORE_CONTENT,
      7,
    );
    const impact = advisoryImpact(CORE_CONTENT, ['trigger']);
    expect(unfiltered.newsDeck.drawPile.length - filtered.newsDeck.drawPile.length)
      .toBe(impact.news);
    expect(unfiltered.trickDeck.drawPile.length - filtered.trickDeck.drawPile.length)
      .toBe(impact.trick);
    expect(unfiltered.policyDeck.drawPile.length - filtered.policyDeck.drawPile.length)
      .toBe(impact.policy);
  });

  for (const size of [MIN_SEATS, MAX_SEATS]) {
    it(`creates and saves a ${size}-player match from lobby operations alone`, async () => {
      const draft = grow(defaultSetupDraft(), size);
      const store = createMemoryStore();
      const matchId = newMatchId(new Date('2026-09-15T10:00:00.000Z'), 0.25);
      const match = await createLocalMatch(
        { store, content: CORE_CONTENT },
        toGameConfig(draft, matchId),
        randomSeed(),
      );

      expect(match.matchId).toBe(matchId);
      expect(match.state().players).toHaveLength(size);
      expect(match.state().status).toBe('setup');
      expect(match.state().turn.phase).toBe('firstPlayerElection');

      // Seat order is clockwise turn order, and every party is one this build draws.
      expect(match.state().turn.order).toEqual(
        draft.seats.map((_, index) => `p${index + 1}`),
      );
      for (const player of match.state().players) {
        expect(PARTY_IDENTITIES.some((party) => party.partyId === player.partyId)).toBe(true);
      }

      // Every seat is asked to vote, and no seat can see another's authorized view.
      const saved = await listLocalMatches(store);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.unreadableReason).toBeNull();
      for (const player of match.state().players) {
        const result = match.viewFor({ kind: 'player', playerId: player.id });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.view.prompt?.kind).toBe('firstPlayerVote');
      }
      const shared = match.viewFor({ kind: 'public' });
      expect(shared.ok).toBe(true);
      if (shared.ok) {
        expect(shared.view.prompt).toBeUndefined();
        expect(shared.view.privateTrickIds).toBeUndefined();
      }
    });
  }
});
