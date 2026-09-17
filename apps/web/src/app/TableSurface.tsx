/**
 * The match screen's layout: the bar, the board, the seats and the action sheet, on one
 * screen.
 *
 * The first design put the board, the actions, the seats and the log in four panels and,
 * on a phone, behind four tabs. The owner's verdict was that the board and the cards had
 * "significant disconnect" and that nobody but the developer could follow it. So this
 * component lays the four out as one surface instead:
 *
 * - the slim status bar, pinned;
 * - the board, fitted to the width, with the seats as a strip of chips against it;
 * - the action sheet, pinned to the bottom of a phone or docked beside the board on a
 *   wider screen, carrying what to do now and the controls that do it;
 * - and a menu drawer for everything that is not needed every turn: the log, the cards
 *   in play, the rules, the mode's own controls and the frozen settings.
 *
 * Which of the three arrangements is used comes from `useViewport`: a phone gets the
 * sheet, a tablet gets the board beside a docked panel with the strip above, a desktop
 * gets three columns with the strip on the left. Every region is in the document at every
 * width, so a render test finds the same controls whatever the layout.
 *
 * Nothing private is drawn here. The revealed seat's own surface arrives already built,
 * as `seat`, and this file never knows a seat: the privacy cover in `MatchShell` owns
 * which seat that is, and online there is only ever one.
 *
 * One thing crosses between the shared board and a seat's own sheet: while the seat is
 * composing an action, its legal areas are ringed on the board and tapping one feeds the
 * choice back through `onPickSlot`. The set arrives already computed; this file neither
 * derives it nor decides what choosing one means.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PlayerView, PublicPlayerView, VisibleEvent } from '@gerrymander/protocol';

import { PARTY_BY_ID } from '../assets/manifest';

import { StatusBar } from './StatusBar';
import type { Availability, Targeting } from './actions';
import { ActionSheet } from './match/ActionSheet';
import { BoardRegion } from './match/BoardRegion';
import { MatchMenuButton, MatchMenuDrawer, type MatchMenuItems } from './match/MatchMenu';
import { SeatsStrip } from './match/SeatsStrip';
import { Market } from './Market';
import { describeDecision, mustActSeat, summarizePlayers, summarizeZones } from './table';
import { useViewport } from './useViewport';

import './match/match.css';

/** The revealed seat's own sheet, built by `seatSheet` in `SeatSurface.tsx`. */
export interface SeatSheet {
  seatId: string;
  /** The one line: what to do now. */
  news: string;
  /** Voter tokens waiting to be placed, or nothing. */
  tray?: ReactNode;
  /** The sheet body: the prompt, the open action, the market and the seat's drawers. */
  body: ReactNode;
  /** A name for what the body is about; a change opens a collapsed sheet. */
  subject: string;
}

/**
 * The sheet body when no seat is revealed: the market to read, and what the table is
 * waiting on. The pass control, when the mode has one, is in the sheet header.
 */
function PublicBody({ view }: { view: PlayerView }) {
  const decision = describeDecision(view);
  return (
    <div className="ms-public">
      <p className="ms-public__detail">{decision.detail}</p>
      <h3 className="ms-seat__label">Voter market</h3>
      <p className="small">Face up for everyone. The seat acting may buy any of them.</p>
      <div data-coach-anchor="market">
        <Market view={view} />
      </div>
    </div>
  );
}

function EventCue({ view }: { view: PlayerView }) {
  const latest = view.history[view.history.length - 1];
  const baseline = useRef({
    matchId: view.matchId,
    eventId: latest?.id,
    status: view.status,
  });
  const [cue, setCue] = useState<{ event: VisibleEvent; kind: string; label: string } | null>(null);

  useEffect(() => {
    if (baseline.current.matchId !== view.matchId) {
      baseline.current = { matchId: view.matchId, eventId: latest?.id, status: view.status };
      setCue(null);
      return;
    }
    const finishedNow = baseline.current.status !== 'finished' && view.status === 'finished';
    baseline.current.status = view.status;
    if (latest === undefined || (baseline.current.eventId === latest.id && !finishedNow)) return;
    baseline.current.eventId = latest.id;
    const kind = finishedNow
      ? 'result'
      : /News/i.test(latest.type)
        ? 'news'
        : /Trick|Priority/i.test(latest.type)
          ? 'trick'
          : /Trade|Debt|Obligation/i.test(latest.type)
            ? 'trade'
            : /Auction|Bid/i.test(latest.type)
              ? 'auction'
              : /Gerrymander|Arbitrage|Shakedown|Demolition|Crackdown|Outreach|Turncoat/i.test(latest.type)
                ? 'power'
                : 'table';
    const label = kind === 'result'
      ? 'Final result'
      : kind === 'news'
        ? 'Breaking News'
        : kind === 'trick'
          ? 'Dirty Trick'
          : kind === 'trade'
            ? 'Trade'
            : kind === 'auction'
              ? 'Auction'
              : kind === 'power'
                ? 'Power'
                : 'Table update';
    setCue({ event: latest, kind, label });
    const timer = setTimeout(() => setCue(null), kind === 'result' ? 5000 : 2400);
    return () => clearTimeout(timer);
  }, [latest?.id, view.matchId, view.status]);

  if (cue === null) return null;
  return (
    <div key={cue.event.id} className={`ms-event-cue ms-event-cue--${cue.kind}`} role="status" aria-live="polite">
      <span className="ms-event-cue__label">{cue.label}</span>
      <span>{cue.event.message}</span>
    </div>
  );
}

export function TableSurface({
  view,
  me,
  targeting,
  onPickSlot,
  attention = false,
  seat,
  pass,
  endTurn,
  thinking = null,
  menu,
  tutorial,
  notices,
}: {
  view: PlayerView;
  /** The revealed seat's public row, whose resources the bar draws. `null` draws none. */
  me: PublicPlayerView | null;
  /** Legal areas for the action the revealed seat is composing, or `null` for none. */
  targeting?: Targeting | null;
  /** Called when a legal area is chosen. Absent while no seat holds the device. */
  onPickSlot?: ((slotId: string) => void) | undefined;
  /** True when the revealed seat has something to do, so the sheet opens to show it. */
  attention?: boolean;
  /** The revealed seat's own sheet. Absent draws the public body. */
  seat?: SeatSheet | undefined;
  /** The mode's control for handing the device to the seat that must act, if any. */
  pass?: ReactNode;
  endTurn: Availability & { onEndTurn: () => void; busy: boolean };
  /** The computer seat about to act, or `null`. */
  thinking?: PublicPlayerView | null;
  menu: MatchMenuItems;
  /** Tutorial coach. On phones it attaches to the action sheet; wider screens keep it above the table. */
  tutorial?: ReactNode;
  /** Alerts and results drawn between the bar and the board. */
  notices?: ReactNode;
}) {
  const viewport = useViewport();
  // The menu's button is in the bar and its drawer is a sibling of the bar: the bar is a
  // sticky stacking context, and a drawer inside it would sit under the action sheet.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const zones = useMemo(() => summarizeZones(view), [view]);
  const players = useMemo(() => summarizePlayers(view, zones), [view, zones]);
  const wantsBoard = (targeting?.slotIds.size ?? 0) > 0;
  const next = mustActSeat(view);

  // The sheet wears the party of whoever it is for: the revealed seat, or on the shared
  // surface the seat the table is waiting on.
  const sheetParty = seat === undefined
    ? next === null ? undefined : PARTY_BY_ID.get(next.partyId)?.color
    : PARTY_BY_ID.get(view.players.find((player) => player.id === seat.seatId)?.partyId ?? '')?.color;

  // The shared surface's headline names who must act; the seat's own says what to do.
  const waiting = describeDecision(view).waitingOn.length;
  const news = seat?.news ?? (
    view.status === 'finished'
      ? 'The match is over'
      : next === null
        ? describeDecision(view).news
        : waiting > 1
          ? `${next.displayName} and ${waiting - 1} other${waiting === 2 ? '' : 's'}`
          : next.displayName
  );
  // On a table with several people, the sheet says whose it is.
  const humans = view.players.filter((player) => player.controller !== 'computer').length;
  const eyebrow = seat !== undefined && humans > 1
    ? view.players.find((player) => player.id === seat.seatId)?.displayName
    : seat === undefined && next !== null && view.status !== 'finished'
      ? 'Whose move'
      : undefined;

  return (
    <div className={`ms-layout ms-layout--${viewport}`}>
      <StatusBar
        view={view}
        me={me}
        thinking={thinking}
        menu={(
          <MatchMenuButton
            open={menuOpen}
            onToggle={() => setMenuOpen((current) => !current)}
            buttonRef={menuButton}
          />
        )}
      />
      <EventCue view={view} />
      <MatchMenuDrawer
        view={view}
        zones={zones}
        items={menu}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        returnFocusTo={menuButton}
      />

      {tutorial === undefined || tutorial === null || viewport === 'phone'
        ? null
        : <div className="ms-notices">{tutorial}</div>}
      {notices === undefined || notices === null ? null : <div className="ms-notices">{notices}</div>}

      <div className="ms-table" inert={menuOpen} aria-hidden={menuOpen}>
        <SeatsStrip view={view} players={players} meId={me?.id ?? null} />
        <BoardRegion
          view={view}
          zones={zones}
          targeting={targeting}
          onPickSlot={onPickSlot}
          zoomable={viewport !== 'phone'}
        />
        <ActionSheet
          view={view}
          docked={viewport !== 'phone'}
          news={news}
          eyebrow={eyebrow}
          endTurn={endTurn}
          {...(pass === undefined ? {} : { pass })}
          {...(seat?.tray === undefined ? {} : { tray: seat.tray })}
          wantsBoard={wantsBoard}
          attention={attention}
          subject={seat?.subject ?? 'none'}
          partyColor={sheetParty}
          {...(viewport === 'phone' && tutorial !== undefined ? { teaching: tutorial } : {})}
        >
          {seat === undefined ? <PublicBody view={view} /> : seat.body}
        </ActionSheet>
      </div>
    </div>
  );
}
