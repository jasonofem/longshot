/**
 * api/index.js — the LONGSHOT API as a Vercel serverless function.
 *
 * Handler signature: classic Node `(req, res)`.
 * `export const maxDuration = 60`.
 * In-memory store reporting `persistent: false` on /api/state.
 */

import { createApi } from '../lib/http-core.js';
import { createMemoryStore } from '../lib/memory-store.js';

const store = createMemoryStore({ oddsApiKey: process.env.ODDS_API_KEY || '' });

const api = createApi({
  store,
  env: process.env,
  persistent: false,
});

export const maxDuration = 60;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end(JSON.stringify(payload, jsonSafe));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** The classic Node serverless handler — the one Vercel always honours. */
export default async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.end();
  }

  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
  }

  try {
    const out = await api({
      method: req.method,
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return send(res, out.status, out.body);
  } catch (err) {
    return send(res, 500, { error: err.message || 'internal error' });
  }
}

/** Web Request/Response wrapper for wintercg preview environments. */
export async function webHandler(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const raw = await request.text();
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
      });
    }
  }

  try {
    const out = await api({
      method: request.method,
      pathname: url.pathname,
      query: url.searchParams,
      body,
    });
    return new Response(JSON.stringify(out.body, jsonSafe), {
      status: out.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'internal error' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
    });
  }
}
