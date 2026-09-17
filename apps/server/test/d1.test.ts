/**
 * The Cloudflare D1 driver, against a stubbed `fetch`.
 *
 * No other suite reaches this code: the harness runs on the local SQLite driver, because
 * a suite that needed an account, a token and a network would not be a suite anybody
 * runs. So what the driver puts on the wire, and what it does when D1 says no, is
 * asserted here instead.
 *
 * The request shapes below are the ones Cloudflare documents for
 * `POST /accounts/{account}/d1/database/{database}/query`: one `{ sql, params }` for a
 * single statement, and `{ batch: [...] }` for several.
 */
import { describe, expect, it, vi } from 'vitest';

import { D1Error, D1HttpDriver } from '../src/persistence/d1Driver';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that answers each call from `responses` and records what it was sent. */
function stubFetch(responses: readonly { status: number; payload: unknown }[]): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const answer = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as unknown,
    });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => JSON.stringify(answer.payload),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function ok(results: readonly Record<string, unknown>[], changes = 0): unknown {
  return { success: true, result: [{ success: true, results, meta: { changes } }] };
}

function driverWith(fetch: typeof globalThis.fetch, maxAttempts = 3): D1HttpDriver {
  return new D1HttpDriver({
    accountId: 'acct',
    databaseId: 'db-id',
    apiToken: 'secret-token',
    timeoutMs: 1000,
    maxAttempts,
    fetch,
  });
}

describe('the D1 driver', () => {
  it('sends one statement as sql and params, to the documented route', async () => {
    const { fetch, calls } = stubFetch([{ status: 200, payload: ok([{ n: 1 }]) }]);
    const rows = await driverWith(fetch).all('SELECT n FROM t WHERE id = ?', ['abc']);

    expect(rows).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-id/query');
    expect(calls[0]!.headers['authorization']).toBe('Bearer secret-token');
    expect(calls[0]!.body).toEqual({ sql: 'SELECT n FROM t WHERE id = ?', params: ['abc'] });
  });

  it('sends several statements as one batch, each keeping its own parameters', async () => {
    const { fetch, calls } = stubFetch([{
      status: 200,
      payload: {
        success: true,
        result: [
          { success: true, results: [], meta: { changes: 1 } },
          { success: true, results: [], meta: { changes: 2 } },
        ],
      },
    }]);

    const results = await driverWith(fetch).batch([
      { sql: 'INSERT INTO t VALUES (?)', params: ['one'] },
      { sql: 'UPDATE t SET n = ? WHERE id = ?', params: [2, 'two'] },
    ]);

    expect(results).toEqual([{ changes: 1 }, { changes: 2 }]);
    // One round trip, not two: a checkpoint is one call however many statements it is.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      batch: [
        { sql: 'INSERT INTO t VALUES (?)', params: ['one'] },
        { sql: 'UPDATE t SET n = ? WHERE id = ?', params: [2, 'two'] },
      ],
    });
  });

  it('reports the rows changed, which is what the guarded updates test', async () => {
    const { fetch } = stubFetch([{ status: 200, payload: ok([], 1) }]);
    await expect(driverWith(fetch).run('UPDATE seats SET x = 1 WHERE y = ?', ['z']))
      .resolves.toEqual({ changes: 1 });
  });

  it('sends an empty batch nowhere', async () => {
    const { fetch, calls } = stubFetch([{ status: 200, payload: ok([]) }]);
    await expect(driverWith(fetch).batch([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('tries again when D1 is briefly unavailable', async () => {
    const { fetch, calls } = stubFetch([
      { status: 503, payload: { success: false, errors: [{ code: 7502, message: 'overloaded' }] } },
      { status: 200, payload: ok([{ n: 1 }]) },
    ]);
    await expect(driverWith(fetch).all('SELECT 1')).resolves.toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it('does not try again when D1 refuses the statement itself', async () => {
    // A 400 is this server sending something wrong. Sending it again changes nothing,
    // and a checkpoint that retried a bad statement would retry it until it gave up.
    const { fetch, calls } = stubFetch([{
      status: 400,
      payload: { success: false, errors: [{ code: 7500, message: 'no such column: nope' }] },
    }]);
    await expect(driverWith(fetch).all('SELECT nope FROM t')).rejects.toThrow(D1Error);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured number of attempts', async () => {
    const { fetch, calls } = stubFetch([{ status: 500, payload: { success: false, errors: [] } }]);
    await expect(driverWith(fetch, 3).all('SELECT 1')).rejects.toThrow(/status 500/u);
    expect(calls).toHaveLength(3);
  });

  it('names the failure without ever naming the token', async () => {
    const { fetch } = stubFetch([{
      status: 403,
      payload: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    }]);
    const driver = driverWith(fetch);
    const error = await driver.all('SELECT 1').catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(D1Error);
    expect((error as D1Error).message).toContain('Authentication error');
    expect((error as D1Error).message).not.toContain('secret-token');
    // The same goes for the string that reaches the log and the health route.
    expect(driver.describe).toBe('d1 db-id');
    expect(driver.describe).not.toContain('secret-token');
  });

  it('treats a request that never reached D1 as retryable', async () => {
    let attempts = 0;
    const fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNRESET');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(ok([{ n: 7 }])),
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    await expect(driverWith(fetch).all('SELECT 1')).resolves.toEqual([{ n: 7 }]);
    expect(attempts).toBe(2);
  });

  it('abandons an attempt that outlives the timeout', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        setTimeout(resolve, 5000);
        init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      });
      return {} as Response;
    }) as unknown as typeof globalThis.fetch;

    const driver = new D1HttpDriver({
      accountId: 'acct',
      databaseId: 'db-id',
      apiToken: 'secret-token',
      timeoutMs: 20,
      maxAttempts: 1,
      fetch,
    });
    await expect(driver.all('SELECT 1')).rejects.toThrow(/could not be reached/u);
  });
});
