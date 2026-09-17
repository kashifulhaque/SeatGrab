/**
 * The surface every match adapter presents, whichever side of the wire holds the state.
 *
 * `MatchShell` and every composer are written against this and nothing wider. The local
 * adapter satisfies it by holding the authoritative state in the browser; the remote one
 * satisfies it by holding a seat's latest authorized projection and a socket. Neither
 * screen nor composer can tell which it has, which is the point: a rule is decided in
 * exactly one place either way, and it is never here.
 *
 * Two members of `LocalMatch` are deliberately **not** in this surface:
 *
 * - `state()`, the authoritative `GameState`. An online client has none; the server does,
 *   and the whole of what a seat may know about it is its projection.
 * - `exportDocument()`, the full-state save. Section 14.3 forbids a live online game from
 *   offering an ordinary player a full-state export, so the remote adapter has no such
 *   method to call rather than a method that refuses.
 */
import type { CommandResponse, GameCommand, PlayerView } from '@gerrymander/protocol';
import type { Viewer } from '@gerrymander/engine';

/**
 * A projected view, or a refusal to render one.
 *
 * `UNSUPPORTED_PROMPT` is the engine having opened a continuation `ChoicePromptContext`
 * does not describe. A screen must refuse that prompt rather than draw an empty one; the
 * view comes with it so the table can show the board and the failure together. The local
 * adapter finds this itself, and the server reports the same condition as
 * `SeatView.promptProblem`.
 *
 * `NO_PROJECTION` is a viewer this adapter cannot answer for at all, and there is no view
 * to show. A remote adapter holds one seat's projection: it has no public projection and
 * no other seat's, because the server produced neither for it. A screen asking for one is
 * asking for something that does not exist rather than something being withheld.
 */
export type MatchViewResult =
  | { ok: true; view: PlayerView }
  | { ok: false; code: 'UNSUPPORTED_PROMPT'; message: string; view: PlayerView }
  | { ok: false; code: 'NO_PROJECTION'; message: string; view: null };

/**
 * A view result that carries a view, whatever it says about the prompt.
 *
 * This is what a seat's controls are written against. `NO_PROJECTION` is not in it
 * because there is nothing to draw in that case at all — not an empty table, not a
 * disabled composer — and a screen that has one shows the connection instead. Narrowing
 * it away is the screen's job, and doing it once at the top of a screen is why no
 * composer below has to ask whether it has a view.
 *
 * `LocalViewResult` is structurally this type: the local adapter always has a projection,
 * so it never had a third case to exclude.
 */
export type DrawableViewResult = Exclude<MatchViewResult, { code: 'NO_PROJECTION' }>;

export interface MatchSurface {
  readonly matchId: string;
  /** The revision the last projection carried. */
  revision(): number;
  /**
   * Send one command for a seat.
   *
   * Resolves with the engine's own answer, refusals included: a refused command is a
   * ruling about the game, and its message is written to be read by a player. Rejects
   * only when the command could not be put to the engine at all — a save that would not
   * write, a connection that would not carry it.
   */
  submit(playerId: string, command: GameCommand): Promise<CommandResponse>;
  viewFor(viewer: Viewer): MatchViewResult;
  /** Notifies on every change a screen must repaint for. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}
