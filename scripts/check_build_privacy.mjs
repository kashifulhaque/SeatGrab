#!/usr/bin/env node
/**
 * Assert that a production web build ships no development surface, no raster image, and
 * that the pass-and-play build ships no network code.
 *
 * The transport-check route prints raw match state and must not reach a build. This check
 * reads what Vite actually emitted rather than trusting a dead-code branch to have been
 * eliminated. Both builds emit hidden source maps with full `sourcesContent`, which the
 * checks below read to prove what was compiled into a chunk; no chunk links to a map, and
 * a deployment copies `dist/` without its `.map` files.
 *
 * Run: node scripts/check_build_privacy.mjs [dist directory]
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(process.argv[2] ?? join(ROOT, 'apps', 'web', 'dist'));

/** Text that only the development surfaces contain. */
const FORBIDDEN_TEXT = [
  'Development only. This route',
  'The transport check route',
];

/** Every development-only route, by virtual module ID and source directory. */
const DEV_ROUTES = [
  { virtual: 'virtual:seatgrab-transport-check', directory: 'transport-check/' },
];

/**
 * The online surface, which the pass-and-play build must not contain at all.
 *
 * `src/remote/` is the socket, the room client and the seat credential store; the
 * `Online*` screens are the only modules that import it. Both are reached only through
 * `virtual:seatgrab-online`, so stubbing that one module keeps all of it out.
 */
const ONLINE_MODULES = [
  { virtual: 'virtual:seatgrab-online', directory: 'src/remote/' },
  { virtual: 'virtual:seatgrab-online', directory: 'app/Online' },
];

/** The meta tag `vite.config.ts` stamps every build's HTML with. */
const BUILD_MARKER = /<meta name="seatgrab-build" content="([a-z-]+)"/;
/** What a development-only route module must compile to outside the dev server. */
const EMPTY_ROUTE = 'export default null;';

/** Leading bytes of common raster image containers. The application ships only SVG. */
const PHOTO_SIGNATURES = [
  { label: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { label: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: 'HEIC/AVIF', bytes: [0x00, 0x00, 0x00], offset: 4, ascii: 'ftyp' },
];

const failures = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

function looksLikeRaster(buffer) {
  for (const signature of PHOTO_SIGNATURES) {
    if (signature.ascii) {
      if (buffer.subarray(signature.offset, signature.offset + 4).toString('latin1')
          === signature.ascii) {
        return signature.label;
      }
      continue;
    }
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) {
      return signature.label;
    }
  }
  return null;
}

async function main() {
  try {
    await stat(DIST);
  } catch {
    console.error(`No build at ${DIST}. Run a web build first.`);
    process.exit(1);
  }

  const files = await walk(DIST);
  check(`build exists at ${relative(ROOT, DIST)}`, files.length > 0, `${files.length} files`);

  const rasterFiles = [];
  const textHits = [];
  /** The executable text of every emitted non-map file, for the checks further down. */
  const rawText = new Map();
  for (const file of files) {
    const buffer = await readFile(file);
    const format = looksLikeRaster(buffer);
    if (format) rasterFiles.push(`${relative(DIST, file)} (${format})`);

    // Source maps carry original source by design, including branches the build
    // eliminated. What must be clean is what the browser executes.
    if (file.endsWith('.map')) continue;
    const text = buffer.toString('utf8');
    rawText.set(file, text);
    for (const needle of FORBIDDEN_TEXT) {
      if (text.includes(needle)) textHits.push(`${relative(DIST, file)}: ${needle}`);
    }
  }

  check('no bundled file is a raster image', !rasterFiles.length,
        rasterFiles.slice(0, 5).join(', '));
  check('no development endpoint or review route runs in the build', !textHits.length,
        textHits.slice(0, 5).join('; '));

  // A source map names every module the chunk was built from. If a development-only
  // route is one of them, the build must have replaced its contents with the empty stub.
  const populated = [];
  const devModules = [];
  for (const file of files.filter((path) => path.endsWith('.map'))) {
    const map = JSON.parse(await readFile(file, 'utf8'));
    (map.sources ?? []).forEach((source, index) => {
      const route = DEV_ROUTES.find(
        ({ virtual, directory }) => source.includes(virtual) || source.includes(directory),
      );
      if (!route) return;
      devModules.push(`${relative(DIST, file)}: ${source}`);
      const contents = (map.sourcesContent ?? [])[index] ?? '';
      if (contents.trim() !== EMPTY_ROUTE) populated.push(`${relative(DIST, file)}: ${source}`);
    });
  }
  check('no development route module was compiled into a chunk', !populated.length,
        populated.length
          ? populated.slice(0, 5).join('; ')
          : devModules.length
            ? `${devModules.length} development route module(s) present, all stubbed`
            : 'no development route module reached a chunk');

  // Which of the two builds this is, read from the tag the build stamps its HTML with.
  // A build that does not say is not assumed to be either: the local build's assertions
  // would pass vacuously against an online one, which is the failure worth avoiding.
  const scripts = files.filter((path) => path.endsWith('.js'));
  const html = files.filter((path) => path.endsWith('.html'));
  const marks = new Set();
  for (const file of html) {
    const found = BUILD_MARKER.exec(rawText.get(file) ?? '');
    if (found) marks.add(found[1]);
  }
  check('the build says which mode it was built in', marks.size === 1,
        marks.size === 1 ? `mode ${[...marks][0]}` : `${marks.size} build markers found`);

  if (!marks.has('local-play')) {
    check('build identified', marks.has('online'),
          'online build — the online surface is expected in it');
  } else {
    const onlineInChunks = [];
    for (const file of files.filter((path) => path.endsWith('.map'))) {
      const map = JSON.parse(await readFile(file, 'utf8'));
      (map.sources ?? []).forEach((source, index) => {
        const hit = ONLINE_MODULES.find(
          ({ virtual, directory }) => source.includes(virtual) || source.includes(directory),
        );
        if (!hit) return;
        const contents = (map.sourcesContent ?? [])[index] ?? '';
        if (contents.trim() !== EMPTY_ROUTE) {
          onlineInChunks.push(`${relative(DIST, file)}: ${source}`);
        }
      });
    }
    check('build identified', true, 'pass-and-play build — it must carry no network code');
    check('the pass-and-play build compiled in no online module', !onlineInChunks.length,
          onlineInChunks.slice(0, 5).join('; '));
    check('the pass-and-play build opens no WebSocket', 
          !scripts.some((file) => rawText.get(file)?.includes('new WebSocket(')),
          'the online socket is the only WebSocket in this application');
  }

  // Maps are built for the two checks above and are not part of the site. What must be
  // true of the bundle is that nothing asks a browser to fetch one.
  const linked = scripts.filter((file) => /sourceMappingURL=/.test(rawText.get(file) ?? ''));
  check('no emitted script links to a source map', !linked.length,
        linked.length
          ? linked.slice(0, 5).map((file) => relative(DIST, file)).join(', ')
          : 'built hidden, so a browser never fetches one');

  const maps = files.filter((path) => path.endsWith('.map'));
  check('source maps are present for this check to read', maps.length > 0,
        `${maps.length} map(s) — do not deploy these files`);
  for (const file of maps) console.log(`      exclude from deployment: ${relative(DIST, file)}`);

  console.log();
  if (failures.length) {
    console.log(`${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('all checks passed');
}

await main();
