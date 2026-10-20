import test from 'node:test';
import assert from 'node:assert/strict';
import { americanToDecimal, convertSgoEvent, scanSportsGameOdds } from '../lib/sportsgameodds.js';
import { createApi } from '../lib/http-core.js';
import { createMemoryStore } from '../lib/memory-store.js';
const day = '2099-10-20';
function fixture(id = 'sgo-1') {
  const odds = {};
  const add = (entity, bet, side, value, line) => {
    odds[`points-${entity}-game-${bet}-${side}`] = { byBookmaker: {
      pinnacle: { odds: value, available: true, ...(bet === 'ou' ? { overUnder: line } : { spread: line }) },
      bet365: { odds: side === 'home' ? '-285' : value, available: true, ...(bet === 'ou' ? { overUnder: line } : { spread: line }) },
    } };
  };
  add('home', 'ml3way', 'home', '-500'); add('away', 'ml3way', 'away', '+1200'); add('all', 'ml3way', 'draw', '+800');
  add('home', 'ml3way', 'home+draw', '-1000'); add('away', 'ml3way', 'away+draw', '+350'); add('all', 'ml3way', 'not_draw', '-700');
  add('all', 'ou', 'over', '-400', '1.5'); add('all', 'ou', 'under', '+300', '1.5');
  add('home', 'ou', 'over', '-500', '0.5'); add('home', 'ou', 'under', '+350', '0.5');
  add('home', 'sp', 'home', '-300', '-1.5'); add('away', 'sp', 'away', '+250', '1.5');
  return { eventID: id, sportID: 'SOCCER', leagueID: 'UEFA_CHAMPIONS_LEAGUE', type: 'match',
    status: { startsAt: `${day}T19:00:00Z`, started: false },
    teams: { home: { names: { long: 'Arsenal' } }, away: { names: { long: 'Barcelona' } } }, odds };
}
const res = (data, nextCursor, status = 200) => new Response(JSON.stringify({ success: status === 200, data, nextCursor }), { status });
let serial = 0;
async function mocked(fetcher, run) {
  const old = globalThis.fetch; globalThis.fetch = fetcher;
  try { await run(`sgo-test-${++serial}`); } finally { globalThis.fetch = old; }
}
test('SGO American prices and complete book markets retain exact quote provenance', () => {
  assert.equal(americanToDecimal('-400'), 1.25); assert.equal(americanToDecimal('+150'), 2.5);
  assert.equal(americanToDecimal('1.45'), null); assert.equal(americanToDecimal(''), null);
  const r = convertSgoEvent(fixture());
  for (const type of ['h2h', 'double_chance', 'totals', 'team_totals', 'spreads']) assert.ok(r.legs.some(l => l.marketType === type));
  assert.ok(r.legs.every(l => l.providerOddID && l.book && l.truthProb === null));
  assert.ok(r.legs.some(l => l.line === 0.5 && l.team === 'Arsenal'));
  assert.ok(r.legs.some(l => l.line === -1.5 && l.marketType === 'spreads'));
});
test('SGO never substitutes consensus, incomplete books, unavailable prices or push markets', () => {
  const f = fixture();
  for (const o of Object.values(f.odds)) { o.bookOdds = '-400'; o.fairOdds = '-500'; for (const q of Object.values(o.byBookmaker)) q.available = false; }
  assert.equal(convertSgoEvent(f).legs.length, 0);
  const g = fixture(); delete g.odds['points-all-game-ml3way-draw'];
  assert.ok(convertSgoEvent(g).legs.every(l => l.marketType !== 'h2h'));
  for (const [id, o] of Object.entries(g.odds)) if (id.includes('-ou-')) for (const q of Object.values(o.byBookmaker)) q.overUnder = '2';
  assert.ok(convertSgoEvent(g).legs.every(l => !['totals', 'team_totals'].includes(l.marketType)));
});
test('SGO Lagos range, header authentication, cursor pagination and two-page hard cap', async () => {
  let calls = 0;
  await mocked(async (url, opts) => {
    const u = new URL(url); calls++;
    assert.equal(u.hostname, 'api.sportsgameodds.com'); assert.ok(!u.searchParams.has('apiKey'));
    assert.ok(opts.headers['x-api-key']); assert.equal(u.searchParams.get('startsBefore'), '2099-10-20T23:00:00.000Z');
    assert.equal(u.searchParams.get('leagueID'), 'UEFA_CHAMPIONS_LEAGUE');
    if (calls === 2) assert.equal(u.searchParams.get('cursor'), 'opaque-token');
    return res([fixture(`e${calls}`)], calls === 1 ? 'opaque-token' : 'more');
  }, async key => {
    const result = await scanSportsGameOdds(day, { apiKey: key, leagues: ['UEFA_CHAMPIONS_LEAGUE'] });
    assert.equal(calls, 2); assert.equal(result.events.length, 2); assert.equal(result.diagnostics.partialCoverage, true);
    assert.equal(result.quota.remaining, null);
    assert.ok(result.diagnostics.coverageWarnings.some(w => w.code === 'PAGE_LIMIT_REACHED'));
  });
});
test('SGO caches pages and filters wrong dates, duplicate events and started matches', async () => {
  let calls = 0;
  await mocked(async () => { calls++; return res([fixture(), fixture(), { ...fixture('wrong'), status: { startsAt: '2099-10-20T23:00:00Z' } }, { ...fixture('started'), status: { startsAt: `${day}T10:00:00Z`, started: true } }]); }, async key => {
    const a = await scanSportsGameOdds(day, { apiKey: key });
    const b = await scanSportsGameOdds(day, { apiKey: key });
    assert.equal(a.events.length, 1); assert.equal(calls, 1); assert.equal(b.diagnostics.cachedPages, 1);
  });
});
for (const [status, code] of [[401, 'AUTHENTICATION_FAILURE'], [403, 'SUBSCRIPTION_ACCESS_DENIED'], [429, 'RATE_LIMITED']]) test(`SGO ${status} fails once without using Odds API or simulation`, async () => {
  let calls = 0;
  await mocked(async url => { calls++; assert.ok(url.startsWith('https://api.sportsgameodds.com/')); return res([], null, status); }, async key => {
    const r = await scanSportsGameOdds(day, { apiKey: key }); assert.equal(calls, 1); assert.equal(r.builder.reason, code);
    assert.equal(r.diagnostics.providerUsed, 'sportsgameodds'); assert.equal(r.legs.length, 0);
  });
});
test('SGO provider keys and leagues route correctly through week creation, scan and selected rescan', async () => {
  const store = createMemoryStore();
  await store.saveSettings({ provider: 'sportsgameodds', oddsApi: { key: 'WRONG' }, sportsGameOdds: { key: 'RIGHT', leagues: ['EPL'] } });
  const calls = [];
  const api = createApi({ store, liveScanner: async (date, options) => {
    calls.push({ date, options });
    return { scan: { diagnostics: { providerUsed: 'sportsgameodds', providerRequested: 'sportsgameodds' } }, diagnostics: {}, builder: { ok: false, report: {}, reason: 'NO_EVENTS_FOR_DATE' }, events: [], legs: [] };
  } });
  const week = await api({ method: 'POST', pathname: '/api/weeks', body: { weekDate: day, provider: 'sportsgameodds' }, query: '' });
  assert.equal(calls.length, 1);
  assert.ok(week.body.week.tickets.every(t => t.provider.used === 'sportsgameodds'));
  await api({ method: 'POST', pathname: `/api/weeks/${week.body.week.id}/rescan`, body: { dayIndex: 2 }, query: '' });
  await api({ method: 'POST', pathname: '/api/scan/live', body: { date: day, provider: 'sportsgameodds' }, query: '' });
  for (const c of calls) { assert.equal(c.options.provider, 'sportsgameodds'); assert.equal(c.options.apiKey, 'RIGHT'); assert.deepEqual(c.options.leagues, ['EPL']); }
  const blocked = await api({ method: 'POST', pathname: `/api/weeks/${week.body.week.id}/rescan`, body: {}, query: '' });
  assert.equal(blocked.status, 400); assert.equal(calls.length, 3);
});
test('SGO browser proxy carries provider and native league filters, never direct provider access', async () => {
  const { localStore, localFetch } = await import('../public/local-api.js');
  await localStore.saveSettings({ provider: 'sportsgameodds', sportsGameOdds: { key: 'browser-sgo', leagues: ['EPL'] } });
  await mocked(async (url, options) => {
    assert.equal(url, '/api/scan/live');
    const b = JSON.parse(options.body); assert.equal(b.provider, 'sportsgameodds'); assert.equal(b.apiKey, 'browser-sgo'); assert.deepEqual(b.leagues, ['EPL']);
    return new Response(JSON.stringify({ diagnostics: { providerUsed: 'sportsgameodds' }, builder: { ok: false }, legs: [], events: [] }));
  }, async () => {
    const response = await localFetch('/api/scan/live', { method: 'POST', body: { date: day, provider: 'sportsgameodds' } });
    assert.equal(response.status, 200);
  });
});

test('SGO shared server API can issue a quote-backed value ticket with original oddIDs', async () => {
  await mocked(async url => {
    assert.ok(url.startsWith('https://api.sportsgameodds.com/'));
    return res(Array.from({ length: 15 }, (_, i) => fixture(`value-${i}`)));
  }, async key => {
    const store = createMemoryStore();
    await store.saveSettings({ provider: 'sportsgameodds', sportsGameOdds: { key, leagues: [] } });
    const api = createApi({ store });
    const out = await api({ method: 'POST', pathname: '/api/scan/live', body: { date: day }, query: '' });
    assert.equal(out.status, 200); assert.equal(out.body.provider.used, 'sportsgameodds');
    assert.ok(out.body.builder.ok);
    assert.ok(out.body.builder.best.legs.every(l => l.providerOddID && l.provider === 'sportsgameodds'));
    assert.ok(out.body.builder.best.odds >= 20);
  });
});

test('SGO empty, missing-key and past-day outcomes are explicit and cheap', async () => {
  let count = 0;
  await mocked(async () => { count++; return res([]); }, async key => {
    assert.equal((await scanSportsGameOdds(day)).builder.reason, 'NO_KEY');
    assert.equal((await scanSportsGameOdds('2000-01-01', { apiKey: key })).builder.reason, 'PAST_DATE');
    assert.equal(count, 0);
    assert.equal((await scanSportsGameOdds(day, { apiKey: key })).builder.reason, 'NO_EVENTS_FOR_DATE');
    assert.equal(count, 1);
  });
});
