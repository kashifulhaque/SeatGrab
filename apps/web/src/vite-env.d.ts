/// <reference types="vite/client" />

/**
 * The content-review route, or `null` in a production build.
 *
 * `vite.config.ts` resolves this module to the real component only while the dev server
 * is running. A production build gets `export default null`, so neither the route nor
 * anything it imports reaches the bundle.
 */
/**
 * The transport-check route, or `null` in a production build.
 *
 * Resolved the same way as the content review: the real component only while the dev
 * server is running.
 */
declare module 'virtual:seatgrab-transport-check' {
  const TransportCheck: (() => import('react').ReactElement) | null;
  export default TransportCheck;
}

/**
 * The `#/online` route family, or `null` in the pass-and-play build.
 *
 * `vite.config.ts` resolves this to the real screens only when the Vite mode is `online`,
 * which is the same decision that sets `__LOCAL_MODE__`. It is the single module the
 * online screens — and through them `src/remote/` — are reached by, so a local build that
 * says it carries no network code contains none.
 */
declare module 'virtual:seatgrab-online' {
  const OnlineRoutes:
    | ((props: { route: import('./app/routes').OnlineRoute }) => import('react').ReactElement)
    | null;
  export default OnlineRoutes;
}

/**
 * Whether this build was produced for pass-and-play only.
 *
 * `vite.config.ts` defines it as `mode !== 'online'`, so the local build can state
 * plainly that it contains no network code rather than offering a room it cannot open.
 */
declare const __LOCAL_MODE__: boolean;
