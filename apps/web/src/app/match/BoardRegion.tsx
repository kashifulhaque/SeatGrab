/**
 * The board, fitted to its column, with the two lines that speak for it.
 *
 * The map is the dominant surface and this frame gives it the whole width it is given.
 * Tablets and desktops keep stepped magnification available. A phone shows the same
 * compact controls whenever an action targets the board and opens that action at 3×, so
 * legal areas are finger-sized without depending on browser pinch.
 *
 * Two things are said over the map, and only when they apply. While an action has legal
 * areas, a pill above the board says how many are ringed and what tapping one does.
 * While an area is selected for inspection, a toast under the board reads it out. The
 * earlier caption that always said "Select an area to read what is on it" is gone: a
 * standing instruction is chrome, and the map explains itself on a tap.
 *
 * The board decides nothing. `targeting` arrives already computed, and a click on a
 * ringed area is handed back through `onPickSlot`; this file never derives a rule.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { PlayerView } from '@gerrymander/protocol';

import { BOARD_VIEW_RATIO, TableBoard } from '../../board/TableBoard';
import type { Targeting } from '../actions';
import { describeSlot, type ZoneSummary } from '../table';

/** The zoom steps, as a multiple of the fitted width. Three steps are enough. */
const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

export function BoardRegion({
  view,
  zones,
  targeting,
  onPickSlot,
  zoomable,
}: {
  view: PlayerView;
  zones: readonly ZoneSummary[];
  targeting: Targeting | null | undefined;
  onPickSlot: ((slotId: string) => void) | undefined;
  /** Keep zoom controls visible even when the board is not being targeted. */
  zoomable: boolean;
}) {
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [zoomStep, setZoomStep] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const wanted = (targeting?.slotIds.size ?? 0) > 0;
  const controlsVisible = zoomable || wanted;
  const zoom = controlsVisible ? ZOOM_STEPS[zoomStep] ?? 1 : 1;

  const selectedSlot = selectedSlotId === null
    ? null
    : view.slots.find((slot) => slot.slotId === selectedSlotId) ?? null;
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  // Phone targeting enters a real pannable 3× view; leaving returns to fit. The frame
  // starts at its centre, where a first placement can still be made with one tap.
  useEffect(() => {
    if (zoomable) return;
    setZoomStep(wanted ? ZOOM_STEPS.length - 1 : 0);
    if (!wanted) return;
    const nextFrame = requestAnimationFrame(() => {
      const element = frame.current;
      if (element === null) return;
      element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    });
    return () => cancelAnimationFrame(nextFrame);
  }, [wanted, zoomable]);

  // When an action starts wanting the board, bring the board under the eye.
  const wasWanted = useRef(wanted);
  useEffect(() => {
    if (wanted && !wasWanted.current) {
      frame.current?.scrollIntoView?.({
        block: 'nearest',
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    }
    wasWanted.current = wanted;
  }, [reducedMotion, wanted]);

  // The toast leaves on its own; the selection ring stays until the area is tapped again.
  const [toastShown, setToastShown] = useState(false);
  useEffect(() => {
    if (selectedSlot === null) {
      setToastShown(false);
      return;
    }
    setToastShown(true);
    const timer = setTimeout(() => setToastShown(false), 4000);
    return () => clearTimeout(timer);
  }, [selectedSlot]);

  return (
    <section className="ms-board" aria-labelledby="board-heading" data-coach-anchor="board">
      <h2 id="board-heading" className="visually-hidden">Board</h2>

      {controlsVisible ? (
        <div className="ms-board__tools">
          <div className="ms-zoom" role="group" aria-label={zoomable ? 'Board magnification' : 'Target magnification'}>
            <button
              type="button"
              className="button button--quiet button--icon"
              disabled={zoomStep === 0}
              title="Zoom out"
              onClick={() => setZoomStep((current) => Math.max(0, current - 1))}
            >
              <span aria-hidden="true">−</span>
              <span className="visually-hidden">Zoom out</span>
            </button>
            <p className="ms-zoom__level" role="status">
              {zoom === 1 ? 'Fitted' : `${zoom}×`}
            </p>
            <button
              type="button"
              className="button button--quiet button--icon"
              disabled={zoomStep === ZOOM_STEPS.length - 1}
              title="Zoom in"
              onClick={() => setZoomStep((current) => Math.min(ZOOM_STEPS.length - 1, current + 1))}
            >
              <span aria-hidden="true">+</span>
              <span className="visually-hidden">Zoom in</span>
            </button>
            {zoomStep === 0 ? null : (
              <button type="button" className="button button--quiet" onClick={() => setZoomStep(0)}>
                Fit
              </button>
            )}
          </div>
        </div>
      ) : null}

      {targeting === null || targeting === undefined ? null : (
        <p
          key={`${targeting.label}:${targeting.slotIds.size === 0 ? 'none' : 'some'}`}
          className={`ms-board__call${targeting.slotIds.size === 0 ? ' ms-board__call--none' : ''}`}
          role="status"
        >
          <span className="ms-board__pin" aria-hidden="true" />
          <span>
            {targeting.slotIds.size === 0
              ? `No area on this board is a legal place to ${targeting.label}.`
              : targeting.slotIds.size > 40
                ? `Tap a ringed area to ${targeting.label}.`
                : `Tap one of the ${targeting.slotIds.size} ringed areas to ${targeting.label}.`}
          </span>
        </p>
      )}

      <div
        ref={frame}
        className={`board-frame ms-board__frame${zoom > 1 ? ' board-frame--zoomed' : ''}${wanted ? ' ms-board__frame--wanted' : ''}`}
        style={{ '--board-ratio': BOARD_VIEW_RATIO } as CSSProperties}
      >
        <div className="board-frame__inner" style={{ '--board-zoom': zoom } as CSSProperties}>
          <TableBoard
            key={view.matchId}
            zones={view.zones}
            slots={view.slots}
            players={view.players}
            summaries={zones}
            selectedSlotId={selectedSlotId}
            onSelectSlot={(slotId) => {
              setSelectedSlotId(slotId);
              if (slotId !== null && targeting?.slotIds.has(slotId) === true) onPickSlot?.(slotId);
            }}
            {...(targeting === null || targeting === undefined
              ? {}
              : { highlightedSlotIds: targeting.slotIds, highlightLabel: targeting.label })}
          />
        </div>
      </div>

      <p className={`ms-board__toast${toastShown && selectedSlot !== null ? ' ms-board__toast--on' : ''}`} role="status">
        {selectedSlot === null
          ? ''
          : describeSlot(selectedSlot, view.zones.find((zone) => zone.id === selectedSlot.zoneId), view.players)}
      </p>
    </section>
  );
}
