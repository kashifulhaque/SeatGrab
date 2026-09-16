/**
 * What one seat can see and do, derived from its own `PlayerView`.
 *
 * `actions.ts` holds the composers' derivations: costs, payments, legal placement, choice
 * models, hand cards and reaction cards. `table.ts` holds what the shared table says:
 * slot ordinals, zone summaries, decision banners and phase names. Both read only the
 * projection and the content pack, so the browser and the server can import them alike.
 * The computer opponent in `@seatgrab/computer` is built on nothing else.
 */
export * from './actions.js';
export * from './table.js';
