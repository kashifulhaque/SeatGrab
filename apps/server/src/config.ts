/**
 * Server settings, read from the environment once at startup.
 *
 * Every setting has a default that runs a single-instance development server, so a bare
 * `pnpm start` works. Anything an operator must change for a real deployment — the
 * database path, the bind address, the allowed origins — is named here rather than
 * spread through the code.
 *
 * Nothing in this file is a game rule, and none of these values reach a projection.
 */
import { isAbsolute, resolve } from 'node:path';

export interface ServerConfig {
  /** TCP port to bind. */
  port: number;
  /**
   * Bind address. The default is loopback: an operator who wants the server reachable
   * from another machine should put it behind the documented reverse proxy, not widen
   * the bind address by accident.
   */
  host: string;
  /** Absolute path of the SQLite file. Its directory is created at startup. */
  databasePath: string;
  /**
   * Largest accepted request body, in bytes.
   *
   * Commands are small; the largest legitimate body is a command envelope with a target
   * set in it. A generous ceiling still refuses a body big enough to be a denial of
   * service on JSON parsing alone.
   */
  maxBodyBytes: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Seconds to wait for in-flight requests before a shutdown stops waiting. */
  shutdownTimeoutSeconds: number;
  /**
   * Browser origins allowed to open a WebSocket connection.
   *
   * Section 14.1 requires the origin of a socket to be validated. A request carrying no
   * `Origin` header is not a browser and is allowed: the seat credential is what
   * authorizes it, and a non-browser caller can put any origin it likes in the header
   * anyway. The check is here for the case it actually defends, which is a page in a
   * player's browser that the player did not open.
   *
   * The default is the Vite dev server, on both loopback spellings, because that is the
   * only origin a development run has. A deployment serves the browser build from its
   * own origin and must list it.
   */
  allowedOrigins: readonly string[];
  /** Seconds a socket may stay open without authenticating before it is closed. */
  socketAuthenticationTimeoutSeconds: number;
  /** Frames a seat may send in one burst before the budget has to refill. */
  socketBurstFrames: number;
  /** Frames per second the burst budget refills at. */
  socketFramesPerSecond: number;
  /**
   * Requests one client address may send to `/api/*` in one burst.
   *
   * Without this, `POST /api/rooms` is an unbounded room-creation endpoint and
   * `POST /api/matches/:id/commands` an unbounded command endpoint for anyone holding a
   * credential. The socket budget does not cover either, because it counts frames on a
   * connection and these arrive without one.
   *
   * The burst is generous on purpose: a browser opening a room sends several requests
   * back to back, and the lobby polls every four seconds while the seats fill. What it
   * refuses is a script, not a table.
   */
  httpBurstRequests: number;
  /** Requests per second the HTTP burst refills at, per client address. */
  httpRequestsPerSecond: number;
  /**
   * Whether to read the client address from `X-Forwarded-For`.
   *
   * It matters for one reason: the HTTP budget is keyed by client address, and behind a
   * reverse proxy every request arrives from the proxy. Left off, the whole internet
   * shares one bucket and the limit is worse than none — the first busy client locks
   * everyone out. So a deployment behind a proxy must either set this, with a proxy that
   * sets the header itself, or rate-limit at the proxy and raise this limit out of the
   * way.
   *
   * It is off by default because trusting the header when nothing sets it lets any
   * caller claim any address, which is a way around the limit rather than a way to
   * enforce it.
   */
  trustProxy: boolean;
  /**
   * Milliseconds a computer seat waits before it acts.
   *
   * The pause is for the people watching: a computer that answered instantly would make
   * a turn arrive as one jump. Tests set it to 0 and await the driver instead.
   */
  computerDelayMs: number;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * The origins a development run has.
 *
 * `apps/web/vite.config.ts` serves on port 5173 and proxies `/ws` here, and a browser
 * reaches that server as either spelling of loopback. Nothing else is allowed by
 * default: a deployment lists its own origin.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}, but it is "${raw}".`);
  }
  return value;
}

/**
 * Read a comma-separated list, with the empty string meaning "none of them".
 *
 * An unset variable falls back to the default; an explicitly empty one does not, so an
 * operator can switch the origin allowlist off deliberately rather than only by
 * accident. `*` is not accepted: an allowlist that allows everything is worth writing
 * out as the exact origins it means.
 */
function readList(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: readonly string[],
): readonly string[] {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const values = raw.split(',').map((value) => value.trim()).filter((value) => value !== '');
  for (const value of values) {
    if (value === '*') {
      throw new ConfigError(
        `${name} does not accept "*". List the exact origins the browser build is served from.`,
      );
    }
  }
  return values;
}

/**
 * Read a boolean, written the way an operator writes one.
 *
 * An unset or empty variable is false. Anything else must be one of the four words
 * below, because a setting that silently reads "false" as true is worse than one that
 * refuses to start.
 */
function readFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${name} must be true, false, 1 or 0, but it is "${env[name]}".`);
}

/**
 * Read the configuration from an environment.
 *
 * The environment is a parameter so a test can build a configuration without touching
 * `process.env`, and so the defaults are exercised rather than assumed.
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawLevel = env['SEATGRAB_LOG_LEVEL'];
  const logLevel = rawLevel === undefined || rawLevel.trim() === '' ? 'info' : rawLevel;
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new ConfigError(`SEATGRAB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, but it is "${logLevel}".`);
  }

  const rawPath = env['SEATGRAB_DB_PATH'];
  const databasePath = rawPath === undefined || rawPath.trim() === ''
    ? resolve(process.cwd(), 'data', 'seatgrab.db')
    : (isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath));

  return {
    port: readInteger(env, 'SEATGRAB_PORT', DEFAULT_PORT, 0, 65535),
    host: env['SEATGRAB_HOST']?.trim() || '127.0.0.1',
    databasePath,
    maxBodyBytes: readInteger(env, 'SEATGRAB_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, 1024, 4 * 1024 * 1024),
    logLevel: logLevel as ServerConfig['logLevel'],
    shutdownTimeoutSeconds: readInteger(env, 'SEATGRAB_SHUTDOWN_TIMEOUT_SECONDS', 10, 0, 300),
    allowedOrigins: readList(env, 'SEATGRAB_ALLOWED_ORIGINS', DEFAULT_ALLOWED_ORIGINS),
    socketAuthenticationTimeoutSeconds: readInteger(
      env, 'SEATGRAB_SOCKET_AUTH_TIMEOUT_SECONDS', 10, 1, 120,
    ),
    socketBurstFrames: readInteger(env, 'SEATGRAB_SOCKET_BURST_FRAMES', 40, 1, 10000),
    socketFramesPerSecond: readInteger(env, 'SEATGRAB_SOCKET_FRAMES_PER_SECOND', 10, 1, 1000),
    httpBurstRequests: readInteger(env, 'SEATGRAB_HTTP_BURST_REQUESTS', 60, 1, 100000),
    httpRequestsPerSecond: readInteger(env, 'SEATGRAB_HTTP_REQUESTS_PER_SECOND', 5, 1, 10000),
    trustProxy: readFlag(env, 'SEATGRAB_TRUST_PROXY'),
    computerDelayMs: readInteger(env, 'SEATGRAB_COMPUTER_DELAY_MS', 800, 0, 60000),
  };
}
