/**
 * The title screen of section 13.2.
 *
 * It offers the entry points the section names — learn the game in the guided tutorial,
 * start a local match, create a private online room, join a room, resume a save, and read
 * the rules and edition — and it is honest about which of them this build can carry out.
 * Session 15 made the two online ones real in the online build; in the pass-and-play build
 * they stay present and disabled with the reason, rather than absent or pretending to work.
 *
 * It is laid out as a game's title screen rather than as a document: the wordmark and the
 * one or two things a player came here to press sit in the middle of the screen, and
 * everything else — the rules, saved matches, the online room, the edition facts — is a
 * tile under them that opens its own drawer in place. Only one drawer is open at a time,
 * so the screen never becomes the stack of panels it used to be.
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
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import {
  LOCAL_MODE_NOTICE,
  deleteLocalMatch,
  importLocalMatch,
  listLocalMatches,
  type LocalMatchSummary,
  type LocalSnapshotStore,
} from '../local';
import { CORE_CONTENT } from '@gerrymander/engine';

import { Glyph, type GlyphName } from './Glyph';
import { PartyMark } from './PartyMark';
import { DECK_SIZES, INSTALLED_CAMPAIGN } from './edition';
import { MAX_SEATS, MIN_SEATS } from './setup';
import { ROUTES, navigate } from './routes';
import { marksComputer } from './table';
import { describeError } from './useLocalStore';

const ONLINE_UNAVAILABLE =
  'This is the pass-and-play build. It carries no network code, so a room cannot be created or '
  + 'joined from it. The online build of this same application can, against a room server.';

/** Which tile's drawer is open. Only one is, so the title screen stays one screen. */
type Drawer = 'saves' | 'online' | 'set' | null;

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

/**
 * One tile under the main calls to action.
 *
 * A tile that opens a drawer is a button reporting `aria-expanded`; a tile that leaves
 * the screen is a link. Both are drawn the same, because to a player they are the same
 * row of choices.
 */
function MenuTile({
  glyph,
  label,
  note,
  badge,
  href,
  open,
  onClick,
}: {
  glyph: GlyphName;
  label: string;
  note: string;
  /** A count drawn beside the label, such as how many saves this browser holds. */
  badge?: string | undefined;
  href?: string | undefined;
  open?: boolean | undefined;
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="tile__icon">
        <Glyph name={glyph} size={26} />
      </span>
      <span className="tile__label">
        {label}
        {badge === undefined ? null : <span className="tile__badge">{badge}</span>}
      </span>
      <span className="tile__note">{note}</span>
    </>
  );
  const classes = `tile${open === true ? ' tile--open' : ''}`;
  return href === undefined ? (
    <button type="button" className={classes} aria-expanded={open} onClick={onClick}>
      {body}
    </button>
  ) : (
    <a className={classes} href={href}>
      {body}
    </a>
  );
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
  const [drawer, setDrawer] = useState<Drawer>(null);
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

  /** Open the tile's drawer, or close it if it is the one already open. */
  const toggle = useCallback((which: Exclude<Drawer, null>) => {
    setDrawer((current) => (current === which ? null : which));
  }, []);

  const skip = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById('page-main')?.focus();
  }, []);

  const busy = store === null && storeError === null;
  const resumable = useMemo(
    () => (saves ?? []).filter((save) => save.unreadableReason === null && save.status !== 'finished'),
    [saves],
  );
  const latest = resumable[0];
  const saveCount = saves === null ? '' : String(saves.length);

  return (
    <div className="title-screen">
      <div className="title-screen__field" aria-hidden="true" />
      <a className="skip-link" href="#page-main" onClick={skip}>
        Skip to the main content
      </a>
      <main className="title-screen__main" id="page-main" tabIndex={-1}>
        <header className="title-card">
          <p className="title-card__eyebrow">{INSTALLED_CAMPAIGN.displayName}</p>
          <h1 className="title-card__name">
            <span>Gerry</span>
            <span className="title-card__name-b">mander</span>
          </h1>
          <p className="title-card__tagline">
            Answer policy questions. Win voters. Hold majorities.
          </p>
          <ul className="title-card__facts">
            <li>
              {MIN_SEATS}–{MAX_SEATS} players
            </li>
            <li>{DECK_SIZES.zones} zones</li>
            <li>one device</li>
          </ul>
        </header>

        {storeError === null ? null : (
          <p className="alert alert--error" role="alert">
            Saved matches are unavailable in this browser: {storeError} Starting a match is
            disabled, because a match that cannot be saved would be lost at the next reload.
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

        <div className="title-cta">
          {latest === undefined ? null : (
            <button
              type="button"
              className="cta cta--resume"
              onClick={() => navigate(ROUTES.match(latest.matchId))}
            >
              <Glyph name="resume" size={30} />
              <span className="cta__text">
                <span className="cta__label">Continue</span>
                <span className="cta__sub">
                  {latest.matchId} · {progressLabel(latest).toLowerCase()}
                </span>
              </span>
            </button>
          )}
          <button
            type="button"
            className={`cta${saves !== null && saves.length === 0 ? ' cta--primary' : ''}`}
            disabled={store === null}
            onClick={() => navigate(ROUTES.tutorial)}
          >
            <Glyph name="book" size={30} />
            <span className="cta__text">
              <span className="cta__label">Learn to play</span>
              <span className="cta__sub">
                A guided first match against the computer, with the rules explained as they come up
              </span>
            </span>
          </button>
          <button
            type="button"
            className="cta cta--primary"
            disabled={store === null}
            onClick={() => navigate(ROUTES.lobby)}
          >
            <Glyph name="play" size={30} />
            <span className="cta__text">
              <span className="cta__label">{latest === undefined ? 'Play' : 'New match'}</span>
              <span className="cta__sub">Pass and play on this device</span>
            </span>
          </button>
          <button
            type="button"
            className="cta cta--primary"
            disabled={store === null}
            onClick={() => navigate(ROUTES.lobbyComputer)}
          >
            <Glyph name="play" size={30} />
            <span className="cta__text">
              <span className="cta__label">Play against the computer</span>
              <span className="cta__sub">
                You take one seat. The computer takes the rest. No cover, no passing the device.
              </span>
            </span>
          </button>
        </div>

        <nav className="title-menu" aria-label="More">
          <MenuTile glyph="book" label="How to play" note="Rules and house rules" href={ROUTES.rules} />
          <MenuTile
            glyph="archive"
            label="Saved matches"
            note={busy ? 'Opening the database…' : 'Resume, import or delete'}
            badge={saveCount === '' || saveCount === '0' ? undefined : saveCount}
            open={drawer === 'saves'}
            onClick={() => toggle('saves')}
          />
          <MenuTile
            glyph="globe"
            label="Online room"
            note={onlineAvailable ? 'Play on separate devices' : 'Not in this build'}
            open={drawer === 'online'}
            onClick={() => toggle('online')}
          />
          <MenuTile
            glyph="gear"
            label="This set"
            note="Decks, board and versions"
            open={drawer === 'set'}
            onClick={() => toggle('set')}
          />
        </nav>

        {drawer !== 'saves' ? null : (
          <section className="drawer-panel" aria-labelledby="saves-heading">
            <h2 id="saves-heading">Saved matches</h2>
            <p className="panel__lede">
              Saves live in this browser. Each one is checked against the content pack and board
              this build ships before it can be resumed.
            </p>
            {busy ? (
              <p role="status">Opening the local database…</p>
            ) : saves === null || saves.length === 0 ? (
              <p>No saved match in this browser yet.</p>
            ) : (
              <ul className="save-cards">
                {saves.map((save) => (
                  <li
                    key={save.matchId}
                    className={`save-card${save.unreadableReason === null ? '' : ' save-card--unreadable'}`}
                  >
                    <div className="save-card__head">
                      <h3 className="save-card__title">{save.matchId}</h3>
                      <span className="small">{progressLabel(save)}</span>
                    </div>
                    <ul className="seat-chips">
                      {save.players.map((player) => (
                        <li key={player.id}>
                          <PartyMark partyId={player.partyId} size={20} />
                          {player.displayName}
                          {marksComputer(player)
                            ? <span className="small"> · computer</span>
                            : null}
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
        )}

        {drawer !== 'online' ? null : (
          <section className="drawer-panel" aria-labelledby="online-heading">
            <h2 id="online-heading">Online room</h2>
            <p className="panel__lede">
              {onlineAvailable
                ? 'Every player uses their own device, and the server holds the cards. Nobody is '
                  + 'ever sent another seat’s private data, so there is no cover to pass and '
                  + 'nothing to look away from.'
                : ONLINE_UNAVAILABLE}
            </p>
            <div className="cta-row">
              <button
                type="button"
                className="cta cta--small"
                disabled={!onlineAvailable}
                aria-describedby="online-reason"
                onClick={() => navigate(ROUTES.onlineHost)}
              >
                <Glyph name="host" size={26} />
                <span className="cta__text">
                  <span className="cta__label">Create a room</span>
                  <span className="cta__sub">You host and share the code</span>
                </span>
              </button>
              <button
                type="button"
                className="cta cta--small"
                disabled={!onlineAvailable}
                aria-describedby="online-reason"
                onClick={() => navigate(ROUTES.onlineJoin())}
              >
                <Glyph name="join" size={26} />
                <span className="cta__text">
                  <span className="cta__label">Join a room</span>
                  <span className="cta__sub">You have a room code</span>
                </span>
              </button>
            </div>
            <p id="online-reason" className="small">
              {onlineAvailable
                ? 'A room code finds the table and is meant to be shared. The seat credential that '
                  + 'plays your seat is issued once, to this browser, and is never shown or '
                  + 'shared — which is what stops a shared code handing over a seat somebody '
                  + 'already took.'
                : 'Until then, everything below the cover on this device is the whole game: one '
                  + 'authoritative state, every seat’s private data on one machine.'}
            </p>
          </section>
        )}

        {drawer !== 'set' ? null : (
          <section className="drawer-panel" aria-labelledby="set-heading">
            <h2 id="set-heading">This set</h2>
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
            <p className="small">{LOCAL_MODE_NOTICE}</p>
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
          </section>
        )}
      </main>

      <footer className="title-screen__foot">
        <span>
          content {INSTALLED_CAMPAIGN.contentPackId} {INSTALLED_CAMPAIGN.contentVersion} · board{' '}
          {INSTALLED_CAMPAIGN.boardId} {INSTALLED_CAMPAIGN.boardVersion}
        </span>
        <a href={ROUTES.rules}>Rules and house rules</a>
      </footer>
    </div>
  );
}
