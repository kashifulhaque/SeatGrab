# Gerrymander

Gerrymander is a political strategy game for 3 to 5 players, playable in a browser.
Players answer policy questions, spend the resources they earn on voters, and place those
voters on a nine-zone board. Hold a zone's majority and its voters score; when every zone
is held, the player with the most scoring voters wins.

Play it three ways: pass and play on one device, against the computer at one of three
difficulties, or in an online room on separate devices. Any seat at a table can be a
computer, as long as one seat is a person. New to the game? **Learn to play** on the title
screen starts a guided match that names each rule as the table asks for it.

For the rules, the design commitments, and the full runbook for the room server, see
[CLAUDE.md](CLAUDE.md).

All card text, board art, icons and rules text in this repository are original to this
project. The resource icons are [Lucide](https://lucide.dev) icons, ISC licence, in
`LICENSES/`.

## Requirements

- Node.js 24 or later. Development and the test suite store in `node:sqlite`, which Node
  still marks experimental, so those runs print an `ExperimentalWarning`. The warning is
  expected.
- pnpm 10.28.0, pinned in `package.json`.
- Python 3, to regenerate the cards and the board. Not needed to run the game.
- A Cloudflare account, to deploy online rooms. Pass-and-play needs none.

There's no native build step and no database server to run: a deployment stores in
Cloudflare D1, and everything else stores in a local file.

## Run it locally

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` starts the room server and the web client together. The checks:

```bash
pnpm typecheck
```

```bash
pnpm test
```

## Deploy

The application is two independent pieces, and a pass-and-play deployment needs only the
first: a static browser build in `apps/web/dist`, and a Node process,
`apps/server/dist/index.js`, with a Cloudflare D1 database for online rooms.

1. Install, typecheck and build. `pnpm typecheck` compiles every package into its `dist/`,
   which is what the server process runs, so don't skip it:

   ```sh
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build:online
   ```

   `pnpm build:online` produces a browser build with online rooms. For a pass-and-play
   deployment, run `pnpm build` instead, which emits no network code at all.

2. Verify what the browser build contains:

   ```sh
   pnpm check:build
   ```

   The output lists one `.map` file per build. Source maps are emitted `hidden`: nothing
   in the bundle links to one, and `check:build` reads them to prove that no development
   route and no online module was compiled into a chunk. **Don't copy the `.map` files to
   the web host.** They carry the full application source, and the check prints their exact
   paths so you can exclude them.

3. Copy `apps/web/dist` to the web host, without the `.map` files.

   The container build does this for you: `apps/web/Dockerfile` deletes every `.map` from
   the nginx image after copying `dist/` into it, and `apps/web/nginx.conf` answers `404`
   for any `.map` request. If your deployment copies `dist/` itself, exclude the `.map`
   files by hand.

4. Start the room server with at least these settings:

   ```sh
   GERRYMANDER_D1_ACCOUNT_ID=YOUR_ACCOUNT_ID \
   GERRYMANDER_D1_DATABASE_ID=YOUR_DATABASE_ID \
   GERRYMANDER_D1_API_TOKEN=YOUR_API_TOKEN \
   GERRYMANDER_ALLOWED_ORIGINS=https://gerrymander.example.com \
   pnpm start
   ```

   Create the database first with `npx wrangler d1 create gerrymander`, which prints the
   database ID. The token needs the **D1 Edit** permission. The server applies its own
   migrations at startup, before it opens the port.

   Leave the three D1 settings unset to store in a local SQLite file at
   `GERRYMANDER_DB_PATH` instead, which is what a development run does.

   Replace `https://gerrymander.example.com` with the exact origin the browser build is
   served from. A deployment that doesn't list its own origin refuses every browser at the
   WebSocket upgrade with a 403, which is the mistake most likely to make a working
   deployment look broken.

The server binds to loopback by default, so put a reverse proxy in front of it that
forwards the WebSocket upgrade on `/ws`. For that configuration, the rest of the settings,
health checks, backups and troubleshooting, see [CLAUDE.md](CLAUDE.md).

## Change the cards

Card text lives in `content/*-text.json`; mechanical facts — costs, handler IDs, advisory
flags — live in `content/*-skeleton.json`. Edit the JSON, then regenerate the typed
modules:

```bash
pnpm generate:content
```

The map is produced by `scripts/generate_board.py`, which lays the nine districts out on a
hex lattice and then refuses to emit a map whose drawn borders disagree with the adjacency
the ruleset lists.
