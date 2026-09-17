/**
 * The routes the application shell understands.
 *
 * A route is an ordinary path, and the shell reads and writes it through the History API,
 * so no address carries a `#`. Every screen stays bookmarkable and reopenable by URL, but
 * a deep link is now the web host's business: a host that answers an unknown path with
 * `404` rather than with `index.html` serves only `/`. `apps/web/nginx.conf` answers it
 * with `try_files`, and the Vite dev server does the same by default.
 */
export const ROUTES = {
  home: '/',
  lobby: '/new',
  /** The lobby, opened on a table of one person and two computers. */
  lobbyComputer: '/new/computer',
  /** The guided tutorial's front door. It starts a local match of its own. */
  tutorial: '/tutorial',
  rules: '/rules',
  match: (matchId: string): string => `/match/${encodeURIComponent(matchId)}`,
  /** The rooms this browser holds a seat in, and the two ways into a new one. */
  online: '/online',
  onlineHost: '/online/new',
  onlineJoin: (roomCode?: string): string =>
    roomCode === undefined || roomCode === ''
      ? '/online/join'
      : `/online/join/${encodeURIComponent(roomCode)}`,
  /**
   * One online room, by match ID rather than by room code.
   *
   * The room code opens a lobby to anyone holding it; this route is the seat this browser
   * already holds, and the credential for it is stored under the match ID. Routing on the
   * match ID also keeps the room code — which is shareable and is read aloud — out of the
   * address bar of a table in progress.
   */
  onlineRoom: (matchId: string): string => `/online/room/${encodeURIComponent(matchId)}`,
} as const;

/**
 * Fired on `window` when this application navigates itself.
 *
 * `pushState` changes the address without telling anyone, and `popstate` covers only the
 * browser's own back and forward. This event is the other half, so the shell has one
 * signal to re-read the address on.
 */
export const ROUTE_CHANGE_EVENT = 'gerrymander:routechange';

/** The route the address bar currently names. */
export function currentRoute(): string {
  return window.location.pathname || '/';
}

/**
 * Replace a legacy `#/…` address with the path it names.
 *
 * Screens were addressed by fragment before this version, and the addresses people
 * bookmarked, shared and linked keep arriving. A browser never sends the fragment to the
 * web host, so no rule on the host can see one, and the two spellings would otherwise
 * both answer for good. The correction replaces the history entry rather than pushing
 * one, so the back button leaves the application instead of returning to the address it
 * just corrected.
 *
 * It reports whether it changed the address. A fragment that names something on the page
 * rather than a route, such as the skip link's `#page-main`, is left alone.
 */
export function redirectLegacyHashRoute(): boolean {
  if (!window.location.hash.startsWith('#/')) return false;
  window.history.replaceState(null, '', window.location.hash.slice(1));
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  return true;
}

/** The match ID in a `/match/<id>` route, or `null` for any other route. */
export function matchIdFromRoute(route: string): string | null {
  const prefix = '/match/';
  if (!route.startsWith(prefix)) return null;
  const id = decodeURIComponent(route.slice(prefix.length));
  return id.length > 0 ? id : null;
}

/** Which screen of the `/online` family a route names, if it names one at all. */
export type OnlineRoute =
  | { kind: 'home' }
  | { kind: 'host' }
  /** `roomCode` is empty when the route carried none, so the form asks for one. */
  | { kind: 'join'; roomCode: string }
  | { kind: 'room'; matchId: string };

/**
 * Read an `/online/...` route, or `null` for any route outside the family.
 *
 * The whole family is parsed in one place so the application shell can ask a single
 * question — is this an online route, and which — and so an unknown `/online/...` path
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

/**
 * Go to a route, without reloading the document.
 *
 * A navigation to the address already showing is dropped rather than pushed, so that the
 * back button doesn't have to walk through a screen's own links to leave it.
 */
export function navigate(path: string): void {
  if (path === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    return;
  }
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}
