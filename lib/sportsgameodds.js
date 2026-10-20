/** SportsGameOdds v2. Only actual, available bookmaker quotes are bettable.
 * Docs: https://sportsgameodds.com/docs/data-types/odds
 * Deliberately ignores provider consensus prices, props, alternate-line payloads
 * and push-capable totals/spreads until their settlement model is implemented.
 */
import { tzDateKey } from './fixtures.js';
import { priceEventFromOffers, extractLegs, classifyBook } from './markets.js';
import { buildLongshotTicket } from './builder.js';

const cache = new Map();
const pending = new Map();
const sports = { SOCCER: 'football', BASKETBALL: 'basketball', TENNIS: 'tennis', BASEBALL: 'baseball', HOCKEY: 'icehockey', ICE_HOCKEY: 'icehockey', MMA: 'mma', FOOTBALL: 'americanfootball' };
export function americanToDecimal(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) >= 100 ? (n > 0 ? 1 + n / 100 : 1 + 100 / -n) : null;
}

export function convertSgoEvent(raw) {
  const home = raw.teams?.home?.names?.long;
  const away = raw.teams?.away?.names?.long;
  if (!home || !away || !sports[raw.sportID] || raw.type !== 'match') return null;
  const event = { id: raw.eventID, sport: sports[raw.sportID], home: { name: home }, away: { name: away },
    kickoff: Date.parse(raw.status?.startsAt), league: { code: raw.leagueID, name: raw.leagueID, tier: 2 }, markets: [] };
  const groups = new Map();
  for (const [oddID, odd] of Object.entries(raw.odds || {})) {
    const [stat, entity, period, bet, side] = oddID.split('-');
    if (!['points', 'goals'].includes(stat) || period !== 'game' || odd.started || odd.ended) continue;
    let type, expected, outcome, team = null;
    if (bet === 'ml3way' && ['home', 'away', 'draw'].includes(side)) {
      type = 'h2h'; expected = ['home', 'away', 'draw']; outcome = side;
    } else if (bet === 'ml3way' && ['home+draw', 'away+draw', 'not_draw'].includes(side)) {
      type = 'double_chance'; expected = ['home+draw', 'away+draw', 'not_draw']; outcome = side;
    } else if (bet === 'ml' && raw.sportID !== 'SOCCER' && ['home', 'away'].includes(side)) {
      type = 'h2h'; expected = ['home', 'away']; outcome = side;
    } else if (bet === 'ou' && ['home', 'away', 'all'].includes(entity) && ['over', 'under'].includes(side)) {
      type = entity === 'all' ? 'totals' : 'team_totals'; expected = ['over', 'under']; outcome = side;
      team = entity === 'home' ? home : entity === 'away' ? away : null;
    } else if (bet === 'sp' && ['home', 'away'].includes(side)) {
      type = 'spreads'; expected = ['home', 'away']; outcome = side;
    } else continue;
    for (const [book, quote] of Object.entries(odd.byBookmaker || {})) {
      if (quote.available !== true) continue;
      const odds = americanToDecimal(quote.odds);
      if (!odds) continue;
      let line = null;
      if (bet === 'ou' || bet === 'sp') {
        const value = bet === 'ou' ? quote.overUnder : quote.spread;
        if (value == null || value === '') continue;
        line = Number(value);
        // Half lines avoid pushes and quarter-line split settlements.
        if (!Number.isFinite(line) || Math.abs(line % 1) !== 0.5) continue;
        if (bet === 'sp' && side === 'away') line = -line;
      }
      const key = `${stat}|${bet}|${type}|${team || ''}|${line ?? ''}`;
      if (!groups.has(key)) groups.set(key, { key, type, team, line, expected, books: new Map() });
      const group = groups.get(key);
      if (!group.books.has(book)) group.books.set(book, new Map());
      group.books.get(book).set(outcome, { odds, oddID });
    }
  }
  const offers = new Map();
  const names = { home, away, draw: 'Draw', 'home+draw': `${home} or Draw`, 'away+draw': `${away} or Draw`, not_draw: `${home} or ${away}`, over: 'Over', under: 'Under' };
  for (const group of groups.values()) {
    const complete = [...group.books].filter(([, entries]) => group.expected.every(s => entries.has(s)));
    if (!complete.length) continue;
    event.markets.push({ key: group.key, type: group.type, name: `${group.team || ''} ${group.type} ${group.line ?? ''}`.trim(),
      line: group.line, team: group.team, providerMarket: group.key, probabilitySource: 'sportsgameodds-bookmaker-devig-consensus-and-sharp',
      outcomes: group.expected.map(side => ({ key: side, label: names[side], p: 1 / group.expected.length })) });
    offers.set(group.key, complete.map(([book, quotes]) => ({ book: { name: book, cls: classifyBook(book) }, odds: group.expected.map(side => quotes.get(side).odds) })));
  }
  const priced = priceEventFromOffers(event, offers, { kickoffHours: Math.max(0, (event.kickoff - Date.now()) / 3600000) });
  const legs = extractLegs({ ...event, markets: priced.markets }).map(l => ({ ...l, live: true, truthProb: null, provider: 'sportsgameodds', providerOddID: groups.get(l.marketKey)?.books.get(l.book)?.get(l.pickKey)?.oddID }));
  return { event: { ...event, markets: priced.markets }, legs };
}

export async function scanSportsGameOdds(dayKey, opts = {}) {
  const diagnostics = { dayKey, tz: 'Africa/Lagos', provider: 'sportsgameodds', providerRequested: 'sportsgameodds', providerUsed: 'sportsgameodds',
    fellBack: false, fetchedAt: new Date().toISOString(), rawFixtures: 0, fixturesOnDate: 0,
    requestLimit: 2, eventObjectLimit: 50, requestsSent: 0, cachedPages: 0, partialCoverage: false, coverageWarnings: [],
    usageNote: 'At most 2 pages of 25 events (50 objects). Free plan allowance is measured in returned objects, not scans. Cached pages do not make new provider requests.',
    scope: 'Available full-game bookmaker moneyline, quoted double chance, half-line totals/team totals/spreads. Alternate-line payloads and push markets excluded.' };
  const events = [], legs = [];
  let failure = null, cursor = null;
  const seen = new Set(), cursors = new Set();
  if (!opts.apiKey) failure = { code: 'NO_KEY', message: 'Configure a SportsGameOdds key, not a The Odds API key.' };
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !Number.isFinite(Date.parse(dayKey))) failure = { code: 'INVALID_DATE', message: 'Use a valid YYYY-MM-DD date.' };
  else if (dayKey < tzDateKey(new Date(), 'Africa/Lagos')) failure = { code: 'PAST_DATE', message: 'Past-day scanning is disabled to conserve allowance.' };
  const start = Date.parse(`${dayKey}T00:00:00+01:00`);
  for (let page = 0; !failure && page < 2; page++) {
    const url = new URL('https://api.sportsgameodds.com/v2/events/');
    url.search = new URLSearchParams({ oddsAvailable: 'true', started: 'false', cancelled: 'false', type: 'match', limit: '25',
      startsAfter: new Date(start - 1).toISOString(), startsBefore: new Date(start + 86400000).toISOString(), includeAltLines: 'false' });
    if (Array.isArray(opts.leagues) && opts.leagues.length) url.searchParams.set('leagueID', opts.leagues.join(','));
    if (cursor) url.searchParams.set('cursor', cursor);
    const key = `${opts.apiKey}|${url.href}`;
    try {
      let data;
      if (cache.get(key)?.until > Date.now()) { data = cache.get(key).data; diagnostics.cachedPages++; }
      else {
        if (!pending.has(key)) {
          const task = (async () => {
            const ctrl = new AbortController();
            const abort = () => ctrl.abort();
            opts.signal?.addEventListener('abort', abort, { once: true });
            if (opts.signal?.aborted) abort();
            const timer = setTimeout(abort, 15000);
            try {
              diagnostics.requestsSent++;
              const res = await fetch(url.href, { headers: { 'x-api-key': opts.apiKey }, signal: ctrl.signal });
              const json = await res.json().catch(() => null);
              if (!res.ok || json?.success !== true || !Array.isArray(json.data)) {
                const code = res.status === 401 ? 'AUTHENTICATION_FAILURE' : res.status === 403 ? 'SUBSCRIPTION_ACCESS_DENIED' : res.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR';
                throw Object.assign(new Error(`SportsGameOdds ${code} (HTTP ${res.status}); check your account access/usage. No automatic retry was sent.`), { code });
              }
              if (cache.size >= 40) cache.clear();
              cache.set(key, { data: json, until: Date.now() + 60000 });
              return json;
            } catch (err) {
              if (ctrl.signal.aborted) throw Object.assign(new Error('SportsGameOdds request timed out or was cancelled.'), { code: 'PROVIDER_TIMEOUT' });
              throw err;
            } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
          })();
          pending.set(key, task);
        }
        try { data = await pending.get(key); } finally { pending.delete(key); }
      }
      diagnostics.rawFixtures += data.data.length;
      for (const raw of data.data) {
        const kickoff = Date.parse(raw.status?.startsAt);
        if (!Number.isFinite(kickoff) || kickoff < start || kickoff >= start + 86400000 || raw.status?.started || raw.status?.cancelled || raw.status?.ended || seen.has(raw.eventID)) continue;
        seen.add(raw.eventID); diagnostics.fixturesOnDate++;
        const converted = convertSgoEvent(raw);
        if (!converted?.legs.length) continue;
        events.push(converted.event); legs.push(...converted.legs);
      }
      cursor = data.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) { diagnostics.coverageWarnings.push({ code: 'REPEATED_CURSOR' }); break; }
      cursors.add(cursor);
    } catch (err) {
      failure = { code: err.code || 'NETWORK_ERROR', message: err.code ? err.message : 'SportsGameOdds could not be reached. No simulated quotes were substituted.' };
    }
  }
  if (cursor || failure) diagnostics.partialCoverage = true;
  if (cursor) diagnostics.coverageWarnings.push({ code: 'PAGE_LIMIT_REACHED' });
  if (failure) diagnostics.coverageWarnings.push({ code: failure.code });
  Object.assign(diagnostics, { fixturesWithQuotes: events.length, extractedSelections: legs.length, availableMarketTypes: [...new Set(legs.map(l => l.marketType))] });
  const builder = buildLongshotTicket(legs, opts.builder || {});
  if (!failure && !legs.length) failure = { code: diagnostics.fixturesOnDate ? 'MARKETS_UNAVAILABLE' : 'NO_EVENTS_FOR_DATE', message: 'No complete supported bookmaker markets available for the selected Lagos date and account coverage.' };
  if (failure) Object.assign(builder, { ok: false, best: null, reason: failure.code, message: failure.message });
  builder.report.outcome = builder.reason || 'ISSUED'; diagnostics.reasonCode = builder.report.outcome; diagnostics.builder = builder.report;
  const scan = { dayKey, events, legs, diagnostics };
  return { scan, events, legs, diagnostics, builder, quota: { remaining: null, used: null, unit: 'See SportsGameOdds account dashboard' }, leagues: [] };
}
