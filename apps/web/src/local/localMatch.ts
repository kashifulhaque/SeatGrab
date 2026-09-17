/**
 * The local transport adapter.
 *
 * This is the pass-and-play equivalent of the online transport: the browser holds the
 * authoritative state, applies commands with the engine, projects an authorized view per
 * seat, and saves the result. It wraps `createGame`, `applyCommand` and `projectGame` and
 * reimplements no rule. Anything a rule decides belongs in the engine.
 *
 * Every accepted command is saved before `submit` resolves, so a reload can never land
 * between an accepted command and its save.
 */
import type { CommandResponse, GameCommand, PlayerView } from '@gerrymander/protocol';
import {
  applyCommand,
  createGame,
  projectGame,
  type GameConfig,
  type GameContent,
  type GameState,
  type Viewer,
} from '@gerrymander/engine';

import {
  buildEnvelope,
  readDocument,
  recheckSummary,
  summarize,
  writeDocument,
  type LocalMatchSummary,
} from './snapshot';
import type { LocalSnapshotStore } from './store';

export interface LocalMatchOptions {
  store: LocalSnapshotStore;
  content: GameContent;
  /** Injected so tests can pin the save timestamp. It is metadata; no rule reads it. */
  now?: () => Date;
}

/**
 * A projected view, or a refusal to render one.
 *
 * `projectChoiceContext` answers `{ op: 'unsupported' }` when the engine opened a
 * continuation the view contract does not describe, which a compiled build reaches only
 * through a hand-edited or otherwise corrupt save. The client must refuse that prompt
 * rather than render an empty one, so the adapter reports it instead of hiding it. The
 * view is still returned, so the table can show the board and the failure together.
 */
export type LocalViewResult =
  | { ok: true; view: PlayerView }
  | { ok: false; code: 'UNSUPPORTED_PROMPT'; message: string; view: PlayerView };

export interface LocalMatch {
  readonly matchId: string;
  /** The authoritative state. Treat it as read-only; commands go through `submit`. */
  state(): GameState;
  revision(): number;
  summary(): LocalMatchSummary;
  submit(playerId: string, command: GameCommand): Promise<CommandResponse>;
  viewFor(viewer: Viewer): LocalViewResult;
  /** The save document for this revision, for download or for a manual copy. */
  exportDocument(): string;
  /** Notifies on every accepted command. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** A seed for a new local match, from the browser's cryptographic generator. */
export function randomSeed(): number {
  const source = globalThis.crypto;
  if (source?.getRandomValues === undefined) {
    throw new Error('This browser has no cryptographic random source, so a match cannot be seeded.');
  }
  const values = new Uint32Array(1);
  source.getRandomValues(values);
  return values[0] ?? 0;
}

interface Binding {
  match: LocalMatch;
  /** Writes the current revision to the store. */
  save: () => Promise<void>;
}

function bind(options: LocalMatchOptions, initial: GameState): Binding {
  const clock = options.now ?? (() => new Date());
  let current = initial;
  const listeners = new Set<() => void>();

  async function save(): Promise<void> {
    const savedAt = clock();
    await options.store.write({
      summary: summarize(buildEnvelope(current, savedAt)),
      document: writeDocument(current, savedAt),
    });
  }

  const match: LocalMatch = {
    matchId: current.matchId,
    state: () => current,
    revision: () => current.revision,
    summary: () => summarize(buildEnvelope(current, clock())),
    async submit(playerId, command) {
      const result = applyCommand(current, { playerId }, command, options.content);
      if (!result.ok) return result.response;
      current = result.state;
      await save();
      for (const listener of listeners) listener();
      return result.response;
    },
    viewFor(viewer) {
      const view = projectGame(current, viewer, options.content);
      const prompt = view.prompt;
      if (prompt?.kind === 'choice' && prompt.context.op === 'unsupported') {
        return {
          ok: false,
          code: 'UNSUPPORTED_PROMPT',
          message:
            'This build cannot describe the prompt the match is waiting on (interaction '
            + `${prompt.interactionId}). The save is from a build with a choice this one does not `
            + 'know, or it was edited by hand. Do not act on it.',
          view,
        };
      }
      return { ok: true, view };
    },
    exportDocument: () => writeDocument(current, clock()),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { match, save };
}

/** Save the opening revision too, so a reload right after creation resumes it. */
async function bindAndSave(options: LocalMatchOptions, state: GameState): Promise<LocalMatch> {
  const { match, save } = bind(options, state);
  await save();
  return match;
}

/** Create a local match and save it before it is handed back. */
export async function createLocalMatch(
  options: LocalMatchOptions,
  config: GameConfig,
  seed: number = randomSeed(),
): Promise<LocalMatch> {
  return bindAndSave(options, createGame(config, options.content, seed));
}

/**
 * Resume a saved match.
 *
 * Returns `null` when no save carries that match ID. A save this build cannot read
 * throws `LocalSnapshotError` naming the version that does not match.
 */
export async function resumeLocalMatch(
  options: LocalMatchOptions,
  matchId: string,
): Promise<LocalMatch | null> {
  const record = await options.store.read(matchId);
  if (record === null) return null;
  const { state } = readDocument(record.document, options.content);
  return bind(options, state).match;
}

/**
 * Import a save document and store it.
 *
 * A document from another content pack, board or schema is rejected before it reaches
 * the store, so an unreadable save cannot displace a readable one.
 */
export async function importLocalMatch(
  options: LocalMatchOptions,
  document: string,
): Promise<LocalMatch> {
  const { state } = readDocument(document, options.content);
  return bindAndSave(options, state);
}

/**
 * The saved matches, each re-checked against the versions this build ships.
 *
 * A stored summary records what the saving build believed, so readability is recomputed
 * here: a save written before a content or board change must list as unreadable rather
 * than as the readable save it once was.
 */
export async function listLocalMatches(
  store: LocalSnapshotStore,
): Promise<readonly LocalMatchSummary[]> {
  return (await store.list()).map(recheckSummary);
}

export async function deleteLocalMatch(store: LocalSnapshotStore, matchId: string): Promise<void> {
  await store.remove(matchId);
}
