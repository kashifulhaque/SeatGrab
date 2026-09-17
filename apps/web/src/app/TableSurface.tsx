/**
 * The shared table: the board and everything anyone at the table can see beside it.
 *
 * Section 13.4 wants the board dominant rather than a stamp between dashboards, the
 * three voter cards visible without opening anything, the deck counts and public effects
 * readable without exposing order. All of that is public, so this component takes the
 * public projection and renders it for the whole table at once. Nothing private is drawn
 * here; the privacy cover in `MatchShell` owns that, and this surface is what stays on
 * screen behind it. The decision owner lives in `StatusBar`, which is pinned above this.
 *
 * The grid is the structure of 13.4: seat summaries on the left, the board filling the
 * centre, and the action column on the right. The action column is handed in as `aside`
 * — the revealed seat's `SeatSurface` — because it is private and this file must never
 * know a seat. When no seat is revealed, the column shows the market read-only and what
 * the table is waiting on. Below the grid, In play and the Log stay as they were.
 *
 * The board and the zone list are two views of the same nine zones. The board is the
 * primary one and is fully keyboard navigable; the zone list exists because a phone in
 * portrait cannot make 129 areas comfortably tappable, and because a table sometimes just
 * wants the numbers. Both are rendered from the same summaries, so they cannot disagree.
 *
 * One thing crosses the line between the shared surface and a seat's own: when a seat is
 * composing an action, its legal areas are ringed here and clicking one feeds the choice
 * back. The set arrives already computed; this file neither derives it nor decides what
 * choosing one means, so the shared board stays a board rather than becoming a composer.
 *
 * Section 13.10 also asks for a zoomable board on a phone. The zoom here enlarges the
 * drawing inside a frame that then scrolls, rather than transforming a fixed box: the
 * areas grow with it, so a magnified area is a bigger hit target and not just a bigger
 * picture of a small one. It is driven by ordinary buttons, so it is as available to a
 * keyboard as to a pinch, and the browser's own pinch-zoom is left switched on beside it.
 *
 * Three layouts, per 13.10, chosen by `useViewport`: three columns on a desktop; on a
 * tablet the seats become a strip above the board and the action column a drawer over
 * its right edge; on a phone the four regions become tabs under the status bar.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import type { PlayerView } from '@seatgrab/protocol';

import { BOARD_VIEW_RATIO, TableBoard, slotLabel } from '../board/TableBoard';
import { PARTY_BY_ID, RESOURCE_ASSETS } from '../assets/manifest';

import { HowToPlay } from './HowToPlay';
import { Market } from './Market';
import { PartyMark } from './PartyMark';
import type { Targeting } from './actions';
import {
  describeDecision,
  describeDecks,
  describeSlot,
  mustActSeat,
  summarizePlayers,
  summarizeZones,
  type PlayerSummary,
  type ZoneSummary,
  marksComputer,
} from './table';
import { useViewport } from './useViewport';

const RESOURCE_ORDER = ['cash', 'influence', 'press', 'faith'] as const;

/**
 * The zoom steps the board offers, as a multiple of the fitted width.
 *
 * Discrete steps rather than a slider: a slider is a poor target on a phone and an
 * awkward one from a keyboard, and three steps are enough to make the most crowded zone
 * comfortable at 400px.
 */
const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

type Tab = 'board' | 'act' | 'seats' | 'log';

/**
 * One seat as a compact scoreboard row that expands to the full card.
 *
 * The row leads with the number that wins — voters counted in a majority — and says so
 * in words, because "score" on its own meant nothing to a first-time player. The rest of
 * the row is one line of plain counts, and the resources are drawn as the same icons the
 * status bar and the market use, so a player learns each icon once.
 */
function SeatRow({ summary }: { summary: PlayerSummary }) {
  const { player } = summary;
  const party = PARTY_BY_ID.get(player.partyId);
  return (
    <li
      className={`seat-row${summary.deciding ? ' seat-row--deciding' : ''}${summary.active ? ' seat-row--active' : ''}`}
      style={party === undefined ? undefined : ({ '--party': party.color } as CSSProperties)}
    >
      <details>
        <summary>
          <span className="seat-row__who">
            <PartyMark partyId={player.partyId} size={30} />
            <span className="seat-row__name">{player.displayName}</span>
            {marksComputer(player) ? (
              <span className="seat-row__badge">computer</span>
            ) : null}
            {summary.deciding ? (
              <span className="seat-row__badge seat-row__badge--deciding">To act</span>
            ) : summary.active ? (
              <span className="seat-row__badge">Their turn</span>
            ) : null}
          </span>
          <span className="seat-row__score">
            <strong>{summary.majorityVoters}</strong>
            <span>majority voter{summary.majorityVoters === 1 ? '' : 's'}</span>
          </span>
          <span className="seat-row__line">
            {summary.boardVoters} on board · {summary.zonesLed.length} zone{summary.zonesLed.length === 1 ? '' : 's'} led ·{' '}
            {player.trickHandCount} card{player.trickHandCount === 1 ? '' : 's'}
          </span>
          <span className="seat-row__resources" aria-label={`${player.displayName}’s resources`}>
            {RESOURCE_ORDER.map((resource) => (
              <span key={resource}>
                <img src={RESOURCE_ASSETS[resource].url} alt="" aria-hidden="true" width={16} height={16} />
                <span className="visually-hidden">{RESOURCE_ASSETS[resource].label} </span>
                {player.resources[resource]}
              </span>
            ))}
            <span className="seat-row__cap">{summary.resourceTotal}/{player.resourceCap}</span>
          </span>
        </summary>
        <dl className="facts facts--tight">
          <div>
            <dt>Seat</dt>
            <dd>{player.seat + 1}</dd>
          </div>
          <div>
            <dt>Majority voters</dt>
            <dd>{summary.majorityVoters}</dd>
          </div>
          <div>
            <dt>Voters on board</dt>
            <dd>{summary.boardVoters}</dd>
          </div>
          <div>
            <dt>Zones held</dt>
            <dd>{summary.zonesLed.length === 0 ? 'none' : summary.zonesLed.join(', ')}</dd>
          </div>
          <div>
            <dt>Zones present in</dt>
            <dd>{summary.zonesPresent} of 9</dd>
          </div>
          <div>
            <dt>Tricks held</dt>
            <dd>{player.trickHandCount}</dd>
          </div>
        </dl>
        <p className="small">
          Policy cards kept — corporate {player.policyCounts.corporate}, nationalist{' '}
          {player.policyCounts.nationalist}, populist {player.policyCounts.populist}, reformer{' '}
          {player.policyCounts.reformer}.
        </p>
        {summary.zonesWithRights.length === 0 ? null : (
          <p className="small">redistricting rights: {summary.zonesWithRights.join(', ')}.</p>
        )}
      </details>
    </li>
  );
}

function ZoneList({ zones }: { zones: readonly ZoneSummary[] }) {
  return (
    <ul className="zone-list">
      {zones.map((zone) => (
        <li key={zone.id} className="zone-card">
          <div className="zone-card__head">
            <h3>{zone.displayName}</h3>
            <p className="zone-card__threshold">
              {zone.majorityThreshold} of {zone.capacity} for a majority
            </p>
          </div>
          <p className="zone-card__fill">
            {zone.filled} filled · {zone.empty} empty · {zone.volatileSlots} volatile
          </p>
          {zone.holdings.length === 0 ? (
            <p className="small">No voters here yet.</p>
          ) : (
            <ul className="zone-card__holdings">
              {zone.holdings.map((holding) => (
                <li key={holding.playerId}>
                  <PartyMark partyId={holding.partyId} size={20} />
                  <span>
                    {holding.displayName}: {holding.voters}
                    {holding.majorityVoters > 0 ? ` (${holding.majorityVoters} marked)` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="zone-card__majority">
            {zone.majorityOwner === null
              ? 'No majority yet.'
              : `Majority: ${zone.majorityOwner.displayName}.`}
            {zone.rightsOwner === null
              ? ''
              : ` redistricting rights: ${zone.rightsOwner.displayName}.`}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the marks on the board mean, in one line each.
 *
 * Every mark here is also stated in words on the zone list and in the spoken zone
 * descriptions, so this is a reading aid rather than the only source. It is drawn
 * beside the map because a first-time player asked what the dashed rings were.
 */
function BoardLegend() {
  return (
    <ul className="board-key" aria-label="What the marks on the board mean">
      <li>
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="8" className="board__slot board__slot--taken" />
          <circle cx="11" cy="11" r="4" fill="var(--frame)" />
        </svg>
        <span>A voter. The emblem says whose.</span>
      </li>
      <li>
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="9" className="board__majority-ring" />
          <path d="M6 11l3.5 3.5L16 8" className="board__majority-tick" />
        </svg>
        <span>Counted in a majority. It scores.</span>
      </li>
      <li>
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="6" className="board__slot" />
          <circle cx="11" cy="11" r="9.5" className="board__slot-volatile" />
        </svg>
        <span>Volatile area: a voter here never moves again and triggers a news.</span>
      </li>
      <li>
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r="6" className="board__slot" />
          <circle cx="11" cy="11" r="9.5" className="board__legal-ring" />
        </svg>
        <span>A legal target for the action you are taking.</span>
      </li>
      <li>
        <span className="board-key__plaque" aria-hidden="true">2/17 · need 9</span>
        <span>Voters in the zone, of its areas. A majority needs that many of one party.</span>
      </li>
    </ul>
  );
}

/**
 * The right column when no seat is revealed: whose move it is, the one thing to do about
 * it, the market to read, and the rules.
 *
 * `pass` is the mode's own control for handing the device to that seat. It is drawn here
 * as well as in the status bar because a table looking at the shared view has exactly one
 * next step, and a first-time player looks for it beside the explanation, not in the bar.
 */
function PublicAside({ view, pass }: { view: PlayerView; pass?: ReactNode }) {
  const decision = describeDecision(view);
  const next = mustActSeat(view);
  const party = next === null ? undefined : PARTY_BY_ID.get(next.partyId);
  return (
    <section
      className="panel action-column"
      aria-labelledby="table-aside-heading"
      style={party === undefined ? undefined : ({ '--party': party.color } as CSSProperties)}
    >
      <h2 id="table-aside-heading">Whose move</h2>
      {next === null ? (
        <p>{decision.detail}</p>
      ) : (
        <section className="now now--free" aria-labelledby="whose-move-heading">
          <p className="now__eyebrow">Now</p>
          <h3 id="whose-move-heading" className="now__news now__news--seat">
            <PartyMark partyId={next.partyId} size={28} /> {next.displayName}
            {decision.waitingOn.length > 1
              ? ` and ${decision.waitingOn.length - 1} other${decision.waitingOn.length === 2 ? '' : 's'}`
              : ''}
          </h3>
          <p className="now__detail">{decision.detail}</p>
          {pass === undefined ? null : <div className="now__body now__body--actions">{pass}</div>}
        </section>
      )}
      <h3 className="options__label">Voter market</h3>
      <p className="small">Face up for everyone. The seat acting may buy any of them.</p>
      <Market view={view} />
      <HowToPlay />
    </section>
  );
}

function ActiveEffects({ view }: { view: PlayerView }) {
  const named = (playerId: string): string =>
    view.players.find((player) => player.id === playerId)?.displayName ?? playerId;
  return (
    <section className="panel" aria-labelledby="effects-heading">
      <h2 id="effects-heading">In play</h2>
      {view.activeEffects.length === 0 ? (
        <p>No card is exerting a continuing effect.</p>
      ) : (
        <ul className="effects">
          {view.activeEffects.map((effect) => (
            <li key={effect.id}>
              <strong>{effect.title}</strong>
              <span className="small">
                {named(effect.ownerId)}
                {effect.targetPlayerIds.length > 0
                  ? ` → ${effect.targetPlayerIds.map(named).join(', ')}`
                  : ''}
                {effect.targetZoneIds.length > 0 ? ` · ${effect.targetZoneIds.join(', ')}` : ''}
                {effect.remainingUses === undefined ? '' : ` · ${effect.remainingUses} uses left`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {view.pendingVoterGroups.length === 0 ? null : (
        <>
          <h3>Voters waiting to be placed</h3>
          <ul className="effects">
            {view.pendingVoterGroups.map((group) => (
              <li key={group.id}>
                <strong>
                  {group.count} voter{group.count === 1 ? '' : 's'} for {named(group.ownerId)}
                </strong>
                <span className="small">
                  Placed by {named(group.controllerId)}
                  {group.sameZone ? ' · all in one zone' : ' · zones may differ'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {view.turncoatHoldings.length === 0 ? null : (
        <>
          <h3>Turncoat placements</h3>
          <ul className="effects">
            {view.turncoatHoldings.map((holding) => (
              <li key={holding.effectId}>
                <strong>
                  {named(holding.ownerId)} · {holding.archetype}
                </strong>
                <span className="small">Acquire for {holding.acquisitionCost} resources.</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Draw piles</h3>
      <dl className="facts facts--tight">
        {describeDecks(view).map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>{entry.value}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        Counts only. The order of every draw pile, and the identity of the next card in it,
        stay where they belong.
      </p>
    </section>
  );
}

function History({ view }: { view: PlayerView }) {
  const recent = [...view.history].slice(-25).reverse();
  return (
    <section className="panel" aria-labelledby="history-heading">
      <h2 id="history-heading">Log</h2>
      {recent.length === 0 ? (
        <p>Nothing yet.</p>
      ) : (
        <ol className="history">
          {recent.map((event) => (
            <li key={event.id}>
              <span className="history__actor">
                {event.actorId === undefined
                  ? '—'
                  : view.players.find((player) => player.id === event.actorId)?.displayName
                    ?? event.actorId}
              </span>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="small">
        The 25 most recent public events, newest first. A private event appears only in the view
        of a seat entitled to it.
      </p>
    </section>
  );
}

export function TableSurface({
  view,
  targeting,
  onPickSlot,
  aside,
  pass,
  attention = false,
}: {
  view: PlayerView;
  /** Legal areas for the action the revealed seat is composing, or `null` for none. */
  targeting?: Targeting | null;
  /** Called when a legal area is chosen. Absent while no seat holds the device. */
  onPickSlot?: ((slotId: string) => void) | undefined;
  /** The revealed seat's action column. Absent draws the market read-only. */
  aside?: ReactNode;
  /** The mode's control for handing the device to the seat that must act, if any. */
  pass?: ReactNode;
  /** True when the revealed seat has something to do, so the phone's Act tab says so. */
  attention?: boolean;
}) {
  const viewport = useViewport();
  const [tab, setTab] = useState<Tab>('board');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [boardTab, setBoardTab] = useState<'board' | 'zones'>('board');
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [zoomStep, setZoomStep] = useState(0);
  const zoom = ZOOM_STEPS[zoomStep] ?? 1;

  const hasSeat = aside !== undefined;
  // A seat that has just revealed itself wants its actions, so the tablet drawer opens
  // and the phone lands on the Act tab; going back to the table view reverses both.
  useEffect(() => {
    setDrawerOpen(hasSeat);
    setTab(hasSeat ? 'act' : 'board');
  }, [hasSeat]);

  const zones = summarizeZones(view);
  const players = summarizePlayers(view, zones);
  const selectedSlot = selectedSlotId === null
    ? null
    : view.slots.find((slot) => slot.slotId === selectedSlotId) ?? null;

  const tabs: readonly { id: Tab; label: string }[] = [
    { id: 'board', label: 'Board' },
    { id: 'act', label: hasSeat ? 'Act' : 'Market' },
    { id: 'seats', label: 'Seats' },
    { id: 'log', label: 'Log' },
  ];

  return (
    <>
      {viewport === 'phone' ? (
        <div className="table-tabs" role="tablist" aria-label="Table sections">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={`tab ${tab === entry.id ? 'tab--active' : ''}`}
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {entry.id === 'act' && hasSeat && attention ? (
                <span className="tab__dot" aria-label="Something is waiting on you" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {viewport === 'tablet' ? (
        <div className="table-tools">
          <button
            type="button"
            className={`button ${drawerOpen ? 'button--primary' : ''}`}
            aria-expanded={drawerOpen}
            aria-controls="table-aside"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {hasSeat ? 'Your actions' : 'Market'}
          </button>
        </div>
      ) : null}

      <div
        className={`table-grid table-grid--${viewport}${drawerOpen ? ' table-grid--drawer-open' : ''}`}
        data-tab={tab}
      >
        <section className="panel table-grid__seats" aria-labelledby="seats-heading">
          <h2 id="seats-heading">Seats</h2>
          <ul className="seat-rows">
            {players.map((summary) => (
              <SeatRow key={summary.player.id} summary={summary} />
            ))}
          </ul>
          <p className="small seats__key">
            Majority voters are the score: voters inside a zone you hold. The most at the end wins.
            Select a seat for the full card.
          </p>
        </section>

        <section className="panel table-grid__board" aria-labelledby="board-heading">
          <div className="board-head">
            <h2 id="board-heading">Board</h2>
            <div className="board-head__tabs" role="group" aria-label="How to read the board">
              <button
                type="button"
                className={`tab ${boardTab === 'board' ? 'tab--active' : ''}`}
                aria-pressed={boardTab === 'board'}
                onClick={() => setBoardTab('board')}
              >
                Map
              </button>
              <button
                type="button"
                className={`tab ${boardTab === 'zones' ? 'tab--active' : ''}`}
                aria-pressed={boardTab === 'zones'}
                onClick={() => setBoardTab('zones')}
              >
                Zone list
              </button>
            </div>
            {boardTab === 'board' ? (
              <div className="board-zoom" role="group" aria-label="Board magnification">
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={zoomStep === 0}
                  onClick={() => setZoomStep((step) => Math.max(0, step - 1))}
                >
                  Zoom out
                </button>
                <p className="board-zoom__level" role="status">
                  {zoom === 1 ? 'Whole board' : `${zoom}× — scroll the frame to pan`}
                </p>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={zoomStep === ZOOM_STEPS.length - 1}
                  onClick={() => setZoomStep((step) => Math.min(ZOOM_STEPS.length - 1, step + 1))}
                >
                  Zoom in
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={zoomStep === 0}
                  onClick={() => setZoomStep(0)}
                >
                  Fit
                </button>
              </div>
            ) : null}
          </div>

          {boardTab === 'board' ? (
            <>
              {targeting === null || targeting === undefined ? null : (
                <p className="board-legend" role="status">
                  {targeting.slotIds.size === 0
                    ? `No area on the board is a legal place to ${targeting.label}.`
                    : `${targeting.slotIds.size} ringed area${targeting.slotIds.size === 1 ? '' : 's'}: `
                      + `choose one to ${targeting.label}.`}
                </p>
              )}
              <div
                className={`board-frame${zoom > 1 ? ' board-frame--zoomed' : ''}`}
                style={{ '--board-ratio': BOARD_VIEW_RATIO } as CSSProperties}
              >
                <div className="board-frame__inner" style={{ '--board-zoom': zoom } as CSSProperties}>
                  <TableBoard
                    zones={view.zones}
                    slots={view.slots}
                    players={view.players}
                    summaries={zones}
                    selectedSlotId={selectedSlotId}
                    onSelectSlot={(slotId) => {
                      setSelectedSlotId(slotId);
                      if (slotId !== null && targeting?.slotIds.has(slotId) === true) {
                        onPickSlot?.(slotId);
                      }
                    }}
                    {...(targeting === null || targeting === undefined
                      ? {}
                      : { highlightedSlotIds: targeting.slotIds, highlightLabel: targeting.label })}
                  />
                </div>
              </div>
              <p className="board-caption" role="status">
                {selectedSlot === null
                  ? 'Select an area to read what is on it. Arrow keys move between areas, '
                    + 'Page Up and Page Down change zone.'
                  : `${describeSlot(
                    selectedSlot,
                    view.zones.find((zone) => zone.id === selectedSlot.zoneId),
                    view.players,
                  )} Inspecting ${slotLabel(selectedSlot.slotId, view.zones)}; select it again to stop.`}
              </p>
              <details className="disclosure disclosure--key">
                <summary>What the marks mean</summary>
                <BoardLegend />
              </details>
            </>
          ) : (
            <ZoneList zones={zones} />
          )}

          <details className="disclosure">
            <summary>Every zone, in words</summary>
            <ul className="spoken-zones">
              {zones.map((zone) => (
                <li key={zone.id}>{zone.spoken}</li>
              ))}
            </ul>
          </details>
        </section>

        <div className="table-grid__aside" id="table-aside">
          {viewport === 'tablet' ? (
            <div className="table-grid__aside-close">
              <button type="button" className="button button--quiet" onClick={() => setDrawerOpen(false)}>
                Close
              </button>
            </div>
          ) : null}
          {aside ?? <PublicAside view={view} {...(pass === undefined ? {} : { pass })} />}
        </div>

        <div className="table-grid__below">
          <ActiveEffects view={view} />
          <History view={view} />
        </div>
      </div>
    </>
  );
}
