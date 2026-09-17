/**
 * Everything on the match screen that is not the board, the seats or the action in hand.
 *
 * One button in the top bar opens a drawer from the right. The log, the cards in play,
 * the draw pile counts, the one-minute rules, the mode's own controls — passing the
 * device, the computer's pace — and the match settings all live here. None of them is
 * needed every turn, and a table that wants one wants it for a moment; a screen that drew
 * all of them at once was the screen the first players called overwhelming.
 *
 * The drawer stays in the document while closed. That is what lets a test find "Match
 * settings" and the pass controls without opening it, and it is also what lets the slide
 * animate: `inert` and `aria-hidden` take it out of the tab order and the accessibility
 * tree while it is shut, so a closed drawer is no more reachable than an unmounted one.
 *
 * Nothing here is private, and nothing here decides a rule. The log prints the public
 * history and the effects print the public projection, exactly as the old panels did.
 */
import { useCallback, useEffect, useId, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';

import type { PlayerView } from '@gerrymander/protocol';

import { HowToPlay } from '../HowToPlay';
import { describeDecks, type ZoneSummary } from '../table';

export interface MatchMenuItems {
  /** The pass-and-play seat controls. Absent online and on a table of one person. */
  switcher?: ReactNode;
  /** The computer pace control. Absent when no computer is seated, and online. */
  settings?: ReactNode;
  /** The mode's frozen facts: match settings locally, the seat credential online. */
  extras?: ReactNode;
  /** The way out. */
  home: { href: string; label: string };
}

function Log({ view }: { view: PlayerView }) {
  const recent = [...view.history].slice(-40).reverse();
  return (
    <>
      {recent.length === 0 ? (
        <p className="small">Nothing yet.</p>
      ) : (
        <ol className="ms-log">
          {recent.map((event, index) => (
            <li key={event.id} style={{ '--i': Math.min(index, 12) } as CSSProperties}>
              <span className="ms-log__actor">
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
      <p className="small">The most recent public events, newest first.</p>
    </>
  );
}

function InPlay({ view }: { view: PlayerView }) {
  const named = (playerId: string): string =>
    view.players.find((player) => player.id === playerId)?.displayName ?? playerId;
  return (
    <>
      {view.activeEffects.length === 0 ? (
        <p className="small">No card is exerting a continuing effect.</p>
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
          <h4>Voters waiting to be placed</h4>
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
          <h4>Turncoat placements</h4>
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
      <h4>Draw piles</h4>
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
    </>
  );
}

/**
 * What the marks on the board mean, in one line each.
 *
 * Every mark is also stated in words in the spoken zone descriptions above it, so this is
 * a reading aid rather than the only source.
 */
function BoardKey() {
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
        <span>Volatile area: a voter here never moves again and triggers a news card.</span>
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

function Section({
  title,
  note,
  open = false,
  children,
}: {
  title: string;
  note?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="ms-menu__section" open={open}>
      <summary>
        <span className="ms-menu__title">{title}</span>
        {note === undefined ? null : <span className="ms-menu__note">{note}</span>}
      </summary>
      <div className="ms-menu__content">{children}</div>
    </details>
  );
}

/**
 * The button in the bar. The drawer it opens is `MatchMenuDrawer`, rendered by the
 * layout outside the bar, because the bar is a sticky stacking context and a drawer
 * inside it would sit under the action sheet.
 */
export function MatchMenuButton({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ms-menu-button"
      aria-expanded={open}
      aria-controls="ms-menu"
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
      <span className="ms-menu-button__label">Menu</span>
    </button>
  );
}

export function MatchMenuDrawer({
  view,
  zones,
  items,
  open,
  onClose,
  returnFocusTo,
}: {
  view: PlayerView;
  zones: readonly ZoneSummary[];
  items: MatchMenuItems;
  open: boolean;
  onClose: () => void;
  /** The control that opened the drawer, which gets focus back when it closes. */
  returnFocusTo: RefObject<HTMLButtonElement | null>;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();

  const close = useCallback(() => {
    onClose();
    returnFocusTo.current?.focus();
  }, [onClose, returnFocusTo]);

  // The drawer is a modal: it takes focus, contains Tab in both directions, closes on
  // Escape, and gives focus back to the button that opened it.
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = panel.current;
      if (root === null) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), summary, [tabindex]:not([tabindex=\"-1\"])',
      )].filter((element) => {
        if (element.closest('[hidden], [inert]') !== null) return false;
        const closed = element.closest('details:not([open])');
        return closed === null || closed.querySelector(':scope > summary') === element;
      });
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, open]);

  const effects = view.activeEffects.length;

  return (
    <div
      id="ms-menu"
      className={`ms-menu${open ? ' ms-menu--open' : ''}`}
      aria-hidden={!open}
      // `inert` is a boolean content attribute; React 19 forwards it as one.
      inert={!open}
    >
      <div className="ms-menu__backdrop" onClick={close} />
      <aside ref={panel} className="ms-menu__panel" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header className="ms-menu__head">
          <h2 id={headingId}>Menu</h2>
          <button ref={closeButton} type="button" className="button button--quiet" onClick={close}>
            Close
          </button>
        </header>

        <Section title="Log" note={`${view.history.length} event${view.history.length === 1 ? '' : 's'}`}>
          <Log view={view} />
        </Section>

        <Section
          title="In play"
          note={effects === 0 ? 'nothing lasting' : `${effects} effect${effects === 1 ? '' : 's'}`}
        >
          <InPlay view={view} />
        </Section>

        {items.switcher === undefined ? null : (
          <Section title="Pass the device" open>
            {/* Choosing a seat is leaving the menu: the cover or the table is what comes next. */}
            <div
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button') !== null) close();
              }}
            >
              {items.switcher}
            </div>
          </Section>
        )}

        {items.settings === undefined ? null : (
          <Section title="Computer pace">
            {items.settings}
          </Section>
        )}

        <Section title="Board in words" note="every zone, and the marks">
          <ul className="spoken-zones">
            {zones.map((zone) => (
              <li key={zone.id}>{zone.spoken}</li>
            ))}
          </ul>
          <BoardKey />
          <p className="small">
            From the keyboard: Tab reaches the board, the arrow keys move between areas, Page Up
            and Page Down change zone, and Enter inspects one.
          </p>
        </Section>

        <div className="ms-menu__section ms-menu__section--help">
          <HowToPlay />
        </div>

        {items.extras === undefined ? null : (
          <div className="ms-menu__section ms-menu__section--extras">{items.extras}</div>
        )}

        <p className="ms-menu__home">
          <a className="button button--quiet" href={items.home.href}>
            ← {items.home.label}
          </a>
        </p>
      </aside>
    </div>
  );
}
