/**
 * The voters a seat still has to place, as tokens along the top edge of the action sheet.
 *
 * A purchase used to produce a sentence — "3 voters waiting to be placed" — and a button
 * some way down a column. Here it produces three discs in the buyer's colours, sitting on
 * the sheet like pieces waiting on the table's edge. Tapping the group opens the place
 * draft, and as each area is picked one token leaves the tray, so the count still to
 * place is something you can see rather than read.
 *
 * It decides nothing. The groups come from `pendingVoterGroups` and the picks from the
 * draft; `legalPlacementSlotIds` in `actions.ts` still says where a voter may go.
 */
import { useEffect, useRef, type CSSProperties } from 'react';

import type { PlayerView } from '@gerrymander/protocol';

import { PARTY_BY_ID } from '../../assets/manifest';
import type { ActionDraft, DraftAction } from '../actions';

export function VoterTray({
  view,
  seatId,
  draft,
  dispatch,
  busy,
}: {
  view: PlayerView;
  seatId: string;
  draft: ActionDraft;
  dispatch: (action: DraftAction) => void;
  busy: boolean;
}) {
  const groups = view.pendingVoterGroups.filter((group) => group.controllerId === seatId);
  const previous = useRef<{ seatId: string; ids: ReadonlySet<string> } | null>(null);
  const added = previous.current?.seatId === seatId
    ? new Set(groups.filter((group) => !previous.current?.ids.has(group.id)).map((group) => group.id))
    : new Set<string>();
  useEffect(() => {
    previous.current = { seatId, ids: new Set(groups.map((group) => group.id)) };
  }, [groups, seatId]);
  if (groups.length === 0) return null;
  return (
    <div className="ms-tray" role="group" aria-label="Voters waiting to be placed" data-coach-anchor="tray">
      {groups.map((group) => {
        const owner = view.players.find((player) => player.id === group.ownerId);
        const party = owner === undefined ? undefined : PARTY_BY_ID.get(owner.partyId);
        const open = draft.kind === 'place' && draft.groupId === group.id;
        const placed = open ? draft.slotIds.length : 0;
        return (
          <button
            key={group.id}
            type="button"
            className={`ms-tray__group${open ? ' ms-tray__group--open' : ''}`}
            style={party === undefined ? undefined : ({ '--party': party.color } as CSSProperties)}
            aria-pressed={open}
            disabled={busy}
            onClick={() => dispatch({
              type: 'open',
              draft: { kind: 'place', groupId: group.id, slotIds: [], zoneId: null },
            })}
          >
            <span className="ms-tray__tokens" aria-hidden="true">
              {Array.from({ length: group.count }, (_, index) => (
                <span
                  key={index}
                  className={`ms-token${added.has(group.id) ? ' ms-token--arriving' : ''}${index < placed ? ' ms-token--placed' : ''}`}
                  style={{ '--i': index } as CSSProperties}
                >
                  {party === undefined ? null : <img src={party.url} alt="" />}
                </span>
              ))}
            </span>
            <span className="ms-tray__label">
              {open
                ? `${group.count - placed} of ${group.count} to place`
                : `Place ${group.count} voter${group.count === 1 ? '' : 's'}`}
              {owner !== undefined && owner.id !== seatId ? ` for ${owner.displayName}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
