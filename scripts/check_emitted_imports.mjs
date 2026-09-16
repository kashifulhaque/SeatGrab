#!/usr/bin/env node
/**
 * Assert that every import in the compiled Node output resolves under Node.
 *
 * Session 16 found an `ERR_MODULE_NOT_FOUND` that had made `pnpm start` unrunnable for
 * fifteen sessions. The cause is structural rather than careless: `tsconfig.base.json`
 * sets `moduleResolution: "Bundler"`, which lets a relative import omit its `.js`
 * extension, and `verbatimModuleSyntax` then emits the specifier exactly as written. Node
 * ESM does no extension search and no directory index lookup, so the omission typechecks,
 * passes every test — the test runner is a bundler — and breaks only the compiled server.
 *
 * Two assertions close it, and neither is enough alone.
 *
 * 1. **Every relative specifier in every emitted file resolves to a file that exists.**
 *    This reads `dist/` rather than `src/`, so it judges what was emitted rather than what
 *    the compiler was asked for, and it reaches modules no entry point imports.
 * 2. **Node itself loads the server's module graph.** `apps/server/dist/app.js` pulls in
 *    every route, the room service, the persistence layer and both workspace packages
 *    through Node's real resolver, including the `exports` maps and the workspace symlinks
 *    a static scan does not model. `app.js` rather than `index.js` because `index.js`
 *    calls `main()` on import: it would bind a port and wait. The static scan covers
 *    `index.js`, which is four imports long.
 *
 * The browser bundle is deliberately out of scope. Vite resolves its own graph and fails
 * the build on a specifier it cannot find, so an extensionless import there is caught
 * already; `scripts/check_build_privacy.mjs` is what judges that output.
 *
 * Run: node scripts/check_emitted_imports.mjs
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every `dist/` that Node loads directly. The web build is Vite's to judge. */
const OUTPUTS = [
  'packages/content/dist',
  'packages/protocol/dist',
  'packages/engine/dist',
  'packages/seat/dist',
  'packages/computer/dist',
  'apps/server/dist',
];

/**
 * The module graph Node is asked to load for real.
 *
 * It must be importable without side effects; see the note above about `index.js`.
 */
const SMOKE_ENTRY = 'apps/server/dist/app.js';

/**
 * Specifiers, from the three forms TypeScript emits.
 *
 * `import`/`export … from '…'`, bare `import '…'`, and `import('…')` with a literal
 * argument. A dynamic import built from a variable cannot be checked statically and this
 * repository has none; if one is ever added, the smoke load is what would catch it.
 */
const SPECIFIER_PATTERNS = [
  /(?:^|[\s;}])(?:import|export)[\s\S]{0,400}?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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

function relativeSpecifiers(text) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('./') || specifier.startsWith('../')) found.add(specifier);
    }
  }
  return [...found];
}

/**
 * Resolve a relative specifier the way Node ESM does, and no other way.
 *
 * Node appends nothing and searches nothing: the specifier names a file or it does not.
 * A `.d.ts` file's specifiers are written the same way and point at the `.js` beside the
 * declaration, so a declaration is checked against the runtime file its consumers load.
 */
async function resolvesUnderNode(fromFile, specifier) {
  const target = resolve(dirname(fromFile), specifier);
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  const unresolved = [];
  const extensionless = [];
  let scannedFiles = 0;
  let scannedSpecifiers = 0;

  for (const output of OUTPUTS) {
    const directory = join(ROOT, output);
    try {
      await stat(directory);
    } catch {
      console.error(`No compiled output at ${output}. Run \`pnpm typecheck\` first.`);
      process.exit(1);
    }

    for (const file of await walk(directory)) {
      if (!file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.mjs')) continue;
      scannedFiles += 1;
      const text = await readFile(file, 'utf8');
      for (const specifier of relativeSpecifiers(text)) {
        scannedSpecifiers += 1;
        const where = `${relative(ROOT, file)}: ${specifier}`;
        // Named separately because it is the one mistake this check exists for, and an
        // author who sees the extension named fixes it without reading the rest.
        if (!/\.(?:js|mjs|cjs|json|node)$/.test(specifier)) extensionless.push(where);
        else if (!(await resolvesUnderNode(file, specifier))) unresolved.push(where);
      }
    }
  }

  check(`compiled output scanned`, scannedFiles > 0,
        `${scannedFiles} files, ${scannedSpecifiers} relative imports`);
  check('every relative import carries a file extension', !extensionless.length,
        extensionless.length
          ? extensionless.slice(0, 10).join('; ')
          : 'Node ESM does no extension search, so an omission breaks only the compiled output');
  check('every relative import resolves to a file that exists', !unresolved.length,
        unresolved.slice(0, 10).join('; '));

  // The real resolver, over the real graph: `exports` maps, workspace symlinks and all.
  const entry = join(ROOT, SMOKE_ENTRY);
  try {
    await run(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(entry)});`], { cwd: ROOT });
    check(`Node loads ${SMOKE_ENTRY}`, true, 'the server module graph resolves');
  } catch (error) {
    const said = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim() || String(error);
    check(`Node loads ${SMOKE_ENTRY}`, false, said.split('\n').slice(0, 6).join(' / '));
  }

  console.log();
  if (failures.length) {
    console.log(`${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('all checks passed');
}

await main();
