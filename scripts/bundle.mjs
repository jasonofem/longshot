#!/usr/bin/env node
/**
 * bundle.mjs — builds public/vendor/engine.bundle.mjs for the browser.
 *
 *   node scripts/bundle.mjs            # build
 *   node scripts/bundle.mjs --check    # build, then import and exercise it
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const OUT = path.join(ROOT, 'public', 'vendor', 'engine.bundle.mjs');
const ENTRY = path.join(LIB, 'http-core.js');

const FACADE = [
  ['http-core.js', ['createApi', 'ENGINE_INFO', 'jsonSafe', 'toPlain']],
  ['memory-store.js', ['createLocalStorageStore', 'createStoreAdapter', 'createMemoryStore']],
  ['store-shared.js', ['DEFAULT_SETTINGS', 'summariseWeek', 'reviveWeek']],
  ['longshot.js', ['createWeek', 'settleTicket', 'rescanDayTicket', 'computeWeekStats', 'assessGoal', 'getWeeklyVerdict', 'formatNaira', 'WEEK_STATUS', 'TICKET_STATUS']],
  ['scan.js', ['scanDay', 'scanForDay', 'scanDayLive', 'fetchOddsApi', 'PROVIDERS', 'SPORT_MAP']],
  ['builder.js', ['buildLongshotTicket', 'validateTicketOdds', 'evaluateTicketConfidence', 'DEFAULT_BUILDER_OPTS', 'DEFAULT_STAKE_BANDS', 'MIN_TICKET_ODDS', 'MAX_TICKET_ODDS']],
  ['fixtures.js', ['getLagosWeek', 'upcomingWeeks', 'tzDateKey', 'tzNowParts', 'formatKickoff']],
  ['markets.js', ['classifyBook', 'extractLegs', 'correlationFactor', 'confidence', 'confBand', 'SIGNAL_WEIGHTS']],
  ['math.js', ['round', 'clamp', 'mean', 'stdev', 'ev', 'devig']],
];

const COLLISIONS = {};

function fail(msg) {
  console.error(`\n  ✗ bundle failed: ${msg}\n`);
  process.exit(1);
}

const modules = new Map(); // abs path → { file, rel, source, exported[], deps[] }

function readModule(file) {
  if (modules.has(file)) return modules.get(file);
  if (!existsSync(file)) fail(`cannot resolve ${path.relative(ROOT, file)}`);
  const source = readFileSync(file, 'utf8');
  const rel = path.relative(LIB, file);

  for (const [re, what] of [
    [/^export\s*\*/m, '`export *`'],
    [/^import\s+[^'"]*?['"][^'"]+['"]\s*with\s*\{/m, 'import attributes'],
    [/\bcreateRequire\s*\(/, 'CommonJS require'],
  ]) {
    if (re.test(source)) fail(`${rel} uses ${what}, which this bundler does not implement`);
  }

  const exported = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    exported.push(m[1]);
  }

  const deps = [];
  for (const m of source.matchAll(/^import\s+[^;]*?from\s+'([^']+)';/gm)) {
    if (!m[1].startsWith('.')) fail(`${rel} imports bare specifier '${m[1]}'`);
    deps.push(path.resolve(path.dirname(file), m[1]));
  }
  for (const m of source.matchAll(/^import\s+'([^']+)';/gm)) {
    if (!m[1].startsWith('.')) fail(`${rel} side-effect imports '${m[1]}'`);
    deps.push(path.resolve(path.dirname(file), m[1]));
  }

  const mod = { file, rel, source, exported, deps };
  modules.set(file, mod);
  for (const d of deps) readModule(d);
  return mod;
}

function strip(source, rel) {
  let out = source;
  out = out.replace(/^import[\s\S]*?from\s*'[^']*';\s*$/gm, '');
  out = out.replace(/^import\s*'[^']*';\s*$/gm, '');
  out = out.replace(/^export\s*\{[^}]*\}\s*(?:from\s*'[^']*')?;\s*$/gm, '');
  out = out.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '');
  out = out.replace(/^export\s+default\s+/gm, 'const __default = ');
  if (/^\s*export\b/m.test(out)) fail(`${rel} still contains an \`export\` after stripping`);
  if (/^\s*import\b/m.test(out)) fail(`${rel} still contains an \`import\` after stripping`);
  return out.trim();
}

readModule(ENTRY);
for (const [file] of FACADE) readModule(path.join(LIB, file));

const order = [];
const placed = new Set();
function place(m) {
  if (placed.has(m.rel)) return;
  for (const d of m.deps) place(modules.get(d));
  placed.add(m.rel);
  order.push(m);
}
for (const m of modules.values()) place(m);

const importsOf = new Map();
for (const m of order) {
  const list = [];
  for (const im of m.source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)) {
    const from = path.relative(LIB, path.resolve(path.dirname(m.file), im[2]));
    for (let part of im[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      const as = part.split(/\s+as\s+/);
      list.push({ name: as[0].trim(), local: (as[1] || as[0]).trim(), from });
    }
  }
  importsOf.set(m.rel, list);
}

const declaredBy = new Map();
for (const m of order) {
  for (const n of m.exported) {
    if (!declaredBy.has(n)) declaredBy.set(n, []);
    declaredBy.get(n).push(m.rel);
  }
}

for (const [file, names] of FACADE) {
  const mod = modules.get(path.join(LIB, file));
  for (const n of names) {
    if (!mod.exported.includes(n)) fail(`${file} does not export \`${n}\`, but the facade asks for it`);
  }
}

function namesToHoist(rel) {
  const mod = modules.get(path.join(LIB, rel));
  const set = new Set();
  for (const other of order) {
    for (const im of importsOf.get(other.rel) || []) {
      if (im.from === rel && im.name !== 'default') set.add(im.name);
    }
  }
  const entry = FACADE.find(([f]) => f === rel);
  if (entry) {
    for (const n of entry[1]) set.add(n);
  }
  return [...set].filter((n) => (mod?.exported || []).includes(n));
}

const out = [];
out.push('/**');
out.push(' * engine.bundle.mjs — GENERATED FILE for LONGSHOT in-browser execution.');
out.push(' * Regenerate: node scripts/bundle.mjs');
out.push(' */');
out.push('');

const outerNames = new Map();
const facadeAliases = [];
const publicName = new Map();
let uid = 0;

for (const m of order) {
  const hoist = namesToHoist(m.rel);
  const outer = new Map();
  for (const n of hoist) outer.set(n, `__exp_${uid++}`);

  const aliases = [];
  for (const im of importsOf.get(m.rel) || []) {
    if (im.name === 'default') continue;
    const src = modules.get(path.join(LIB, im.from));
    const srcOuter = src ? outerNames.get(src.rel) : null;
    const alias = srcOuter?.get(im.name);
    if (!alias) continue;
    const local = im.local && im.local !== im.name ? im.local : im.name;
    aliases.push(`const ${local} = ${alias};`);
  }

  out.push(`/* ${'═'.repeat(72)}`);
  out.push(`   lib/${m.rel}${hoist.length ? `   →  hoists ${hoist.join(', ')}` : ''}`);
  out.push(`   ${'═'.repeat(72)} */`);
  for (const v of outer.values()) out.push(`let ${v};`);
  out.push('{');
  for (const a of aliases) out.push(a);
  if (aliases.length) out.push('');
  out.push(strip(m.source, m.rel));
  for (const [n, v] of outer) out.push(`${v} = ${n};`);
  out.push('}');
  out.push('');

  outerNames.set(m.rel, outer);

  const entry = FACADE.find(([f]) => f === m.rel);
  if (entry) {
    for (const n of entry[1]) {
      if (!outer.has(n)) continue;
      const own = declaredBy.get(n) || [];
      if (own.length > 1 && COLLISIONS[n] !== m.rel) continue;
      if (publicName.has(n)) continue;
      publicName.set(n, m.rel);
      facadeAliases.push(`${outer.get(n)} as ${n}`);
    }
  }
}

const wanted = new Set(FACADE.flatMap(([, n]) => n));
const got = new Set(publicName.keys());
const absent = [...wanted].filter((n) => !got.has(n));
if (absent.length) fail(`facade is missing ${absent.join(', ')}`);

out.push(`/* ${'═'.repeat(72)}`);
out.push(`   facade — ${facadeAliases.length} public bindings`);
out.push(`   ${'═'.repeat(72)} */`);
out.push(`export { ${facadeAliases.join(', ')} };`);
out.push('');

mkdirSync(path.dirname(OUT), { recursive: true });
const text = out.join('\n');
writeFileSync(OUT, text, 'utf8');
console.log(`\n  ✓ ${path.relative(ROOT, OUT)} · ${order.length} modules · ${facadeAliases.length} public exports · ${(text.length / 1024).toFixed(1)} KB\n`);

const publicNames = [...publicName.keys()];

if (process.argv.includes('--check')) {
  const mod = await import(pathToFileURL(OUT).href);

  const missing = publicNames.filter((n) => mod[n] === undefined);
  if (missing.length) fail(`bundle evaluated, but these exports are undefined: ${missing.join(', ')}`);

  const store = mod.createLocalStorageStore('__bundle_check_longshot__');
  const api = mod.createApi({ store, persistent: false });

  const call = (method, target, body) => {
    const url = new URL(String(target), 'http://local');
    return api({ method, pathname: url.pathname, query: url.searchParams, body: body || {} });
  };

  const state = await call('GET', '/api/state');
  if (state.status !== 200) fail(`/api/state → ${state.status}`);
  if (state.body.runtime.persistent !== false) fail('the browser runtime must report persistent:false');

  const created = await call('POST', '/api/weeks', { goal: 2 });
  if (created.status !== 201) fail(`/api/weeks → ${created.status} ${JSON.stringify(created.body)}`);
  const week = created.body.week;

  if (week.tickets.length !== 7) fail(`week must have 7 tickets, got ${week.tickets.length}`);

  const settled = await call('POST', `/api/weeks/${week.id}/tickets/0/settle`, { outcome: 'won' });
  if (settled.status !== 200) fail(`settle ticket 0 → ${settled.status}`);

  console.log('  ✓ bundle check green: state · createWeek · 7 tickets · settleTicket');
}
