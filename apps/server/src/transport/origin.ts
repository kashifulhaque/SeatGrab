/**
 * The WebSocket origin allowlist.
 *
 * Section 14.1 requires the origin of a socket connection to be validated. What that
 * defends against is narrow and worth naming, because the rule is easy to over-read: a
 * page the player did not open, running in the player's browser, opening a socket to
 * this server. It is not a defence against a program written to talk to this server,
 * which can put any origin it likes in the header — that is what the seat credential is
 * for.
 *
 * A request carrying no `Origin` at all is therefore allowed: it did not come from a
 * browser, so there is no origin to judge, and it still has to present a credential
 * before it can do anything. A request carrying one must carry one the operator listed.
 */

/** Whether a connection with this `Origin` header may be upgraded. */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}

/**
 * The `Origin` of a request, or `undefined` when it carried none.
 *
 * A repeated header arrives as an array. Two origins are not one origin, so a request
 * that sends more than one is treated as sending something unusable rather than as
 * sending whichever came first.
 */
export function readOrigin(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (Array.isArray(header)) return header.length === 1 ? header[0] : '';
  return header;
}
