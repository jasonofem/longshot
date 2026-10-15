/**
 * store.js — flat-file JSON persistence for node:http server. Zero dependencies.
 */

import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS, summariseWeek, reviveWeek } from './store-shared.js';

export { DEFAULT_SETTINGS, summariseWeek, reviveWeek };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LONGSHOT_DATA_DIR || path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const TMP = FILE + '.tmp';

const EMPTY = { weeks: {}, order: [], settings: {} };

let cache = null;
let cacheMtimeMs = -1;
let writeChain = Promise.resolve();

async function load() {
  try {
    if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
    const st = await stat(FILE).catch(() => null);
    const mtime = st ? st.mtimeMs : -1;
    if (cache && mtime === cacheMtimeMs) return cache;

    if (st) {
      const raw = await readFile(FILE, 'utf8');
      cache = { ...EMPTY, ...JSON.parse(raw) };
    } else {
      cache = structuredClone(EMPTY);
    }
    cache.weeks = cache.weeks || {};
    cache.order = cache.order || [];
    cache.settings = cache.settings || {};
    cacheMtimeMs = mtime;
  } catch {
    cache = structuredClone(EMPTY);
    cacheMtimeMs = -1;
  }
  return cache;
}

async function persist() {
  if (!cache) return;
  writeChain = writeChain.then(async () => {
    try {
      if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
      await writeFile(TMP, JSON.stringify(cache, null, 2), 'utf8');
      await rename(TMP, FILE);
      const st = await stat(FILE).catch(() => null);
      cacheMtimeMs = st ? st.mtimeMs : -1;
    } catch (err) {
      console.error('[store] persist failed:', err.message);
    }
  });
  return writeChain;
}

export async function saveWeek(week) {
  const db = await load();
  db.weeks[week.id] = reviveWeek(week);
  if (!db.order.includes(week.id)) db.order.unshift(week.id);
  db.order = db.order.slice(0, 100);
  await persist();
  return week;
}

export async function getWeek(id) {
  const db = await load();
  const week = db.weeks[id];
  return week ? reviveWeek(week) : null;
}

export async function getActiveWeek() {
  const db = await load();
  for (const id of db.order) {
    const w = db.weeks[id];
    if (w && w.status === 'active') return reviveWeek(w);
  }
  return null;
}

export async function listWeeks(limit = 20) {
  const db = await load();
  return db.order
    .slice(0, limit)
    .map((id) => db.weeks[id])
    .filter(Boolean)
    .map((w) => summariseWeek(w));
}

export async function deleteWeek(id) {
  const db = await load();
  delete db.weeks[id];
  db.order = db.order.filter((x) => x !== id);
  await persist();
  return true;
}

export async function getSettings() {
  const db = await load();
  return {
    ...DEFAULT_SETTINGS,
    oddsApi: {
      key: process.env.ODDS_API_KEY || db.settings?.oddsApi?.key || '',
      sports: db.settings?.oddsApi?.sports || [],
    },
    ...db.settings,
  };
}

export async function saveSettings(patch) {
  const db = await load();
  db.settings = { ...(db.settings || {}), ...patch };
  await persist();
  return getSettings();
}

export const DATA_FILE = FILE;
