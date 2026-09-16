import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TRANSPORT_COMPONENT = join(
  REPO_ROOT, 'apps', 'web', 'src', 'transport-check', 'TransportCheck.tsx',
);
const ONLINE_COMPONENT = join(REPO_ROOT, 'apps', 'web', 'src', 'app', 'OnlineRoutes.tsx');

/** Every development-only route, and the component each resolves to while serving. */
const DEV_ROUTES = [
  { virtual: 'virtual:seatgrab-transport-check', component: TRANSPORT_COMPONENT },
] as const;

/**
 * Resolve each development-only route to its real component while the dev server is
 * running, and to `null` in a production build, so neither the route nor anything it
 * imports can survive into a shipped bundle.
 */
function devRoutes(command: 'serve' | 'build'): Plugin {
  const resolved = new Map(DEV_ROUTES.map((route) => [`\0${route.virtual}`, route.component]));
  return {
    name: 'seatgrab:dev-routes',
    resolveId(source) {
      return resolved.has(`\0${source}`) ? `\0${source}` : null;
    },
    load(id) {
      const component = resolved.get(id);
      if (component === undefined) return null;
      return command === 'serve'
        ? `export { default } from ${JSON.stringify(component)};`
        : 'export default null;';
    },
  };
}

/**
 * Resolve the online route family to its screens, or to `null` in the local build.
 *
 * The pass-and-play build states on its home screen that it carries no network code, and
 * this is what makes that true: `OnlineRoutes.tsx` is the only module that imports the
 * online screens, and they are the only modules that import `src/remote/`, so stubbing
 * this one module keeps the socket, the room client and the seat store out of that bundle
 * entirely rather than merely out of reach.
 *
 * The gate is the Vite mode and nothing else, so it is the same decision that sets
 * `__LOCAL_MODE__`: the sentence the home screen prints about this build and the modules
 * the build actually contains cannot disagree. `pnpm dev` serves the online mode, which is
 * what the room server beside it is for; `pnpm --filter @seatgrab/web dev:local` serves the
 * pass-and-play build as it ships.
 */
function onlineRoutes(local: boolean): Plugin {
  const id = '\0virtual:seatgrab-online';
  return {
    name: 'seatgrab:online-routes',
    resolveId(source) {
      return source === 'virtual:seatgrab-online' ? id : null;
    },
    load(loaded) {
      if (loaded !== id) return null;
      return local
        ? 'export default null;'
        : `export { default } from ${JSON.stringify(ONLINE_COMPONENT)};`;
    },
  };
}

/**
 * Stamp the emitted HTML with the mode it was built in.
 *
 * The two builds differ in what they contain, and a deployment has no other way to say
 * which one it is serving: `__LOCAL_MODE__` is inlined into expressions and minified away,
 * and neither virtual module survives into a source map, so there is nothing in a chunk to
 * read. A meta tag survives both builds unchanged, is visible in view-source to an
 * operator, and is what `scripts/check_build_privacy.mjs` reads to know which set of
 * assertions a `dist/` is owed.
 */
function buildMarker(mode: string): Plugin {
  const value = mode === 'online' ? 'online' : 'local-play';
  return {
    name: 'seatgrab:build-marker',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta name="seatgrab-build" content="${value}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    devRoutes(command),
    onlineRoutes(mode !== 'online'),
    buildMarker(mode),
  ],
  define: {
    __LOCAL_MODE__: JSON.stringify(mode !== 'online'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    /**
     * Maps are built, but nothing in the bundle points at them.
     *
     * Session 16 had to decide whether a deployment publishes the application source,
     * which `sourcemap: true` does: every map carries `sourcesContent`, and the
     * `sourceMappingURL` comment tells the browser to go and fetch it.
     *
     * Turning maps off entirely was the obvious answer and is the wrong one, because
     * `scripts/check_build_privacy.mjs` reads them. Its two strongest assertions — that
     * no development route and no online module was compiled into a chunk — work by
     * looking at what each chunk was built from, and a build with no maps would pass
     * both by having nothing to look at.
     *
     * `'hidden'` keeps the maps for the check and removes the comment, so a browser
     * never asks for one. The maps are then a build artifact rather than part of the
     * site: a deployment copies `dist/` **without** its `.map` files, and `check:build`
     * asserts that nothing in the bundle links to one.
     */
    sourcemap: 'hidden',
  },
}));
