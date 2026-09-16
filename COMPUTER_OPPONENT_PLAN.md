# SEATGRAB computer opponents: implementation brief

This document is a brief for a coding agent. It describes how to add computer-controlled
seats to SEATGRAB so that a person can play against the computer, locally on one device and
in an online room, with a choice of difficulty. The game engine is complete and correct;
this work adds no rule. It adds a decision-maker that reads what a seat is shown and
submits commands the way a player does.

Read `DESIGN.md` sections 0.0, 0.4, 0.8, 13, and 14 before you start.
Section 0.0 explains how this project finds defects (by playing whole games) and why the
sweep's refusal list matters more than its completion rate. Section 0.8 lists what you
must record at the end of each session.

## Contents

1. [Decisions already taken](#decisions-already-taken)
2. [What must not change](#what-must-not-change)
3. [Architecture](#architecture)
4. [Difficulty design](#difficulty-design)
5. [The driver: when and how a computer acts](#the-driver-when-and-how-a-computer-acts)
6. [Work items, in order](#work-items-in-order)
7. [Screens and copy](#screens-and-copy)
8. [Acceptance criteria](#acceptance-criteria)
9. [Verification](#verification)
10. [Files](#files)
11. [Follow-ups that are not part of this brief](#follow-ups-that-are-not-part-of-this-brief)

## Decisions already taken

These were decided with the project owner. Do not reopen them.

| Decision | Choice | Consequence |
|---|---|---|
| Where computers run | Both transports. In the pass-and-play build the browser drives them; in an online room the server drives them. | The decision logic must live in a package that both `apps/web` and `apps/server` can import. Today it lives in `apps/web/src/app/actions.ts`, which the server cannot import. |
| Table shape | Mixed. Any seat is a human or a computer. A table needs at least one human. | The privacy cover keeps working for tables with two or more humans. A table with exactly one human never shows a cover. |
| What the computer may know | Exactly what a human at that seat is shown. It reads its own `PlayerView` and nothing else. In particular it does **not** look up the archetype or reward of an policy answer in the content pack before committing, because section 13.5 hides those from the human. | No difficulty simulates the engine, reads `GameState`, or reads another seat's projection. Difficulty comes from how well it uses public information. |
| Difficulty levels | Three: `easy`, `medium`, `hard`. | One decision policy per level, sharing one legal-move enumerator and one evaluator. |
| Search | None. Deterministic heuristics over the projection. | The game is deterministic and the projection is rich enough. A one-ply evaluation of the projected result of each candidate is the ceiling. |

## What must not change

The following invariants are asserted by the existing suite and must hold after this work.

- **The engine decides.** A computer composes commands from the same derivations the
  composers use and submits them through `submit`. It never applies a rule itself and it
  never bypasses `applyCommand`. A refused command is a finding, not something to route
  around. This is the rule `apps/web/test/autoplay.ts` was written under; keep it.
- **A computer reads only its own projection.** Its input is
  `viewFor({ kind: 'player', playerId })` for its own seat. Enforce this structurally:
  the new `@seatgrab/computer` package must not depend on `@seatgrab/engine`, so it cannot
  import `GameState`, `applyCommand`, or `projectGame`. Add a test that reads the
  package's `package.json` and asserts the dependency is absent.
- **Nothing private is drawn for a seat that has not revealed it.** `revealedSeatId` in
  `apps/web/src/app/handoff.ts` stays the only accessor. A computer seat never reveals, so
  its hand, kept policy cards, and prompts never reach the document.
  `apps/web/test/match-shell.test.tsx` must keep passing and gain a solo-table case.
- **The server sends a seat only its own projection.** A computer seat has no connection,
  so its projection is never sent anywhere. The server driver calls `viewFor` in-process.
- **The sweeps stay clean.** `pnpm tsx apps/web/test/sweep.ts` must keep finishing every
  game with an empty refusal list, on a seed range the last session did not use. The
  existing driver's behavior is the regression instrument; preserve it while you refactor
  under it.
- **Both production builds pass `check:build`.** The pass-and-play build must still
  contain no module under `src/remote/`.
- **Saves stay readable.** Existing local saves and server snapshots carry no controller
  field. Every reader treats a missing field as `human`. Do not bump
  `GAME_SCHEMA_VERSION` or `LOCAL_SNAPSHOT_FORMAT_VERSION` for an additive optional field.

## Architecture

### Two new workspace packages

The decision logic needs the projection derivations in `apps/web/src/app/actions.ts`
(3,000 lines: costs, payments, legal placement, choice models, hand cards, reaction cards)
and `apps/web/src/app/table.ts` (slot ordinals, phase descriptions). Both are plain
TypeScript with no React and no DOM. They import only `@seatgrab/content` and
`@seatgrab/protocol`. Move them.

```
packages/seat/          @seatgrab/seat      What one seat can see and do, derived from its
                                         PlayerView. actions.ts and table.ts move here.
packages/computer/      @seatgrab/computer  The computer opponent: enumerator, evaluator,
                                         three policies, and the step function both
                                         drivers call.
```

Rules for the move:

- Mirror `packages/engine` for `package.json` (`exports` pointing at `dist/`),
  `tsconfig.json`, and the root `tsconfig.json` references. Add both `dist/` directories to
  `OUTPUTS` in `scripts/check_emitted_imports.mjs`.
- Relative imports inside a package need the `.js` extension, because Node loads the
  emitted `dist/` directly. `actions.ts` imports `./table`; that becomes `./table.js`.
- Leave `apps/web/src/app/actions.ts` and `apps/web/src/app/table.ts` in place as
  one-line re-exports (`export * from '@seatgrab/seat';`). Twelve source files and several
  tests import them by relative path, and all keep working unchanged. Removing the shims is a
  follow-up, not part of this brief.
- `@seatgrab/computer` depends on `@seatgrab/seat`, `@seatgrab/protocol`, and `@seatgrab/content`.
  It does **not** depend on `@seatgrab/engine`. It needs a small seeded pseudorandom
  generator for tie-breaking; write a 20-line xorshift in the package rather than
  importing the engine's.

### What `@seatgrab/computer` exports

```ts
// packages/computer/src/index.ts
export type ComputerDifficulty = 'easy' | 'medium' | 'hard';   // re-exported from protocol
export const COMPUTER_DIFFICULTIES: readonly { id: ComputerDifficulty; label: string; description: string }[];

/** True when this seat's own view says it has something to answer or do. */
export function hasSomethingToDo(view: PlayerView, seatId: string): boolean;

/** Every command this seat would try now, best first. Never empty when hasSomethingToDo is true. */
export function decide(view: PlayerView, seatId: string, difficulty: ComputerDifficulty): readonly GameCommand[];

/** Static evaluation of a projection from one seat's point of view. Exported for tests. */
export function evaluate(view: PlayerView, seatId: string): number;

/** The minimal table a driver hands the step function. Both transports satisfy it. */
export interface ComputerTable {
  view(seatId: string): PlayerView | null;
  submit(seatId: string, command: GameCommand): Promise<CommandResponse>;
}

/** One accepted command for one computer seat, or a report that none was accepted. */
export function stepComputer(
  table: ComputerTable,
  seatId: string,
  difficulty: ComputerDifficulty,
): Promise<ComputerStep>;

export type ComputerStep =
  | { kind: 'acted'; command: GameCommand; revision: number }
  | { kind: 'idle' }
  | { kind: 'stuck'; refusals: readonly { command: GameCommand; code: string; message: string }[] };
```

`hasSomethingToDo` is true when any of the following holds for the seat's own view:

- `view.prompt !== undefined`. The projection gives a prompt only to a seat the engine is
  waiting on, so this covers setup votes, starting resources, policy answers, cap
  discards, majority selections, and every choice, auction, vote, and priority window.
- `view.activePlayerId === seatId` and `view.pendingDecision === undefined`.
- `view.privateTradeOffers` contains an offer whose `opponentId` is this seat.

### Internal layout of `@seatgrab/computer`

```
src/
  index.ts        exports above
  enumerate.ts    candidateCommands, moved from apps/web/test/autoplay.ts and generalized:
                  it lists every legal-looking command in every category, with the
                  affordable payment already computed. No ordering opinion beyond
                  "settle debts and due groups first".
  evaluate.ts     evaluate(view, seatId) and the projected-outcome helpers
                  (afterPlacement, afterPurchase, afterMove, afterRemoval).
  random.ts       seeded xorshift; the seed is a hash of matchId, revision and seatId,
                  so a decision is a pure function of the view.
  policies/
    easy.ts       orders and filters candidates as described in Difficulty design
    medium.ts
    hard.ts
    shared.ts     choice-prompt filling (from autoplay's fillControl/answerChoice),
                  payment shaping, placement scoring
  step.ts         stepComputer: decide, then try candidates in order through submit
```

`apps/web/test/autoplay.ts` becomes a thin driver over `enumerate.ts` that keeps its
`placement: 'concentrate' | 'spread'` options and its exact candidate order, because the
sweeps and `full-game.test.ts` depend on that behavior. Do this move first and re-run the
sweep before touching anything else. If the sweep's refusal list is not empty after the
move, the move changed behavior; fix that before continuing.

### Protocol and engine additions

Additive and optional everywhere, so old saves and old snapshots load.

```ts
// packages/protocol/src/controllers.ts (new)
export const SEAT_CONTROLLERS = ['human', 'computer'] as const;
export type SeatController = (typeof SEAT_CONTROLLERS)[number];
export const COMPUTER_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type ComputerDifficulty = (typeof COMPUTER_DIFFICULTIES)[number];
export const ComputerDifficultySchema = z.enum(COMPUTER_DIFFICULTIES);

// packages/engine/src/model/state.ts — GameConfig.players[]
controller?: SeatController;        // absent means 'human'
difficulty?: ComputerDifficulty;    // present if and only if controller is 'computer'

// packages/protocol/src/views.ts — PublicPlayerView
controller: SeatController;         // required in the view; projected from config, default 'human'
difficulty?: ComputerDifficulty;

// packages/protocol/src/rooms.ts — LobbySeatView
controller: SeatController;
difficulty?: ComputerDifficulty;
```

`createGame` validates that `difficulty` is present exactly when `controller` is
`'computer'`, and that at least one player is human. `projectGame` publishes the two
fields on every `PublicPlayerView`; they are public facts, like a seat's party. Update the
`PlayerView` fixtures in `apps/web/test/remote-match.test.ts` and
`apps/web/test/online-room.test.tsx`, as Session 21 did for its additions.
`packages/engine/test/projection-privacy.test.ts` gains one test that the fields reach
both the seat view and the public view.

The local save envelope's `players` entries gain optional `controller` and `difficulty`,
read by `requirePlayers` in `apps/web/src/local/snapshot.ts` with `human` as the
default, so the saved-match list can label a computer seat without loading the state.

## Difficulty design

All three policies share the enumerator, so every command they consider is one the
composers would have offered. They differ in ordering, filtering, and a few extra
candidates. The following table is the specification. Where it names a derivation, that
derivation already exists in `actions.ts`.

| Decision | Easy | Medium | Hard |
|---|---|---|---|
| First-player vote | Lowest-numbered seat other than itself (as the autoplay driver does; keeps the election decided on the first ballot). | Same. | Same. |
| Starting resources | Even split across the four types up to `startingResourceQuota`. | Split so that the cheapest card in the open market becomes affordable next turn; remainder even. | Same as Medium. |
| Policy answer | Seeded coin flip. | Seeded coin flip. | Seeded coin flip. The projection hides the reward and archetype, and no policy looks them up. Never redraws. |
| Cap discard | Largest pile first (`discardVector`). | Discard the types the open market needs least (`shortfallOrder`). | Same as Medium. |
| Which voter card to buy | Cheapest printed total first. | Most voters per resource first, then cheapest. Skip a card whose group has no zone it can usefully fill. | Same as Medium, and never buys a card it cannot place this turn without discarding. |
| Groundswell, Volunteers | Never. | Groundswell on the two largest purchases of the turn when unlocked. Volunteers when it turns an unaffordable card into an affordable one, else on the largest purchase. | Same as Medium. |
| Where to place | `spread`: emptiest zone first, non-volatile slots first. | Placement score (see below). | Placement score with denial and endgame terms. |
| Volatile slots | Indifferent. | Only when the target zone has no other empty slot. | Same as Medium. |
| Arbitrage | Only when no market card is affordable (as today). | When one resource short of the best purchase. | Same as Medium. |
| Shakedown | Never. | Take the resource it is short of from the seat holding most of it. | Take it from the seat with the highest evaluated standing. |
| Gerrymander | Never. | Move own voters to complete a majority or to reach the unique-highest count in a zone. | Also move a rival's voter out of a zone where that rival is within two of the threshold, when the rights zone authorizes it. |
| Demolition, Crackdown, Outreach | Never. | Only to break a rival majority that is one voter above threshold, or to complete its own. Outreach only when both targets are in a zone it can then win. | Whenever the evaluated delta is positive, targets chosen by evaluated damage to the leading rival. |
| Buy a trick | Never. | When it can still afford a voter card afterwards (`TRICK_RESERVE`). | When holding fewer than two cards and the reserve rule holds. |
| Play a trick | Never. | Cards that benefit itself: Cornerstone (ordinary), Grand Coalition when a level 3 power is unlocked, Star Power, Turncoat. Hostile cards against the rival with the highest score. | Every card, target chosen by evaluated damage. Cornerstone triple conversion when it holds three and a 6-or-11 zone with a rival majority exists. Flip-Flop when the committed card's other face (face up, so legitimately known) moves a track to 3 or 5. |
| Reactions (Veto, Boomerang) | Pass. | Boomerang when a card targets it. Veto a card that targets it. | Also Veto a card played by the leading rival that benefits them. Pass otherwise. |
| Auctions | Pass. | Bid the floor when held resources are at least 8. | Bid up to `min(4, held - 3)`, stepping by the floor. |
| Campaign vote | First candidate. | Itself if eligible, else the candidate with the lowest score. | Same as Medium. |
| Incoming trade | Reject. | Reject. | Accept when the evaluated value received is at least the value given and no trick card is given. Never proposes. |
| Choice prompts (all 41 operations) | The autoplay fill: smallest legal selection, rotating on refusal. | Same fill, options ordered by evaluated benefit where the option is a player, zone, or voter. | Same as Medium. |
| Majority selection | First `required` eligible voters. | Non-volatile voters first. | Same as Medium. |
| End turn | When nothing else is offered. | When no candidate has a positive evaluated delta. | Same as Medium. |
| Endgame | None. | None. | When leading on evaluated standing, prefer placements that complete the last undecided zone. When trailing, avoid completing the ninth majority and avoid filling the last empty area on the board. |

### The evaluator

`evaluate(view, seatId)` returns a number; higher is better for `seatId`. It is a static
function of the projection. Suggested terms, all tunable constants in one place:

- **Locked points.** For each zone whose `majorityOwnerId` is this seat, add
  `majorityThreshold`. For each zone a rival owns, subtract `0.5 * majorityThreshold`.
- **Potential.** For each undecided zone where `mine + emptySlots >= threshold`, add
  `0.6 * threshold * (mine / threshold)^2`. Central (threshold 5) and the four corner
  zones (threshold 6) are the cheapest points on the board and this term finds them.
- **Threat.** For each undecided zone where a rival has `threshold - 2` or more voters,
  subtract `0.4 * threshold`.
- **Rights.** Add 1.5 per zone where `rightsOwnerId` is this seat.
- **Resources.** Add 0.25 per held resource up to `resourceCap`; subtract 1 per resource
  over the cap, because the cap phase discards it.
- **Policy progress.** Add 0.5 per unit of `passiveIncome`; add 1 when a track sits at
  2 or 4, one card from a power.
- **Hand.** Add 1 per trick card held.

For a candidate whose effect the policy can project (place, buy, move, evict, convert),
score `evaluate(afterCommand(view)) - evaluate(view)`. For a candidate it cannot project
(playing a card with a continuation, buying a face-down card), use the fixed heuristics
in the table. Ties break by the seeded generator, never by array order alone, so two
identical positions in different matches do not always play the same way.

### Placement score

For a group of `count` voters, choose slots one at a time, re-asking
`legalPlacementSlotIds` after each pick because a same-zone group narrows after its first
slot. Score each legal slot's zone as follows:

- `-100` if a rival already holds the majority there.
- `-20` if `mine + emptySlots < threshold` (this seat can no longer win it).
- Otherwise `threshold - (threshold - mine - count)`: points available minus voters
  still needed after this placement, so a zone this group completes scores highest.
- `-3` if the zone's leading rival is within one of the threshold and this placement
  does not give this seat the unique-highest count.
- `-1` for a volatile slot when the zone has a non-volatile empty slot.
- Hard only: `+5` when completing this zone would complete all nine majorities and this
  seat leads on evaluated standing; `-8` when it would and this seat trails.

## The driver: when and how a computer acts

The same rules apply in the browser and on the server.

1. After every accepted command, and once when a match is opened or the server starts,
   check each computer seat's own view with `hasSomethingToDo`.
2. For the first computer seat with something to do, wait `delay` milliseconds, then call
   `stepComputer`. The step tries the candidates from `decide` in order and stops at the
   first accepted command. Every refusal on the way is recorded on the step result.
3. When the step reports `acted`, go to 1. When it reports `idle`, stop until the next
   accepted command. When it reports `stuck`, stop for this match, surface it (see
   below), and do not retry on a timer. A new accepted command from a human restarts
   the loop from 1.
4. At most one command is in flight per match, humans and computers together. Locally,
   lift the `busy` flag in `MatchShell` into one gate the hook and the human's `submit`
   share. On the server, the `MatchQueue` already serializes commands per match; the
   driver must still not schedule a second step while one is running.
5. Command IDs on the server are deterministic:
   `computer:${playerId}:${revision}:${attempt}`. A restart cannot apply the same
   decision twice, because the idempotency record answers the replay.
6. A `stuck` result is a defect in the enumerator, the policy, or a composer derivation,
   exactly as a stalled autoplay run is. Log the refusals with their codes and messages.
   Locally, show an alert on the match screen: "The computer could not find a legal
   move. Export this match and report it." Online, log at error level with the match ID
   and revision and answer the health route with `computers: 'degraded'` until the
   process restarts.

The delay exists so a human can follow what happened. Default 800 ms locally, configurable
per browser as **Computer pace: Normal or Fast** (Fast is 0 ms), stored under the
`localStorage` key `seatgrab.computerPace`. On the server it is
`SEATGRAB_COMPUTER_DELAY_MS`, default 800, and tests pass 0. Tests await a promise the driver
exposes (`settled(matchId)`) rather than sleeping.

## Work items, in order

Each item is one session in the sense `DESIGN.md` uses: it ends with
the narrowest relevant tests green, the root typecheck green, and a record in 0.7. Do not
start an item before the previous one's checks pass.

### Item 1: extract `@seatgrab/seat`

- Create `packages/seat` and move `actions.ts` and `table.ts` into `src/`, adding `.js`
  to relative imports. Export both from `src/index.ts`.
- Leave re-export shims at the old paths.
- Add the package to the root `tsconfig.json` references, to `apps/web/package.json` and
  `apps/server/package.json` dependencies, and to `OUTPUTS` in
  `scripts/check_emitted_imports.mjs`.
- Run `pnpm typecheck`, `pnpm vitest run`, both builds with `pnpm check:build`, and the
  sweep on a fresh seed offset. Nothing may change behavior.

### Item 2: extract the enumerator and build `@seatgrab/computer`

- Create `packages/computer`. Move `candidateCommands`, `affordablePayment`,
  `discardVector`, `placementSlots`, `fillControl`, and `answerChoice` from
  `apps/web/test/autoplay.ts` into the package. `autoplay.ts` imports them and keeps its
  public surface (`autoplay`, `candidateCommands`, `AutoplayOptions`) unchanged.
- Write `evaluate.ts`, `random.ts`, the three policies, `hasSomethingToDo`, `decide`, and
  `stepComputer`.
- Add the dependency test: `@seatgrab/computer` does not list `@seatgrab/engine`.
- Add `packages/computer/test/`: unit tests per policy on hand-built views (placement
  picks Central over North with equal counts; Hard blocks a leader's card and Medium does
  not; Easy never returns a `PlayTrick`; `decide` is deterministic for the same
  view; every choice operation in `ChoicePromptContext` yields at least one candidate
  from a view that offers it, reusing the fixtures in
  `apps/web/test/campaign-model.test.ts`).
- Re-run the sweep. The refusal list must still be empty.

### Item 3: protocol, engine, and saves

- Add `packages/protocol/src/controllers.ts` and export it from the package index.
- Extend `GameConfig`, `PublicPlayerView`, `LobbySeatView`, and the save envelope as
  described in Architecture. `createGame` validates the pairing and the one-human rule.
- Project the fields in `projectGame`. Fix every fixture the required field breaks.
- `rematchConfig` in `apps/web/src/app/results.ts` carries `controller` and
  `difficulty` through, so a rematch keeps the same computers.

### Item 4: local play

- `apps/web/src/app/setup.ts`: `SeatDraft` gains `controller` and `difficulty`. Add
  `setController(draft, key, controller, difficulty?)`. `validateSetup` requires at least
  one human seat and gives computer seats the default name `Computer N`, where `N` makes
  the name unique. `toGameConfig` writes the fields. Add a `defaultComputerDraft()` that
  returns one human seat and two `medium` computers, for the home screen shortcut.
- `apps/web/src/app/Lobby.tsx`: per seat, a **Controlled by** select (You, on this
  device / Computer) and, for a computer, a **Difficulty** select with the three
  descriptions from `COMPUTER_DIFFICULTIES`. The **Start** panel says how many humans and
  computers are seated and whether the cover will be used.
- `apps/web/src/app/Home.tsx`: a second primary action, **Play against the computer**,
  which opens the lobby with `defaultComputerDraft()`. Saved-match cards mark computer
  seats.
- `apps/web/src/app/handoff.ts`: add `initialHandoff(view): HandoffState`, which returns
  `{ kind: 'revealed', seatId }` when exactly one seat is human and `SHARED_HANDOFF`
  otherwise. Do not change `handoffReducer` or `revealedSeatId`. Extend
  `apps/web/test/handoff.test.ts` to walk the reachable states from both starts and to
  assert that a `passTo` naming a computer seat is never dispatched by the shell (the
  shell filters; the reducer stays generic).
- `apps/web/src/app/MatchShell.tsx`: initialize the handoff from the view once the match
  loads; hide the switcher's pass controls when there is one human; filter computer seats
  out of every pass menu; add `useComputerSeats(match, pace)` from a new
  `apps/web/src/app/useComputerSeats.ts` that implements the driver over `LocalMatch`;
  share the `busy` gate; show the `stuck` alert.
- `apps/web/src/app/StatusBar.tsx` and `packages/seat/src/table.ts`: `describeDecision`
  names a computer seat as "Devi (computer)" and, while the driver is between steps, the
  bar reads "Devi is thinking…". Add the **Computer pace** control to the bar's menu.
- `apps/web/src/app/ResultsSurface.tsx`: a computer badge on standings; the rematch
  consent list needs consent only from human seats.
- `apps/web/test/match-shell.test.tsx`: add a solo-table case. Render a saved match with
  one human and two computers at the human's turn and assert no cover is in the document,
  the human's panel is, and no computer's private data is. Then let the driver run with
  pace 0 through one computer turn and assert the human's panel is still the only private
  panel.
- `apps/web/test/full-game.test.ts`: one seeded three-player game with one `easy`, one
  `medium`, and one `hard` seat, driven through `stepComputer`, finishing with an empty
  refusal list.

### Item 5: online rooms

- Migration 2 in `apps/server/src/persistence/migrations.ts`: `ALTER TABLE seats ADD
  COLUMN controller TEXT NOT NULL DEFAULT 'human' CHECK (controller IN ('human',
  'computer'))` and `ALTER TABLE seats ADD COLUMN difficulty TEXT`. Never edit
  migration 1.
- `MatchRepository`: `SeatRow` gains the two fields; `seatComputer(matchId, seatIndex,
  displayName, partyId, difficulty)`; `releaseSeat` also clears a computer seat (drop the
  `credential_hash IS NOT NULL` condition in favor of "the seat is held by a credential
  or by a computer"); `listMatchesWithComputers(statuses)` for restart recovery.
- `RoomService`:
  - `seatComputer(host, seatIndex, difficulty): LobbyView`. Host only, lobby only, seat
    must be free, not the host's own seat. The server picks the display name `Computer N`
    (unique at the table, case-folded against human names) and the first free party from
    `SEATABLE_PARTY_IDS`. No credential is minted.
  - `releaseSeat` accepts a computer seat.
  - `lobby()` publishes `controller` and `difficulty`; `ready` is true when every seat is
    claimed by a credential or held by a computer.
  - `start()` writes `controller` and `difficulty` into `GameConfig.players`.
  - `claimSeat` checks name and party uniqueness against computer seats too.
  - `computerSeats(matchId): readonly SeatIdentity[]` builds identities for the driver
    from seat rows, with `isHost: false`. `authenticate` is unchanged and keeps refusing
    a computer seat, because it has no credential hash.
- `apps/server/src/rooms/computerDriver.ts`: the driver described earlier, constructed
  with `{ rooms, hub, delayMs, log }`. `MatchHub` gains an `onChanged(matchId)` callback
  invoked after `start` and after every accepted, non-duplicate `submit`; the driver
  subscribes to it. `buildServer` constructs the driver, and `index.ts` calls
  `driver.recover()` after listening so matches with computers that were mid-decision
  at shutdown continue.
- Routes in `apps/server/src/transport/httpRoutes.ts`:
  - `PUT /api/matches/:matchId/seats/:seatIndex/computer` with body
    `{ difficulty }`, host credential, answers the lobby.
  - The existing `DELETE /api/matches/:matchId/seats/:seatIndex` removes a computer seat.
- `apps/web/src/remote/rooms.ts`: `seatComputer(options, { matchId, seatIndex,
  difficulty, credential })`.
- `apps/web/src/app/OnlineRoom.tsx`: for the host, each free seat offers **Seat a
  computer** with a difficulty select beside the existing **Free seat** control; a
  computer seat shows its difficulty and a **Remove** control that calls `releaseSeat`.
  `hostStartState` in `online.ts` needs no change because it reads `lobby.ready`.
- Server tests, in `apps/server/test/computers.test.ts` on the real harness with
  `SEATGRAB_COMPUTER_DELAY_MS=0`:
  - A host seats a computer; a guest cannot; a computer seat cannot be claimed with the
    room code; the lobby reports it and `ready` becomes true with one human and two
    computers.
  - Starting the match makes the computers play: after the human's setup commands, the
    human's socket receives `state` frames whose `activePlayerId` advances past both
    computer seats without any client command.
  - A computer seat's projection is never sent: with one human connected, count frames
    per broadcast and assert one.
  - Restart recovery: stop the server while a computer is due to act, restart, and
    assert the match advances.
  - Command IDs are deterministic and a replayed decision is answered from the
    idempotency record.

### Item 6: instruments and the record

- `apps/web/test/sweep.ts`: keep the default behavior. Add a `--policy` flag taking
  `autoplay` (default), `easy`, `medium`, `hard`, or `mixed`, where `mixed` seats one of
  each. Report finish rate, refusal list, and, for `mixed`, wins per difficulty.
- `apps/web/test/tournament.ts`: 60 seeded three-player `mixed` games on a fixed seed
  range, printing wins per difficulty. Record the figures in the session record. Do not
  tune to a threshold you then assert in a unit test; the acceptance criterion is an
  ordering, not a number.
- Update `DESIGN.md`: 0.0 "start here", 0.1 repository map (two new
  packages), 0.3 important files, 0.7 one record per item, and a new 13.12 "Computer
  opponents" describing the screens. Follow 0.8.

## Screens and copy

- Home: **Play against the computer** as a second primary action under **Set up a new
  local match**, with the lede "You take one seat. The computer takes the rest. No cover,
  no passing the device."
- Lobby: the per-seat **Controlled by** control reads "You, on this device" and
  "Computer". Difficulty descriptions, one line each:
  - Easy: "Buys the cheapest voters and spreads them around. Never uses powers or
    tricks."
  - Medium: "Goes for the cheapest majorities, uses its unlocked powers, and plays
    tricks that help itself."
  - Hard: "Plays to win: targets the leader, defends its majorities, and times the end
    of the game."
- Match screen, one human: no cover on load; the status bar reads "Devi (computer) is
  thinking…" between steps; the menu holds **Computer pace**.
- Match screen, two or more humans: unchanged, except that computer seats never appear
  in **Pass the device**.
- Online lobby, host: **Seat a computer** with a difficulty select on each free seat;
  **Remove** on a computer seat. Guests see the computer seat's name and difficulty.
- Every seat list, including saved-match cards, the roster, and results, marks a computer
  seat with a small "computer" label beside the party mark. Words, not only an icon.
- The rules page gains a short section stating what the computer can and cannot see: it
  reads the same table a player does, does not know the reward of an policy answer
  before committing, and does not see any hand but its own.

## Acceptance criteria

- A person can start a match from **Play against the computer**, answer their own
  prompts, and reach the results screen without ever seeing a cover or a **Pass to**
  control. Verified in the browser and by `match-shell.test.tsx`.
- A three-seat pass-and-play table with two humans and one computer keeps the cover
  between the humans, and the computer's seat never appears in the pass menu.
- A host can seat computers in an online room and start with one human. The human's
  browser watches the computers play through `state` frames. A restart mid-computer-turn
  does not stall the match. Verified by `apps/server/test/computers.test.ts`.
- `pnpm tsx apps/web/test/sweep.ts 40 <fresh offset>` finishes every game with an empty
  refusal list, both with the default policy and with `--policy mixed`.
- In the 60-game tournament, `hard` wins more games than `medium`, and `medium` wins more
  than `easy`. Record the actual counts.
- `@seatgrab/computer` has no dependency on `@seatgrab/engine`, asserted by a test.
- Old local saves and old server snapshots load and treat every seat as human.
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @seatgrab/web build && pnpm check:build`,
  and `pnpm --filter @seatgrab/web build:online && pnpm check:build` pass.

## Verification

Run these after each item and record the results in the session record:

```bash
pnpm typecheck
```

```bash
pnpm vitest run
```

```bash
pnpm tsx apps/web/test/sweep.ts 40 <fresh seed offset>
```

```bash
pnpm tsx apps/web/test/sweep.ts 40 <fresh seed offset> --policy mixed
```

```bash
pnpm tsx apps/web/test/tournament.ts
```

```bash
pnpm --filter @seatgrab/web build && pnpm check:build && pnpm --filter @seatgrab/web build:online && pnpm check:build
```

For browser evidence, start Vite directly with `nohup pnpm --filter @seatgrab/web dev:local &`
rather than through an IDE preview tool, which has stalled on this project before. Create
a solo match from the home screen and record a screenshot of the computer's turn
advancing and of the results screen.

`sweep.ts` reads its two positional arguments first (games per combination, seed offset),
so put `--policy` after them.

## Files

New:

- `packages/seat/` (package files, `src/index.ts`, `src/actions.ts`, `src/table.ts`)
- `packages/computer/` (package files, `src/` as laid out earlier, `test/`)
- `packages/protocol/src/controllers.ts`
- `apps/web/src/app/useComputerSeats.ts`
- `apps/server/src/rooms/computerDriver.ts`
- `apps/server/test/computers.test.ts`
- `apps/web/test/tournament.ts`

Changed:

- `packages/protocol/src/views.ts`, `rooms.ts`, `index.ts`
- `packages/engine/src/model/state.ts`, `flow/createGame.ts`,
  `projections/projectGame.ts`, `test/projection-privacy.test.ts`
- `apps/web/src/app/actions.ts` and `table.ts` (become re-export shims)
- `apps/web/src/app/setup.ts`, `Lobby.tsx`, `Home.tsx`, `handoff.ts`, `MatchShell.tsx`,
  `StatusBar.tsx`, `SeatSwitcher.tsx`, `ResultsSurface.tsx`, `results.ts`, `RulesInfo.tsx`,
  `online.ts`, `OnlineRoom.tsx`
- `apps/web/src/local/snapshot.ts`
- `apps/web/src/remote/rooms.ts`
- `apps/web/test/autoplay.ts`, `sweep.ts`, `full-game.test.ts`, `handoff.test.ts`,
  `match-shell.test.tsx`, `lobby-setup.test.ts`, `remote-match.test.ts`,
  `online-room.test.tsx`
- `apps/server/src/config.ts`, `app.ts`, `index.ts`, `persistence/migrations.ts`,
  `persistence/repository.ts`, `rooms/roomService.ts`, `rooms/matchHub.ts`,
  `transport/httpRoutes.ts`
- `apps/web/package.json`, `apps/server/package.json`, root `tsconfig.json`,
  `scripts/check_emitted_imports.mjs`
- `DESIGN.md`, `OPERATIONS.md` (the new setting and the health field)

## Follow-ups that are not part of this brief

- Removing the re-export shims and moving `action-model.test.ts`,
  `campaign-model.test.ts`, and `table-model.test.ts` into `packages/seat/test`.
- Trade proposals by the `hard` policy. Accepting trades is in scope; proposing is not.
- Letting a human take over a computer seat mid-match, or the reverse. A seat's
  controller is fixed at start, like its party.
- A fourth difficulty that may read answer rewards from the content pack. The owner chose
  strict fairness for all three levels; add this only if asked, and disclose it in the
  difficulty description.
- Tuning the evaluator's constants from tournament data. Record the first tournament's
  figures and leave tuning to a later session.
