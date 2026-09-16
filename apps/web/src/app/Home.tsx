/**
 * The home screen of section 13.2.
 *
 * It offers the five entry points the section names — start a local match, create a
 * private online room, join a room, resume a save, and read the rules and edition — and
 * it is honest about which of them this build can carry out. Session 15 made the two
 * online ones real in the online build; in the pass-and-play build they stay present and
 * disabled with the reason, rather than absent or pretending to work.
 *
 * The screen is laid out for the person who has never seen the game: one primary action
 * at the top, the rules in one minute beside it, saved matches as cards rather than a
 * table, and the edition facts folded away for whoever wants them.
 *
 * Whether the online entries work is `onlineAvailable`, which the shell reads from the
 * online route module itself rather than from a flag. The module and the flag are set by
 * one decision, but asking the module is asking the thing that is actually true: a build
 * whose online screens were stripped cannot offer them, whatever a constant says.
 *
 * Saved matches are listed from the adapter, which re-checks each save against the
 * versions this build ships. A save written by another content pack is listed, named and
 * deletable, but cannot be resumed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LOCAL_MODE_NOTICE,
  deleteLocalMatch,
  importLocalMatch,
  listLocalMatches,
  type LocalMatchSummary,
  type LocalSnapshotStore,
} from '../local';
import { CORE_CONTENT } from '@seatgrab/engine';

import { HowToPlay } from './HowToPlay';
import { PageFrame } from './PageFrame';
import { PartyMark } from './PartyMark';
import { DECK_SIZES, INSTALLED_CAMPAIGN } from './edition';
import { MAX_SEATS, MIN_SEATS } from './setup';
import { ROUTES, navigate } from './routes';
import { describeError } from './useLocalStore';

const ONLINE_UNAVAILABLE =
  'This is the pass-and-play build. It carries no network code, so a room cannot be created or '
  + 'joined from it. The online build of this same application can, against a room server.';

function savedAtLabel(savedAt: string): string {
  const when = new Date(savedAt);
  return Number.isNaN(when.getTime()) ? savedAt : when.toLocaleString();
}

/** `active · turn 4` in the words a player uses, from the summary the adapter keeps. */
function progressLabel(save: LocalMatchSummary): string {
  const status = save.status === 'active' ? 'In progress' : save.status === 'finished' ? 'Finished' : 'Setting up';
  return `${status} · revision ${save.revision}`;
}

/** A link to a development-only route. Empty in both production builds. */
export interface DevRouteLink {
  href: string;
  label: string;
}

export function Home({
  store,
  storeError,
  devRoutes = [],
  onlineAvailable = false,
}: {
  store: LocalSnapshotStore | null;
  storeError: string | null;
  devRoutes?: readonly DevRouteLink[];
  /** True when this build carries the online screens. False in the pass-and-play build. */
  onlineAvailable?: boolean;
}) {
  const [saves, setSaves] = useState<readonly LocalMatchSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (open: LocalSnapshotStore) => {
    setSaves(await listLocalMatches(open));
  }, []);

  useEffect(() => {
    if (store === null) return;
    let cancelled = false;
    void listLocalMatches(store).then(
      (found) => {
        if (!cancelled) setSaves(found);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(describeError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  const onImport = useCallback(
    async (file: File) => {
      if (store === null) return;
      setFailure(null);
      try {
        const imported = await importLocalMatch({ store, content: CORE_CONTENT }, await file.text());
        await refresh(store);
        setNote(`Imported ${imported.matchId} at revision ${imported.revision()}.`);
      } catch (error) {
        setFailure(describeError(error));
      }
    },
    [refresh, store],
  );

  const busy = store === null && storeError === null;
  const resumable = (saves ?? []).filter((save) => save.unreadableReason === null && save.status !== 'finished');

  return (
    <PageFrame
      title="Play SeatGrab"
      hero
      lede={
        <>
          A political strategy game for {MIN_SEATS} to {MAX_SEATS} players around one device. Answer
          policy questions, win voters, hold majorities.
        </>
      }
    >
      {storeError === null ? null : (
        <p className="alert alert--error" role="alert">
          Saved matches are unavailable in this browser: {storeError} Starting a match is disabled,
          because a match that cannot be saved would be lost at the next reload.
        </p>
      )}
      {failure === null ? null : (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      )}
      {note === null ? null : (
        <p className="alert alert--ok" role="status">
          {note}
        </p>
      )}

      <div className="home-grid">
        <section className="panel panel--commit home-start" aria-labelledby="start-heading">
          <h2 id="start-heading">Start a match</h2>
          <p className="panel__lede">
            Everyone plays on this device and passes it around. Each player’s cards stay behind a
            cover until they reveal them.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button--primary button--large"
              disabled={store === null}
              onClick={() => navigate(ROUTES.lobby)}
            >
              Set up a new local match
            </button>
            {resumable.length === 0 ? null : (
              <button
                type="button"
                className="button button--large"
                onClick={() => navigate(ROUTES.match(resumable[0]!.matchId))}
              >
                Continue {resumable[0]!.matchId}
              </button>
            )}
          </div>
          <p className="small home-start__notice">{LOCAL_MODE_NOTICE}</p>
        </section>

        <section className="panel home-learn" aria-labelledby="learn-heading">
          <h2 id="learn-heading">New here?</h2>
          <p className="panel__lede">
            Every zone on the board needs a set number of voters for a majority. Win majorities
            with your voters; the most majority voters at the end wins.
          </p>
          <HowToPlay />
          <p className="small">
            <a href={ROUTES.rules}>The full rules and the house rules this app applies</a>
          </p>
        </section>
      </div>

      <section className="panel" aria-labelledby="saves-heading">
        <h2 id="saves-heading">Saved matches</h2>
        <p className="panel__lede">
          Saves live in this browser. Each one is checked against the content pack and board this
          build ships before it can be resumed.
        </p>
        {busy ? (
          <p role="status">Opening the local database…</p>
        ) : saves === null || saves.length === 0 ? (
          <p>No saved match in this browser yet.</p>
        ) : (
          <ul className="save-cards">
            {saves.map((save) => (
              <li key={save.matchId} className={`save-card${save.unreadableReason === null ? '' : ' save-card--unreadable'}`}>
                <div className="save-card__head">
                  <h3 className="save-card__title">{save.matchId}</h3>
                  <span className="small">{progressLabel(save)}</span>
                </div>
                <ul className="seat-chips">
                  {save.players.map((player) => (
                    <li key={player.id}>
                      <PartyMark partyId={player.partyId} size={20} />
                      {player.displayName}
                    </li>
                  ))}
                </ul>
                <p className="small">Saved {savedAtLabel(save.savedAt)}</p>
                {save.unreadableReason === null ? null : (
                  <p className="alert alert--error">{save.unreadableReason}</p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={save.unreadableReason !== null}
                    onClick={() => navigate(ROUTES.match(save.matchId))}
                  >
                    {save.status === 'finished' ? 'Open results' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => {
                      setNote(null);
                      setFailure(null);
                      if (store === null) return;
                      if (!window.confirm(`Delete ${save.matchId}? This cannot be undone.`)) return;
                      void deleteLocalMatch(store, save.matchId)
                        .then(() => refresh(store))
                        .then(() => setNote(`Deleted ${save.matchId}.`))
                        .catch((error: unknown) => setFailure(describeError(error)));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <details className="disclosure">
          <summary>Import a save from a file</summary>
          <p className="panel__lede">
            A save exported from another browser can be brought in here. It holds every seat’s
            private data, so only import a file you trust.
          </p>
          <div className="actions">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="file-input"
              aria-label="Save file to import"
              disabled={store === null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined) void onImport(file);
              }}
            />
          </div>
        </details>
      </section>

      <section className="panel" aria-labelledby="online-heading">
        <h2 id="online-heading">Online room</h2>
        <p className="panel__lede">
          {onlineAvailable
            ? 'Every player uses their own device, and the server holds the cards. Nobody is ever '
              + 'sent another seat’s private data, so there is no cover to pass and nothing to '
              + 'look away from.'
            : ONLINE_UNAVAILABLE}
        </p>
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={!onlineAvailable}
            aria-describedby="online-reason"
            onClick={() => navigate(ROUTES.onlineHost)}
          >
            Create a private room
          </button>
          <button
            type="button"
            className="button"
            disabled={!onlineAvailable}
            aria-describedby="online-reason"
            onClick={() => navigate(ROUTES.onlineJoin())}
          >
            Join with a room code
          </button>
        </div>
        <p id="online-reason" className="small">
          {onlineAvailable
            ? 'A room code finds the table and is meant to be shared. The seat credential that '
              + 'plays your seat is issued once, to this browser, and is never shown or shared — '
              + 'which is what stops a shared code handing over a seat somebody already took.'
            : 'Until then, everything below the cover on this device is the whole game: one '
              + 'authoritative state, every seat’s private data on one machine.'}
        </p>
      </section>

      <details className="settings">
        <summary>This set</summary>
        <dl className="facts">
          <div>
            <dt>Set</dt>
            <dd>{INSTALLED_CAMPAIGN.displayName}</dd>
          </div>
          <div>
            <dt>Players</dt>
            <dd>
              {MIN_SEATS}–{MAX_SEATS}
            </dd>
          </div>
          <div>
            <dt>Zones</dt>
            <dd>{DECK_SIZES.zones}</dd>
          </div>
          <div>
            <dt>Voter areas</dt>
            <dd>{DECK_SIZES.slots}</dd>
          </div>
          <div>
            <dt>Policy cards</dt>
            <dd>{DECK_SIZES.policy}</dd>
          </div>
          <div>
            <dt>Breaking News</dt>
            <dd>{DECK_SIZES.news}</dd>
          </div>
          <div>
            <dt>Dirty Tricks</dt>
            <dd>{DECK_SIZES.trick}</dd>
          </div>
          <div>
            <dt>Content</dt>
            <dd>
              {INSTALLED_CAMPAIGN.contentPackId} {INSTALLED_CAMPAIGN.contentVersion}
            </dd>
          </div>
          <div>
            <dt>Board</dt>
            <dd>
              {INSTALLED_CAMPAIGN.boardId} {INSTALLED_CAMPAIGN.boardVersion}
            </dd>
          </div>
        </dl>
        <p>
          <a href={ROUTES.rules}>Read the rules, the house rules and what this build cannot do</a>
        </p>
        {devRoutes.length === 0 ? null : (
          <ul className="seat-chips">
            {devRoutes.map((route) => (
              <li key={route.href}>
                <a href={route.href}>{route.label}</a>
              </li>
            ))}
          </ul>
        )}
      </details>
    </PageFrame>
  );
}
