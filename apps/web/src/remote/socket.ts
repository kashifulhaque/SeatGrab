/**
 * The browser's end of the room server's WebSocket, and nothing above it.
 *
 * This module owns one thing: a connection that keeps coming back. It opens a socket,
 * authenticates it, reports what state it is in, retries with a backoff when it drops,
 * and stops retrying when the server says the credential will never work. It reads no
 * frame's meaning — `remoteMatch.ts` does that — so the reconnection logic can be tested
 * on its own, without a projection anywhere near it.
 *
 * The WebSocket itself arrives through a factory rather than being constructed here, so
 * the whole of this file runs in a plain unit test against a socket that is a few lines
 * of bookkeeping. The default factory is the browser's own `WebSocket`.
 */
import type { ClientFrame, ServerFrame } from '@gerrymander/protocol';
import { PERMANENT_SOCKET_ERRORS, SOCKET_CLOSE, SOCKET_PATH } from '@gerrymander/protocol';

/** What the connection tells a socket to tell it. */
export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number, reason: string) => void;
  /** A transport-level failure. A close always follows, so this only records why. */
  onError: (message: string) => void;
}

/** The half of a WebSocket this client uses. */
export interface RemoteSocket {
  send: (data: string) => void;
  close: () => void;
}

export type RemoteSocketFactory = (url: string, handlers: SocketHandlers) => RemoteSocket;

/** Cancels a scheduled callback. */
export type CancelTimer = () => void;
export type Scheduler = (callback: () => void, delayMs: number) => CancelTimer;

/**
 * What a screen shows about the connection, as section 14.4 requires it to be
 * distinguishable.
 *
 * `connecting` is the first attempt and `reconnecting` is every attempt after a
 * connection has been lost; they are the same work, and they are separate states because
 * "we have not reached the table yet" and "we were at the table and are getting back"
 * are different things to tell a player mid-turn.
 *
 * `rejected` is terminal on purpose. The server has said this credential does not hold
 * this seat, and retrying says nothing new: a player has to come back with the right
 * credential or a new seat.
 */
export type ConnectionStatus =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'synchronized'; since: number }
  | { kind: 'reconnecting'; attempt: number; retryInMs: number; reason: string }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'rejected'; code: string; message: string };

export interface RemoteConnectionOptions {
  /** Base URL of the room server, or `''` for the page's own origin. */
  serverUrl?: string;
  matchId: string;
  /** The seat credential. Held here only to re-present it on a reconnection. */
  credential: string;
  /** Called for every frame the server sends, in arrival order. */
  onFrame: (frame: ServerFrame) => void;
  /** Called whenever the status changes. */
  onStatus: (status: ConnectionStatus) => void;
  /** The cursor to catch up from. Read fresh on each attempt. */
  cursor: () => number;
  socketFactory?: RemoteSocketFactory;
  schedule?: Scheduler;
  now?: () => number;
  /** Retry delays in milliseconds, in order. The last is repeated. */
  backoffMs?: readonly number[];
}

/** Doubling from a quarter second to half a minute. The last delay repeats forever. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 5000, 10_000, 30_000];

/**
 * The socket URL for a server base.
 *
 * `http` becomes `ws` and `https` becomes `wss`, so a page served over TLS never
 * silently opens a cleartext socket. An empty base means the page's own origin, which is
 * what the Vite dev server's `/ws` proxy and a single-origin deployment both want.
 */
export function socketUrl(serverUrl: string, origin: string): string {
  const base = serverUrl === '' ? origin : serverUrl;
  const url = new URL(SOCKET_PATH, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.toString();
}

function defaultSocketFactory(url: string, handlers: SocketHandlers): RemoteSocket {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event) => {
    handlers.onMessage(typeof event.data === 'string' ? event.data : '');
  });
  socket.addEventListener('close', (event) => handlers.onClose(event.code, event.reason));
  // A browser deliberately says nothing about why a socket failed, so there is nothing
  // to report but that it did. The close that follows carries the code.
  socket.addEventListener('error', () => handlers.onError('The connection failed.'));
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
}

const defaultScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * A connection to one seat of one match, which reopens itself.
 *
 * Nothing here holds game state. The caller decides what to do with a frame, and gives
 * back a cursor so each attempt asks for the right catch-up.
 */
export class RemoteConnection {
  readonly #matchId: string;
  readonly #credential: string;
  readonly #serverUrl: string;
  readonly #onFrame: (frame: ServerFrame) => void;
  readonly #onStatus: (status: ConnectionStatus) => void;
  readonly #cursor: () => number;
  readonly #socketFactory: RemoteSocketFactory;
  readonly #schedule: Scheduler;
  readonly #now: () => number;
  readonly #backoffMs: readonly number[];

  #socket: RemoteSocket | null = null;
  #cancelRetry: CancelTimer | null = null;
  #status: ConnectionStatus = { kind: 'connecting', attempt: 1 };
  /** Attempts made since the last successful welcome. Reported, not used for timing. */
  #attempt = 0;
  /** Connections lost since the last successful welcome. This picks the delay. */
  #failures = 0;
  #stopped = false;
  /** Set once a connection has been authenticated, so a later drop is a *re*connection. */
  #everSynchronized = false;

  constructor(options: RemoteConnectionOptions) {
    this.#matchId = options.matchId;
    this.#credential = options.credential;
    this.#serverUrl = options.serverUrl ?? '';
    this.#onFrame = options.onFrame;
    this.#onStatus = options.onStatus;
    this.#cursor = options.cursor;
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#schedule = options.schedule ?? defaultScheduler;
    this.#now = options.now ?? (() => Date.now());
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  status(): ConnectionStatus {
    return this.#status;
  }

  /** True while a socket is open and authenticated. */
  get live(): boolean {
    return this.#status.kind === 'synchronized' && this.#socket !== null;
  }

  /** Open the connection. Calling it again while open does nothing. */
  open(): void {
    if (this.#stopped || this.#socket !== null) return;
    this.#attempt += 1;
    this.#setStatus(
      this.#everSynchronized
        ? { kind: 'reconnecting', attempt: this.#attempt, retryInMs: 0, reason: 'Reopening the connection.' }
        : { kind: 'connecting', attempt: this.#attempt },
    );

    const url = socketUrl(
      this.#serverUrl,
      typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    );
    let lastError: string | null = null;
    this.#socket = this.#socketFactory(url, {
      onOpen: () => {
        this.send({
          type: 'authenticate',
          matchId: this.#matchId,
          credential: this.#credential,
          sinceEventCursor: this.#cursor(),
        });
      },
      onMessage: (data) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(data) as ServerFrame;
        } catch {
          // A frame this client cannot even parse is the server's problem, not a reason
          // to tear down a working connection; the next one is very likely fine.
          return;
        }
        if (frame.type === 'welcome') {
          this.#everSynchronized = true;
          this.#attempt = 0;
          this.#failures = 0;
          this.#setStatus({ kind: 'synchronized', since: this.#now() });
        }
        if (frame.type === 'error' && PERMANENT_SOCKET_ERRORS.includes(frame.code)) {
          this.#reject(frame.code, frame.message);
        }
        this.#onFrame(frame);
      },
      onError: (message) => {
        lastError = message;
      },
      onClose: (code, reason) => {
        this.#socket = null;
        if (this.#stopped || this.#status.kind === 'rejected') return;
        this.#retry(
          code === SOCKET_CLOSE.unauthorized
            ? 'The server closed this connection as unauthorized.'
            : lastError ?? (reason === '' ? `The connection closed (${code}).` : reason),
        );
      },
    });
  }

  /** Send one frame, if there is a socket to send it on. Returns whether it went. */
  send(frame: ClientFrame): boolean {
    const socket = this.#socket;
    if (socket === null) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Close for good. No retry follows, and the status says so. */
  close(reason = 'This client closed the connection.'): void {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#socket?.close();
    this.#socket = null;
    if (this.#status.kind !== 'rejected') this.#setStatus({ kind: 'disconnected', reason });
  }

  #reject(code: string, message: string): void {
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#stopped = true;
    this.#setStatus({ kind: 'rejected', code, message });
    this.#socket?.close();
    this.#socket = null;
  }

  #retry(reason: string): void {
    const delays = this.#backoffMs;
    // The delay is chosen by how many connections have been lost since the last
    // welcome, not by how many have been opened: the first loss waits the first delay,
    // and a connection that reaches the table resets the sequence.
    const index = Math.min(this.#failures, delays.length - 1);
    const retryInMs = delays[index] ?? 1000;
    this.#failures += 1;
    this.#setStatus({ kind: 'reconnecting', attempt: this.#attempt, retryInMs, reason });
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = null;
      this.open();
    }, retryInMs);
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#onStatus(status);
  }
}
