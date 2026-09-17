/**
 * The application shell.
 *
 * Production routes: the home screen, the lobby, the tutorial, the rules and edition page,
 * a local match, and the `#/online` family. The development-only route resolves to `null` in
 * both production builds, which `scripts/check_build_privacy.mjs` asserts from the emitted
 * files; the online family resolves to `null` in the pass-and-play build for the same
 * reason and by the same mechanism, so that build contains no network code to reach.
 */
import { useEffect, useState } from 'react';

import OnlineRoutes from 'virtual:seatgrab-online';
import TransportCheck from 'virtual:seatgrab-transport-check';

import { Home } from './app/Home';
import { Lobby } from './app/Lobby';
import { MatchShell } from './app/MatchShell';
import { RulesInfo } from './app/RulesInfo';
import { TutorialStart } from './app/TutorialStart';
import type { DevRouteLink } from './app/Home';
import { matchIdFromRoute, onlineRouteFrom } from './app/routes';
import { useLocalStore } from './app/useLocalStore';

function currentRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

function useHashRoute(): string {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const { store, error } = useLocalStore();

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
  // `#/online/...` address there falls through to the home screen, which says why.
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
    ...(TransportCheck ? [{ href: '#/transport', label: 'Transport check (development)' }] : []),
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
