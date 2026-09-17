# Gerrymander working notes

This file holds everything about the project that isn't the short pitch in
[README.md](README.md): the rules, the design commitments, how the computer opponents are
built, and the runbook for the online room server.

It replaces three earlier documents — a design note, an operations runbook, and the
implementation brief for the computer opponents. Comments in the source that cite a
numbered section, for example "section 13.6", refer to a much longer design document that
was retired before those. Treat such citations as historical context, not as a live
reference.

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/content` | Typed card, board and house-rule data. Generated from `content/`. |
| `packages/engine` | The rules engine: commands, effects, projections. |
| `packages/protocol` | Shared command, view and socket schemas. |
| `packages/seat` | What one seat can see and do, derived from its own projection. |
| `packages/computer` | The computer opponent. Reads a seat's own projection; no engine dependency. |
| `apps/web` | The React client. Pass-and-play and online builds. |
| `apps/server` | The online room server. |
| `content/` | Editable JSON: card text and mechanical skeletons. |
| `scripts/` | Content generators and build checks. |

`apps/web/src/app/actions.ts` and `apps/web/src/app/table.ts` are one-line re-export shims
over `@gerrymander/seat`. The derivations moved so the server could import them for the
computer opponent; a dozen source files and several tests still import the old paths.
Removing the shims, and moving `action-model.test.ts`, `campaign-model.test.ts` and
`table-model.test.ts` into `packages/seat/test`, is a follow-up.

## Commands

For install, dev, build and deploy, see [README.md](README.md). The rest:

```bash
pnpm typecheck
```

`pnpm typecheck` compiles every package into its `dist/`, which is what both the server
process and the dev server run, and then runs `scripts/check_emitted_imports.mjs`. A build
that skips it leaves the application on a stale engine.

```bash
pnpm test
```

```bash
pnpm check:build
```

`check:build` reads the `gerrymander-build` marker out of the emitted HTML and applies the
assertions that build is owed. For the markers themselves, see [Two browser
builds](#two-browser-builds).

To regenerate the typed content modules after editing `content/*.json`:

```bash
pnpm generate:content
```

To see the map on its own while you work on it:

```bash
python3 scripts/generate_board.py --preview board.svg
```

### Whole-game instruments

This project finds defects by playing whole games. A sweep's refusal list matters more
than its completion rate: a refused command is a finding, never something to route around.

```bash
pnpm tsx apps/web/test/sweep.ts 40 SEED_OFFSET
```

```bash
pnpm tsx apps/web/test/sweep.ts 40 SEED_OFFSET --policy mixed
```

```bash
pnpm tsx apps/web/test/tournament.ts
```

Replace `SEED_OFFSET` with a seed range the last session didn't use. `sweep.ts` reads its
two positional arguments first, games per combination and seed offset, so `--policy` goes
after them. `--policy` takes `autoplay`, the default, or `easy`, `medium`, `hard`, or
`mixed`, which seats one of each.

For browser evidence, start Vite directly with `nohup pnpm --filter @gerrymander/web
dev:local &` rather than through an IDE preview tool, which has stalled on this project
before.

## Fixed points

- **The engine is the only source of rule truth.** The client derives everything it shows
  from a `PlayerView` projection and never reads authoritative state.
- **Content is data.** Card text, costs, handler IDs and the board live in
  `packages/content` and are generated from `content/` by `scripts/generate_decks.py` and
  `scripts/generate_board.py`.
- **Every rule the engine fixes where a table might argue is a house rule** in
  `packages/content/src/ruleset.ts`, and is shown to players before a match starts.
- **The pass-and-play build carries no network code.**
  `scripts/check_build_privacy.mjs` asserts this from the emitted bundle.
- **Nothing private is drawn for a seat that hasn't revealed it.** `revealedSeatId` in
  `apps/web/src/app/handoff.ts` is the only accessor.
- **Saves stay readable.** Existing local saves and server snapshots carry no controller
  field, and every reader treats a missing field as `human`. Don't bump
  `GAME_SCHEMA_VERSION` or `LOCAL_SNAPSHOT_FORMAT_VERSION` for an additive optional field.

## Rules of the game

- **Goal.** Each zone shows a threshold. Reach it with your own voters and you hold the
  zone. When all nine zones are held, the player with the most majority voters wins.
- **Your turn.** Take passive income. Answer a policy question by picking one of two
  answers; the answer builds one of four archetypes (Corporate, Nationalist, Populist,
  Reformer) and pays resources (Cash, Influence, Press, Faith). Buy voter cards from the
  market and place each card's voters together in one zone. Use unlocked powers, buy or
  play a Dirty Trick, or trade. End your turn; unplaced voters are lost.
- **Archetypes.** Two policy cards in one archetype pay one resource a turn. Three unlock
  that archetype's first power, five its second.
- **Redistricting.** Strictly the most voters in a zone gives you its redistricting
  rights: once a turn, move one voter into, out of or within that zone. Majority voters
  can't be moved.
- **The map.** The nine zones are the districts of one island: Central at its heart, North
  and South belting it, and the other six around the coast. Two districts are neighbours
  for redistricting exactly when their borders touch on the map.
- **Volatile areas.** A voter placed there is fixed for the game and deals its owner a
  Breaking News card that resolves at the end of the turn.
- **Dirty Tricks.** Bought face down for the price on the back; played on your turn, or as
  a reaction when the card says so.

### Vocabulary

| Term | Meaning |
| --- | --- |
| Policy card | The question card answered each turn. |
| Archetype | Corporate, Nationalist, Populist or Reformer; each answer builds one. |
| Cash, Influence, Press, Faith | The four resources, one per archetype. |
| Breaking News | Cards dealt by volatile areas, resolved at end of turn. |
| Dirty Trick | Cards bought face down and played for effect. |
| Redistricting rights | Held by the seat with strictly the most voters in a zone. |
| Controller | Who plays a seat: a person or the computer. Fixed at start, like the party. |

### Learn to play

**Learn to play** on the title screen starts a guided match against two Easy computers. A
coach panel on the match screen names the rule the table is asking for at the moment it
asks — the vote, the starting resources, the policy question, the market, placement,
majorities, redistricting and the rest — and retires each lesson once the player has used
it. It's an ordinary match underneath, saved like any other, so nothing learned there is a
tutorial-only rule.

## The map

- The board is an island of nine districts: `central` at the core, `north` and `south`
  belting it, and the remaining six around the coast. Three tiers are what the ruleset
  forces, not a style choice. `central` borders only `north` and `south`, and both of
  those border `west`, `east` and `central`, so the border graph isn't outerplanar and no
  layout can put all nine districts on the coast.
- The map is unchanged by a half-turn that swaps `northWest` with `southEast`, `northEast`
  with `southWest`, `west` with `east` and `north` with `south` — which is a symmetry of
  the border graph too. No seat sits at a shape another seat doesn't get.
- Districts are sets of cells on a hex lattice, one voter area per cell, and a district
  outline is the union of its cells' edges. Two districts that share a border therefore
  meet exactly; only coastal corners are rounded.
- `scripts/generate_board.py` asserts what it builds: cell counts, one connected piece per
  district, one boundary loop each, and drawn borders that match `adjacency` exactly.
  Legality is still read from `adjacency` and `movementTriples` and never from the
  artwork, but a map that draws a border the rules don't have is a lie, and the script
  refuses to emit one.
- Every district wears the same 124 by 54 plaque, and the map reserves a clear rectangle
  that size inside each one. A plaque that changed size with the state of play — an
  earlier one grew when a majority arrived — would cover voter areas. A coastal district
  is a thin arc, so its plaque may hang over the water; none may cross a border.
- `apps/web/test/board.test.ts` holds the invariants the rest of the build reads, so a
  regenerated map that breaks one fails the suite rather than the game.

## Computer opponents

### What the computer may know

- A computer seat reads exactly what a person at that seat is shown — its own `PlayerView`
  — and submits commands through the same `submit` a person's control reaches. It applies
  no rule and it never bypasses `applyCommand`.
- The decision logic is `packages/computer`, which depends on `@gerrymander/seat`,
  `@gerrymander/protocol` and `@gerrymander/content` and deliberately **not** on
  `@gerrymander/engine`. That's what makes the previous point structural rather than a
  promise: the package can't import `GameState`, `applyCommand` or `projectGame`, so it
  can't read the authoritative state or look up the reward of a policy answer that the
  projection hides. `apps/web/test/computer.test.ts` asserts the missing dependency.
- No difficulty simulates the engine, reads `GameState`, or reads another seat's
  projection. Difficulty is how well a seat uses public information, and nothing else.
- Three difficulties — `easy`, `medium`, `hard` — share one legal-move enumerator and one
  evaluator and differ only in ordering and filtering. There's no search: the game is
  deterministic and the projection is rich enough that a one-ply evaluation of each
  candidate's projected result is the ceiling.
- Who plays a seat is public, like its party: `controller` and `difficulty` are on every
  `PublicPlayerView` and every `LobbySeatView`. Both are additive and optional wherever
  they're stored, so a save or a snapshot written before they existed reads every seat as
  `human`.
- A table needs at least one person. `createGame` refuses one that has none.

### Difficulty specification

Every command all three policies consider is one the composers would have offered. They
differ in ordering, filtering, and a few extra candidates:

| Decision | Easy | Medium | Hard |
|---|---|---|---|
| First-player vote | Lowest-numbered seat other than itself, which keeps the election decided on the first ballot. | Same. | Same. |
| Starting resources | Even split across the four types up to `startingResourceQuota`. | Split so that the cheapest card in the open market becomes affordable next turn; remainder even. | Same as Medium. |
| Policy answer | Seeded coin flip. | Seeded coin flip. | Seeded coin flip. The projection hides the reward and archetype, and no policy looks them up. Never redraws. |
| Cap discard | Largest pile first (`discardVector`). | Discard the types the open market needs least (`shortfallOrder`). | Same as Medium. |
| Which voter card to buy | Cheapest printed total first. | Most voters per resource first, then cheapest. Skip a card whose group has no zone it can usefully fill. | Same as Medium, and never buys a card it can't place this turn without discarding. |
| Groundswell, Volunteers | Never. | Groundswell on the two largest purchases of the turn when unlocked. Volunteers when it turns an unaffordable card into an affordable one, else on the largest purchase. | Same as Medium. |
| Where to place | `spread`: emptiest zone first, non-volatile slots first. | Placement score. | Placement score with denial and endgame terms. |
| Volatile slots | Indifferent. | Only when the target zone has no other empty slot. | Same as Medium. |
| Arbitrage | Only when no market card is affordable. | When one resource short of the best purchase. | Same as Medium. |
| Shakedown | Never. | Take the resource it's short of from the seat holding most of it. | Take it from the seat with the highest evaluated standing. |
| Gerrymander | Never. | Move own voters to complete a majority or to reach the unique-highest count in a zone. | Also move a rival's voter out of a zone where that rival is within two of the threshold, when the rights zone authorizes it. |
| Demolition, Crackdown, Outreach | Never. | Only to break a rival majority that is one voter above threshold, or to complete its own. Outreach only when both targets are in a zone it can then win. | Whenever the evaluated delta is positive, targets chosen by evaluated damage to the leading rival. |
| Buy a trick | Never. | When it can still afford a voter card afterwards (`TRICK_RESERVE`). | When holding fewer than two cards and the reserve rule holds. |
| Play a trick | Never. | Cards that benefit itself: Cornerstone (ordinary), Grand Coalition when a level 3 power is unlocked, Star Power, Turncoat. Hostile cards against the rival with the highest score. | Every card, target chosen by evaluated damage. Cornerstone triple conversion when it holds three and a 6-or-11 zone with a rival majority exists. Flip-Flop when the committed card's other face, which is face up and so legitimately known, moves a track to 3 or 5. |
| Reactions (Veto, Boomerang) | Pass. | Boomerang when a card targets it. Veto a card that targets it. | Also Veto a card played by the leading rival that benefits them. Pass otherwise. |
| Auctions | Pass. | Bid the floor when held resources are at least 8. | Bid up to `min(4, held - 3)`, stepping by the floor. |
| Campaign vote | First candidate. | Itself if eligible, else the candidate with the lowest score. | Same as Medium. |
| Incoming trade | Reject. | Reject. | Accept when the evaluated value received is at least the value given and no trick card is given. Never proposes. |
| Choice prompts (all 41 operations) | The autoplay fill: smallest legal selection, rotating on refusal. | Same fill, options ordered by evaluated benefit where the option is a player, zone, or voter. | Same as Medium. |
| Majority selection | First `required` eligible voters. | Non-volatile voters first. | Same as Medium. |
| End turn | When nothing else is offered. | When no candidate has a positive evaluated delta. | Same as Medium. |
| Endgame | None. | None. | When leading on evaluated standing, prefer placements that complete the last undecided zone. When trailing, avoid completing the ninth majority and avoid filling the last empty area on the board. |

### The evaluator

`evaluate(view, seatId)` returns a number, higher being better for `seatId`. It's a static
function of the projection, and its constants live in one place:

- **Locked points.** For each zone whose `majorityOwnerId` is this seat, add
  `majorityThreshold`. For each zone a rival owns, subtract `0.5 * majorityThreshold`.
- **Potential.** For each undecided zone where `mine + emptySlots >= threshold`, add
  `0.6 * threshold * (mine / threshold)^2`. Central, threshold 5, and the four corner
  zones, threshold 6, are the cheapest points on the board, and this term finds them.
- **Threat.** For each undecided zone where a rival has `threshold - 2` or more voters,
  subtract `0.4 * threshold`.
- **Rights.** Add 1.5 per zone where `rightsOwnerId` is this seat.
- **Resources.** Add 0.25 per held resource up to `resourceCap`; subtract 1 per resource
  over the cap, because the cap phase discards it.
- **Policy progress.** Add 0.5 per unit of `passiveIncome`; add 1 when a track sits at 2
  or 4, one card from a power.
- **Hand.** Add 1 per trick card held.

For a candidate whose effect the policy can project — place, buy, move, evict, convert —
score `evaluate(afterCommand(view)) - evaluate(view)`. For one it can't project, such as
playing a card with a continuation or buying a face-down card, use the fixed heuristics in
the difficulty table. Ties break by the seeded generator in `random.ts`, whose seed is a
hash of the match ID, revision and seat ID, so a decision is a pure function of the view
and two identical positions in different matches don't always play the same way.

### Placement score

For a group of `count` voters, choose slots one at a time, re-asking
`legalPlacementSlotIds` after each pick, because a same-zone group narrows after its first
slot. Score each legal slot's zone as follows:

- `-100` if a rival already holds the majority there.
- `-20` if `mine + emptySlots < threshold`, so this seat can no longer win it.
- Otherwise `threshold - (threshold - mine - count)`: points available minus voters still
  needed after this placement, so a zone this group completes scores highest.
- `-3` if the zone's leading rival is within one of the threshold and this placement
  doesn't give this seat the unique-highest count.
- `-1` for a volatile slot when the zone has a non-volatile empty slot.
- Hard only: `+5` when completing this zone would complete all nine majorities and this
  seat leads on evaluated standing; `-8` when it would and this seat trails.

### The drivers

Two drivers, one loop: `apps/web/src/app/useComputerSeats.ts` in the browser and
`apps/server/src/rooms/computerDriver.ts` on the server. The same rules apply to both:

1. After every accepted command, and once when a match is opened or the server starts,
   check each computer seat's own view with `hasSomethingToDo`.
2. For the first computer seat with something to do, wait the pace, then call
   `stepComputer`, which tries the candidates from `decide` in order and stops at the
   first accepted command. Every refusal on the way is recorded on the step result.
3. When the step reports `acted`, go back to step 1. When it reports `idle`, stop until the
   next accepted command. When it reports `stuck`, stop for this match, surface it, and
   don't retry on a timer. A new accepted command from a person restarts the loop.
4. At most one command is in flight per match, people and computers together. On the
   server, `MatchQueue` already serializes commands per match, but the driver still
   mustn't schedule a second step while one is running.
5. Command IDs on the server are deterministic: `computer:${playerId}:${revision}:${attempt}`.
   A restart can't apply the same decision twice, because the idempotency record answers
   the replay.

A step that has every candidate refused is a defect in the enumerator, the policy or a
composer derivation — not something to retry. Locally it shows an alert on the match
screen; online it logs at error level with the match ID and revision, and the health route
answers `computers: degraded` until the process restarts.

The pace exists so a person can follow what happened. Locally it defaults to 800 ms and is
configurable per browser as **Computer pace: Normal or Fast**, where Fast is 0 ms, stored
under the `localStorage` key `gerrymander.computerPace`. On the server it's
`GERRYMANDER_COMPUTER_DELAY_MS`. Tests pass 0 and await the driver's `settled(matchId)`
promise rather than sleeping.

### Screens

- A solo table, one person against computers, shows no cover and no **Pass to** control.
  `initialHandoff(view)` returns a revealed state when exactly one seat is human.
- A table with two or more people is unchanged, except that computer seats never appear in
  **Pass the device**. The shell filters them; the reducer stays generic.
- Every seat list — the roster, saved-match cards, standings — marks a computer seat with a
  small "computer" label beside the party mark. Words, not only an icon.
- The status bar names a computer seat as "Devi (computer)" and reads "Devi is thinking…"
  between steps.
- The rematch consent list needs consent only from human seats.
- In an online lobby, the host gets **Seat a computer** with a difficulty select on each
  free seat, and **Remove** on a computer seat. Guests see the name and difficulty.

### Measured, September 2026

`pnpm tsx apps/web/test/tournament.ts`, 60 seeded three-player games with the seating
rotated each game:

| Difficulty | Wins | Total score |
| --- | --- | --- |
| easy | 0 | 151 |
| medium | 17 | 1,767 |
| hard | 42 | 2,053 |

59 of the 60 finished, with no refused command. `sweep.ts 20 700000 --policy mixed` is the
same figure from a different seed range: 59 of 60, no refusals, `medium 36 / hard 23 /
easy 1` on a sample a third the size. Don't tune the evaluator's constants against these
without recording the run that replaces them. The acceptance criterion is an ordering —
hard beats medium beats easy — not a number, so don't assert a threshold in a unit test.

### The stalemate the policies can't break

About one game in sixty reaches a position the engine has no ending for: every zone is
decided or full, the last one or two empty areas are in zones nobody can still win, and no
seat both has voters left and can afford a card. Nobody can place, so the board never
fills and the ninth majority never arrives. Every seat then ends its turn forever.

It's a property of the board and the economy rather than of a difficulty — all three sit
in it — and the autoplay driver escapes only because it proposes trades, which no policy
does. Both drivers detect it instead of spinning: twelve consecutive computer turns that
change nothing stops the driver, shows the same alert a refused move does, and logs
`computers: degraded` on the server. Fixing the position itself needs either trade
proposals or an engine ending for a board that can't fill; both are follow-ups.

### Follow-ups

- Trade proposals by the `hard` policy. Accepting trades is done; proposing isn't.
- Letting a person take over a computer seat mid-match, or the reverse. A seat's controller
  is fixed at start, like its party.
- A fourth difficulty that may read answer rewards from the content pack. The owner chose
  strict fairness for all three levels; add this only if asked, and disclose it in the
  difficulty description.

## Operate the room server

Every command and every output in this section was run against this repository. Where a
procedure has a caveat, the caveat is one that was observed rather than inferred.

### What you deploy

The application is two independent pieces, and a pass-and-play deployment needs only the
first:

- **A static browser build**, in `apps/web/dist`. Any static host serves it.
- **A Node process**, `apps/server/dist/index.js`, with a durable store behind it. It's the
  authority for online rooms, and nothing else writes to that store.

#### Two stores

The store is chosen by configuration, not by the build, and both satisfy one interface in
`apps/server/src/persistence/driver.ts`:

| Store | Chosen by | What it's for |
| --- | --- | --- |
| Cloudflare D1 | `GERRYMANDER_D1_*` set | A deployment. Reached over the HTTP API, because the server is an ordinary Node process rather than a Worker. |
| Local SQLite | `GERRYMANDER_D1_*` unset | Development and the test suite. Node's built-in `node:sqlite`, one file. |

Nothing above `persistence/database.ts` knows which one it has.

#### Two browser builds

The two builds of the browser are genuinely different, and the choice is made at build
time:

| Command | Build marker | What it contains |
|---|---|---|
| `pnpm build` | `local-play` | Pass-and-play only. No network code: no module from `src/remote/`, no `Online*` screen, and no `new WebSocket`. |
| `pnpm build:online` | `online` | Pass-and-play and the `#/online` family, which needs the room server. |

Each build stamps its marker into the emitted HTML as `<meta name="gerrymander-build">`.
To read which build a directory holds, run `pnpm check:build`.

### Settings

Every setting has a default that runs a single-instance development server, so a bare
`pnpm start` works with none of them. The ones a deployment must consider:

| Variable | Default | What it does |
|---|---|---|
| `GERRYMANDER_DB_PATH` | `./data/gerrymander.db` | The local SQLite file, read only when the D1 settings are unset. Its directory is created at startup. |
| `GERRYMANDER_D1_ACCOUNT_ID` | none | The Cloudflare account that holds the D1 database. |
| `GERRYMANDER_D1_DATABASE_ID` | none | The D1 database's UUID, as `wrangler d1 create` prints it. |
| `GERRYMANDER_D1_API_TOKEN` | none | An API token with the **D1 Edit** permission on that account. A secret: it never reaches a log or the health route. |
| `GERRYMANDER_D1_TIMEOUT_MS` | `10000` | How long one HTTP attempt to D1 may take. |
| `GERRYMANDER_D1_MAX_ATTEMPTS` | `4` | How many times a retryable D1 failure is tried again. A 429, a 408, a 5xx and a transport failure are retryable; a 4xx is not. |
| `GERRYMANDER_CHECKPOINT_EVERY_COMMANDS` | `10` | Accepted commands that may go unwritten before the store is checkpointed. Also the size of the window an unclean stop loses. `1` writes through. |
| `GERRYMANDER_CHECKPOINT_MAX_DELAY_MS` | `5000` | The longest a change may sit unwritten, however few commands it is. |
| `GERRYMANDER_HOST` | `127.0.0.1` | Bind address. Leave it on loopback and put a reverse proxy in front. |
| `GERRYMANDER_PORT` | `8787` | TCP port. |
| `GERRYMANDER_ALLOWED_ORIGINS` | the two loopback spellings of the Vite dev server | Comma-separated browser origins allowed to open a WebSocket. `*` is refused. |
| `GERRYMANDER_TRUST_PROXY` | `false` | Read the client address from `X-Forwarded-For`. Set it only behind a proxy that sets the header itself. |
| `GERRYMANDER_HTTP_BURST_REQUESTS` | `60` | Requests one client address may send to `/api/*` in a burst. |
| `GERRYMANDER_HTTP_REQUESTS_PER_SECOND` | `5` | The rate that burst refills at. |
| `GERRYMANDER_SOCKET_BURST_FRAMES` | `40` | Frames one seat may send in a burst. |
| `GERRYMANDER_SOCKET_FRAMES_PER_SECOND` | `10` | The rate that burst refills at. |
| `GERRYMANDER_MAX_BODY_BYTES` | `65536` | Largest accepted request body. |
| `GERRYMANDER_SHUTDOWN_TIMEOUT_SECONDS` | `10` | How long a shutdown waits for in-flight requests. |
| `GERRYMANDER_LOG_LEVEL` | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `GERRYMANDER_COMPUTER_DELAY_MS` | `800` | How long a computer seat waits before it acts. The pause is for the people watching; `0` makes the computers play as fast as the engine allows. |

A setting the server can't read stops it with exit code 2 and a message naming the
variable. It doesn't fall back to a default.

The three D1 settings that identify the database are all-or-nothing. Setting two of them
stops the server rather than falling back to a local file, because a server quietly
writing where nobody is looking is a fault an operator finds out about from a restore.

#### Create the D1 database

Gerrymander runs its own migrations against whatever store it's given, so creating the
database is the whole of the setup. Don't point it at a D1 database another application
uses: the table names — `matches`, `seats`, `commands`, `events` — are ordinary words, and
two migration systems on one database is how a deployment loses a table.

```sh
npx wrangler d1 create gerrymander
```

The output names the `database_id`. Pass it as `GERRYMANDER_D1_DATABASE_ID`, with the
account ID and an API token carrying the **D1 Edit** permission. The server applies every
pending migration at startup, before it opens the port, so a store it can't reach stops it
there rather than on the first player's request.

### What a checkpoint costs

The server doesn't write to D1 on every command, and this is the section that says what
that buys and what it costs.

D1 is reached over HTTP, so a write-through store would put a round trip to Cloudflare in
the middle of every turn. Instead the authority for a live match is the state in this
process, in `apps/server/src/rooms/matchStore.ts`, and D1 holds a checkpoint of it. A
checkpoint is one HTTP call carrying the snapshot, the events and the idempotency records
together, and it's written:

- every `GERRYMANDER_CHECKPOINT_EVERY_COMMANDS` accepted or refused commands,
- `GERRYMANDER_CHECKPOINT_MAX_DELAY_MS` after the first unwritten change,
- when a match finishes,
- when the process stops cleanly.

Whichever comes first. So the commands between checkpoints cost no network at all, and one
command in `n` waits for a write.

**Players never see the lag.** Views, event reads and duplicate detection are all answered
from the live match, unwritten changes included. The store being behind is the store's
business.

**A clean stop loses nothing.** `SIGTERM` and `SIGINT` checkpoint every live match before
closing.

**An unclean stop loses the window.** A kill or a power loss loses that match's commands
since its last checkpoint — at most `GERRYMANDER_CHECKPOINT_EVERY_COMMANDS - 1` of them.
Every match still comes back at a revision boundary, never part-way through a command,
because a checkpoint writes the snapshot and its events and its command records together.
A player who re-sends a command ID that was lost that way has it applied again rather than
answered from the record, because the record was lost with it.

Set `GERRYMANDER_CHECKPOINT_EVERY_COMMANDS=1` to write through and pay one round trip per
turn instead. That's what the test suite runs at, because it's the setting under which the
older durability assertions still mean what they say;
`apps/server/test/checkpoint.test.ts` is the suite that sets it higher on purpose and
proves each of the four points above, including the loss.

### The origin allowlist

`GERRYMANDER_ALLOWED_ORIGINS` defaults to the Vite dev server's two loopback spellings. A
deployment that doesn't list its own origin refuses every browser at the WebSocket upgrade
with a 403, which looks like a broken server rather than a policy. **Check this first when
online play won't connect.**

A request carrying no `Origin` header is allowed. It isn't a browser, the seat credential
is what authorizes it, and a non-browser caller can put any origin it likes in the header
anyway. The check defends the case it can: a page in a player's browser that the player
didn't open.

### Reverse proxy

The server binds to loopback by default, so a deployment terminates TLS at a proxy and
forwards to it. Three things matter:

- **The WebSocket upgrade must be forwarded.** `/ws` is a long-lived connection, not a
  request. A proxy that doesn't forward `Upgrade` and `Connection` headers leaves every
  table stuck on Connecting.
- **Set a read timeout longer than a turn.** A table thinking about a move sends nothing.
  A proxy that closes an idle socket after 60 seconds disconnects players mid-game; they
  reconnect, but the banner flickers through `reconnecting` for no reason.
- **Decide where rate limiting lives.** The server counts requests per client address, and
  behind a proxy every request arrives from the proxy. Either set
  `GERRYMANDER_TRUST_PROXY=true` with a proxy that sets `X-Forwarded-For` itself, or
  rate-limit at the proxy and raise `GERRYMANDER_HTTP_BURST_REQUESTS` out of the way. Left
  alone, the whole internet shares one bucket and the limit is worse than none: the first
  busy client locks everyone out.

An nginx location block that satisfies the first two:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
}

location /api {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### Health

`GET /health` answers 200 when the store answers a trivial read and every checkpoint has
landed, and 503 when the store doesn't answer. The body names the build so a mismatch between the browser and the server is
visible:

```sh
curl -s http://127.0.0.1:8787/health
```

The output is similar to the following:

```json
{"status":"ok","database":"ok","computers":"ok","uptimeSeconds":1,"schemaVersion":1,
 "contentPackId":"core-set","contentVersion":"0.9.0","boardId":"grid-nine"}
```

It names no room code, no seat, and no count of who is playing, and it never names the D1
token. It's also deliberately outside the request budget: a health check that starts
failing because the server is busy reports the opposite of what it's for. Because it's
outside that budget, the read behind it is cached for a few seconds — otherwise anyone
could turn health polling into billable traffic against D1.

`database` reads `degraded` when a checkpoint failed and its commands are still held in
memory, and `unavailable` when the store didn't answer at all. Only the second answers
503. The distinction is the point: a container marked unhealthy for a failed checkpoint is
a container something will restart, and the restart is what turns unwritten commands into
lost ones. The compose healthcheck keys on the status code for that reason. Search the log
at error level for the match ID:

```sh
journalctl -u gerrymander | grep 'Checkpoint to the store failed'
```

The field clears when a later checkpoint for that match succeeds. A `degraded` that
persists means D1 is refusing something this build sends, which is a defect to report with
the match ID.

`computers` reads `degraded` when a computer seat in some match had every move it
considered refused. The match it happened in is stopped for that seat and nothing retries
it on a timer, because a retry would produce the same refusals. The rest of the server
keeps serving, so the status code stays 200 and `status` stays `ok`. Search the log at
error level for the match ID, the revision and the refusals:

```sh
journalctl -u gerrymander | grep 'every candidate refused'
```

That's a defect to report with the match ID, not a condition to wait out: the field clears
only when the process restarts.

### Back up and restore

D1 takes its own backups, and `wrangler` exports one as SQL while the server runs:

```sh
npx wrangler d1 export gerrymander --remote --output gerrymander-$(date +%F).sql
```

An export taken from a running server can miss the commands that haven't been checkpointed
yet — see [What a checkpoint costs](#what-a-checkpoint-costs). To take one that misses
nothing, stop the server first: a clean stop checkpoints every live match before it closes
the store.

To restore, stop the server, then import into an empty database. An import under a running
process races the checkpoints that process is still writing:

```sh
systemctl stop gerrymander
npx wrangler d1 execute gerrymander --remote \
  --command 'DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS commands;
             DROP TABLE IF EXISTS seats; DROP TABLE IF EXISTS matches;
             DROP TABLE IF EXISTS schema_migrations'
npx wrangler d1 execute gerrymander --remote --file gerrymander-2026-09-16.sql
systemctl start gerrymander
```

Dropping the tables first matters. An import over a populated database leaves rows from
both, and a match whose snapshot is one revision and whose events are another is worse
than a match that's missing. A restored server resumes every room in the backup at the
revision it was taken at: commands accepted after the backup are gone, and a client that
reconnects is sent the restored state rather than its own.

Point `wrangler` at the right database with an `apps/server/wrangler.toml` naming it, or
pass the database name the account knows it by. No Worker is deployed from that file; it
exists so the CLI can find the database.

### Restart and recovery

A clean restart is safe at any point and loses nothing. An unclean one — a kill, a power
loss — loses the commands since that match's last checkpoint, and nothing else. See [What a
checkpoint costs](#what-a-checkpoint-costs), which is the section to read before choosing
`GERRYMANDER_CHECKPOINT_EVERY_COMMANDS` for a deployment.

A checkpoint carries the snapshot, the events and the idempotency records together, and
writes the match row last. So a checkpoint that fails part-way leaves rows nothing reads
yet and a match at the revision it was already at; the next attempt sends the same
statements again, which is harmless by construction. A match never comes back part-way
through a command.

`SIGTERM` and `SIGINT` both close the HTTP server first, so no new request starts, then
checkpoint every live match, then close the store. That order is what makes a clean stop
lossless. If in-flight requests don't finish within
`GERRYMANDER_SHUTDOWN_TIMEOUT_SECONDS`, the process logs and exits with code 1; a
checkpoint it couldn't write is logged at error level naming the match.

Rooms survive a restart in SQLite. Connected browsers show Reconnecting, retry with a
backoff, and rejoin the same seat at the same pending decision. Nothing is lost and no
player has to re-enter a room code.

Resending a command ID that the server already accepted returns the stored response with
`"duplicate": true` and applies nothing a second time. A client that's unsure whether a
command landed can safely send it again with the same ID. The record is searched in memory
before the store, so this holds inside the checkpoint window too — but not across an
unclean restart that lost the window, where the command is applied again.

Matches with computer seats resume too. After the port is open, the server looks for every
match that is mid-play and seats a computer, and continues it — a table whose computer was
due to act when the last process stopped would otherwise sit waiting for a turn that never
arrives.

### Recover a lost seat

A seat credential is issued once, to the browser that claimed the seat, and the server
stores only its hash. A player who clears their site data, or opens the room on a second
device, can't rejoin that seat. Because a room can't start with an empty seat, one
player's cleared storage would otherwise strand the whole table.

Before the match starts, the host frees the seat from the lobby roster, and the player
claims it again with the room code. The freed credential stops working immediately.

Once the table is dealt, seats lock and no seat can be freed. A seat holds private cards
and committed answers from that point, and freeing one would hand them to whoever claimed
it next. A table that loses a credential mid-match has lost that seat; open a new room.

### Troubleshooting

**Every browser fails to connect, and the server logs a 403 at the upgrade.** The origin
isn't in `GERRYMANDER_ALLOWED_ORIGINS`. It must be the exact origin the browser build is
served from, scheme and port included.

**Tables connect and then drop every minute.** The proxy is closing an idle WebSocket.
Raise `proxy_read_timeout`.

**One client gets 429 and so does everyone else.** The server is behind a proxy and
`GERRYMANDER_TRUST_PROXY` isn't set, so every request shares one bucket. See [Reverse
proxy](#reverse-proxy).

**The server exits with code 2 at startup.** A setting couldn't be read. The message on
stderr names the variable and the values it accepts.

**The server exits with `ERR_MODULE_NOT_FOUND`.** The build is stale or partial. Run
`pnpm typecheck` to rebuild every package's `dist/`, then start again.

**The server exits at startup naming the D1 settings.** Two of the three that identify the
database are set and one isn't. Set all three, or none — the server won't fall back to a
local file while it looks half-configured.

**Startup fails with a D1 403 or "Authentication error".** The API token doesn't carry the
**D1 Edit** permission on that account, or it's scoped to a different account than
`GERRYMANDER_D1_ACCOUNT_ID`.

**`/health` answers `database: degraded` but the tables still play.** A checkpoint failed
and its commands are held in memory. See [Health](#health) for the log line to search for.
The commands are still live; they're only unwritten. Don't restart the process to clear
it — that's what would lose them. A later checkpoint clears the field on its own.

**`docker compose ps` shows the server unhealthy.** The healthcheck only fails on a
non-200, which means the server couldn't reach D1. Check the token and the account first,
then Cloudflare's status.

**Rooms come back a few commands behind after a restart.** The process didn't stop
cleanly, so it lost that match's checkpoint window. Lower
`GERRYMANDER_CHECKPOINT_EVERY_COMMANDS` to narrow it, and check that the service manager
sends `SIGTERM` and waits rather than killing.

### What this deployment doesn't do

State these plainly rather than discovering them in production:

- **One process.** There's no clustering and no shared-state story, and moving the store to
  D1 doesn't add one. A second process on the same database would corrupt the command
  ordering that `MatchQueue` exists to guarantee — and now it would do worse, because each
  process holds its own authoritative copy of a live match in memory and they'd overwrite
  each other at every checkpoint. Run exactly one.
- **No CORS policy on the HTTP surface.** Origin checking is a WebSocket rule, so a browser
  reaches `/api` same-origin only. Serve the browser build and the server from one origin.
- **No point-in-time recovery of the last few commands.** A backup is as current as the
  last checkpoint, and so is an unclean restart. See [What a checkpoint
  costs](#what-a-checkpoint-costs).
- **Local saves are unencrypted.** The pass-and-play build stores every seat's private
  cards and answers in the browser's IndexedDB, and exports them in clear JSON. That's the
  stated pass-and-play model. It's never the online model: the server has no full-state
  export for an ordinary player.
