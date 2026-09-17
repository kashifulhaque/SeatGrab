/**
 * The application shell.
 *
 * Production routes: the home screen, the lobby, the tutorial, the rules and edition page,
 * a local match, and the `/online` family. The development-only route resolves to `null` in
 * both production builds, which `scripts/check_build_privacy.mjs` asserts from the emitted
 * files; the online family resolves to `null` in the pass-and-play build for the same
 * reason and by the same mechanism, so that build contains no network code to reach.
 */
import { useEffect, useState } from 'react';

import OnlineRoutes from 'virtual:gerrymander-online';
import TransportCheck from 'virtual:gerrymander-transport-check';

import { Home } from './app/Home';
import { Lobby } from './app/Lobby';
import { MatchShell } from './app/MatchShell';
import { RulesInfo } from './app/RulesInfo';
import { TutorialStart } from './app/TutorialStart';
import type { DevRouteLink } from './app/Home';
import {
  ROUTE_CHANGE_EVENT, currentRoute, matchIdFromRoute, navigate, onlineRouteFrom,
  redirectLegacyHashRoute,
} from './app/routes';
import { useLocalStore } from './app/useLocalStore';

/**
 * The route the address bar names, re-read on the browser's own history moves and on the
 * navigations this application makes itself.
 *
 * `hashchange` is here for a legacy `#/…` address followed while the application is
 * already open, which changes the address without loading the document again.
 */
function useRoute(): string {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = () => {
      redirectLegacyHashRoute();
      setRoute(currentRoute());
    };
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    window.addEventListener(ROUTE_CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener(ROUTE_CHANGE_EVENT, onChange);
    };
  }, []);
  return route;
}

/**
 * Route a click on a link of this application's own rather than reloading the document.
 *
 * Every screen links with a plain `<a href>`, which is what gives each one a real address
 * to bookmark, share and open in a new tab. A path, unlike the hash these routes used to
 * be, makes the browser fetch the document again, so the shell catches the plain left
 * click and turns it into a history move instead. Anything the browser should still
 * handle itself — a modified click, another tab, a download, another origin, or a
 * fragment on the screen already showing, such as the skip link — falls through.
 */
function useLinkRouting(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (target === null) return;
      if (target.target !== '' && target.target !== '_self') return;
      if (target.hasAttribute('download')) return;
      if (target.origin !== window.location.origin) return;
      if (target.hash !== '' && target.pathname === window.location.pathname) return;
      event.preventDefault();
      navigate(`${target.pathname}${target.search}${target.hash}`);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

export function App() {
  const route = useRoute();
  const { store, error } = useLocalStore();
  useLinkRouting();

  if (route === '/transport' && TransportCheck) return <TransportCheck />;
  if (route === '/rules') return <RulesInfo />;
  if (route === '/tutorial') return <TutorialStart store={store} storeError={error} />;
  if (route === '/new') return <Lobby store={store} storeError={error} />;
  // The same lobby, opened on a table the person shares with the computer. Keyed so
  // moving between the two addresses re-seeds the draft rather than keeping the old one.
  if (route === '/new/computer') {
    return <Lobby key="computer" store={store} storeError={error} againstComputer />;
  }

  // The whole online family resolves to `null` in the pass-and-play build, so an
  // `/online/...` address there falls through to the home screen, which says why.
  const online = onlineRouteFrom(route);
  if (online !== null && OnlineRoutes) return <OnlineRoutes route={online} />;

  const matchId = matchIdFromRoute(route);
  // Keyed by match, so moving from one saved match to another starts from the shared
  // surface with nothing composed. Without the key the shell is reused and the seat that
  // was revealed in the previous match stays revealed in the next one.
  if (matchId !== null) {
    return <MatchShell key={matchId} matchId={matchId} store={store} storeError={error} />;
  }

  const devRoutes: DevRouteLink[] = [
    ...(TransportCheck ? [{ href: '/transport', label: 'Transport check (development)' }] : []),
  ];
  return (
    <Home
      store={store}
      storeError={error}
      devRoutes={devRoutes}
      onlineAvailable={OnlineRoutes !== null}
    />
  );
}
