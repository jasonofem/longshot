/**
 * scan.js — the Longshot market scanner.
 *
 * Markets: h2h, totals (over/under), spreads (handicap).
 * Providers:
 *   sim     — built-in market simulator
 *   manual  — user pasted odds
 *   oddsapi — The Odds API v4 (api.the-odds-api.com)
 *
 * Contract:
 *   - Live legs carry `live: true` and `truthProb: null`.
 *   - Every scan carries `provider: { requested, used, fellBack, reason }`.
 *   - Capture `x-requests-remaining` and `x-requests-used` headers.
 *   - 15s AbortController on live fetches with honest 504 explanation.
 */

import { buildDayEvents, tzDateKey, formatKickoff } from './fixtures.js';
import { priceEvent, priceEventFromOffers, extractLegs, classifyBook } from './markets.js';
import { applyMarketInformation } from './truth.js';
import { buildLongshotTicket, DEFAULT_BUILDER_OPTS } from './builder.js';
import { clamp, round, mean } from './math.js';

export const PROVIDERS = {
  sim: {
    id: 'sim',
    name: 'Simulated market',
    blurb: 'Built-in multi-book price simulator. Deterministic, models vig + sharp book bias.',
    needsKey: false,
    live: false,
  },
  manual: {
    id: 'manual',
    name: 'Manual odds entry',
    blurb: 'Paste real prices from your bookmaker. De-vigs and blends with ratings.',
    needsKey: false,
    live: true,
  },
  oddsapi: {
    id: 'oddsapi',
    name: 'The Odds API v4',
    blurb: 'Live multi-book prices across eu, uk, us books. Requires Odds API key.',
    needsKey: true,
    live: true,
  },
};

export const SPORT_MAP = [
  // football — the deep cards
  { key: 'soccer_epl', sport: 'football', league: 'Premier League', tier: 1, noise: 0.05, base: 1.42 },
  { key: 'soccer_spain_la_liga', sport: 'football', league: 'La Liga', tier: 1, noise: 0.05, base: 1.3 },
  { key: 'soccer_italy_serie_a', sport: 'football', league: 'Serie A', tier: 1, noise: 0.05, base: 1.34 },
  { key: 'soccer_germany_bundesliga', sport: 'football', league: 'Bundesliga', tier: 1, noise: 0.05, base: 1.58 },
  { key: 'soccer_france_ligue_one', sport: 'football', league: 'Ligue 1', tier: 1, noise: 0.05, base: 1.38 },
  { key: 'soccer_uefa_champs_league', sport: 'football', league: 'Champions League', tier: 1, noise: 0.04, base: 1.5 },
  { key: 'soccer_uefa_europa_league', sport: 'football', league: 'Europa League', tier: 2, noise: 0.06, base: 1.44 },
  { key: 'soccer_brazil_campeonato', sport: 'football', league: 'Brasileirão', tier: 2, noise: 0.07, base: 1.16 },
  { key: 'soccer_portugal_primeira_liga', sport: 'football', league: 'Primeira Liga', tier: 2, noise: 0.06, base: 1.3 },
  { key: 'soccer_netherlands_eredivisie', sport: 'football', league: 'Eredivisie', tier: 2, noise: 0.06, base: 1.5 },
  { key: 'soccer_turkey_super_lig', sport: 'football', league: 'Süper Lig', tier: 2, noise: 0.07, base: 1.4 },
  { key: 'soccer_usa_mls', sport: 'football', league: 'MLS', tier: 2, noise: 0.07, base: 1.5 },
  // basketball
  { key: 'basketball_nba', sport: 'basketball', league: 'NBA', tier: 1, noise: 0.045, base: 114, sigma: 11.6 },
  { key: 'basketball_euroleague', sport: 'basketball', league: 'EuroLeague', tier: 2, noise: 0.06, base: 84, sigma: 10 },
  { key: 'basketball_wnba', sport: 'basketball', league: 'WNBA', tier: 2, noise: 0.07, base: 82, sigma: 11 },
  // tennis
  { key: 'tennis_atp', sport: 'tennis', league: 'ATP', tier: 1, noise: 0.055, scale: 7.5 },
  { key: 'tennis_wta', sport: 'tennis', league: 'WTA', tier: 2, noise: 0.065, scale: 7.5 },
  // and the rest of the board
  { key: 'baseball_mlb', sport: 'baseball', league: 'MLB', tier: 1, noise: 0.05, base: 4.55, sigma: 3.5 },
  { key: 'icehockey_nhl', sport: 'icehockey', league: 'NHL', tier: 1, noise: 0.05, base: 3.1, sigma: 1.35 },
  { key: 'mma_mixed_martial_arts', sport: 'mma', league: 'MMA / UFC', tier: 2, noise: 0.08, scale: 6 },
  { key: 'cricket_odi', sport: 'cricket', league: 'Cricket (ODI)', tier: 2, noise: 0.07, base: 260, sigma: 30 },
  { key: 'aussierules_afl', sport: 'aussierules', league: 'AFL', tier: 2, noise: 0.07, base: 86, sigma: 12 },
  { key: 'rugbyleague_nrl', sport: 'rugbyleague', league: 'NRL', tier: 2, noise: 0.07, base: 24, sigma: 6 },
];

const DAY_CACHE = new Map();
const DAY_CACHE_LIMIT = 24;

/**
 * Scan one day synchronously.
 * Note: When live odds are requested, sync scan cannot make network calls,
 * so it returns an empty live failure rather than simulated selections.
 */
export function scanDay(dayKey, opts = {}) {
  const requested = opts.provider || 'sim';

  if (requested === 'manual') {
    const usable = (opts.manualOdds || []).filter(
      (e) => e?.outcomes?.length >= 2 && e.outcomes.every((o) => Number(o.odds) > 1)
    );
    if (opts.manualOdds?.length && !usable.length) {
      return stamp(
        scanSim(dayKey, opts),
        requested,
        'sim',
        'Pasted odds could not be parsed: every market needs at least two outcomes priced >1.00. These prices are simulated.'
      );
    }
    if (usable.length) return stamp(scanManual(dayKey, { ...opts, manualOdds: usable }), requested, 'manual', null);
    return stamp(
      scanSim(dayKey, opts),
      requested,
      'sim',
      'Manual odds mode selected but no valid odds were pasted. These prices are simulated.'
    );
  }

  if (requested === 'oddsapi') {
    return failedLiveBoard(dayKey, { code: opts.apiKey ? 'ASYNC_REQUIRED' : 'NO_KEY',
      message: 'Live scanning requires the asynchronous provider route and a valid API key.' }).scan;
  }

  return stamp(scanSim(dayKey, opts), requested, 'sim', null);
}

function stamp(scan, requested, used, fallbackReason) {
  return {
    ...scan,
    diagnostics: {
      ...(scan.diagnostics || {}),
      providerRequested: requested,
      providerUsed: used,
      provider: used,
      fallbackReason,
      fellBack: Boolean(fallbackReason) && requested !== used,
    },
  };
}

/**
 * Simulated day market scanner.
 */
export function scanSim(dayKey, opts = {}) {
  const tz = opts.tz || 'Africa/Lagos';
  const cacheKey = `${dayKey}|${tz}|${opts.eventsPerDay ?? 38}|${opts.marketInefficiency ?? 1.2}`;
  if (DAY_CACHE.has(cacheKey)) return DAY_CACHE.get(cacheKey);

  const ineff = clamp(opts.marketInefficiency ?? 1.2, 0.2, 3);
  const events = buildDayEvents(dayKey, { tz, eventsPerDay: opts.eventsPerDay ?? 38 });
  const now = Date.now();

  const legs = [];
  const pricedEvents = [];
  const bookNames = new Set();
  let pricesQuoted = 0;
  let marketsSeen = 0;

  for (const e of events) {
    const kickoffHours = clamp((e.kickoff - now) / 3600000, 0, 72);
    const truth = applyMarketInformation(e);
    const priced = priceEvent(e, truth, { tier: e.league.tier, kickoffHours, marketInefficiency: ineff });
    const ev = { ...e, markets: priced.markets, books: priced.books, kickoffHours: round(kickoffHours, 1) };
    pricedEvents.push(ev);
    marketsSeen += priced.markets.length;

    for (const m of priced.markets) {
      pricesQuoted += m.books.length * m.outcomes.length;
      for (const b of m.books) bookNames.add(b.book);
    }
    legs.push(...extractLegs(ev));
  }

  const diagnostics = {
    dayKey,
    tz,
    provider: 'sim',
    events: pricedEvents.length,
    markets: marketsSeen,
    pricesQuoted,
    books: [...bookNames].sort(),
    bookCount: bookNames.size,
    bookQuotes: pricesQuoted,
    positiveEdgeLegs: legs.filter((l) => l.edge > 0).length,
    aboveFloorLegs: legs.filter((l) => l.edge >= 0.012).length,
    avgEdge: round((legs.reduce((a, l) => a + l.edge, 0) / Math.max(1, legs.length)) * 100, 2),
  };

  const result = { dayKey, events: pricedEvents, legs, diagnostics };
  if (DAY_CACHE.size > DAY_CACHE_LIMIT) DAY_CACHE.clear();
  DAY_CACHE.set(cacheKey, result);
  return result;
}

/**
 * Async live scan: fetches real quotes from The Odds API v4, de-vigs, and builds ticket.
 */
export async function scanDayLive(dayKey, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) {
    const e = new Error('No Odds API key provided. Set ODDS_API_KEY in the environment or paste one in Settings.');
    e.code = 'NO_KEY';
    throw e;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !Number.isFinite(Date.parse(dayKey)))
    throw Object.assign(new Error('Invalid selected date; use YYYY-MM-DD.'), { code: 'INVALID_DATE' });
  if (dayKey < tzDateKey(new Date(), 'Africa/Lagos')) {
    const failed = failedLiveBoard(dayKey, { code: 'PAST_DATE', message: 'Past dates require the historical odds API; the current live endpoint cannot reconstruct those quotes.' });
    return { ...failed, events: [], legs: [], diagnostics: failed.scan.diagnostics, quota: {}, leagues: [] };
  }
  const fetched = await fetchOddsApi(opts.sports, apiKey, {
    ...opts, dayKey,
  });

  const games = fetched.games;

  const scan = stamp(scanLiveGames(dayKey, games, opts), 'oddsapi', 'oddsapi', null);
  scan.diagnostics.quota = fetched.quota;
  scan.diagnostics.leagues = fetched.leagues;
  scan.diagnostics.leaguesQueried = fetched.leagues.length;
  scan.diagnostics.leaguesWithFixtures = fetched.leagues.filter((l) => l.ok && l.fixtures > 0).length;

  const builderOpts = { ...DEFAULT_BUILDER_OPTS, ...(opts.builder || {}) };
  const builderResult = buildLongshotTicket(scan.legs, builderOpts);
  Object.assign(scan.diagnostics, { sportsRequested: fetched.leagues.length,
    sportsSucceeded: fetched.leagues.filter(l => l.ok).length,
    sportsFailed: fetched.leagues.filter(l => !l.ok).length,
    rawFixtures: fetched.rawFixtures, fixturesOnDate: games.length,
    fixturesWithQuotes: scan.events.length, extractedSelections: scan.legs.length,
    requestStats: fetched.requestStats,
    partialCoverage: fetched.leagues.some(l => !l.ok) || fetched.additional.some(l => l.ok === false || l.code) || fetched.eventRequestsSkipped > 0,
    coverageWarnings: [...fetched.leagues, ...fetched.additional].filter(l => l.code).map(l => ({ code: l.code, sport: l.key, eventId: l.eventId, providerCode: l.providerCode, retryAfterMs: l.retryAfterMs })),
    additionalMarkets: fetched.additional, eventRequestsSkipped: fetched.eventRequestsSkipped,
    availableMarketTypes: [...new Set(scan.legs.map(l => l.providerMarket || l.marketType))], builder: builderResult.report });
  const coverageFailure = !fetched.leagues.some(l => l.ok) && fetched.leagues.find(l => l.code);
  const failure = fetched.fatal || (coverageFailure ? { code: coverageFailure.code, message: `No sports fetched successfully: ${coverageFailure.code}. See per-sport coverage.` } : null) || (!games.length ? { code: fetched.leagues.find(l => l.code === 'PROVIDER_TIMEOUT')?.code || 'NO_EVENTS_FOR_DATE',
    message: 'No events returned for the selected Lagos date. Past events require historical access; advance odds may not yet be published.' } :
    !scan.legs.length ? { code: 'MARKETS_UNAVAILABLE', message: 'Fixtures found but no complete usable bookmaker markets were returned.' } : null);
  if (failure) Object.assign(builderResult, { ok: false, best: null, reason: failure.code, message: failure.message });
  if (scan.diagnostics.partialCoverage && !builderResult.ok) builderResult.message += ' This result is based on incomplete provider coverage; see coverage warnings and skipped requests.';
  scan.diagnostics.reasonCode = builderResult.reason || 'ISSUED';
  builderResult.report.outcome = scan.diagnostics.reasonCode;

  return {
    scan,
    builder: builderResult,
    builderOpts,
    legs: scan.legs,
    events: scan.events,
    diagnostics: scan.diagnostics,
    quota: fetched.quota,
    leagues: fetched.leagues,
  };
}

/**
 * Fetch The Odds API v4 across sports on the board with quota header capture and 15s timeout.
 */
const QUOTE_CACHE = new Map();
const INFLIGHT = new Map();

export function failedLiveBoard(dayKey, err) {
  const diagnostics = { dayKey, providerRequested: 'oddsapi', providerUsed: 'oddsapi',
    fellBack: false, fetchedAt: new Date().toISOString(), ...(err.diagnostics || {}),
    reasonCode: err.code || 'LIVE_FETCH_FAILED', message: err.message };
  return { scan: { dayKey, events: [], legs: [], diagnostics }, builder: {
    ok: false, reason: diagnostics.reasonCode, message: err.message, report: diagnostics, alternatives: [] } };
}

export async function fetchOddsApi(sports, apiKey, opts = {}) {
  const { dayKey, signal, timeoutMs = 15000, maxEventRequests = 0, concurrency = 2, maxRetries = 2, retryDelayMs = 500, requestIntervalMs = 150 } = opts;
  const games = [], leagues = [], additional = [];
  const quota = { remaining: null, used: null };
  let fatal = null, rawFixtures = 0, nextRequestAt = 0, retriesLeft = 6;
  const creditBudget = Math.max(1, Math.min(30, Number(opts.maxCredits) || 30));
  const requestStats = { attempts: 0, rateLimits: 0, retries: 0, reservedCredits: 0, creditBudget };
  let budgetStopped = false;
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Request cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  async function request(path, params = {}) {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${path}`);
    url.search = new URLSearchParams({ apiKey, ...params });
    const key = url.href;
    const cached = QUOTE_CACHE.get(key);
    if (cached && cached.expires > Date.now()) {
      if (cached.quota.remaining != null) quota.remaining = quota.remaining == null ? cached.quota.remaining : Math.min(quota.remaining, cached.quota.remaining);
      quota.used = cached.quota.used;
      return cached.data;
    }
    if (INFLIGHT.has(key)) return INFLIGHT.get(key);
    const task = (async () => {
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        for (let attempt = 0; ; attempt++) {
        const scheduled = Math.max(Date.now(), nextRequestAt);
        nextRequestAt = scheduled + Math.max(0, requestIntervalMs);
        await wait(Math.max(0, scheduled - Date.now()), ctrl.signal);
        const cost = params.markets ? params.markets.split(',').length : 0;
        if (requestStats.reservedCredits + cost > creditBudget) {
          budgetStopped = true;
          throw Object.assign(new Error('Per-scan credit budget reached; remaining requests were not sent.'), { code: 'SCAN_BUDGET_REACHED' });
        }
        requestStats.reservedCredits += cost;
        requestStats.attempts++;
        const res = await fetch(url.href, { signal: ctrl.signal });
        for (const [field, header] of [['remaining', 'x-requests-remaining'], ['used', 'x-requests-used']]) {
          const v = res.headers?.get(header);
          if (v != null && Number.isFinite(Number(v))) {
            const value = Number(v);
            quota[field] = quota[field] == null ? value : field === 'remaining' ? Math.min(quota[field], value) : Math.max(quota[field], value);
          }
        }
        if (!res.ok) {
          const errorBody = await res.json().catch(() => ({}));
          const code = (errorBody.error_code === 'OUT_OF_USAGE_CREDITS' || (res.status === 429 && res.headers?.get('x-requests-remaining') === '0')) ? 'QUOTA_EXHAUSTED' : res.status === 401 ? 'AUTHENTICATION_FAILURE' : res.status === 429 ? 'RATE_LIMITED' : res.status === 403 ? 'MARKETS_UNAVAILABLE' : 'PROVIDER_ERROR';
          const retryHeader = res.headers?.get('retry-after');
          const retryAfterMs = retryHeader == null ? null : Number.isFinite(Number(retryHeader))
            ? Math.max(0, Number(retryHeader) * 1000) : Math.max(0, Date.parse(retryHeader) - Date.now());
          if (code === 'RATE_LIMITED') {
            requestStats.rateLimits++;
            const delay = Math.max(retryDelayMs * 2 ** attempt, retryAfterMs || 0);
            if (attempt < Math.min(2, Math.max(0, maxRetries)) && retriesLeft > 0 && delay <= 5000) {
              retriesLeft--; requestStats.retries++;
              nextRequestAt = Math.max(nextRequestAt, Date.now() + delay);
              continue;
            }
          }
          throw Object.assign(new Error(`${code}: provider HTTP ${res.status}`), {
            code, status: res.status, providerCode: errorBody.error_code || null,
            retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
          });
        }
        const data = await res.json();
        if (QUOTE_CACHE.size > 300) QUOTE_CACHE.clear();
        QUOTE_CACHE.set(key, { data, quota: { ...quota }, expires: Date.now() + 60000 });
        return data;
        }
      } catch (err) {
        if (ctrl.signal.aborted) throw Object.assign(new Error('Provider request timed out or was cancelled.'), { code: 'PROVIDER_TIMEOUT' });
        throw err;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    })();
    INFLIGHT.set(key, task);
    try { return await task; } finally { INFLIGHT.delete(key); }
  }
  let selected = SPORT_MAP.filter(s => !sports?.length || sports.includes(s.key));
  // Tennis uses tournament-specific active keys, not generic ATP/WTA endpoints.
  if (selected.some(s => s.sport === 'tennis')) {
    try {
      const active = await request('');
      if (Array.isArray(active)) selected = selected.flatMap(s => s.sport !== 'tennis' ? [s] :
        active.filter(x => x.active && x.key.startsWith(s.key + '_')).map(x => ({ ...s, key: x.key, league: x.title })));
    } catch (err) { additional.push({ stage: 'sports-discovery', code: err.code, message: err.message }); }
  }
  const params = { regions: 'uk', markets: 'h2h,totals,spreads', oddsFormat: 'decimal', dateFormat: 'iso' };
  if (dayKey) {
    const start = Date.parse(`${dayKey}T00:00:00+01:00`);
    params.commenceTimeFrom = new Date(start).toISOString().replace('.000Z', 'Z');
    params.commenceTimeTo = new Date(start + 86400000 - 1000).toISOString().replace('.000Z', 'Z');
  }
  for (const meta of selected) {
    if (budgetStopped || fatal || quota.remaining === 0) { leagues.push({ key: meta.key, ok: false, code: budgetStopped ? 'SCAN_BUDGET_REACHED' : fatal?.code || 'QUOTA_EXHAUSTED' }); continue; }
    try {
      const data = await request(`${meta.key}/odds`, params);
      if (!Array.isArray(data)) throw new Error('Malformed provider fixture response');
      rawFixtures += data.length;
      leagues.push({ key: meta.key, ok: true, fixtures: data.length });
      for (const g of data) if (!dayKey || tzDateKey(new Date(g.commence_time), 'Africa/Lagos') === dayKey)
        games.push({ ...structuredClone(g), _meta: meta });
    } catch (err) {
      leagues.push({ key: meta.key, ok: false, status: err.status, code: err.code || 'NETWORK_ERROR', providerCode: err.providerCode, retryAfterMs: err.retryAfterMs });
      if (['AUTHENTICATION_FAILURE', 'QUOTA_EXHAUSTED'].includes(err.code)) fatal = err;
    }
  }
  const unique = [...new Map(games.map(g => [g.id, g])).values()];
  let cursor = 0;
  if (dayKey) await Promise.all(Array.from({ length: Math.max(1, Math.min(6, concurrency)) }, async () => {
    while (cursor < Math.min(unique.length, maxEventRequests)) {
      if (budgetStopped || fatal || (quota.remaining !== null && quota.remaining < 5)) break;
      const g = unique[cursor++];
      try {
        const markets = g._meta.sport === 'football' ? 'double_chance,alternate_totals,team_totals,alternate_team_totals,alternate_spreads' : 'alternate_totals,alternate_spreads';
        const data = await request(`${g._meta.key}/events/${g.id}/odds`, { regions: 'uk', markets, oddsFormat: 'decimal', dateFormat: 'iso' });
        for (const book of data.bookmakers || []) {
          const existing = g.bookmakers?.find(b => (b.key || b.title) === (book.key || book.title));
          if (existing) existing.markets = [...existing.markets, ...book.markets];
          else (g.bookmakers ||= []).push(book);
        }
        additional.push({ eventId: g.id, ok: true });
      } catch (err) {
        additional.push({ eventId: g.id, ok: false, code: err.code || 'NETWORK_ERROR', providerCode: err.providerCode, retryAfterMs: err.retryAfterMs });
        if (['AUTHENTICATION_FAILURE', 'QUOTA_EXHAUSTED'].includes(err.code)) fatal = err;
      }
    }
  }));
  return { games: unique.map(g => normaliseOddsApiGame(g, g._meta)), quota, leagues, additional,
    rawFixtures, fatal, requestStats, eventRequestsSkipped: Math.max(0, unique.length - cursor) };
}

function normaliseOddsApiGame(g, meta) {
  const books = (g.bookmakers || []).map((b) => ({
    name: b.title,
    cls: classifyBook(b.title),
    markets: b.markets,
  }));
  return {
    id: g.id,
    sport: meta.sport,
    league: {
      code: meta.key,
      name: meta.league,
      tier: meta.tier,
      noise: meta.noise,
      base: meta.base,
      sigma: meta.sigma,
      scale: meta.scale,
    },
    kickoff: Date.parse(g.commence_time),
    home: { name: g.home_team },
    away: { name: g.away_team },
    books,
  };
}

/**
 * Turn live games from The Odds API into the pricing model format.
 * Prices h2h, totals (per line), and spreads (per line).
 * Leaves truthProb null (no tautological calibration).
 */
function scanLiveGames(dayKey, games, opts = {}) {
  const tz = opts.tz || 'Africa/Lagos';
  const legs = [];
  const events = [];
  const bookNames = new Set();
  let pricesQuoted = 0;
  let marketsSeen = 0;
  let skippedNotOnDay = 0;

  for (const g of games) {
    if (!g.kickoff || !Number.isFinite(g.kickoff)) continue;
    const gameDay = tzDateKey(new Date(g.kickoff), tz);
    if (dayKey && gameDay !== dayKey) {
      skippedNotOnDay++;
      continue;
    }

    const groups = new Map();
    for (const b of g.books || []) {
      for (const original of b.markets || []) {
        const split = new Map();
        for (const out of original.outcomes || []) {
          const point = original.key.includes('spreads') ? (out.name === g.home.name ? out.point : -out.point) : out.point;
          const k = `${point ?? ''}|${out.description || ''}`;
          if (!split.has(k)) split.set(k, { ...original, point, team: out.description, outcomes: [] });
          split.get(k).outcomes.push(out);
        }
        for (const m of split.values()) {
        let gkey = null;
        let type = null;
        let name = null;
        let point = null;
        if (m.key === 'double_chance') {
          gkey = type = 'double_chance'; name = 'Double chance';
        } else if (m.key === 'h2h') {
          gkey = 'h2h';
          type = 'h2h';
          name = 'Match Result';
        } else if (['totals', 'alternate_totals', 'team_totals', 'alternate_team_totals'].includes(m.key) && Number.isFinite(m.point)) {
          gkey = `${m.key}_${m.team || ''}_${m.point}`;
          type = 'totals';
          name = `${m.team || 'Total'} ${m.point} — Over/Under`;
          point = m.point;
        } else if (['spreads', 'alternate_spreads'].includes(m.key) && Number.isFinite(m.point)) {
          gkey = `${m.key}_${m.point}`;
          type = 'spreads';
          name = `Home handicap ${m.point}`;
          point = m.point;
        } else continue;

        if (!groups.has(gkey)) groups.set(gkey, { key: gkey, type, name, point, providerMarket: m.key, team: m.team, entries: [] });
        groups.get(gkey).entries.push({ book: b, m });
        }
      }
    }

    const marketsMeta = [];
    const offersByMarket = new Map();

    for (const [gkey, grp] of groups) {
      const names = [];
      for (const { m } of grp.entries) {
        for (const o of m.outcomes || []) {
          if (!names.includes(o.name)) names.push(o.name);
        }
      }
      if (names.length < 2 || (grp.type === 'double_chance' && names.length !== 3) ||
        (g.sport === 'football' && grp.type === 'h2h' && (names.length !== 3 || !names.includes('Draw')))) continue;

      const offers = [];
      for (const { book, m } of grp.entries) {
        const byName = new Map((m.outcomes || []).map((o) => [o.name, o.price]));
        const odds = names.map((nm) => byName.get(nm));
        if (odds.some((o) => !(Number.isFinite(o) && o > 1))) continue; // every book must quote every outcome
        offers.push({ book: { name: book.name, cls: book.cls }, odds });
        pricesQuoted += odds.length;
        bookNames.add(book.name);
      }
      if (!offers.length) continue;
      marketsSeen++;

      // Prior: h2h gets home boost, totals and spreads flat
      const prior = grp.type === 'h2h' ? outcomePrior(names, g.home?.name) : flatPrior(names);
      marketsMeta.push({ key: gkey, name: grp.name, type: grp.type, point: grp.point, line: grp.point, team: grp.team, providerMarket: grp.providerMarket, probabilitySource: 'devigged-cross-book-consensus-and-sharp', outcomes: prior });
      offersByMarket.set(gkey, offers);
    }

    if (!marketsMeta.length) continue;

    const event = {
      id: g.id,
      sport: g.sport,
      league: g.league,
      kickoff: g.kickoff,
      kickoffLocal: formatKickoff(g.kickoff, tz),
      home: g.home,
      away: g.away,
      markets: marketsMeta,
    };
    const kickoffHours = Math.max(0, (g.kickoff - Date.now()) / 3600000);
    const priced = priceEventFromOffers(event, offersByMarket, { tier: g.league.tier, kickoffHours });

    const eventLegs = extractLegs({ ...event, markets: priced.markets });
    for (const l of eventLegs) {
      l.live = true;
      l.truthProb = null;
    }
    legs.push(...eventLegs);
    events.push({
      eventId: g.id,
      sport: g.sport,
      league: g.league.name,
      home: g.home.name,
      away: g.away.name,
      kickoff: g.kickoff,
      kickoffLocal: event.kickoffLocal,
      legs: eventLegs.length,
      live: true,
    });
  }

  return {
    dayKey,
    legs,
    events,
    diagnostics: {
      dayKey,
      tz,
      provider: 'oddsapi',
      events: events.length,
      markets: marketsSeen,
      pricesQuoted,
      books: [...bookNames].sort(),
      bookCount: bookNames.size,
      bookQuotes: pricesQuoted,
      skippedNotOnDay,
      truthKnown: false,
      scope: 'Actual quoted bulk and event-specific markets; de-vigged cross-book estimates',
      fetchedAt: new Date().toISOString(),
    },
  };
}

function outcomePrior(names, homeName) {
  const home = String(homeName || '');
  const n = names.length;
  const homeBoost = 1.12;
  const raw = names.map((nm) => (nm === home ? homeBoost : 1));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return names.map((nm, i) => ({
    key: nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) || `o${i}`,
    label: nm,
    p: round(raw[i] / sum, 4),
  }));
}

function flatPrior(names) {
  const p = round(1 / names.length, 4);
  return names.map((nm, i) => ({
    key: nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) || `o${i}`,
    label: nm,
    p,
  }));
}

/**
 * Scan manual odds pasted by user.
 */
export function scanManual(dayKey, opts = {}) {
  const entries = opts.manualOdds || [];
  const legs = [];
  const pricedEvents = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const oddsList = entry.outcomes.map((o) => Number(o.odds));
    const impl = oddsList.map((o) => 1 / o);
    const sum = impl.reduce((a, b) => a + b, 0);
    const fair = impl.map((p) => p / sum);
    const modelGiven = entry.modelP && entry.modelP.length === impl.length ? entry.modelP : fair;
    const blended = fair.map((f, k) => clamp(0.72 * f + 0.28 * modelGiven[k], 0.001, 0.999));
    const bSum = blended.reduce((a, b) => a + b, 0);
    const model = blended.map((b) => b / bSum);

    const ev = {
      id: entry.id || `manual-${dayKey}-${i}`,
      sport: entry.sport || 'football',
      league: {
        code: (entry.league || 'MANUAL').toUpperCase().slice(0, 8),
        name: entry.league || 'Manual entry',
        tier: entry.tier ?? 2,
        noise: 0.08,
      },
      kickoff: entry.kickoff ? Date.parse(entry.kickoff) : Date.now() + 86400000,
      kickoffLocal: entry.kickoff ? formatKickoff(Date.parse(entry.kickoff), opts.tz || 'Africa/Lagos') : 'user supplied',
      home: { name: entry.home || 'Home' },
      away: { name: entry.away || 'Away' },
      markets: [
        {
          key: entry.marketKey || 'manual',
          name: entry.market || 'Selection',
          type: 'manual',
          overround: round((sum - 1) * 100, 2),
          outcomes: entry.outcomes.map((o, k) => ({
            key: o.key || `o${k}`,
            label: o.label || o.pick || `Selection ${k + 1}`,
            odds: Number(o.odds),
            bestBook: o.book || 'your book',
            avgOdds: Number(o.odds),
            impliedProb: round(impl[k], 4),
            fairProb: round(fair[k], 4),
            sharpProb: round(fair[k], 4),
            modelProb: round(model[k], 4),
            truthProb: null,
            edge: round(model[k] - impl[k], 4),
            edgePct: round((model[k] - impl[k]) * 100, 2),
            evPerUnit: round(model[k] * (Number(o.odds) - 1) - (1 - model[k]), 4),
            confidence: round(clamp(entry.confidence ?? 0.55, 0.1, 0.95), 3),
            confidenceBand: 'B',
            agreement: 0.6,
          })),
          books: [],
        },
      ],
    };
    pricedEvents.push(ev);
    legs.push(...extractLegs(ev));
  }

  for (const l of legs) {
    l.viewSource = 'pasted-single-book';
    l.live = true;
    l.truthProb = null;
  }

  return {
    dayKey,
    events: pricedEvents,
    legs,
    diagnostics: {
      dayKey,
      provider: 'manual',
      events: pricedEvents.length,
      markets: pricedEvents.length,
      pricesQuoted: legs.length,
      books: [],
      avgOverround: 5,
      positiveEdgeLegs: legs.filter((l) => l.edge > 0).length,
    },
  };
}

export function scanForDay(dayKey, runConfig = {}, overrides = {}) {
  const opts = {
    tz: runConfig.tz || 'Africa/Lagos',
    provider: runConfig.provider || 'sim',
    eventsPerDay: runConfig.eventsPerDay || 38,
    marketInefficiency: runConfig.marketInefficiency ?? 1.2,
    manualOdds: overrides.manualOdds ?? runConfig.manualOdds,
    apiKey: overrides.apiKey ?? runConfig.oddsApiKey ?? runConfig.apiKey ?? '',
    sports: overrides.sports ?? runConfig.sports ?? [],
    ...overrides,
  };
  const scan = scanDay(dayKey, opts);
  const builderOpts = {
    ...DEFAULT_BUILDER_OPTS,
    ...(runConfig.builder || {}),
    ...(overrides.builder || {}),
  };
  const result = scan.diagnostics.reasonCode ? failedLiveBoard(dayKey, { code: scan.diagnostics.reasonCode, message: scan.diagnostics.message }).builder : buildLongshotTicket(scan.legs, builderOpts);
  return {
    scan,
    builder: result,
    builderOpts,
    legs: scan.legs,
    events: scan.events,
    diagnostics: scan.diagnostics,
  };
}
