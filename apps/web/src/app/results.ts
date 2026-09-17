/**
 * What a finished match says about itself, decided here rather than inside a component.
 *
 * Section 13.11 asks the results screen for each seat's final majority score, a
 * zone-by-zone breakdown that names the voters which did *not* count, the end reason,
 * the tie policy, joint winners, the retained policy summary, the public history, and
 * a rematch that keeps the settings but shuffles again. Every one of those is a
 * derivation from a single `PlayerView`, so they live in a module a unit test can call.
 *
 * Three rules hold here:
 *
 * 1. The score is the engine's. `finalScores` is read as written; nothing in this file
 *    recomputes a total, and nothing adds a bonus. The counts below exist to *explain*
 *    that score — to show which voters were marked and which were surplus — not to
 *    arrive at it a second way.
 * 2. No moral score. Section 13.11 forbids inventing a "best policy" ranking, so the
 *    policy summary is reported as the four printed track counts and nothing else.
 * 3. A rematch is a new match. The settings are copied; the seed is not, and the config
 *    this file builds carries no state from the finished game.
 */
import type { GameConfig } from '@gerrymander/engine';
import type { PlayerView, PublicPlayerView } from '@gerrymander/protocol';

/** One seat's voters in one zone, split by whether they counted. */
export interface ZoneHoldingResult {
  playerId: string;
  displayName: string;
  partyId: string;
  seat: number;
  /** Voters marked for the majority. These are the ones that scored. */
  counted: number;
  /** Voters standing in the zone that were never marked. These scored nothing. */
  surplus: number;
}

export interface ZoneResult {
  id: string;
  displayName: string;
  capacity: number;
  majorityThreshold: number;
  filled: number;
  empty: number;
  /** The seat holding the majority here, or `null` when the zone never resolved one. */
  majorityOwner: ZoneHoldingResult | null;
  /** Every seat with at least one voter here, most counted voters first, then by seat. */
  holdings: readonly ZoneHoldingResult[];
  /** Voters standing in this zone that counted for nobody. */
  surplusTotal: number;
  /** The sentence a screen reader is given for the whole row. */
  spoken: string;
}

export interface Standing {
  player: PublicPlayerView;
  /** The engine's final score for this seat: its marked majority voters. */
  score: number;
  /** Shared rank, so joint winners are both rank 1 and the next seat is rank 3. */
  rank: number;
  winner: boolean;
  /** Every voter this seat had on the board, counted and surplus together. */
  boardVoters: number;
  /** Board voters that were never marked, so never scored. */
  surplusVoters: number;
  /** Zones where this seat held the majority. */
  zonesWon: readonly string[];
}

export interface MatchResults {
  /** The engine's own reason, or `null` when a finished match recorded none. */
  reason: 'allMajorities' | 'fullBoardFinalTurns' | null;
  /** That reason in words, always present, so no screen has to invent one. */
  reasonSentence: string;
  tiePolicySentence: string;
  standings: readonly Standing[];
  winners: readonly PublicPlayerView[];
  /** True when more than one seat tied for the top score. */
  jointWinners: boolean;
  zones: readonly ZoneResult[];
  /** Marked voters across the whole board: the sum of every seat's score. */
  countedTotal: number;
  /** Board voters that counted for nobody, across the whole board. */
  surplusTotal: number;
  /** Zones that never resolved a majority. Non-empty only after a full-board end. */
  unresolvedZones: readonly string[];
}

const REASON_SENTENCES: Readonly<Record<'allMajorities' | 'fullBoardFinalTurns', string>> = {
  allMajorities:
    'Every zone had a majority, so the match ended at the turn checkpoint and was scored '
    + 'where it stood.',
  fullBoardFinalTurns:
    'The board filled before all nine majorities existed. Every seat took one last turn, '
    + 'starting with the seat that filled the last empty area, and the match was then scored.',
};

function namesOf(players: readonly PublicPlayerView[]): string {
  if (players.length === 0) return 'nobody';
  if (players.length === 1) return players[0]!.displayName;
  const names = players.map((player) => player.displayName);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

function zoneResult(
  zone: PlayerView['zones'][number],
  view: PlayerView,
): ZoneResult {
  const zoneSlots = view.slots.filter((slot) => slot.zoneId === zone.id);
  const totals = new Map<string, { counted: number; surplus: number }>();
  let filled = 0;
  for (const slot of zoneSlots) {
    if (slot.voter === undefined) continue;
    filled += 1;
    const running = totals.get(slot.voter.ownerId) ?? { counted: 0, surplus: 0 };
    if (slot.voter.majority) running.counted += 1;
    else running.surplus += 1;
    totals.set(slot.voter.ownerId, running);
  }

  const holdingFor = (player: PublicPlayerView, counted: number, surplus: number): ZoneHoldingResult => ({
    playerId: player.id,
    displayName: player.displayName,
    partyId: player.partyId,
    seat: player.seat,
    counted,
    surplus,
  });

  const holdings = view.players
    .flatMap((player) => {
      const running = totals.get(player.id);
      return running === undefined ? [] : [holdingFor(player, running.counted, running.surplus)];
    })
    .sort((left, right) =>
      right.counted - left.counted
      || right.surplus - left.surplus
      || left.seat - right.seat);

  const ownerId = zone.majorityOwnerId;
  const owned = ownerId === undefined ? undefined : holdings.find((h) => h.playerId === ownerId);
  const fallback = ownerId === undefined
    ? undefined
    : view.players.find((player) => player.id === ownerId);
  const majorityOwner = owned ?? (fallback === undefined ? null : holdingFor(fallback, 0, 0));

  const surplusTotal = holdings.reduce((total, holding) => total + holding.surplus, 0);
  const spokenHoldings = holdings.length === 0
    ? 'no voters stood here'
    : holdings
      .map((holding) => `${holding.displayName} scored ${holding.counted}, ${holding.surplus} did not count`)
      .join('; ');
  return {
    id: zone.id,
    displayName: zone.displayName,
    capacity: zone.capacity,
    majorityThreshold: zone.majorityThreshold,
    filled,
    empty: zoneSlots.length - filled,
    majorityOwner,
    holdings,
    surplusTotal,
    spoken: `${zone.displayName}, majority ${majorityOwner === null ? 'unresolved' : majorityOwner.displayName}, `
      + `${zone.majorityThreshold} of ${zone.capacity} required, ${spokenHoldings}.`,
  };
}

/**
 * The results of a finished match, or `null` while it is still being played.
 *
 * Returning `null` rather than an empty shape is deliberate: a results screen must be
 * unreachable while the match is live, and a caller cannot forget to check a `null`.
 */
export function summarizeResults(view: PlayerView): MatchResults | null {
  if (view.status !== 'finished') return null;

  const zones = view.zones.map((zone) => zoneResult(zone, view));
  const scores = view.finalScores ?? {};
  const seats = [...view.players].sort((left, right) => left.seat - right.seat);

  // The engine's score is authoritative. `player.score` is the same number projected for
  // the live table, and reading `finalScores` first keeps the results screen reporting
  // the figure that was frozen when the match ended.
  const scoreOf = (player: PublicPlayerView): number => scores[player.id] ?? player.score;
  const highest = seats.reduce((best, player) => Math.max(best, scoreOf(player)), 0);
  const declared = view.winners;

  const standings: Standing[] = seats
    .map((player) => {
      const boardVoters = zones.reduce((total, zone) => {
        const holding = zone.holdings.find((entry) => entry.playerId === player.id);
        return total + (holding === undefined ? 0 : holding.counted + holding.surplus);
      }, 0);
      const surplusVoters = zones.reduce((total, zone) => {
        const holding = zone.holdings.find((entry) => entry.playerId === player.id);
        return total + (holding?.surplus ?? 0);
      }, 0);
      return {
        player,
        score: scoreOf(player),
        rank: 0,
        // A seat wins when the engine named it. A finished match always carries
        // `winners`; the top-score fallback only covers a save that somehow does not.
        winner: declared === undefined ? scoreOf(player) === highest : declared.includes(player.id),
        boardVoters,
        surplusVoters,
        zonesWon: zones
          .filter((zone) => zone.majorityOwner?.playerId === player.id)
          .map((zone) => zone.displayName),
      };
    })
    .sort((left, right) => right.score - left.score || left.player.seat - right.player.seat);

  // Standard competition ranking: equal scores share a rank and the next seat skips.
  for (let index = 0; index < standings.length; index += 1) {
    const previous = standings[index - 1];
    const current = standings[index]!;
    current.rank = previous !== undefined && previous.score === current.score
      ? previous.rank
      : index + 1;
  }

  const winners = standings.filter((standing) => standing.winner).map((standing) => standing.player);
  const reason = view.endReason ?? null;
  return {
    reason,
    reasonSentence: reason === null
      ? 'This save records no end reason, so none is claimed here.'
      : REASON_SENTENCES[reason],
    tiePolicySentence: view.setup.tiePolicy === 'jointWinners'
      ? `Tie policy: joint winners. Seats level on majority voters all win, and ${
        winners.length > 1 ? 'that is what happened' : 'no tie arose'}.`
      : `Tie policy: ${view.setup.tiePolicy}.`,
    standings,
    winners,
    jointWinners: winners.length > 1,
    zones,
    countedTotal: standings.reduce((total, standing) => total + standing.score, 0),
    surplusTotal: zones.reduce((total, zone) => total + zone.surplusTotal, 0),
    unresolvedZones: zones
      .filter((zone) => zone.majorityOwner === null)
      .map((zone) => zone.displayName),
  };
}

/** The news a results screen leads with, joint winners included. */
export function describeWinners(results: MatchResults): string {
  if (results.winners.length === 0) return 'The match ended with no seat holding a majority voter.';
  const score = results.standings.find((standing) => standing.winner)?.score ?? 0;
  const voters = `${score} majority voter${score === 1 ? '' : 's'}`;
  return results.jointWinners
    ? `${namesOf(results.winners)} win together on ${voters}.`
    : `${namesOf(results.winners)} wins on ${voters}.`;
}

/**
 * The seats a rematch would use, in the finished match's clockwise order.
 *
 * Rematch consent is per seat, so the screen needs the seats before it has a config.
 */
export function rematchSeats(view: PlayerView): readonly PublicPlayerView[] {
  return [...view.players].sort((left, right) => left.seat - right.seat);
}

/**
 * The config for a rematch of a finished match.
 *
 * Settings are preserved exactly: the same seats in the same clockwise order, the same
 * names and party emblems, the same advisory filters, the same tie policy. Nothing else
 * crosses over. The decks are shuffled by a fresh seed the caller supplies, the
 * first-player vote is held again, and no score, resource, card or board position
 * survives — this returns a config, and `createGame` builds the state from it.
 *
 * Engine player IDs are reassigned from the seat order rather than copied, so `p1` is
 * the first seat clockwise in the new match exactly as it was in the old one.
 */
export function rematchConfig(view: PlayerView, matchId: string): GameConfig {
  return {
    matchId,
    players: rematchSeats(view).map((player, index) => ({
      id: `p${index + 1}`,
      displayName: player.displayName,
      partyId: player.partyId,
      controller: player.controller,
      ...(player.controller === 'computer' && player.difficulty !== undefined
        ? { difficulty: player.difficulty }
        : {}),
    })),
    contentAdvisories: [...view.setup.contentAdvisories],
    tiePolicy: view.setup.tiePolicy,
  };
}
