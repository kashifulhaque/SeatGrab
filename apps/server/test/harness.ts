/**
 * A real server on a real database file, for the server suites.
 *
 * The database is a file rather than `:memory:` on purpose: the durability suite closes
 * the process and opens it again, and an in-memory database would make that test pass by
 * never having written anything. `restart()` is the whole point of the harness.
 *
 * `openSocket` drives the real WebSocket route through `injectWS`, which dispatches a
 * genuine upgrade request through the router, the route's hooks and `ws` itself — the
 * same path a browser takes, without binding a port. Two seats on two connections is
 * therefore a test in this harness rather than a second harness with a listening server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame } from '@seatgrab/protocol';

import { buildServer, type BuiltServer } from '../src/app';
import { readServerConfig, type ServerConfig } from '../src/config';

export interface Harness {
  server: BuiltServer;
  config: ServerConfig;
  /** Close the server and open a new one on the same file, as a restart does. */
  restart: () => Promise<void>;
  dispose: () => Promise<void>;
}

export interface HarnessOptions {
  /** A fixed seed keeps the deal, and every legal action after it, deterministic. */
  seed?: number;
  /**
   * Extra environment for `readServerConfig`, so a test can shorten a timeout or
   * narrow a budget without a second way of building a configuration.
   */
  env?: Readonly<Record<string, string>>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'seatgrab-server-'));
  const databasePath = join(directory, 'seatgrab.db');
  const config = readServerConfig({
    SEATGRAB_DB_PATH: databasePath,
    SEATGRAB_LOG_LEVEL: 'silent',
    SEATGRAB_PORT: '0',
    ...options.env,
  } as NodeJS.ProcessEnv);

  const seed = options.seed ?? 20260915;
  let ticks = 0;
  const build = (): BuiltServer =>
    buildServer({
      config,
      now: () => new Date(Date.UTC(2026, 8, 15) + ticks++ * 1000),
      seed: () => seed,
    });

  const harness: Harness = {
    server: build(),
    config,
    async restart() {
      await harness.server.close();
      harness.server = build();
    },
    async dispose() {
      await harness.server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return harness;
}

export function bearer(credential: string): Record<string, string> {
  return { authorization: `Bearer ${credential}` };
}

/**
 * The `ws` client `injectWS` hands back, named for what this file uses.
 *
 * `ws` ships no type declarations and `@types/ws` is not a dependency of this
 * workspace, so the returned value is `any`. Naming the members keeps the tests
 * checked rather than letting a typo pass as a passing assertion.
 */
interface RawClientSocket {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
}

interface InjectableApp {
  injectWS: (
    path: string,
    upgradeContext?: unknown,
    options?: { onInit?: (socket: RawClientSocket) => void },
  ) => Promise<RawClientSocket>;
}

/** How long a test waits for a frame before calling it missing. */
const FRAME_TIMEOUT_MS = 2000;

export interface TestSocket {
  /** Send one client frame. Serialized here so a test writes an object. */
  send: (frame: unknown) => void;
  /** Send exactly these bytes, for the frames a well-behaved client never sends. */
  sendRaw: (data: string) => void;
  /**
   * The next frame of this type that no earlier call has taken.
   *
   * Frames are queued, so `next('state')` twice returns the first two broadcasts rather
   * than the same one twice, and a frame that arrived before the call was made is not
   * missed.
   */
  next: <T extends ServerFrame['type']>(
    type: T,
    timeoutMs?: number,
  ) => Promise<Extract<ServerFrame, { type: T }>>;
  /** Every frame received so far, in arrival order. */
  received: () => readonly ServerFrame[];
  /** Resolves when the server closes the connection. */
  closed: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  /** Close from this end. */
  close: () => void;
}

export interface SocketOptions {
  /** The `Origin` header to send. `null` sends none, as a non-browser client does. */
  origin?: string | null;
  /** Extra upgrade-request headers, for the credential-on-upgrade path. */
  headers?: Readonly<Record<string, string>>;
  /** Query string, without the leading `?`. */
  query?: string;
}

/**
 * Open a real WebSocket connection to the harness's server.
 *
 * Rejects when the upgrade is refused, which is how an origin refusal is asserted: the
 * server answers the upgrade with a status rather than switching protocols.
 */
export async function openSocket(
  harness: Harness,
  options: SocketOptions = {},
): Promise<TestSocket> {
  await harness.server.app.ready();
  const app = harness.server.app as unknown as InjectableApp;

  const origin = options.origin === undefined ? 'http://localhost:5173' : options.origin;
  const headers: Record<string, string> = {
    ...(origin === null ? {} : { origin }),
    ...options.headers,
  };
  const path = options.query === undefined ? '/ws' : `/ws?${options.query}`;

  const queue: ServerFrame[] = [];
  const all: ServerFrame[] = [];
  let closure: { code: number; reason: string } | null = null;
  const waiting = new Set<() => void>();
  const wake = (): void => {
    for (const listener of [...waiting]) listener();
  };

  // Listeners are attached through `onInit`, before the client socket is wired to the
  // stream. A server that answers the upgrade itself — the credential-on-upgrade path —
  // writes its first frame before `injectWS` resolves, so listeners attached after the
  // await would miss it and the test would report a frame the server did send.
  const socket = await app.injectWS(path, { headers }, {
    onInit: (client) => {
      client.on('message', ((data: { toString: () => string }) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        queue.push(frame);
        all.push(frame);
        wake();
      }) as (...args: never[]) => void);

      client.on('close', (((code: number, reason: { toString: () => string }) => {
        closure = { code, reason: reason?.toString() ?? '' };
        wake();
      }) as unknown) as (...args: never[]) => void);
    },
  });

  const settle = async <T>(
    take: () => T | null,
    describe: string,
    timeoutMs: number,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const taken = take();
      if (taken !== null) return taken;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Waited ${timeoutMs}ms for ${describe}. Frames seen: `
          + `${all.map((frame) => frame.type).join(', ') || 'none'}.`,
        );
      }
      await new Promise<void>((resolve) => {
        const listener = (): void => {
          waiting.delete(listener);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(listener, Math.min(remaining, 25));
        waiting.add(listener);
      });
    }
  };

  return {
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
    sendRaw(data) {
      socket.send(data);
    },
    received: () => all,
    async next(type, timeoutMs = FRAME_TIMEOUT_MS) {
      return settle(
        () => {
          const index = queue.findIndex((frame) => frame.type === type);
          if (index < 0) return null;
          const [frame] = queue.splice(index, 1);
          return (frame ?? null) as Extract<ServerFrame, { type: typeof type }> | null;
        },
        `a "${type}" frame`,
        timeoutMs,
      );
    },
    async closed(timeoutMs = FRAME_TIMEOUT_MS) {
      return settle(() => closure, 'the connection to close', timeoutMs);
    },
    close() {
      socket.close();
    },
  };
}
