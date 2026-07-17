/**
 * Pack smoke test: `files: ["dist"]` ships the WHOLE directory, so a stale
 * `dist/` (built before a source deletion, or without the prebuild clean) would
 * publish deleted modules. Fails when any emitted module lacks a live source,
 * when the bin entry is missing or non-executable. Runs from `prepack`, after
 * the build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const SRC = join(ROOT, 'src');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const binRelative = packageJson.bin?.['secure-telegram-mcp'];

if (typeof binRelative !== 'string') {
  console.error('check-dist: package.json has no secure-telegram-mcp bin entry.');
  process.exit(1);
}

const BIN_ENTRY = join(ROOT, binRelative);

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
};

if (!existsSync(DIST)) {
  console.error('check-dist: dist/ does not exist — run the build first.');
  process.exit(1);
}

const stale = [];
const unknown = [];
for (const file of walk(DIST)) {
  const rel = relative(DIST, file);
  // Every emitted artifact maps back to one TS source: x.js / x.d.ts /
  // x.js.map / x.d.ts.map <- x.ts or x.tsx. `files: ["dist"]` ships the WHOLE
  // directory, so anything else in dist/ would be published too — reject it.
  const base = rel.replace(/\.(?:d\.ts|js)(?:\.map)?$/, '');
  if (base === rel) {
    unknown.push(rel);
    continue;
  }
  if (
    !existsSync(join(SRC, `${base}.ts`)) &&
    !existsSync(join(SRC, `${base}.tsx`))
  ) {
    stale.push(rel);
  }
}

if (stale.length > 0 || unknown.length > 0) {
  if (stale.length > 0) {
    console.error(
      `check-dist: ${String(stale.length)} stale artifact(s) without a live source (clean build required):`,
    );
    for (const rel of stale) console.error(`  dist/${rel}`);
  }
  if (unknown.length > 0) {
    console.error(
      `check-dist: ${String(unknown.length)} non-tsc file(s) in dist would be published:`,
    );
    for (const rel of unknown) console.error(`  dist/${rel}`);
  }
  process.exit(1);
}

if (!existsSync(BIN_ENTRY)) {
  console.error(`check-dist: bin entry ${binRelative} is missing.`);
  process.exit(1);
}

if (!readFileSync(BIN_ENTRY, 'utf8').startsWith('#!/usr/bin/env node\n')) {
  console.error(`check-dist: bin entry ${binRelative} has no Node shebang.`);
  process.exit(1);
}

if (process.platform !== 'win32' && (statSync(BIN_ENTRY).mode & 0o111) === 0) {
  console.error(`check-dist: bin entry ${binRelative} is not executable.`);
  process.exit(1);
}

console.log('check-dist: dist matches src; bin entry present and executable.');
