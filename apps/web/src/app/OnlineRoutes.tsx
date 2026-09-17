/**
 * The whole `/online` family, behind one module.
 *
 * This is the only file the rest of the application imports the online screens through,
 * and that is deliberate: `vite.config.ts` resolves it to `export default null` in the
 * pass-and-play build, so neither these screens nor `src/remote/` — the socket, the room
 * client, the seat store — reaches that bundle at all. The home screen says the local
 * build carries no network code, and this is what makes the claim true rather than a
 * description of intent.
 *
 * The seat store is opened once here and handed down, the same way `useLocalStore` opens
 * the save database once for the local screens. It is a secret store, so nothing below
 * opens a second one and nothing caches what it holds.
 */
import { useCallback, useMemo, useState } from 'react';

import { openSeatStore } from '../remote';

import { OnlineHome } from './OnlineHome';
import { OnlineHost } from './OnlineHost';
import { OnlineJoin } from './OnlineJoin';
import { OnlineRoom } from './OnlineRoom';
import type { OnlineRoute } from './routes';

export default function OnlineRoutes({ route }: { route: OnlineRoute }) {
  const seats = useMemo(() => openSeatStore(), []);
  // The store is not reactive — it is one storage key — so a screen that changes it says
  // so, and this repaints. It is one counter rather than a copy of the store's contents,
  // because a copy of a credential in React state is a copy of a credential.
  const [, repaint] = useState(0);
  const onChange = useCallback(() => repaint((tick) => tick + 1), []);

  switch (route.kind) {
    case 'host':
      return <OnlineHost seats={seats} />;
    case 'join':
      return <OnlineJoin seats={seats} roomCode={route.roomCode} />;
    case 'room':
      return <OnlineRoom seats={seats} matchId={route.matchId} />;
    case 'home':
    default:
      return <OnlineHome seats={seats} onChange={onChange} />;
  }
}
