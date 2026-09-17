/**
 * The transport check route: proof that a local match survives a reload.
 *
 * Session 07 ships transport, not screens. The lobby and the table arrive later, so this
 * route exists to exercise the adapter against the real browser database and to show the
 * values a resume has to preserve — revision, pending interaction, deck order, random
 * state, debts and effect counters — where a reload can be seen to preserve them.
 *
 * It encodes no rule. Commands are typed as JSON and handed to the engine unchanged, so
 * this route can never disagree with the engine about what is legal.
 *
 * It is development-only. `vite.config.ts` resolves the virtual module that loads it to
 * `null` in both production builds, the same way it handles the content review. It
 * prints raw state, which is exactly what a production screen must not do.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { CORE_CONTENT, type GameConfig, type GameState } from '@gerrymander/engine';
import type { GameCommand } from '@gerrymander/protocol';

import {
  LOCAL_MODE_NOTICE,
  createLocalMatch,
  deleteLocalMatch,
  importLocalMatch,
  listLocalMatches,
  openIndexedDbStore,
  randomSeed,
  resumeLocalMatch,
  type LocalMatch,
  type LocalMatchSummary,
  type LocalSnapshotStore,
} from '../local';

const SEATS = [
  { id: 'p1', displayName: 'Asha', partyId: 'kite' },
  { id: 'p2', displayName: 'Bikram', partyId: 'lantern' },
  { id: 'p3', displayName: 'Chandni', partyId: 'sprout' },
] as const;

const EXAMPLE_COMMAND = JSON.stringify(
  { type: 'ChooseStartingResources', resources: { cash: 1, influence: 0, press: 0, faith: 0 } },
  null,
  2,
);

function newConfig(): GameConfig {
  return {
    matchId: `local-${Date.now().toString(36)}`,
    players: SEATS.map((seat) => ({ ...seat })),
    contentAdvisories: [],
    tiePolicy: 'jointWinners',
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The values a resume must reproduce exactly. */
function resumeFacts(state: GameState): readonly [string, string][] {
  const pending = state.pendingInteraction;
  return [
    ['Revision', String(state.revision)],
    ['Status', state.status],
    ['Phase', state.turn.phase],
    ['Active seat', state.turn.activePlayerId ?? '—'],
    ['Pending interaction', pending === null ? 'none' : `${pending.kind} · ${pending.id}`],
    ['Responsible seats', pending === null ? '—' : pending.responsiblePlayerIds.join(', ')],
    ['Interaction stack', String(state.interactionStack.length)],
    ['Random state', `${state.random.value} · ${state.random.draws} draws`],
    ['Voter draw pile', `${state.voterDeck.drawPile.length} cards`],
    ['Voter deck head', state.voterDeck.drawPile.slice(0, 4).join(', ') || '—'],
    ['Voter market', state.voterDeck.market.join(', ') || '—'],
    ['News deck head', state.newsDeck.drawPile.slice(0, 3).join(', ') || '—'],
    ['Debts', String(state.players.reduce((total, player) => total + player.debts.length, 0))],
    ['Obligations', String(state.players.reduce((total, player) => total + player.obligations.length, 0))],
    ['Active effects', String(state.activeEffects.length)],
    ['News queue', String(state.newsQueue.length)],
    ['Events recorded', String(state.events.length)],
  ];
}

export default function TransportCheck() {
  const [store, setStore] = useState<LocalSnapshotStore | null>(null);
  const [summaries, setSummaries] = useState<readonly LocalMatchSummary[]>([]);
  const [match, setMatch] = useState<LocalMatch | null>(null);
  const [revision, setRevision] = useState(-1);
  const [status, setStatus] = useState('Opening the local database…');
  const [failure, setFailure] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string>(SEATS[0].id);
  const [commandText, setCommandText] = useState(EXAMPLE_COMMAND);
  const [transferText, setTransferText] = useState('');

  const options = useMemo(
    () => (store === null ? null : { store, content: CORE_CONTENT }),
    [store],
  );

  const refresh = useCallback(async (open: LocalSnapshotStore) => {
    setSummaries(await listLocalMatches(open));
  }, []);

  const adopt = useCallback((resumed: LocalMatch | null, note: string) => {
    setMatch(resumed);
    setRevision(resumed?.revision() ?? -1);
    setStatus(note);
  }, []);

  // Open the database and resume the most recently saved readable match. Reloading the
  // page runs exactly this path, which is the check the session has to pass.
  useEffect(() => {
    let cancelled = false;
    let opened: LocalSnapshotStore | null = null;
    void (async () => {
      try {
        const open = await openIndexedDbStore();
        opened = open;
        if (cancelled) {
          open.close();
          return;
        }
        setStore(open);
        const saved = await listLocalMatches(open);
        if (cancelled) return;
        setSummaries(saved);
        const newest = saved.find((summary) => summary.unreadableReason === null);
        if (newest === undefined) {
          setStatus(
            saved.length === 0
              ? 'No saved match. Create one, then reload this page.'
              : 'Every saved match was written by a different build.',
          );
          return;
        }
        const resumed = await resumeLocalMatch({ store: open, content: CORE_CONTENT }, newest.matchId);
        if (cancelled) return;
        adopt(resumed, `Resumed ${newest.matchId} at revision ${resumed?.revision() ?? '?'}.`);
      } catch (error) {
        if (!cancelled) setFailure(describe(error));
      }
    })();
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [adopt]);

  const run = useCallback(
    (note: string, work: () => Promise<void>) => {
      setFailure(null);
      void work()
        .then(() => setStatus(note))
        .catch((error: unknown) => setFailure(describe(error)));
    },
    [],
  );

  if (failure !== null && store === null) {
    return (
      <div className="review">
        <header className="review__header">
          <h1>Transport check</h1>
        </header>
        <p className="review__warning">{failure}</p>
      </div>
    );
  }

  const state = match?.state() ?? null;
  const viewResult = match?.viewFor({ kind: 'player', playerId: viewerId }) ?? null;

  return (
    <div className="review">
      <header className="review__header">
        <div>
          <h1>Transport check</h1>
          <p>
            Development only. This route drives the local adapter against the browser
            database so a reload can be checked by hand.
          </p>
        </div>
        <p className="review__warning">{LOCAL_MODE_NOTICE}</p>
      </header>

      <p className="transport__status" role="status">
        {status}
        {revision >= 0 ? ` (revision ${revision})` : ''}
      </p>
      {failure === null ? null : (
        <p className="transport__failure" role="alert">
          {failure}
        </p>
      )}

      <section className="panel transport__panel">
        <h2>Saved matches</h2>
        <p className="panel__lede">
          Reloading the page resumes the newest readable save without any further action.
        </p>
        <div className="transport__actions">
          <button
            type="button"
            className="tab"
            disabled={options === null}
            onClick={() => {
              if (options === null) return;
              const config = newConfig();
              run(`Created ${config.matchId}.`, async () => {
                const created = await createLocalMatch(options, config, randomSeed());
                adopt(created, `Created ${config.matchId} at revision ${created.revision()}.`);
                await refresh(options.store);
              });
            }}
          >
            New three-seat match
          </button>
        </div>
        {summaries.length === 0 ? (
          <p>Nothing saved yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="transport__table">
              <thead>
                <tr>
                  <th scope="col">Match</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Status</th>
                  <th scope="col">Saved</th>
                  <th scope="col">Versions</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((summary) => (
                  <tr key={summary.matchId}>
                    <th scope="row">
                      {summary.matchId}
                      <span className="transport__seats">
                        {summary.players.map((player) => player.displayName).join(' · ')}
                      </span>
                    </th>
                    <td>{summary.revision}</td>
                    <td>{summary.status}</td>
                    <td>{summary.savedAt.replace('T', ' ').slice(0, 19)}</td>
                    <td>
                      schema {summary.schemaVersion} · content {summary.contentVersion} · board{' '}
                      {summary.boardVersion}
                      {summary.unreadableReason === null ? null : (
                        <span className="transport__failure">{summary.unreadableReason}</span>
                      )}
                    </td>
                    <td className="transport__actions">
                      <button
                        type="button"
                        className="tab"
                        disabled={options === null || summary.unreadableReason !== null}
                        onClick={() => {
                          if (options === null) return;
                          run(`Resumed ${summary.matchId}.`, async () => {
                            const resumed = await resumeLocalMatch(options, summary.matchId);
                            adopt(resumed, `Resumed ${summary.matchId} at revision ${resumed?.revision() ?? '?'}.`);
                          });
                        }}
                      >
                        Resume
                      </button>
                      <button
                        type="button"
                        className="tab"
                        disabled={options === null}
                        onClick={() => {
                          if (options === null) return;
                          run(`Read ${summary.matchId} into the transfer box.`, async () => {
                            const record = await options.store.read(summary.matchId);
                            setTransferText(record?.document ?? '');
                          });
                        }}
                      >
                        Export
                      </button>
                      <button
                        type="button"
                        className="tab"
                        disabled={options === null}
                        onClick={() => {
                          if (options === null) return;
                          run(`Deleted ${summary.matchId}.`, async () => {
                            await deleteLocalMatch(options.store, summary.matchId);
                            if (match?.matchId === summary.matchId) adopt(null, 'Deleted the open match.');
                            await refresh(options.store);
                          });
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {state === null || match === null ? null : (
        <section className="panel transport__panel">
          <h2>What a resume must reproduce</h2>
          <dl className="facts transport__facts">
            {resumeFacts(state).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <h3>Send a command</h3>
          <p className="method">
            The text is parsed as JSON and passed to the engine unchanged. This route knows
            no rules, so a rejection here is the engine’s answer, not this page’s.
          </p>
          <div className="transport__actions">
            <label>
              Seat
              <select value={viewerId} onChange={(event) => setViewerId(event.target.value)}>
                {SEATS.map((seat) => (
                  <option key={seat.id} value={seat.id}>
                    {seat.id} · {seat.displayName}
                  </option>
                ))}
              </select>
            </label>
            {SEATS.map((seat) => (
              <button
                key={seat.id}
                type="button"
                className="tab"
                onClick={() => {
                  const candidate = seat.id === 'p2' ? 'p1' : 'p2';
                  run(`${seat.id} voted.`, async () => {
                    const response = await match.submit(seat.id, {
                      type: 'VoteForFirstPlayer',
                      candidateId: candidate,
                    });
                    setRevision(match.revision());
                    if (options !== null) await refresh(options.store);
                    if (!response.ok) throw new Error(`${response.code}: ${response.message}`);
                  });
                }}
              >
                {seat.id} votes
              </button>
            ))}
          </div>
          <textarea
            className="transport__input"
            rows={5}
            value={commandText}
            onChange={(event) => setCommandText(event.target.value)}
            aria-label="Command JSON"
          />
          <div className="transport__actions">
            <button
              type="button"
              className="tab"
              onClick={() => {
                run(`Sent as ${viewerId}.`, async () => {
                  const command = JSON.parse(commandText) as GameCommand;
                  const response = await match.submit(viewerId, command);
                  setRevision(match.revision());
                  if (options !== null) await refresh(options.store);
                  if (!response.ok) throw new Error(`${response.code}: ${response.message}`);
                  setStatus(`Accepted at revision ${response.revision}.`);
                });
              }}
            >
              Send as {viewerId}
            </button>
          </div>

          <h3>Authorized view for {viewerId}</h3>
          {viewResult === null ? null : viewResult.ok ? (
            <pre className="transport__dump">
              {JSON.stringify(viewResult.view.prompt ?? 'no prompt for this seat', null, 2)}
            </pre>
          ) : (
            <p className="transport__failure" role="alert">
              {viewResult.message}
            </p>
          )}
        </section>
      )}

      <section className="panel transport__panel">
        <h2>Export and import</h2>
        <p className="panel__lede">
          Export writes the same document the database holds. Import rejects a save from a
          different schema, content pack or board and says which one does not match.
        </p>
        <textarea
          className="transport__input"
          rows={8}
          value={transferText}
          onChange={(event) => setTransferText(event.target.value)}
          aria-label="Save document"
        />
        <div className="transport__actions">
          <button
            type="button"
            className="tab"
            disabled={match === null}
            onClick={() => {
              if (match === null) return;
              setTransferText(match.exportDocument());
              setStatus(`Exported ${match.matchId}.`);
            }}
          >
            Export the open match
          </button>
          <button
            type="button"
            className="tab"
            disabled={options === null}
            onClick={() => {
              if (options === null) return;
              run('Imported the document.', async () => {
                const imported = await importLocalMatch(options, transferText);
                adopt(imported, `Imported ${imported.matchId} at revision ${imported.revision()}.`);
                await refresh(options.store);
              });
            }}
          >
            Import the document
          </button>
        </div>
      </section>
    </div>
  );
}
