/**
 * The two fields every online seat is claimed with, and the disclosure that goes with
 * claiming one.
 *
 * Hosting a room and joining one differ in almost everything — one names the table, the
 * other finds it — but both end in the same request: a name the other players will see
 * and a party emblem nobody else at that table holds. Drawing those two fields once means
 * the host and the join screens cannot disagree about what a seat is.
 *
 * `CredentialNotice` is the other half. The server issues a seat credential exactly once,
 * at the moment of the claim, and has no route that reissues one; that is deliberate,
 * because a room code is shareable and reissuing from one would hand an occupied seat to
 * anyone who read the group chat. The consequence belongs in front of the player *before*
 * they claim, not after they lose it, so it is a disclosure on both forms rather than a
 * confirmation afterwards.
 */
import type { PartyIdentity } from '../assets/parties';

import { PartyMark } from './PartyMark';
import { MAX_NAME_LENGTH } from './setup';
import type { OnlineProblem } from './online';
import { problemsFor } from './online';

export function SeatIdentityFields({
  idPrefix,
  displayName,
  partyId,
  parties,
  problems,
  disabled = false,
  onName,
  onParty,
}: {
  /** Prefix for the field IDs, so two of these can share a screen. */
  idPrefix: string;
  displayName: string;
  partyId: string;
  /** The identities still free at this table. */
  parties: readonly PartyIdentity[];
  problems: readonly OnlineProblem[];
  disabled?: boolean;
  onName: (value: string) => void;
  onParty: (value: string) => void;
}) {
  const nameProblems = problemsFor(problems, 'displayName');
  const partyProblems = problemsFor(problems, 'partyId');
  const nameId = `${idPrefix}-name`;
  const partyFieldId = `${idPrefix}-party`;
  return (
    <div className="seat seat--identity">
      <div className="seat__field">
        <label htmlFor={nameId}>Your name</label>
        <input
          id={nameId}
          className="input"
          value={displayName}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={nameProblems.length > 0}
          aria-describedby={nameProblems.length > 0 ? `${nameId}-problem` : undefined}
          onChange={(event) => onName(event.target.value)}
        />
        {nameProblems.map((problem) => (
          <p key={problem.message} id={`${nameId}-problem`} className="field-problem">
            {problem.message}
          </p>
        ))}
        <span className="hint">
          Everyone at the table sees this name. Your cards are never sent to their devices.
        </span>
      </div>

      <div className="seat__field">
        <label htmlFor={partyFieldId}>Your party</label>
        <span className="seat__party">
          <PartyMark partyId={partyId} size={28} />
          <select
            id={partyFieldId}
            className="input"
            value={partyId}
            disabled={disabled}
            aria-invalid={partyProblems.length > 0}
            onChange={(event) => onParty(event.target.value)}
          >
            {parties.map((party) => (
              <option key={party.partyId} value={party.partyId}>
                {party.displayName} — {party.description}
              </option>
            ))}
          </select>
        </span>
        {partyProblems.map((problem) => (
          <p key={problem.message} className="field-problem">
            {problem.message}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * What claiming a seat puts in this browser, and what losing it would cost.
 *
 * `storable` is false when this browser will not keep anything across a reload, which
 * makes claiming a seat unsafe rather than merely inconvenient: an unclaimable seat can
 * never be filled again, and a room with an empty seat can never be started, so one
 * player's blocked storage would strand the whole table.
 */
export function CredentialNotice({
  storable,
  unavailableReason,
}: {
  storable: boolean;
  unavailableReason: string | null;
}) {
  return storable ? (
    <p className="notice">
      Claiming a seat gives this browser a seat credential, and it is saved here. It is
      issued once and never reissued, so this browser — this profile, on this device — is
      the only thing that can act for your seat. If you clear this site&rsquo;s data or open
      the room somewhere else, the host can free your seat from the lobby and you can claim
      it again with the room code — but only until the table is dealt. After that, seats
      lock and the table has to open a new room.
    </p>
  ) : (
    <p className="alert alert--error" role="alert">
      This browser will not keep a seat credential: {unavailableReason ?? 'local storage is unavailable.'}{' '}
      Claiming a seat is disabled, because the credential is issued once and cannot be
      reissued: the seat would be unusable at the next reload, and a room with a seat
      nobody holds can never be started.
    </p>
  );
}
