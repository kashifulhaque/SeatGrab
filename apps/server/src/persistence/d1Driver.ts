/**
 * The Cloudflare D1 driver, over the HTTP API.
 *
 * The room server runs as an ordinary Node process, so it reaches D1 the way anything
 * outside a Worker does: `POST /accounts/{account}/d1/database/{database}/query`, with
 * either one `{ sql, params }` or a `batch` array of them. Only anonymous `?` binds are
 * accepted, which is what the repository already writes.
 *
 * Every call here is a round trip to D1's primary region, which is why nothing on the
 * hot path calls it. `rooms/matchStore.ts` answers reads from memory and
 * `rooms/checkpoint.ts` batches writes, so a turn costs no network at all and a
 * checkpoint costs one call. Treat a direct call from a request path as a defect.
 *
 * Failures are retried, because a network is not a disk: a request that fails to reach
 * Cloudflare has usually not been applied, and one that times out may have been. Every
 * statement the checkpoint sends is therefore written to be safe to send twice — see
 * the `INSERT OR IGNORE` and the revision guards there — and this driver retries only
 * the failures that are worth retrying.
 */
import type { SqlDriver, SqlResult, SqlRow, SqlStatement, SqlValue } from './driver.js';

export interface D1DriverOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** How long one attempt may take before it is abandoned. */
  timeoutMs: number;
  /** How many times a retryable failure is tried again before it is raised. */
  maxAttempts: number;
  /** Overridden by the tests, which serve a D1-shaped response from a local route. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** What D1 answers. Only the fields this driver reads are named. */
interface D1Response {
  success?: boolean;
  errors?: readonly { code?: number; message?: string }[];
  result?: readonly {
    success?: boolean;
    results?: readonly SqlRow[];
    meta?: { changes?: number; rows_written?: number };
  }[];
}

/** Raised when D1 answers, but answers a failure. Carries what the operator needs. */
export class D1Error extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'D1Error';
    this.status = status;
  }
}

/**
 * Whether a failed attempt is worth another.
 *
 * A 4xx other than 429 is this server sending something wrong, and sending it again
 * changes nothing. A 429, a 5xx and a transport failure are all worth retrying.
 */
function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export class D1HttpDriver implements SqlDriver {
  readonly describe: string;
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: D1DriverOptions) {
    const base = options.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    this.#url = `${base}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
    this.#token = options.apiToken;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts;
    this.#fetch = options.fetch ?? globalThis.fetch;
    // The token is never described. This string reaches the log and the health route.
    this.describe = `d1 ${options.databaseId}`;
  }

  async all(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const [first] = await this.#send([{ sql, params }]);
    return first?.rows ?? [];
  }

  async get(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow | undefined> {
    const rows = await this.all(sql, params);
    return rows[0];
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
    const [first] = await this.#send([{ sql, params }]);
    return { changes: first?.changes ?? 0 };
  }

  async batch(statements: readonly SqlStatement[]): Promise<SqlResult[]> {
    if (statements.length === 0) return [];
    const results = await this.#send(statements);
    return results.map((result) => ({ changes: result.changes }));
  }

  async ping(): Promise<void> {
    await this.all('SELECT 1');
  }

  async close(): Promise<void> {
    // Nothing to close: the driver holds no connection, only a URL and a token.
  }

  /**
   * Send one or more statements, retrying the failures that are worth retrying.
   *
   * A single statement is sent as `{ sql, params }` and several as `{ batch: [...] }`,
   * which is the shape D1 documents for running them together.
   */
  async #send(
    statements: readonly SqlStatement[],
  ): Promise<readonly { rows: SqlRow[]; changes: number }[]> {
    const body = statements.length === 1 && statements[0] !== undefined
      ? JSON.stringify({ sql: statements[0].sql, params: statements[0].params ?? [] })
      : JSON.stringify({
        batch: statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params ?? [],
        })),
      });

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#attempt(body);
      } catch (error) {
        lastError = error;
        const status = error instanceof D1Error ? error.status : 0;
        // A transport failure carries status 0 and is retryable; a refusal is not.
        const worthRetrying = status === 0 || retryable(status);
        if (!worthRetrying || attempt === this.#maxAttempts) throw error;
        // Back off, so a D1 that is briefly busy is not hammered by every match at once.
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  async #attempt(body: string): Promise<readonly { rows: SqlRow[]; changes: number }[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      // No status: the request did not reach D1, or the answer did not come back.
      throw new D1Error(
        `D1 could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: D1Response;
    try {
      payload = JSON.parse(text) as D1Response;
    } catch {
      throw new D1Error(`D1 answered ${response.status} with a body that is not JSON.`, response.status);
    }

    if (!response.ok || payload.success === false) {
      const reported = (payload.errors ?? [])
        .map((error) => `${error.code ?? '?'}: ${error.message ?? 'no message'}`)
        .join('; ');
      throw new D1Error(
        `D1 refused the query with status ${response.status}${reported === '' ? '' : ` (${reported})`}.`,
        response.status,
      );
    }

    return (payload.result ?? []).map((result) => ({
      rows: [...(result.results ?? [])],
      // D1 reports `changes` in its meta; a statement that reports none changed none.
      changes: result.meta?.changes ?? 0,
    }));
  }
}
