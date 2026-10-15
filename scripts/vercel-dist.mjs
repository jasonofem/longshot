#!/usr/bin/env node
/**
 * vercel-dist.mjs — assemble the static payload Vercel should publish.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const LIB = path.join(ROOT, 'lib');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(PUB, 'vendor', 'engine.bundle.mjs');

function fail(msg) {
  console.error(`\n  ✗ vercel-dist: ${msg}\n`);
  process.exit(1);
}

if (!statSync(PUB).isDirectory()) fail('public/ is missing');

let bundleMtime;
try {
  bundleMtime = statSync(BUNDLE).mtimeMs;
} catch {
  fail('public/vendor/engine.bundle.mjs is missing — run `npm run bundle` first');
}

const stale = [];
for (const f of readdirSync(LIB)) {
  if (!f.endsWith('.js')) continue;
  const m = statSync(path.join(LIB, f)).mtimeMs;
  if (m > bundleMtime + 1000) stale.push(f);
}
if (stale.length) {
  fail(`the browser bundle is older than ${stale.join(', ')} — run \`npm run bundle\` and commit the result`);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(PUB, DIST, { recursive: true });

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = 'unknown';
try {
  commit = readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
  if (commit.startsWith('ref: ')) {
    const ref = commit.slice(5);
    commit = readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 12);
  } else {
    commit = commit.slice(0, 12);
  }
} catch {}

writeFileSync(
  path.join(DIST, 'VERSION.json'),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, commit, builtAt: new Date().toISOString(), bundleBytes: statSync(BUNDLE).size },
    null,
    2
  ) + '\n'
);

const files = readdirSync(DIST).length;
console.log(`\n  ✓ dist/ · ${files} top-level entries · bundle ${(statSync(BUNDLE).size / 1024).toFixed(1)} KB · ${pkg.version} @ ${commit}\n`);
