/**
 * Re-export shim. The derivations moved to `@seatgrab/seat` so the server can import them
 * for the computer opponent; the twelve source files and several tests that import this
 * path keep working unchanged. Removing the shim is a follow-up.
 */
export * from '@seatgrab/seat';
