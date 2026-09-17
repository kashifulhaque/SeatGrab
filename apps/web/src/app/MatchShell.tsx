/**
 * The match screen: status bar, shared table, privacy cover, and one seat's own surface.
 *
 * Session 08 built the handoff, session 09 replaced its placeholder panel with the real
 * table, and session 10 gave the private surface controls: the setup prompts, the player
 * mat, and every ordinary action of a turn. The surface now acts as well as reports.
 *
 * Three rules hold here and are worth stating plainly:
 *
 * 1. Private data is drawn only for `revealedSeatId(handoff)`. Passing the device always
 *    lands on the cover first, so no sequence of clicks moves from one seat's cards to
 *    another's. Every composer belongs to one seat, so every composer is behind that. The
 *    status bar draws a seat's resources only for that same seat.
 * 2. A prompt is rendered only from `LocalMatch.viewFor`. When the adapter refuses a
 *    prompt this build cannot describe, the refusal is shown in place of the prompt
 *    rather than a control the player might act on.
 * 3. `match.submit` is the only way a command leaves this screen, and the engine's own
 *    refusal is shown as written. Nothing here rewords a ruling or predicts one.
 *
 * The action being composed lives in this shell rather than inside the composer, because
 * the board underneath has to highlight its legal targets. Keeping the draft here means
 * one state produces both the controls and the ring on the map, so they cannot disagree.
 *
 * The seat's own surface is `SeatSurface`, which session 15 moved next door so the online
 * screen could draw the same one. What stays here is the part the cover owns: *which*
 * seat is drawn, and that nothing private is drawn at all until that seat asks.
 *
 * A fourth rule joined them in session 12: when the projection says the match is
 * finished, no composer is drawn at all. The engine has cleared the interaction stack
 * and `getLegalActions` answers with nothing, so every control a composer could offer
 * would be one the engine refuses. The results screen takes their place, and the seats
 * keep the privacy cover so each can still look over its own kept cards.
 *
 * The order of the page follows how a turn is played rather than how the code is laid
 * out: the status bar first and pinned, then the table with the board in the middle and
 * the revealed seat's actions beside it, and the immutable match settings last, folded
 * into the footer. The first playtest had that order inverted, with the board four
 * screens down.
 *
 * A tutorial match — one whose ID `isTutorialMatchId` recognizes — draws `TutorialCoach`
 * between the status bar and the table. It is the only difference between a tutorial and
 * any other local match: the engine, the content, the computer seats and every control
 * are the same ones, so a rule the coach teaches is a rule the player has just used.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';

import { CORE_CONTENT } from '@gerrymander/engine';
import type { GameCommand, PlayerView } from '@gerrymander/protocol';

import {
  LOCAL_MODE_NOTICE,
  resumeLocalMatch,
  type LocalMatch,
  type LocalSnapshotStore,
} from '../local';

import { PARTY_BY_ID } from '../assets/manifest';

import { INSTALLED_CAMPAIGN } from './edition';
import { PageFrame } from './PageFrame';
import { PartyMark } from './PartyMark';
import { SeatSurface } from './SeatSurface';
import { SeatSwitcher } from './SeatSwitcher';
import { StatusBar } from './StatusBar';
import { TableSurface } from './TableSurface';
import { TutorialCoach } from './TutorialCoach';
import { ROUTES } from './routes';
import { ADVISORY_FILTERS } from './setup';
import {
  SHARED_HANDOFF,
  coveredSeatId,
  handoffReducer,
  initialHandoff,
  revealedSeatId,
} from './handoff';
import {
  COMPUTER_PACES,
  readComputerPace,
  useComputerSeats,
  writeComputerPace,
  type ComputerPace,
} from './useComputerSeats';
import { describeDecision, mustActSeat } from './table';
import { isTutorialMatchId } from './tutorial';
import { describeError } from './useLocalStore';
import {
  NO_DRAFT,
  actionDraftReducer,
  draftTargeting,
  endTurnAvailability,
  promptTargeting,
  voterAt,
  type Availability,
  type Targeting,
} from './actions';
import { LocalRematch, ResultsSurface } from './ResultsSurface';

/**
 * The cover. Nothing private is rendered while this is on screen.
 *
 * It is a full-screen layer at every width, so the device can be handed over with the
 * table out of sight. The table stays in the document behind it — it is public — but the
 * layer takes focus when it opens and gives it back when it closes.
 */
function Cover({
  name,
  partyId,
  onReveal,
  onCancel,
}: {
  name: string;
  partyId: string;
  onReveal: () => void;
  onCancel: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, [name]);
  const party = PARTY_BY_ID.get(partyId);
  return (
    <div className="cover-screen" role="dialog" aria-modal="true" aria-labelledby="cover-heading">
      <section
        className="panel cover"
        style={party === undefined ? undefined : ({ '--party': party.color } as CSSProperties)}
      >
        <p className="cover__eyebrow">Everyone else, look away</p>
        <div className="cover__mark">
          <PartyMark partyId={partyId} size={72} />
        </div>
        <h2 id="cover-heading">Pass the device to {name}</h2>
        <p className="cover__lede">
          {name}’s cards, answers and prompts stay hidden until {name} says so.
        </p>
        <div className="actions">
          <button ref={button} type="button" className="button button--primary button--large" onClick={onReveal}>
            I am {name} — show my cards
          </button>
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Back to the table view
          </button>
        </div>
        <p className="notice">{LOCAL_MODE_NOTICE}</p>
      </section>
    </div>
  );
}

/**
 * How quickly the computer takes its turn, as a menu beside the seat switcher.
 *
 * The pace is a property of this browser rather than of the match: it says how fast the
 * person watching wants to read what happened, and it is stored under
 * `gerrymander.computerPace` so the next match starts the way the last one ended.
 */
function PaceMenu({ pace, onChoose }: { pace: ComputerPace; onChoose: (pace: ComputerPace) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={menu} className="menu">
      <summary className="button button--quiet">Computer pace</summary>
      <ul className="menu__list">
        {COMPUTER_PACES.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              className="button button--quiet"
              aria-pressed={pace === option.id}
              title={option.description}
              onClick={() => {
                if (menu.current !== null) menu.current.open = false;
                onChoose(option.id);
              }}
            >
              {option.label}
              {pace === option.id ? <span className="small"> · in use</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function MatchShell({
  matchId,
  store,
  storeError,
}: {
  matchId: string;
  store: LocalSnapshotStore | null;
  storeError: string | null;
}) {
  const [match, setMatch] = useState<LocalMatch | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [handoff, dispatch] = useReducer(handoffReducer, SHARED_HANDOFF);
  const [draft, dispatchDraft] = useReducer(actionDraftReducer, NO_DRAFT);
  const [rejection, setRejection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, bumpRevision] = useState(0);
  const [pace, setPace] = useState<ComputerPace>(readComputerPace);
  const choosePace = useCallback((next: ComputerPace) => {
    setPace(next);
    writeComputerPace(next);
  }, []);
  // The seat switcher's table-view control, so dismissing the cover puts focus back on a
  // control that can raise it again instead of dropping it on the document body. The
  // cover is the one thing on this screen that behaves like a dialog: it takes focus when
  // it opens, so it owes focus back when it closes.
  const sharedButton = useRef<HTMLButtonElement>(null);
  const returnFocusToShared = useCallback(() => {
    dispatch({ type: 'showShared' });
    sharedButton.current?.focus();
  }, []);

  useEffect(() => {
    if (store === null) return;
    let cancelled = false;
    setMatch(null);
    setFailure(null);
    setMissing(false);
    void resumeLocalMatch({ store, content: CORE_CONTENT }, matchId).then(
      (resumed) => {
        if (cancelled) return;
        if (resumed === null) setMissing(true);
        else setMatch(resumed);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(describeError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [matchId, store]);

  // An action being composed belongs to the seat that opened it, so passing the device
  // puts it away rather than leaving it for whoever picks the device up next.
  const revealedSeat = revealedSeatId(handoff);
  useEffect(() => {
    dispatchDraft({ type: 'close' });
    setRejection(null);
  }, [revealedSeat]);

  // A save written by another tab or by a later command must repaint this screen.
  useEffect(() => {
    if (match === null) return;
    return match.subscribe(() => bumpRevision((tick) => tick + 1));
  }, [match]);

  /**
   * Open the handoff from the match's own view, once the match has loaded.
   *
   * A table with one person opens on that person's seat; every other table opens on the
   * shared projection, which is what `SHARED_HANDOFF` already gave it. `handoffReducer`
   * is untouched: the solo table reaches its seat through the same `passTo` then `reveal`
   * a person would click, batched into one render so no cover is ever drawn.
   */
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (match === null || opened.current === match.matchId) return;
    opened.current = match.matchId;
    const start = initialHandoff(match.viewFor({ kind: 'public' }).view);
    if (start.kind !== 'revealed') return;
    dispatch({ type: 'passTo', seatId: start.seatId });
    dispatch({ type: 'reveal', seatId: start.seatId });
  }, [match]);

  // The computer seats play themselves, through the same `submit` a person's control
  // reaches and behind the same `busy` gate, so only one command is ever in flight.
  const computers = useComputerSeats({ match, revision, pace, busy, setBusy });

  /**
   * Send one command for the seat holding the device.
   *
   * `submit` resolves only after the accepted command is saved, so the screen repaints
   * from a revision that survives a reload. A refused command resolves with the engine's
   * own `CommandFailure`, whose message is written to be read by a player: it is shown
   * unchanged rather than translated into wording invented here.
   */
  const submit = useCallback(
    (playerId: string, command: GameCommand) => {
      if (match === null || busy) return;
      setBusy(true);
      setRejection(null);
      void match.submit(playerId, command).then(
        (response) => {
          setBusy(false);
          if (response.ok) dispatchDraft({ type: 'close' });
          else setRejection(response.message);
        },
        (error: unknown) => {
          setBusy(false);
          setRejection(describeError(error));
        },
      );
    },
    [busy, match],
  );

  const download = useCallback(() => {
    if (match === null) return;
    const blob = new Blob([match.exportDocument()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${match.matchId}.gerrymander-save.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [match]);

  const publicResult = match?.viewFor({ kind: 'public' }) ?? null;
  // A tutorial match differs from any other local match in one thing: the coach.
  const tutorial = isTutorialMatchId(matchId);

  const body = () => {
    if (storeError !== null) {
      return (
        <p className="alert alert--error" role="alert">
          This browser will not open the save database: {storeError}
        </p>
      );
    }
    if (failure !== null) {
      return (
        <p className="alert alert--error" role="alert">
          {failure}
        </p>
      );
    }
    if (missing) {
      return (
        <p className="alert alert--error" role="alert">
          No saved match with the ID <code>{matchId}</code> is stored in this browser.
        </p>
      );
    }
    if (match === null || publicResult === null) return <p role="status">Loading the match…</p>;

    const revealed = revealedSeatId(handoff);
    const covered = coveredSeatId(handoff);
    const seatResult = revealed === null ? null : match.viewFor({ kind: 'player', playerId: revealed });
    const seats = [...publicResult.view.players].sort((left, right) => left.seat - right.seat);
    const coveredSeat = seats.find((seat) => seat.id === covered);
    const finished = publicResult.view.status === 'finished';
    const mustAct = mustActSeat(publicResult.view);
    const thinking = computers.thinkingSeatId === null
      ? null
      : seats.find((seat) => seat.id === computers.thinkingSeatId) ?? null;
    // The revealed seat's public row: everything the bar prints for "you" comes from it,
    // and the bar prints nothing of the kind when no seat is revealed.
    const me = revealed === null ? null : seats.find((seat) => seat.id === revealed) ?? null;

    // The board draws the legal targets of whatever the revealed seat is doing: the
    // action it is composing, or failing that the prompt it is answering. Both sets come
    // from the same derivations the controls use, so a ring on the map and an option in
    // a list are never out of step. Nothing is highlighted on the shared surface.
    const targeting: Targeting | null = revealed === null || seatResult === null
      ? null
      : draftTargeting(seatResult.view, revealed, draft)
        ?? promptTargeting(seatResult.view, revealed);

    // The phone's Act tab carries a dot while the revealed seat has something to do: a
    // decision waiting on it, or an unblocked turn of its own.
    const decision = describeDecision(publicResult.view);
    const attention = revealed !== null && !finished && (
      decision.waitingOn.some((seat) => seat.id === revealed)
      || (decision.waitingOn.length === 0 && publicResult.view.activePlayerId === revealed)
    );

    const endTurn: Availability = revealed === null || seatResult === null
      ? finished
        ? { can: false, reason: 'The match is over.' }
        : {
          can: false,
          reason: mustAct === null
            ? 'No seat is acting yet.'
            : `Pass the device to ${mustAct.displayName} to end the turn.`,
        }
      : endTurnAvailability(seatResult.view, revealed);

    return (
      <>
        <StatusBar
          view={publicResult.view}
          me={me}
          endTurn={{
            ...endTurn,
            busy,
            onEndTurn: () => {
              if (revealed !== null) submit(revealed, { type: 'RequestEndTurn' });
            },
          }}
          thinking={thinking}
          switcher={
            <SeatSwitcher
              seats={seats}
              handoff={handoff}
              mustAct={mustAct}
              dispatch={dispatch}
              sharedButtonRef={sharedButton}
            />
          }
          {...(seats.some((seat) => seat.controller === 'computer')
            ? { settings: <PaceMenu pace={pace} onChoose={choosePace} /> }
            : {})}
        />

        {tutorial && revealed !== null && seatResult !== null ? (
          <TutorialCoach matchId={matchId} view={seatResult.view} seatId={revealed} />
        ) : null}

        {computers.stuck === null ? null : (
          <div className="alert alert--error" role="alert">
            <p>
              {computers.stuck.some((refusal) => refusal.code === 'NO_PROGRESS')
                ? 'This match cannot reach an ending: the board has empty areas no seat can '
                  + 'fill. Export it and report it.'
                : 'The computer could not find a legal move. Export this match and report it.'}
            </p>
            <ul className="small">
              {computers.stuck.map((refusal, index) => (
                <li key={`${refusal.command}-${index}`}>
                  {refusal.command}: {refusal.code} — {refusal.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {finished ? (
          <ResultsSurface
            view={publicResult.view}
            again={<LocalRematch view={publicResult.view} store={store} />}
          />
        ) : null}

        {covered !== null ? (
          <Cover
            name={coveredSeat?.displayName ?? covered}
            partyId={coveredSeat?.partyId ?? ''}
            onReveal={() => dispatch({ type: 'reveal', seatId: covered })}
            onCancel={returnFocusToShared}
          />
        ) : null}

        <TableSurface
          view={publicResult.view}
          targeting={targeting}
          attention={attention}
          {...(mustAct === null || finished || mustAct.controller === 'computer'
            ? {}
            : {
              pass: (
                <button
                  type="button"
                  className="button button--primary button--large"
                  onClick={() => dispatch({ type: 'passTo', seatId: mustAct.id })}
                >
                  <PartyMark partyId={mustAct.partyId} size={22} />
                  Pass the device to {mustAct.displayName}
                </button>
              ),
            })}
          onPickSlot={revealed === null || seatResult === null
            ? undefined
            : (slotId) => dispatchDraft({
              type: 'pick',
              slotId,
              voterId: voterAt(seatResult.view, slotId),
            })}
          {...(revealed !== null && seatResult !== null
            ? {
              aside: (
                <SeatSurface
                  key={revealed}
                  result={seatResult}
                  seatId={revealed}
                  draft={draft}
                  dispatch={dispatchDraft}
                  targeting={targeting}
                  submit={(command) => submit(revealed, command)}
                  busy={busy}
                  failure={rejection}
                  finished={finished}
                />
              ),
            }
            : {})}
        />
      </>
    );
  };

  return (
    <PageFrame
      title={tutorial ? 'Tutorial match' : 'Local match'}
      back={{ href: ROUTES.home, label: 'Home' }}
      wide
      compact
      footer={publicResult === null ? undefined : (
        <MatchSettings view={publicResult.view} matchId={matchId} onExport={download} />
      )}
    >
      {body()}
    </PageFrame>
  );
}

/**
 * The settings frozen into the match when it was created, folded into the footer.
 *
 * Every value comes from `view.setup`, which the projection carries for every viewer.
 * This screen used to read the advisory filters from the authoritative state, which
 * worked only because the local adapter holds that state in the same process. An online
 * client has no `state()`, so the table reads the projection and nothing else.
 */
function MatchSettings({
  view,
  matchId,
  onExport,
}: {
  view: PlayerView;
  matchId: string;
  onExport: () => void;
}) {
  const setup = view.setup;
  return (
    <details className="settings">
      <summary>Match settings</summary>
      <p className="small">
        Fixed when the match was created. A different table needs a new match.
      </p>
      <dl className="facts">
        <div>
          <dt>Match</dt>
          <dd><code>{matchId}</code></dd>
        </div>
        <div>
          <dt>Players</dt>
          <dd>{setup.playerCount}</dd>
        </div>
        <div>
          <dt>Tie policy</dt>
          <dd>{setup.tiePolicy === 'jointWinners' ? 'Joint winners' : setup.tiePolicy}</dd>
        </div>
        <div>
          <dt>Content advisories</dt>
          <dd>
            {setup.contentAdvisories.length === 0
              ? 'no cards removed'
              : setup.contentAdvisories
                .map((advisory) =>
                  ADVISORY_FILTERS.find((filter) => filter.advisory === advisory)?.label ?? advisory)
                .join(' · ')}
          </dd>
        </div>
        <div>
          <dt>Edition</dt>
          <dd>{INSTALLED_CAMPAIGN.displayName}</dd>
        </div>
        <div>
          <dt>Content pack</dt>
          <dd>
            {setup.contentPackId} {setup.contentVersion}
          </dd>
        </div>
        <div>
          <dt>Board</dt>
          <dd>
            {setup.boardId} {setup.boardVersion}
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>
            {setup.engineVersion} · schema {setup.schemaVersion}
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{view.revision}</dd>
        </div>
      </dl>
      <div className="actions">
        <button type="button" className="button" onClick={onExport}>
          Export this match to a file
        </button>
        <span className="hint">
          The file holds every seat’s private data. Treat it the way you would treat the table with
          all the cards face up.
        </span>
      </div>
    </details>
  );
}
