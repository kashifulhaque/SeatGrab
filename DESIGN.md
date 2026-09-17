# Design notes

This file replaces an earlier, much longer design document. Comments in the source that
cite a numbered section (for example "section 13.6") refer to that retired document;
treat them as historical context, not as a live reference.

## Fixed points

- The engine is the only source of rule truth. The client derives everything it shows
  from a `PlayerView` projection and never reads authoritative state.
- Content is data. Card text, costs, handler IDs and the board live in
  `packages/content` and are generated from `content/` by `scripts/generate_decks.py`
  and `scripts/generate_board.py`.
- Every rule the engine fixes where a table might argue is a house rule in
  `packages/content/src/ruleset.ts` and is shown to players before a match starts.
- The pass-and-play build carries no network code; `scripts/check_build_privacy.mjs`
  asserts this from the emitted bundle.

## The map

- The board is an island of nine districts: `central` at the core, `north` and `south`
  belting it, and the remaining six around the coast. Three tiers are what the ruleset
  forces, not a style choice. `central` borders only `north` and `south`, and both of
  those border `west`, `east` and `central`, so the border graph is not outerplanar and
  no layout can put all nine districts on the coast.
- The map is unchanged by a half-turn that swaps `northWest` with `southEast`,
  `northEast` with `southWest`, `west` with `east` and `north` with `south` — which is a
  symmetry of the border graph too. No seat sits at a shape another seat does not get.
- Districts are sets of cells on a hex lattice, one voter area per cell, and a district
  outline is the union of its cells' edges. Two districts that share a border therefore
  meet exactly; only coastal corners are rounded.
- `scripts/generate_board.py` asserts what it builds: cell counts, one connected piece
  per district, one boundary loop each, and drawn borders that match `adjacency` exactly.
  Legality is still read from `adjacency` and `movementTriples` and never from the
  artwork, but a map that draws a border the rules do not have is a lie, and the script
  refuses to emit one.
- Every district wears the same 124 by 54 plaque, and the map reserves a clear rectangle
  that size inside each one. A plaque that changed size with the state of play — the
  earlier one grew when a majority arrived — would cover voter areas. A coastal district
  is a thin arc, so its plaque may hang over the water; none may cross a border.
- `apps/web/test/board.test.ts` holds the invariants the rest of the build reads, so a
  regenerated map that breaks one fails the suite rather than the game.

## Computer opponents

- A computer seat reads exactly what a person at that seat is shown — its own
  `PlayerView` — and submits commands through the same `submit` a person's control
  reaches. It applies no rule and it never bypasses `applyCommand`.
- The decision logic is `packages/computer`, which depends on `@seatgrab/seat`,
  `@seatgrab/protocol` and `@seatgrab/content` and deliberately **not** on
  `@seatgrab/engine`. That is what makes the previous point structural rather than a
  promise: the package cannot import `GameState`, `applyCommand` or `projectGame`, so it
  cannot read the authoritative state or look up the reward of a policy answer that the
  projection hides. `apps/web/test/computer.test.ts` asserts the missing dependency.
- Three difficulties — `easy`, `medium`, `hard` — share one enumerator and one
  evaluator and differ only in ordering and filtering. Difficulty is how well a seat uses
  public information, and nothing else.
- Who plays a seat is public, like its party: `controller` and `difficulty` are on every
  `PublicPlayerView` and every `LobbySeatView`. Both are additive and optional wherever
  they are stored, so a save or a snapshot written before they existed reads every seat
  as `human`.
- A table needs at least one person. `createGame` refuses one that has none.
- Two drivers, one loop: `apps/web/src/app/useComputerSeats.ts` in the browser and
  `apps/server/src/rooms/computerDriver.ts` on the server. Both find the first computer
  seat whose own view says it has something to do, wait a pace, and take one step. A step
  that has every candidate refused is a defect: it is surfaced and never retried on a
  timer.

### Measured, September 2026

`pnpm tsx apps/web/test/tournament.ts`, 60 seeded three-player games with the seating
rotated each game:

| Difficulty | Wins | Total score |
| --- | --- | --- |
| easy | 0 | 151 |
| medium | 17 | 1,767 |
| hard | 42 | 2,053 |

59 of the 60 finished, with no refused command. `sweep.ts 20 700000 --policy mixed` is the
same figure from a different seed range: 59 of 60, no refusals, `medium 36 / hard 23 / easy
1` on a sample a third the size. Do not tune the evaluator's constants against these
without recording the run that replaces them.

### The stalemate the policies cannot break

About one game in sixty reaches a position the engine has no ending for: every zone is
decided or full, the last one or two empty areas are in zones nobody can still win, and no
seat both has voters left and can afford a card. Nobody can place, so the board never
fills and the ninth majority never arrives. Every seat then ends its turn forever.

It is a property of the board and the economy rather than of a difficulty — all three sit
in it — and the autoplay driver escapes only because it proposes trades, which no policy
does. Both drivers detect it instead of spinning: twelve consecutive computer turns that
change nothing stops the driver, shows the same alert a refused move does, and logs
`computers: degraded` on the server. Fixing the position itself needs either trade
proposals or an engine ending for a board that cannot fill; both are follow-ups.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Policy card | The question card answered each turn. |
| Archetype | Corporate, Nationalist, Populist or Reformer; each answer builds one. |
| Cash, Influence, Press, Faith | The four resources, one per archetype. |
| Breaking News | Cards dealt by volatile areas, resolved at end of turn. |
| Dirty Trick | Cards bought face down and played for effect. |
| Redistricting rights | Held by the seat with strictly the most voters in a zone. |
| Controller | Who plays a seat: a person or the computer. Fixed at start, like the party. |
