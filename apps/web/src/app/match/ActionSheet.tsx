/**
 * The action sheet: the one thing to do now, and the controls that do it, pinned where a
 * thumb reaches them.
 *
 * On a phone it is a sheet along the bottom of the screen with three heights. Collapsed,
 * it is one row — what to do, and End turn — and the board above it is the whole screen.
 * Half open, it shows the prompt or the open action while the board stays visible above
 * it, so placing a voter is "see board, tap area" with nothing to switch between. Fully
 * open, it is the column the seat used to have, with a dimmed backdrop behind it. It
 * opens itself when something new arrives for the seat, and steps back to half when an
 * action wants an area tapped on the board. On a tablet or a desktop the same component is
 * a docked panel beside the board, with no heights to manage.
 *
 * Dragging the handle moves it; tapping the header toggles it; **Show more** does the
 * same from a keyboard. None of that is a rule: everything in the body is in the document
 * at every height, so a test and a screen reader find the same controls whatever the
 * sheet is showing.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { PlayerView } from '@gerrymander/protocol';

import type { Availability } from '../actions';
import { turnSteps } from '../table';

export type SheetLevel = 'collapsed' | 'half' | 'full';

const ORDER: readonly SheetLevel[] = ['collapsed', 'half', 'full'];

function step(level: SheetLevel, by: number): SheetLevel {
  const index = Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(level) + by));
  return ORDER[index] ?? level;
}

/**
 * The step labels at the length a sheet header has room for. `turnSteps` names each step
 * in full; here one or two words stand for it, and an unknown step keeps its full name.
 */
const SHORT_STEPS: Readonly<Record<string, string>> = {
  vote: 'Vote',
  resources: 'Resources',
  answer: 'Answer',
  act: 'Buy & place',
  end: 'End',
};

/** The turn as three quiet words, the current one marked. */
function StepTrail({ view }: { view: PlayerView }) {
  if (view.status === 'setup') return null;
  const steps = turnSteps(view);
  return (
    <ol className="ms-steps" aria-label="Where this turn is">
      {steps.map((entry) => (
        <li
          key={entry.id}
          className={`ms-steps__step ms-steps__step--${entry.state}`}
          aria-current={entry.state === 'current' ? 'step' : undefined}
        >
          {SHORT_STEPS[entry.id] ?? entry.label}
          <span className="visually-hidden">
            {entry.state === 'done' ? ', done' : entry.state === 'current' ? ', now' : ', next'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * End turn, with its reason one long-press away.
 *
 * A disabled button cannot say why it is disabled on a phone: there is no hover. So the
 * reason is on the wrapper's `title`, in visually hidden text a screen reader gets, and
 * in a small bubble that a long press on the button shows.
 */
function EndTurnButton({ endTurn }: { endTurn: Availability & { onEndTurn: () => void; busy: boolean } }) {
  const [reasonShown, setReasonShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = () => {
    if (endTurn.reason === null) return;
    timer.current = setTimeout(() => setReasonShown(true), 420);
  };
  const release = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (reasonShown) setTimeout(() => setReasonShown(false), 1800);
  };
  return (
    <span
      className="ms-end"
      title={endTurn.reason ?? undefined}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      <button
        type="button"
        className="button button--primary ms-end__button"
        disabled={!endTurn.can || endTurn.busy}
        aria-describedby={endTurn.reason === null ? undefined : 'end-turn-reason'}
        onClick={endTurn.onEndTurn}
        data-coach-anchor="end-turn"
      >
        End turn
      </button>
      {endTurn.reason === null ? null : (
        <span
          id="end-turn-reason"
          className={reasonShown ? 'ms-end__reason' : 'visually-hidden'}
          role={reasonShown ? 'status' : undefined}
        >
          {endTurn.reason}
        </span>
      )}
    </span>
  );
}

export function ActionSheet({
  view,
  docked,
  news,
  eyebrow,
  endTurn,
  pass,
  tray,
  teaching,
  wantsBoard,
  attention,
  subject,
  partyColor,
  children,
}: {
  view: PlayerView;
  /** True on a tablet or a desktop, where the sheet is a panel beside the board. */
  docked: boolean;
  /** The one line: what to do now. */
  news: string;
  /** A small line over the news: whose sheet this is, on a table with several people. */
  eyebrow?: string | undefined;
  endTurn: Availability & { onEndTurn: () => void; busy: boolean };
  /** The pass-and-play control for the seat that must act, drawn instead of End turn. */
  pass?: ReactNode;
  /** Voter tokens waiting to be placed, drawn along the top edge. */
  tray?: ReactNode;
  /** Compact phone-only teaching callout between the header and current controls. */
  teaching?: ReactNode;
  wantsBoard: boolean;
  /** True when the seat has something to do, so the sheet opens to show it. */
  attention: boolean;
  /**
   * A name for what the body is about. When it changes to a new thing — a prompt
   * arrives, an action opens — a collapsed sheet opens to half.
   */
  subject: string;
  partyColor?: string | undefined;
  children: ReactNode;
}) {
  const [level, setLevel] = useState<SheetLevel>(
    attention ? (wantsBoard ? 'half' : 'full') : 'collapsed',
  );
  const head = useRef<HTMLDivElement>(null);
  const teachingBox = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [headHeight, setHeadHeight] = useState(64);
  const [teachingHeight, setTeachingHeight] = useState(0);
  // The collapsed height is the header's own, tray included, whatever it wraps to.
  useEffect(() => {
    const element = head.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const write = () => setHeadHeight(Math.ceil(element.getBoundingClientRect().height));
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = teachingBox.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      setTeachingHeight(0);
      return;
    }
    const write = () => setTeachingHeight(Math.ceil(element.getBoundingClientRect().height));
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => observer.disconnect();
  }, [teaching]);

  // The page below keeps room for the sheet at its current height, so the board and the
  // seats can always be scrolled out from under it. `--ms-sheet-half` is the same figure
  // the stylesheet uses for the half level.
  useEffect(() => {
    if (docked) return;
    const root = document.documentElement.style;
    const visible = level === 'collapsed'
      ? `${headHeight}px`
      : level === 'half'
        ? 'min(46dvh, 420px)'
        : teaching === undefined
          ? 'calc(100dvh - var(--bar-h) - 12px)'
          : 'min(58dvh, 460px)';
    root.setProperty('--ms-sheet-head', `${headHeight}px`);
    root.setProperty('--ms-sheet-pad', visible);
    return () => {
      root.removeProperty('--ms-sheet-head');
      root.removeProperty('--ms-sheet-pad');
    };
  }, [docked, headHeight, level, teaching]);

  // New non-board prompts and purchases open to a useful height. Board-targeting flows
  // stay half open so the tray and map remain visible together.
  const lastSubject = useRef(subject);
  useEffect(() => {
    if (lastSubject.current === subject) return;
    lastSubject.current = subject;
    body.current?.scrollTo?.({ top: 0 });
    if (subject !== 'free' && subject !== 'none') setLevel(wantsBoard ? 'half' : 'full');
  }, [subject, wantsBoard]);
  const lastAttention = useRef(attention);
  useEffect(() => {
    if (lastAttention.current === attention) return;
    lastAttention.current = attention;
    setLevel(attention ? (wantsBoard ? 'half' : 'full') : 'collapsed');
  }, [attention, wantsBoard]);
  // An action that wants the board gets it: a full sheet steps back to half.
  useEffect(() => {
    if (wantsBoard) setLevel((current) => (current === 'full' ? 'half' : current));
  }, [wantsBoard]);

  // Dragging the header. A short drag is a tap; a longer one moves the sheet one level in
  // its direction, and a long one two. The click that follows a drag is swallowed.
  const drag = useRef<{ startY: number; moved: boolean } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (docked || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, a, input, select')) return;
    drag.current = { startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (state === null) return;
    const delta = event.clientY - state.startY;
    if (Math.abs(delta) > 6) state.moved = true;
    setDragOffset(delta);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    drag.current = null;
    setDragOffset(0);
    if (state === null || !state.moved) return;
    const delta = event.clientY - state.startY;
    const magnitude = Math.abs(delta);
    if (magnitude < 40) return;
    const by = magnitude > window.innerHeight * 0.4 ? 2 : 1;
    setLevel((current) => step(current, delta < 0 ? by : -by));
  };
  const swallowed = useRef(false);
  const onHeaderClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (docked) return;
    if ((event.target as HTMLElement).closest('button, a, input, select')) return;
    if (swallowed.current) {
      swallowed.current = false;
      return;
    }
    setLevel((current) => (current === 'collapsed' ? 'half' : current === 'half' ? 'collapsed' : 'half'));
  }, [docked]);

  const style: CSSProperties & Record<string, string | number> = {
    '--ms-sheet-head': `${headHeight}px`,
    '--ms-drag': `${dragOffset}px`,
  };
  style['--ms-sheet-teaching'] = `${teachingHeight}px`;
  if (partyColor !== undefined) style['--party'] = partyColor;

  const bodyId = 'ms-sheet-body';

  return (
    <>
      {docked ? null : (
        <div
          className={`ms-sheet-backdrop${level === 'full' && teaching === undefined ? ' ms-sheet-backdrop--on' : ''}`}
          aria-hidden="true"
          onClick={() => setLevel('half')}
        />
      )}
      <section
        className={[
          'ms-sheet',
          docked ? 'ms-sheet--docked' : `ms-sheet--${level}`,
          dragOffset !== 0 ? 'ms-sheet--dragging' : '',
          wantsBoard ? 'ms-sheet--targeting' : '',
          teaching === undefined ? '' : 'ms-sheet--teaching',
        ].filter(Boolean).join(' ')}
        aria-label="Your actions"
        data-coach-anchor="sheet"
        data-level={docked ? 'docked' : level}
        style={style}
      >
        <div
          ref={head}
          className="ms-sheet__head"
          data-coach-anchor="sheet-head"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => {
            if (drag.current?.moved) swallowed.current = true;
            finishDrag(event);
          }}
          onPointerCancel={finishDrag}
          onClick={onHeaderClick}
        >
          {docked ? null : <span className="ms-sheet__handle" aria-hidden="true" />}
          {tray}
          <div className={`ms-sheet__row${pass === undefined ? '' : ' ms-sheet__row--pass'}`}>
            <div className="ms-sheet__text">
              <div className="ms-sheet__eyebrow">
                {eyebrow === undefined ? null : <span className="ms-sheet__you">{eyebrow}</span>}
                <StepTrail view={view} />
              </div>
              <h2 key={news} className="ms-sheet__news">{news}</h2>
            </div>
            <div className="ms-sheet__actions">
              {pass ?? <EndTurnButton endTurn={endTurn} />}
              {docked ? null : (
                <button
                  type="button"
                  className="ms-sheet__more"
                  aria-expanded={level !== 'collapsed'}
                  aria-controls={bodyId}
                  onClick={() => setLevel((current) => (current === 'full' ? 'collapsed' : step(current, 1)))}
                >
                  <span className="visually-hidden">{level === 'full' ? 'Show less' : 'Show more'}</span>
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                    <path d="M6 14l6-6 6 6" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        {teaching === undefined ? null : (
          <div ref={teachingBox} className="ms-sheet__teaching">
            {teaching}
          </div>
        )}
        <div id={bodyId} ref={body} className="ms-sheet__body" data-coach-anchor="sheet-body">
          {children}
        </div>
      </section>
    </>
  );
}
