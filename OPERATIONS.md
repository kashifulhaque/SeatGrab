# Operate the SeatGrab room server

This runbook covers deploying and running the online room server and the browser build
beside it. Every command and every output in it was run against this repository; where a
procedure has a caveat, the caveat is one that was observed rather than inferred.

For the rules and the repository layout, see [README.md](README.md) and
[DESIGN.md](DESIGN.md).

## What you deploy

The application is two independent pieces, and a pass-and-play deployment needs only the
first:

- **A static browser build**, in `apps/web/dist`. Any static host serves it.
- **A Node process**, `apps/server/dist/index.js`, with one SQLite file. It is the
  authority for online rooms, and nothing else writes to that file.

The two builds of the browser are genuinely different, and the choice is made at build
time:

| Command | Build marker | What it contains |
|---|---|---|
| `pnpm build` | `local-play` | Pass-and-play only. No network code: no module from `src/remote/`, no `Online*` screen, and no `new WebSocket`. |
| `pnpm build:online` | `online` | Pass-and-play and the `#/online` family, which needs the room server. |

Each build stamps its marker into the emitted HTML as `<meta name="seatgrab-build">`. To read
which build a directory holds, run `pnpm check:build`, which reads the marker itself and
applies the assertions that build is owed.

## Requirements

- Node.js 24 or later. The server uses `node:sqlite`, which Node still marks
  experimental, so every start prints an `ExperimentalWarning`. The warning is expected.
- pnpm 10.28.0, pinned in `package.json`.
- No native build step and no separate database server.

## Deploy

1. Install dependencies and build everything:

   ```sh
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build:online
   ```

   `pnpm typecheck` compiles every package into its `dist/`, which is what both the
   server process and the dev server run. Building the browser without it leaves the
   application on a stale engine.

2. Verify what the browser build contains:

   ```sh
   pnpm check:build
   ```

   The output lists one `.map` file per build. Source maps are emitted `hidden`: nothing
   in the bundle links to one, and `check:build` reads them to prove that no development
   route and no online module was compiled into a chunk. **Do not copy the `.map` files to
   the web host.** They carry the full application source, and the check prints their exact
   paths so you can exclude them.

3. Copy `apps/web/dist` to the web host, without the `.map` files.

4. Start the room server with at least these settings:

   ```sh
   SEATGRAB_DB_PATH=/var/lib/seatgrab/seatgrab.db \
   SEATGRAB_ALLOWED_ORIGINS=https://seatgrab.example.com \
   pnpm start
   ```

   Replace `https://seatgrab.example.com` with the exact origin the browser build is served
   from. This setting is the one most likely to make a working deployment look broken:
   see [The origin allowlist](#the-origin-allowlist).

## Settings

Every setting has a default that runs a single-instance development server, so a bare
`pnpm start` works with none of them. The ones a deployment must consider:

| Variable | Default | What it does |
|---|---|---|
| `SEATGRAB_DB_PATH` | `./data/seatgrab.db` | The SQLite file. Its directory is created at startup. |
| `SEATGRAB_HOST` | `127.0.0.1` | Bind address. Leave it on loopback and put a reverse proxy in front. |
| `SEATGRAB_PORT` | `8787` | TCP port. |
| `SEATGRAB_ALLOWED_ORIGINS` | the two loopback spellings of the Vite dev server | Comma-separated browser origins allowed to open a WebSocket. `*` is refused. |
| `SEATGRAB_TRUST_PROXY` | `false` | Read the client address from `X-Forwarded-For`. Set it only behind a proxy that sets the header itself. |
| `SEATGRAB_HTTP_BURST_REQUESTS` | `60` | Requests one client address may send to `/api/*` in a burst. |
| `SEATGRAB_HTTP_REQUESTS_PER_SECOND` | `5` | The rate that burst refills at. |
| `SEATGRAB_SOCKET_BURST_FRAMES` | `40` | Frames one seat may send in a burst. |
| `SEATGRAB_SOCKET_FRAMES_PER_SECOND` | `10` | The rate that burst refills at. |
| `SEATGRAB_MAX_BODY_BYTES` | `65536` | Largest accepted request body. |
| `SEATGRAB_SHUTDOWN_TIMEOUT_SECONDS` | `10` | How long a shutdown waits for in-flight requests. |
| `SEATGRAB_LOG_LEVEL` | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |

A setting the server cannot read stops it with exit code 2 and a message naming the
variable. It does not fall back to a default.

## The origin allowlist

`SEATGRAB_ALLOWED_ORIGINS` defaults to the Vite dev server's two loopback spellings. A
deployment that does not list its own origin refuses every browser at the WebSocket
upgrade with a 403, which looks like a broken server rather than a policy. **Check this
first when online play will not connect.**

A request carrying no `Origin` header is allowed. It is not a browser, the seat credential
is what authorizes it, and a non-browser caller can put any origin it likes in the header
anyway. The check defends the case it can: a page in a player's browser that the player
did not open.

## Boomerang proxy

The server binds to loopback by default, so a deployment terminates TLS at a proxy and
forwards to it. Three things matter:

- **The WebSocket upgrade must be forwarded.** `/ws` is a long-lived connection, not a
  request. A proxy that does not forward `Upgrade` and `Connection` headers leaves every
  table stuck on Connecting.
- **Set a read timeout longer than a turn.** A table thinking about a move sends nothing.
  A proxy that closes an idle socket after 60 seconds disconnects players mid-game; they
  reconnect, but the banner flickers through `reconnecting` for no reason.
- **Decide where rate limiting lives.** The server counts requests per client address, and
  behind a proxy every request arrives from the proxy. Either set `SEATGRAB_TRUST_PROXY=true`
  with a proxy that sets `X-Forwarded-For` itself, or rate-limit at the proxy and raise
  `SEATGRAB_HTTP_BURST_REQUESTS` out of the way. Left alone, the whole internet shares one
  bucket and the limit is worse than none: the first busy client locks everyone out.

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

## Health

`GET /health` answers 200 when the database answers a trivial read, and 503 when it does
not. The body names the build so a mismatch between the browser and the server is visible:

```sh
curl -s http://127.0.0.1:8787/health
```

The output is similar to the following:

```json
{"status":"ok","database":"ok","uptimeSeconds":1,"schemaVersion":1,
 "contentPackId":"core-set","contentVersion":"0.9.0","boardId":"grid-nine"}
```

It names no room code, no seat, and no count of who is playing. It is also deliberately
outside the request budget: a health check that starts failing because the server is busy
reports the opposite of what it is for.

## Back up and restore

The database is one SQLite file in WAL mode, so a plain file copy of a running server can
capture a `.db` without the `-wal` beside it. Use SQLite's own backup instead, which is
safe while the server runs:

```sh
sqlite3 /var/lib/seatgrab/seatgrab.db ".backup '/var/backups/seatgrab-$(date +%F).db'"
```

To restore, stop the server first. A restore under a running process leaves it holding a
file that no longer matches its WAL:

```sh
systemctl stop seatgrab
rm -f /var/lib/seatgrab/seatgrab.db /var/lib/seatgrab/seatgrab.db-wal /var/lib/seatgrab/seatgrab.db-shm
cp /var/backups/seatgrab-2026-09-16.db /var/lib/seatgrab/seatgrab.db
systemctl start seatgrab
```

Removing the `-wal` and `-shm` files matters. Left in place, they belong to the file you
just replaced, and the server either fails to open the database or reads a mixture of the
two. A restored server resumes every room in the backup at the revision it was taken at:
commands accepted after the backup are gone, and a client that reconnects is sent the
restored state rather than its own.

## Restart and recovery

A restart is safe at any point. Every accepted command is one transaction carrying the
snapshot, the events, and the idempotency record together, so a process that dies
mid-command either committed it whole or did not commit it at all.

`SIGTERM` and `SIGINT` both close the HTTP server first, so no new request starts, and
then close the database. If in-flight requests do not finish within
`SEATGRAB_SHUTDOWN_TIMEOUT_SECONDS`, the process logs and exits with code 1.

Rooms survive a restart in SQLite. Connected browsers show Reconnecting, retry with a
backoff, and rejoin the same seat at the same pending decision. Nothing is lost and no
player has to re-enter a room code.

Resending a command ID that the server already accepted returns the stored response with
`"duplicate": true` and applies nothing a second time. A client that is unsure whether a
command landed can safely send it again with the same ID.

## Recover a lost seat

A seat credential is issued once, to the browser that claimed the seat, and the server
stores only its hash. A player who clears their site data, or opens the room on a second
device, cannot rejoin that seat. Because a room cannot start with an empty seat, one
player's cleared storage would otherwise strand the whole table.

Before the match starts, the host frees the seat from the lobby roster, and the player
claims it again with the room code. The freed credential stops working immediately.

Once the table is dealt, seats lock and no seat can be freed. A seat holds private cards
and committed answers from that point, and freeing one would hand them to whoever claimed
it next. A table that loses a credential mid-match has lost that seat; open a new room.

## Troubleshooting

**Every browser fails to connect, and the server logs a 403 at the upgrade.** The origin
is not in `SEATGRAB_ALLOWED_ORIGINS`. It must be the exact origin the browser build is served
from, scheme and port included.

**Tables connect and then drop every minute.** The proxy is closing an idle WebSocket.
Raise `proxy_read_timeout`.

**One client gets 429 and so does everyone else.** The server is behind a proxy and
`SEATGRAB_TRUST_PROXY` is not set, so every request shares one bucket. See
[Boomerang proxy](#reverse-proxy).

**The server exits with code 2 at startup.** A setting could not be read. The message on
stderr names the variable and the values it accepts.

**The server exits with `ERR_MODULE_NOT_FOUND`.** The build is stale or partial. Run
`pnpm typecheck` to rebuild every package's `dist/`, then start again.

## What this deployment does not do

State these plainly rather than discovering them in production:

- **One process, one file.** There is no clustering and no shared-state story. A second
  process on the same database would corrupt the command ordering that `MatchQueue`
  exists to guarantee.
- **No CORS policy on the HTTP surface.** Origin checking is a WebSocket rule, so a
  browser reaches `/api` same-origin only. Serve the browser build and the server from
  one origin.
- **Local saves are unencrypted.** The pass-and-play build stores every seat's private
  cards and answers in the browser's IndexedDB, and exports them in clear JSON. That is
  the stated pass-and-play model. It is never the online model: the server has no
  full-state export for an ordinary player.
