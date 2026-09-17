/**
 * The hash routes the application shell understands.
 *
 * Hash routing keeps every screen reachable from a static file, which is what both
 * production builds emit, and lets a saved match be bookmarked and reopened by URL.
 */
export const ROUTES = {
  home: '#/',
  lobby: '#/new',
  /** The lobby, opened on a table of one person and two computers. */
  lobbyComputer: '#/new/computer',
  /** The guided tutorial's front door. It starts a local match of its own. */
  tutorial: '#/tutorial',
  rules: '#/rules',
  match: (matchId: string): string => `#/match/${encodeURIComponent(matchId)}`,
  /** The rooms this browser holds a seat in, and the two ways into a new one. */
  online: '#/online',
  onlineHost: '#/online/new',
  onlineJoin: (roomCode?: string): string =>
    roomCode === undefined || roomCode === ''
      ? '#/online/join'
      : `#/online/join/${encodeURIComponent(roomCode)}`,
  /**
   * One online room, by match ID rather than by room code.
   *
   * The room code opens a lobby to anyone holding it; this route is the seat this browser
   * already holds, and the credential for it is stored under the match ID. Routing on the
   * match ID also keeps the room code — which is shareable and is read aloud — out of the
   * address bar of a table in progress.
   */
  onlineRoom: (matchId: string): string => `#/online/room/${encodeURIComponent(matchId)}`,
} as const;

/** The match ID in a `#/match/<id>` route, or `null` for any other route. */
export function matchIdFromRoute(route: string): string | null {
  const prefix = '/match/';
  if (!route.startsWith(prefix)) return null;
  const id = decodeURIComponent(route.slice(prefix.length));
  return id.length > 0 ? id : null;
}

/** Which screen of the `#/online` family a route names, if it names one at all. */
export type OnlineRoute =
  | { kind: 'home' }
  | { kind: 'host' }
  /** `roomCode` is empty when the route carried none, so the form asks for one. */
  | { kind: 'join'; roomCode: string }
  | { kind: 'room'; matchId: string };

/**
 * Read an `#/online/...` route, or `null` for any route outside the family.
 *
 * The whole family is parsed in one place so the application shell can ask a single
 * question — is this an online route, and which — and so an unknown `#/online/...` path
 * lands on the online home rather than on a blank screen.
 */
export function onlineRouteFrom(route: string): OnlineRoute | null {
  if (route !== '/online' && !route.startsWith('/online/')) return null;
  const rest = route.slice('/online'.length).replace(/^\//, '');
  if (rest === '') return { kind: 'home' };

  const [head = '', ...tail] = rest.split('/');
  const parameter = decodeURIComponent(tail.join('/'));
  if (head === 'new') return { kind: 'host' };
  if (head === 'join') return { kind: 'join', roomCode: parameter };
  if (head === 'room' && parameter.length > 0) return { kind: 'room', matchId: parameter };
  return { kind: 'home' };
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
