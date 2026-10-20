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
  liveScanner: proxyLiveScan,
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
    return respond(500, { error: err.message || 'local engine error', code: err.code || 'LOCAL_API_ERROR', diagnostics: err.diagnostics });
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

/** Local persistence does not require browser-to-provider network access. */
export async function proxyLiveScan(date, options = {}) {
  let res;
  try {
    res = await globalThis.fetch('/api/scan/live', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date, apiKey: options.apiKey, sports: options.sports, builder: options.builder }),
      signal: options.signal,
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the same-origin live scan service. Check your connection and server deployment; no direct-provider or simulated fallback was used.'), { code: 'LIVE_PROXY_UNREACHABLE' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.diagnostics || !data?.builder || !Array.isArray(data?.legs)) {
    throw Object.assign(new Error(data?.error || 'Live scan service returned an invalid response. A server API deployment is required for live scans.'), { code: data?.code || 'LIVE_PROXY_INVALID_RESPONSE' });
  }
  return { ...data, scan: { dayKey: date, events: data.events, legs: data.legs, diagnostics: data.diagnostics } };
}
