/**
 * local-api.js — LONGSHOT API running inside the browser tab.
 *
 * When /api/state reports persistent: false (or times out after 8s), the
 * dashboard uses localFetch to run the engine in-browser, persisting to localStorage.
 */

import { createApi, createLocalStorageStore } from './vendor/engine.bundle.mjs';

export const STORAGE_KEY = 'longshot.store.v1';

export const localStore = createLocalStorageStore(STORAGE_KEY);

export const localApi = createApi({
  store: localStore,
  env: {},
  persistent: false,
});

export function storageInfo() {
  return {
    backend: localStore.backend,
    key: STORAGE_KEY,
    persistent: localStore.backend === 'localStorage',
    evictions: (localStore.evictions || []).map((e) => e.evictedWeek).filter(Boolean),
    bytes: (() => {
      try {
        return (localStorage.getItem(STORAGE_KEY) || '').length;
      } catch {
        return 0;
      }
    })(),
  };
}

export async function localFetch(path, opts = {}) {
  const url = new URL(String(path), 'http://local');
  let body = {};
  if (opts.body) {
    try {
      body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    } catch {
      body = {};
    }
  }
  try {
    const out = await localApi({
      method: (opts.method || 'GET').toUpperCase(),
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return respond(out.status, out.body);
  } catch (err) {
    return respond(500, { error: err.message || 'local engine error' });
  }
}

function respond(status, body) {
  const text = JSON.stringify(body, jsonSafe);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'Error',
    headers: { get: () => 'application/json' },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

export default localFetch;
