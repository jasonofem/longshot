import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanDayLive, fetchOddsApi } from '../lib/scan.js';
import { buildLongshotTicket } from '../lib/builder.js';
import { createApi } from '../lib/http-core.js';
import { createMemoryStore } from '../lib/memory-store.js';

const date = '2099-10-20';
const sport = 'soccer_uefa_champs_league';
const event = (id = 'ucl-1', kickoff = `${date}T19:00:00Z`) => ({ id, sport_key: sport,
  commence_time: kickoff, home_team: 'Arsenal', away_team: 'Barcelona', bookmakers: [
    { key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [
      { name: 'Arsenal', price: 1.2 }, { name: 'Draw', price: 8 }, { name: 'Barcelona', price: 12 } ] }] },
    { key: 'bet365', title: 'Bet365', markets: [{ key: 'h2h', outcomes: [
      { name: 'Arsenal', price: 1.35 }, { name: 'Draw', price: 6 }, { name: 'Barcelona', price: 9 } ] }] }
  ] });
const extra = () => ({ bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', markets: [
  { key: 'double_chance', outcomes: [{ name: 'Arsenal or Draw', price: 1.1 }, { name: 'Draw or Barcelona', price: 4 }, { name: 'Arsenal or Barcelona', price: 1.15 }] },
  { key: 'alternate_totals', outcomes: [1.5, 3.5, 4.5].flatMap(point => [ { name: 'Over', point, price: 1.3 }, { name: 'Under', point, price: 3.5 } ]) },
  { key: 'team_totals', outcomes: ['Arsenal', 'Barcelona'].flatMap(description => [ { name: 'Over', description, point: 0.5, price: 1.3 }, { name: 'Under', description, point: 0.5, price: 3.5 } ]) },
  { key: 'alternate_spreads', outcomes: [-1.5, 1.5].flatMap(point => [ { name: 'Arsenal', point, price: 1.3 }, { name: 'Barcelona', point: -point, price: 3.5 } ]) }
] }] });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
let serial = 0;
async function mock(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(`mock-${++serial}`); } finally { globalThis.fetch = original; }
}
const opts = apiKey => ({ apiKey, sports: [sport], maxEventRequests: 3 });

test('Lagos boundaries and ISO query; enrich only selected-day events', async () => {
  const calls = [];
  await mock(async url => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.includes('/events/')) return response(extra());
    return response([event('start', '2099-10-19T23:00:00Z'), event('end', '2099-10-20T22:59:59Z'), event('outside', '2099-10-20T23:00:00Z')]);
  }, async key => {
    const r = await scanDayLive(date, opts(key));
    assert.equal(r.diagnostics.rawFixtures, 3);
    assert.equal(r.diagnostics.fixturesOnDate, 2);
    assert.equal(r.events.length, 2);
    assert.equal(calls[0].searchParams.get('commenceTimeFrom'), '2099-10-19T23:00:00Z');
    assert.equal(calls[0].searchParams.get('commenceTimeTo'), '2099-10-20T22:59:59Z');
    assert.ok(!calls[0].searchParams.has('endDate'));
    assert.ok(calls.every(u => !u.pathname.includes('outside')));
  });
});

test('actual quoted DC, alternate lines, team totals and signed handicaps survive conversion', async () => {
  await mock(async url => response(url.includes('/events/') ? extra() : [event()]), async key => {
    const r = await scanDayLive(date, opts(key));
    assert.ok(r.legs.some(l => l.providerMarket === 'double_chance' && l.odds === 1.1));
    for (const line of [1.5, 3.5, 4.5]) assert.ok(r.legs.some(l => l.providerMarket === 'alternate_totals' && l.line === line));
    for (const team of ['Arsenal', 'Barcelona']) assert.ok(r.legs.some(l => l.team === team && l.line === 0.5));
    for (const line of [-1.5, 1.5]) assert.ok(r.legs.some(l => l.providerMarket === 'alternate_spreads' && l.line === line));
    assert.ok(r.legs.every(l => l.eventId && l.book && l.kickoff && l.probabilitySource && l.truthProb === null));
    assert.ok(r.diagnostics.availableMarketTypes.includes('double_chance'));
  });
});

test('moneyline never manufactures a double-chance quote', async () => {
  await mock(async url => response(url.includes('/events/') ? {} : [event()]), async key => {
    const r = await scanDayLive(date, opts(key));
    assert.ok(r.legs.length > 0);
    assert.ok(r.legs.every(l => l.marketType !== 'double_chance'));
  });
});

for (const [status, code] of [[401, 'AUTHENTICATION_FAILURE'], [429, 'QUOTA_EXHAUSTED']]) {
  test(`${status} is distinct and never simulated`, async () => {
    await mock(async () => response(status === 429 ? { error_code: 'OUT_OF_USAGE_CREDITS' } : {}, status), async key => {
      const r = await scanDayLive(date, opts(key));
      assert.equal(r.builder.reason, code);
      assert.equal(r.diagnostics.providerUsed, 'oddsapi');
      assert.equal(r.legs.length, 0);
    });
  });
}

test('one sport timeout does not abort subsequent sport requests', async () => {
  await mock((url, options) => url.includes('soccer_epl') ? new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) : Promise.resolve(response([event()])), async key => {
    const r = await fetchOddsApi(['soccer_epl', sport], key, { timeoutMs: 5, requestIntervalMs: 0 });
    assert.equal(r.leagues[0].code, 'PROVIDER_TIMEOUT');
    assert.equal(r.leagues[1].ok, true);
    assert.equal(r.games.length, 1);
  });
});

test('additional-market concurrency, cap, cache and deduplication', async () => {
  let active = 0, peak = 0, requests = 0;
  await mock(async url => {
    requests++;
    if (!url.includes('/events/')) return response(Array.from({ length: 6 }, (_, i) => event(`e${i}`)));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return response(extra());
  }, async key => {
    const options = { dayKey: date, maxEventRequests: 3, concurrency: 2 };
    await Promise.all([fetchOddsApi([sport], key, options), fetchOddsApi([sport], key, options)]);
    assert.equal(requests, 4);
    assert.ok(peak <= 2);
    const r = await fetchOddsApi([sport], key, options);
    assert.equal(requests, 4);
    assert.equal(r.eventRequestsSkipped, 3);
  });
});

test('quota reserve prevents extra market requests; missing coverage stays visible', async () => {
  let count = 0;
  await mock(async () => { count++; return response([event()], 200, { 'x-requests-remaining': '3' }); }, async key => {
    const r = await scanDayLive(date, opts(key));
    assert.equal(count, 1);
    assert.equal(r.quota.remaining, 3);
    assert.ok(r.legs.every(l => l.providerMarket === 'h2h'));
  });
});

test('empty fixtures, empty markets, and past dates have different reasons', async () => {
  await mock(async () => response([]), async key => {
    assert.equal((await scanDayLive(date, opts(key))).builder.reason, 'NO_EVENTS_FOR_DATE');
    assert.equal((await scanDayLive('2000-01-01', opts(key))).builder.reason, 'PAST_DATE');
  });
  await mock(async url => response(url.includes('/events/') ? {} : [{ ...event(), bookmakers: [] }]), async key => {
    assert.equal((await scanDayLive(date, opts(key))).builder.reason, 'MARKETS_UNAVAILABLE');
  });
});

test('active tennis tournaments discovered while Champions League remains selected', async () => {
  const paths = [];
  await mock(async url => {
    const path = new URL(url).pathname; paths.push(path);
    return response(path.endsWith('/sports/') ? [{ key: 'tennis_atp_paris', title: 'Paris', active: true }] : []);
  }, async key => {
    await fetchOddsApi(['tennis_atp', sport], key);
    assert.ok(paths.some(p => p.includes('tennis_atp_paris/odds')));
    assert.ok(paths.some(p => p.includes(`${sport}/odds`)));
    assert.ok(!paths.some(p => p.includes('tennis_atp/odds')));
  });
});

const legs = (count = 20, odds = 1.3) => Array.from({ length: count }, (_, i) => ({ legId: `l${i}`, eventId: `e${i}`, odds, modelProb: 0.85, edge: 0.85 - 1 / odds, confidence: 0.8, leagueCode: `L${i}` }));
test('builder reports probability/confidence/edge funnels and feasibility without relaxing safety', () => {
  const r = buildLongshotTicket(legs());
  assert.ok(r.ok); assert.equal(r.report.passingPrice, 20); assert.equal(r.report.passingProbability, 20);
  assert.equal(r.report.passingConfidence, 20); assert.ok(r.report.edgeTiers.length);
  assert.equal(new Set(r.best.legs.map(l => l.eventId)).size, r.best.legCount);
  assert.equal(buildLongshotTicket(legs(7)).reason, 'INSUFFICIENT_ELIGIBLE_EVENTS');
  assert.equal(buildLongshotTicket(legs().map(l => ({ ...l, edge: -0.01 }))).reason, 'EDGE_POOL_TOO_SMALL');
  assert.equal(buildLongshotTicket(legs(10, 1.11).map(l => ({ ...l, modelProb: 0.95, edge: 0.04 }))).reason, 'ODDS_TARGET_UNREACHABLE');
});

test('server and browser-local shared API persist selected-date refusal report, no fallback', async () => {
  await mock(async () => response({}, 401), async key => {
    for (const persistent of [true, false]) {
      const store = createMemoryStore();
      await store.saveSettings({ provider: 'oddsapi', oddsApi: { key, sports: [sport] } });
      const api = createApi({ store, persistent });
      const call = (method, pathname, body = {}, query = '') => api({ method, pathname, body, query });
      const created = await call('POST', '/api/weeks', { weekDate: date, provider: 'oddsapi' });
      assert.equal(created.status, 201);
      const week = created.body.week;
      assert.ok(week.tickets.every(t => !t.issued && ['AUTHENTICATION_FAILURE', 'NOT_SCANNED'].includes(t.reasonCode) && t.builderReport));
      const rescanned = await call('POST', `/api/weeks/${week.id}/rescan`, { dayIndex: 2 });
      assert.equal(rescanned.body.week.tickets[2].scanDiagnostics.dayKey, week.tickets[2].date);
      const state = await call('GET', '/api/state');
      assert.equal(state.body.activeWeek.todayIndex, -1);
      assert.ok(state.body.activeWeek.tickets.every(t => !t.isToday));
      const scan = await call('GET', '/api/scan', {}, `date=${date}&provider=oddsapi`);
      assert.equal(scan.body.builder.reason, 'AUTHENTICATION_FAILURE');
    }
  });
});

test('dashboard clears all metrics and renders every issued selection, labels selected day', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(js.includes('s.legs.forEach'));
  assert.ok(js.includes("'fair-odds', 'total-edge', 'ev', 'corr', 'tier-label'"));
  assert.ok(!js.includes('Nothing in today’s market cleared the edge floor'));
  assert.ok(html.includes('Rescan selected day'));
  assert.ok(html.includes('slip-scan-report'));
});

test('live quoted value pool produces and saves an issued ticket with full provenance', async () => {
  await mock(async url => response(url.includes('/events/') ? {} : Array.from({ length: 15 }, (_, i) => event(`value-${i}`))), async key => {
    const r = await scanDayLive(date, { ...opts(key), builder: { minLegs: 10 } });
    assert.equal(r.builder.ok, true);
    assert.ok(r.builder.best.odds >= 20);
    assert.ok(r.builder.best.legs.every(l => l.probabilitySource && l.providerMarket === 'h2h' && l.book === 'Bet365'));
    const store = createMemoryStore();
    await store.saveSettings({ provider: 'oddsapi', oddsApi: { key, sports: [sport] } });
    const api = createApi({ store, persistent: false });
    const result = await api({ method: 'POST', pathname: '/api/weeks', body: { weekDate: date }, query: '' });
    const saved = await store.getWeek(result.body.week.id);
    const ticket = saved.tickets.find(t => t.date === date);
    assert.ok(ticket.issued);
    assert.equal(ticket.slip.legs.length, ticket.slip.legCount);
    assert.equal(ticket.scanDiagnostics.fixturesOnDate, 15);
  });
});

test('beam keeps competing market/event combinations and honours configured 25 legs', () => {
  const pool = legs(26).flatMap((l, i) => [l, { ...l, legId: `alternate-${i}`, odds: 1.4, modelProb: 0.8, edge: 0.8 - 1/1.4 }]);
  const r = buildLongshotTicket(pool, { minLegs: 25, maxLegs: 25 });
  assert.ok(r.ok);
  assert.equal(r.best.legCount, 25);
  assert.equal(new Set(r.best.legs.map(l => l.eventId)).size, 25);
});

test('browser localFetch proxies live scans with settings in POST body', async () => {
  const { localFetch, localStore } = await import('../public/local-api.js');
  const server = createApi({ store: createMemoryStore() });
  let proxyCalls = 0;
  await mock(async (url, options) => {
    if (url === '/api/scan/live') {
      proxyCalls++;
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.sports, [sport]);
      const result = await server({ method: 'POST', pathname: url, body: payload, query: '' });
      return response(result.body, result.status);
    }
    return response(url.includes('/events/') ? extra() : [event()]);
  }, async key => {
    await localStore.saveSettings({ provider: 'oddsapi', oddsApi: { key, sports: [sport] } });
    const res = await localFetch('/api/scan/live', { method: 'POST', body: { date, additionalMarkets: true } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.legs.some(l => l.providerMarket === 'double_chance'));
    assert.equal(body.diagnostics.fixturesOnDate, 1);
    assert.equal(proxyCalls, 1);
  });
});

test('local week creation and both rescan paths never call provider directly', async () => {
  const { localFetch, localStore } = await import('../public/local-api.js');
  let requests = 0;
  await mock(async (url, options) => {
    assert.equal(url, '/api/scan/live');
    const payload = JSON.parse(options.body);
    requests++;
    return response({ date: payload.date, events: [], legs: [], diagnostics: {
      dayKey: payload.date, providerUsed: 'oddsapi', providerRequested: 'oddsapi', fellBack: false,
    }, builder: { ok: false, reason: 'NO_EVENTS_FOR_DATE', message: 'No events', report: {} } });
  }, async key => {
    await localStore.saveSettings({ provider: 'oddsapi', oddsApi: { key, sports: [sport] } });
    const created = await localFetch('/api/weeks', { method: 'POST', body: { weekDate: date } });
    const { week } = await created.json();
    assert.equal(requests, 1);
    assert.ok(week.tickets.every(t => !t.issued && t.provider.used === 'oddsapi'));
    await localFetch(`/api/weeks/${week.id}/rescan`, { method: 'POST', body: { dayIndex: 2 } });
    assert.equal(requests, 2);
    await localFetch(`/api/weeks/${week.id}/rescan`, { method: 'POST', body: {} });
    assert.equal(requests, 2);
  });
});

test('proxy failure never falls back to direct provider or simulation', async () => {
  const { proxyLiveScan, localFetch, localStore } = await import('../public/local-api.js');
  await mock(async url => {
    assert.equal(url, '/api/scan/live');
    throw new TypeError('Failed to fetch');
  }, async key => {
    await assert.rejects(proxyLiveScan(date, { apiKey: key }), { code: 'LIVE_PROXY_UNREACHABLE' });
    await localStore.saveSettings({ provider: 'oddsapi', oddsApi: { key, sports: [sport] } });
    const res = await localFetch('/api/weeks', { method: 'POST', body: { weekDate: date } });
    const { week } = await res.json();
    assert.ok(week.tickets.every(t => !t.issued && ['LIVE_PROXY_UNREACHABLE', 'NOT_SCANNED'].includes(t.reasonCode)));
  });
  await mock(async () => new Response('<html>Static host</html>', { status: 200 }), async () => {
    await assert.rejects(proxyLiveScan(date), { code: 'LIVE_PROXY_INVALID_RESPONSE' });
  });
});

test('429 with credits remaining retries and resumes all event enrichment', async () => {
  const attempts = new Map();
  await mock(async url => {
    if (!url.includes('/events/')) return response([event('r1'), event('r2'), event('r3')], 200, { 'x-requests-remaining': '425', 'x-requests-used': '75' });
    const count = (attempts.get(url) || 0) + 1; attempts.set(url, count);
    if (url.includes('/r1/') && count === 1) return response({ error_code: 'TOO_MANY_REQUESTS' }, 429,
      { 'retry-after': '0', 'x-requests-remaining': '425' });
    return response(extra());
  }, async key => {
    const r = await scanDayLive(date, { ...opts(key), requestIntervalMs: 0, retryDelayMs: 0 });
    assert.equal(r.quota.remaining, 425);
    assert.equal(r.diagnostics.requestStats.retries, 1);
    assert.equal(r.diagnostics.requestStats.rateLimits, 1);
    assert.equal(r.diagnostics.additionalMarkets.filter(x => x.ok).length, 3);
    assert.equal(r.diagnostics.eventRequestsSkipped, 0);
    assert.notEqual(r.builder.reason, 'QUOTA_EXHAUSTED');
  });
});

test('persistent event 429 is partial coverage, not a fatal quota error or builder override', async () => {
  let attempts = 0;
  await mock(async url => {
    if (!url.includes('/events/')) return response([event('limited'), event('available')]);
    if (url.includes('/limited/')) {
      attempts++;
      return response({ error_code: 'TOO_MANY_REQUESTS' }, 429, { 'x-requests-remaining': '425' });
    }
    return response(extra());
  }, async key => {
    const r = await scanDayLive(date, { ...opts(key), requestIntervalMs: 0, retryDelayMs: 0 });
    assert.equal(attempts, 3);
    assert.equal(r.diagnostics.partialCoverage, true);
    assert.equal(r.diagnostics.eventRequestsSkipped, 0);
    assert.equal(r.diagnostics.coverageWarnings[0].code, 'RATE_LIMITED');
    assert.equal(r.diagnostics.coverageWarnings[0].providerCode, 'TOO_MANY_REQUESTS');
    assert.equal(r.builder.reason, 'INSUFFICIENT_ELIGIBLE_EVENTS');
    assert.equal(r.builder.report.outcome, r.builder.reason);
    assert.ok(r.diagnostics.additionalMarkets.some(x => x.eventId === 'available' && x.ok));
  });
});

test('long Retry-After is disclosed without retrying early; zero credits is distinct', async () => {
  let count = 0;
  await mock(async () => { count++; return response({}, 429, { 'retry-after': '60', 'x-requests-remaining': '425' }); }, async key => {
    const r = await scanDayLive(date, { ...opts(key), requestIntervalMs: 0 });
    assert.equal(count, 1);
    assert.equal(r.builder.reason, 'RATE_LIMITED');
    assert.equal(r.leagues[0].retryAfterMs, 60000);
  });
  await mock(async () => response({}, 429, { 'x-requests-remaining': '0' }), async key => {
    const r = await scanDayLive(date, { ...opts(key), requestIntervalMs: 0 });
    assert.equal(r.builder.reason, 'QUOTA_EXHAUSTED');
    assert.equal(r.diagnostics.requestStats.retries, 0);
  });
});

test('default scanner never enriches events and uses one region', async () => {
  let calls = 0;
  await mock(async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('regions'), 'uk');
    assert.ok(!url.includes('/events/'));
    return response([event()]);
  }, async key => {
    const r = await scanDayLive(date, { apiKey: key, sports: [sport] });
    assert.equal(calls, 1);
    assert.equal(r.diagnostics.requestStats.reservedCredits, 3);
  });
});

test('credit budget stops bulk and enrichment requests including retry reservations', async () => {
  let calls = 0;
  await mock(async url => {
    calls++;
    return response(url.includes('/events/') ? extra() : [event()]);
  }, async key => {
    const r = await fetchOddsApi([sport, 'soccer_epl'], key, { dayKey: date, maxCredits: 3, maxEventRequests: 40, requestIntervalMs: 0 });
    assert.equal(calls, 1);
    assert.equal(r.requestStats.reservedCredits, 3);
    assert.ok(r.leagues.some(l => l.code === 'SCAN_BUDGET_REACHED'));
  });
  calls = 0;
  await mock(async () => { calls++; return response({ error_code: 'TOO_MANY_REQUESTS' }, 429); }, async key => {
    const r = await fetchOddsApi([sport], key, { maxCredits: 3, requestIntervalMs: 0, retryDelayMs: 0 });
    assert.equal(calls, 1);
    assert.equal(r.requestStats.reservedCredits, 3);
  });
});

test('live week scans one date and rejects full-week rescan without any provider calls', async () => {
  const store = createMemoryStore();
  await store.saveSettings({ provider: 'oddsapi', oddsApi: { key: 'test-budget', sports: [sport] } });
  const dates = [];
  const api = createApi({ store, liveScanner: async (day, options) => {
    dates.push(day);
    assert.equal(options.maxEventRequests, 0);
    return { scan: { diagnostics: { providerUsed: 'oddsapi' } }, builder: { ok: false, reason: 'NO_EVENTS_FOR_DATE', message: 'No events', report: {} } };
  } });
  const created = await api({ method: 'POST', pathname: '/api/weeks', body: { weekDate: date }, query: '' });
  assert.deepEqual(dates, [date]);
  assert.equal(created.body.week.tickets.filter(t => t.reasonCode === 'NOT_SCANNED').length, 6);
  const rescan = await api({ method: 'POST', pathname: `/api/weeks/${created.body.week.id}/rescan`, body: {}, query: '' });
  assert.equal(rescan.status, 400);
  assert.equal(rescan.body.code, 'SELECT_DAY_REQUIRED');
  assert.deepEqual(dates, [date]);
  await api({ method: 'GET', pathname: '/api/state', query: '' });
  assert.deepEqual(dates, [date]);
});
