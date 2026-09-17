# SeatGrab

SeatGrab is a political strategy game for 3 to 5 players, playable in a browser. Players
answer policy questions, spend the resources they earn on voters, and place those voters
on a nine-zone board. Hold a zone's majority and its voters score; when every zone is held,
the player with the most scoring voters wins.

Play it three ways: pass and play on one device, against the computer at one of three
difficulties, or in an online room on separate devices. Any seat at a table can be a
computer, as long as one seat is a person.

New to the game? **Learn to play** on the title screen starts a guided match against two
Easy computers. A coach panel on the match screen names the rule the table is asking for
at the moment it asks — the vote, the starting resources, the policy question, the market,
placement, majorities, redistricting and the rest — and retires each lesson once you have
used it. It is an ordinary match underneath, saved like any other, so nothing you learn
there is a tutorial-only rule.

All card text, board art, icons and rules text in this repository are original to this
project. The resource icons are [Lucide](https://lucide.dev) icons (ISC licence, see
`LICENSES/`).

## Rules in brief

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
  cannot be moved.
- **Volatile areas.** A voter placed there is fixed for the game and deals its owner a
  Breaking News card that resolves at the end of the turn.
- **Dirty Tricks.** Bought face down for the price on the back; played on your turn, or
  as a reaction when the card says so.
- **The computer.** A computer seat reads the same table you do. It does not see any hand
  but its own, and it does not know what a policy answer pays before it commits. Easy
  buys cheap voters and spreads them around; Medium goes for the cheapest majorities and
  uses its powers; Hard targets the leader and times the end of the game.

The house rules the engine applies where a table might argue are listed in
`packages/content/src/ruleset.ts` and on the rules screen of the app.

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/content` | Typed card, board and house-rule data. Generated from `content/`. |
| `packages/engine` | The rules engine: commands, effects, projections. |
| `packages/protocol` | Shared command, view and socket schemas. |
| `packages/seat` | What one seat can see and do, derived from its own projection. |
| `packages/computer` | The computer opponent. Reads a seat's own projection; no engine dependency. |
| `apps/web` | The React client. Pass-and-play and online builds. |
| `apps/server` | The online room server. See `OPERATIONS.md`. |
| `content/` | Editable JSON: card text and mechanical skeletons. |
| `scripts/` | Content generators and build checks. |

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the room server and the web client together. Other commands:

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

```bash
pnpm check:build
```

## Change the cards

Card text lives in `content/*-text.json`; mechanical facts (costs, handler IDs,
advisory flags) live in `content/*-skeleton.json`. Edit the JSON, then regenerate the
typed modules:

```bash
pnpm generate:content
```

The board layout is produced by `scripts/generate_board.py`.
