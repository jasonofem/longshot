/**
 * http-core.js — the LONGSHOT HTTP core with zero runtime dependencies.
 *
 * Runs identically in three environments:
 *   - server/index.js: node:http + store.js (data/store.json)
 *   - api/index.js: Vercel serverless + memory-store.js (reporting persistent: false)
 *   - public/local-api.js: Browser tab + localStorage store
 */

import {
  createWeek,
  settleTicket,
  rescanDayTicket,
  computeWeekStats,
  assessGoal,
  getWeeklyVerdict,
  formatNaira,
  WEEK_STATUS,
  TICKET_STATUS,
} from './longshot.js';
import { scanDay, scanForDay, scanDayLive, failedLiveBoard, PROVIDERS, SPORT_MAP } from './scan.js';
import { SIGNAL_WEIGHTS } from './markets.js';
import { tzNowParts, tzDateKey, getLagosWeek, upcomingWeeks } from './fixtures.js';
import { DEFAULT_BUILDER_OPTS, DEFAULT_STAKE_BANDS, MIN_TICKET_ODDS, MAX_TICKET_ODDS } from './builder.js';

export const ENGINE_INFO = {
  name: 'LONGSHOT',
  version: '1.0.0',
  mission: 'Weekly longshot-accumulator portfolio engine (odds 10.0–1000.0, stake ₦100–₦500)',
  signalWeights: SIGNAL_WEIGHTS,
  sportMapCount: SPORT_MAP.length,
  oddsBand: [MIN_TICKET_ODDS, MAX_TICKET_ODDS],
  notes: [
    'Every week issues 7 tickets (Monday–Sunday, Africa/Lagos timezone).',
    'Ticket combined odds strictly in 10.0 – 1000.0.',
    'Stake scaled by ticket confidence band: A→₦500, B→₦350, C→₦200, D→₦100.',
    'User target: 2–3 wins out of 7. Expected wins = Σ ticket win probs.',
    'Honest numbers: treats goal as optimization target, never as a promise.',
    'Live odds from The Odds API v4 (h2h, totals, spreads) with quota header capture.',
    'Loud gold SIMULATED banner whenever data is simulated or falls back.',
  ],
};

export function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

export function toPlain(value) {
  return JSON.parse(JSON.stringify(value, jsonSafe));
}

/**
 * Await live scan whenever an API key exists (prepared-board pattern).
 */
function liveProvider(p) { return ['oddsapi', 'sportsgameodds'].includes(p); }
function liveKey(settings, env, provider = settings.provider) {
  return provider === 'sportsgameodds' ? settings.sportsGameOdds?.key || env.SPORTSGAMEODDS_API_KEY || '' : settings.oddsApi?.key || env.ODDS_API_KEY || '';
}

async function livePreparedForWeek(env, body, settings, weekDays, liveBoards = null, liveScanner = scanDayLive) {
  if (liveBoards && Object.keys(liveBoards).length) return liveBoards;
  if (!liveProvider(settings.provider)) return {};

  const key = body?.apiKey || liveKey(settings, env);
  if (!key) return {};

  const boards = {};
  const sports = settings.oddsApi?.sports || [];
  const scanDate = body.scanDate || body.weekDate || tzDateKey(new Date(), 'Africa/Lagos');
  const daysToFetch = (weekDays || []).filter(day => day.date === scanDate);
  for (const day of weekDays || []) if (day.date !== scanDate) boards[day.date] = failedLiveBoard(day.date,
    { code: 'NOT_SCANNED', message: 'Not scanned to conserve API credits. Select this day and explicitly rescan when needed.' }, settings.provider);

  for (const day of daysToFetch) {
    try {
      const live = await liveScanner(day.date, {
        tz: settings.tz, provider: settings.provider, leagues: settings.sportsGameOdds?.leagues || [],
        apiKey: key,
        sports,
        maxEventRequests: body.additionalMarkets === true ? 3 : 0,
        builder: {
          ...(settings.builder || {}),
          stakeBands: settings.stakeBands || DEFAULT_STAKE_BANDS,
          minEdgePerLeg: Number(settings.minEdgePerLeg ?? 0.012),
        },
      });
      boards[day.date] = { scan: live.scan, builder: live.builder };
    } catch (err) {
      boards[day.date] = failedLiveBoard(day.date, err, settings.provider);
    }
  }

  return boards;
}

export function createApi({ store, env = {}, persistent = true, liveScanner = scanDayLive } = {}) {
  const startedAt = Date.now();

  async function statePayload() {
    const settings = await store.getSettings();
    const activeWeek = await store.getActiveWeek();
    const weeks = await store.listWeeks(20);
    const now = new Date();
    const tz = settings.tz || 'Africa/Lagos';
    if (activeWeek) {
      activeWeek.todayDate = tzDateKey(now, tz);
      activeWeek.todayIndex = activeWeek.tickets.findIndex(t => t.date === activeWeek.todayDate);
      activeWeek.tickets.forEach(t => { t.isToday = t.date === activeWeek.todayDate; });
    }

    return {
      settings,
      providers: PROVIDERS,
      sportMap: SPORT_MAP,
      now: tzNowParts(now, tz),
      currentWeek: getLagosWeek(now, tz),
      activeWeek,
      weeks,
      engine: { ...ENGINE_INFO, persistent },
      runtime: {
        persistent,
        mode: persistent ? 'server' : 'stateless',
        advice: persistent
          ? 'Weekly portfolios are persisted on the server.'
          : 'Stateless deployment: the dashboard runs the engine locally in your browser and saves to localStorage.',
      },
    };
  }

  return async function api({ method, pathname, query, body = {} }) {
    const q = query instanceof URLSearchParams ? query : new URLSearchParams(typeof query === 'string' ? query : '');
    const p = String(pathname || '').replace(/\/+$/, '');
    const seg = p.split('/').filter(Boolean); // ['api', ...]

    if (method === 'GET' && p === '/api/state') {
      return { status: 200, body: await statePayload() };
    }

    if (method === 'GET' && p === '/api/health') {
      return { status: 200, body: { ok: true, persistent, uptimeMs: Date.now() - startedAt } };
    }

    if (method === 'GET' && p === '/api/providers') {
      return { status: 200, body: { providers: PROVIDERS } };
    }

    if (method === 'GET' && p === '/api/calendar') {
      const settings = await store.getSettings();
      const tz = settings.tz || 'Africa/Lagos';
      const now = new Date();
      return {
        status: 200,
        body: {
          tz,
          now: tzNowParts(now, tz),
          currentWeek: getLagosWeek(now, tz),
          upcomingWeeks: upcomingWeeks(4, now, tz),
        },
      };
    }

    if (method === 'GET' && p === '/api/scan') {
      const settings = await store.getSettings();
      const tz = settings.tz || 'Africa/Lagos';
      const date = q.get('date') || tzDateKey(new Date(), tz);
      const wantProvider = q.get('provider') || settings.provider || 'sim';
      const apiKey = q.get('apiKey') || liveKey(settings, env);

      if (liveProvider(wantProvider)) return api({ method, pathname: '/api/scan/live', query: q });
      const scanResult = scanForDay(
        date,
        {
          tz,
          provider: wantProvider,
          apiKey,
          sports: settings.oddsApi?.sports || [],
          eventsPerDay: settings.eventsPerDay || 38,
          marketInefficiency: settings.marketInefficiency ?? 1.2,
          manualOdds: settings.manualOdds || [],
          builder: {
          ...(settings.builder || {}),
            stakeBands: settings.stakeBands || DEFAULT_STAKE_BANDS,
            minEdgePerLeg: Number(settings.minEdgePerLeg ?? 0.012),
          },
        }
      );

      return {
        status: 200,
        body: {
          date,
          provider: {
            requested: scanResult.scan.diagnostics?.providerRequested ?? wantProvider,
            used: scanResult.scan.diagnostics?.providerUsed ?? 'sim',
            fellBack: Boolean(scanResult.scan.diagnostics?.fellBack),
            reason: scanResult.scan.diagnostics?.fallbackReason ?? null,
          },
          diagnostics: scanResult.diagnostics,
          builder: scanResult.builder,
          events: scanResult.events,
          legs: scanResult.legs,
          topLegs: [...scanResult.legs].sort((a, b) => b.edge - a.edge).slice(0, 50),
        },
      };
    }

    if (['GET', 'POST'].includes(method) && p === '/api/scan/live') {
      const settings = await store.getSettings();
      const tz = settings.tz || 'Africa/Lagos';
      const date = body.date || q.get('date') || tzDateKey(new Date(), tz);
      const provider = body.provider || q.get('provider') || (liveProvider(settings.provider) ? settings.provider : 'oddsapi');
      if (!liveProvider(provider)) return { status: 400, body: { error: 'Unknown live provider', code: 'INVALID_PROVIDER' } };
      const apiKey = body.apiKey || q.get('apiKey') || liveKey(settings, env, provider);

      if (!apiKey) {
        return {
          status: 400,
          body: {
            error: 'No key configured for the selected provider. Save its key in Settings.',
            code: 'NO_KEY',
          },
        };
      }

      try {
        const live = await liveScanner(date, {
          tz, provider, leagues: body.leagues || settings.sportsGameOdds?.leagues || [],
          apiKey,
          maxEventRequests: body.additionalMarkets === true ? 3 : 0,
          sports: Array.isArray(body.sports) ? body.sports : settings.oddsApi?.sports || [],
          builder: {
          ...(settings.builder || {}),
            ...(body.builder || {}),
            stakeBands: body.builder?.stakeBands || settings.stakeBands || DEFAULT_STAKE_BANDS,
            minEdgePerLeg: Number(body.builder?.minEdgePerLeg ?? settings.minEdgePerLeg ?? 0.012),
          },
        });

        return {
          status: 200,
          body: {
            date,
            provider: {
              requested: provider,
              used: provider,
              fellBack: false,
              reason: null,
            },
            diagnostics: live.diagnostics,
            quota: live.quota,
            leagues: live.leagues,
            builder: live.builder,
            events: live.events,
            legs: live.legs,
            topLegs: [...live.legs].sort((a, b) => b.edge - a.edge).slice(0, 50),
          },
        };
      } catch (err) {
        return {
          status: err.code === 'NO_GAMES' ? 404 : 502,
          body: {
            error: err.message,
            code: err.code || 'LIVE_FETCH_FAILED',
          },
        };
      }
    }

    if (method === 'POST' && p === '/api/settings') {
      const saved = await store.saveSettings(body);
      return { status: 200, body: { settings: saved } };
    }

    if (method === 'GET' && p === '/api/weeks') {
      const list = await store.listWeeks(Number(q.get('limit') || 20));
      return { status: 200, body: { weeks: list } };
    }

    if (method === 'POST' && p === '/api/weeks') {
      const settings = await store.getSettings();
      const tz = settings.tz || 'Africa/Lagos';
      const weekDate = body.weekDate || tzDateKey(new Date(), tz);
      const goal = Number(body.goal ?? settings.goal ?? 2);

      // Save any updated settings from creation body
      if (body.apiKey) {
        await store.saveSettings({
          [body.provider === 'sportsgameodds' || (!body.provider && settings.provider === 'sportsgameodds') ? 'sportsGameOdds' : 'oddsApi']: { ...(body.provider === 'sportsgameodds' || (!body.provider && settings.provider === 'sportsgameodds') ? settings.sportsGameOdds : settings.oddsApi), key: body.apiKey },
          provider: body.provider === 'sportsgameodds' || (!body.provider && settings.provider === 'sportsgameodds') ? 'sportsgameodds' : 'oddsapi',
        });
      }

      if (body.provider && ['sim', 'oddsapi', 'sportsgameodds', 'manual'].includes(body.provider)) await store.saveSettings({ provider: body.provider });
      const mergedSettings = await store.getSettings();
      const lagosWeek = getLagosWeek(weekDate, tz);

      // Prepared board pattern: await live scan if key exists
      const liveBoards = await livePreparedForWeek(
        env,
        body,
        mergedSettings,
        lagosWeek.days,
        body.liveBoards, liveScanner
      );

      const week = createWeek({
        weekDate,
        goal,
        settings: mergedSettings,
        liveBoards,
      });

      await store.saveWeek(week);
      return { status: 201, body: { week } };
    }

    if (method === 'GET' && seg.length === 3 && seg[0] === 'api' && seg[1] === 'weeks') {
      const id = seg[2];
      const week = await store.getWeek(id);
      if (!week) return { status: 404, body: { error: `Week "${id}" not found` } };
      return { status: 200, body: { week } };
    }

    if (method === 'POST' && seg.length === 4 && seg[0] === 'api' && seg[1] === 'weeks' && seg[3] === 'rescan') {
      const id = seg[2];
      const week = await store.getWeek(id);
      if (!week) return { status: 404, body: { error: `Week "${id}" not found` } };

      const settings = await store.getSettings();
      const tz = settings.tz || 'Africa/Lagos';
      const dayIndex = body.dayIndex !== undefined ? Number(body.dayIndex) : null;

      if (dayIndex !== null) {
        const ticket = week.tickets.find((t) => t.dayIndex === dayIndex);
        if (!ticket) return { status: 400, body: { error: `Invalid dayIndex ${dayIndex}` } };

        let prepared = body.prepared || null;
        if (!prepared && liveProvider(settings.provider)) {
          const key = body.apiKey || liveKey(settings, env);
          if (key) {
            try {
              const live = await liveScanner(ticket.date, {
                tz, provider: settings.provider, leagues: settings.sportsGameOdds?.leagues || [],
                apiKey: key,
                sports: settings.oddsApi?.sports || [],
                maxEventRequests: body.additionalMarkets === true ? 3 : 0,
                builder: { ...(settings.builder || {}), stakeBands: settings.stakeBands, minEdgePerLeg: settings.minEdgePerLeg },
              });
              prepared = { scan: live.scan, builder: live.builder };
            } catch (err) { prepared = failedLiveBoard(ticket.date, err, settings.provider); }
          }
        }

        rescanDayTicket(week, dayIndex, settings, prepared);
      } else {
        if (liveProvider(settings.provider)) return { status: 400, body: { code: 'SELECT_DAY_REQUIRED', error: 'Full-week live scanning is disabled to protect credits. Select one day to rescan.' } };
        // Rescan entire week
        const lagosWeek = getLagosWeek(week.mondayDate, tz);
        const liveBoards = await livePreparedForWeek(env, body, settings, lagosWeek.days, body.liveBoards, liveScanner);
        for (let i = 0; i < 7; i++) {
          const t = week.tickets[i];
          const prep = liveBoards[t.date] || null;
          rescanDayTicket(week, i, settings, prep);
        }
      }

      await store.saveWeek(week);
      return { status: 200, body: { week } };
    }

    if (
      method === 'POST' &&
      seg.length === 6 &&
      seg[0] === 'api' &&
      seg[1] === 'weeks' &&
      seg[3] === 'tickets' &&
      seg[5] === 'settle'
    ) {
      const id = seg[2];
      const dayIndex = Number(seg[4]);
      const week = await store.getWeek(id);
      if (!week) return { status: 404, body: { error: `Week "${id}" not found` } };

      const outcome = body.outcome;
      if (outcome !== 'won' && outcome !== 'lost') {
        return { status: 400, body: { error: `Outcome must be "won" or "lost", got "${outcome}"` } };
      }

      try {
        settleTicket(week, dayIndex, outcome);
        await store.saveWeek(week);
        return { status: 200, body: { week, ticket: week.tickets[dayIndex] } };
      } catch (err) {
        return { status: 400, body: { error: err.message } };
      }
    }

    if (method === 'GET' && p === '/api/history') {
      const weeks = await store.listWeeks(50);
      return { status: 200, body: { history: weeks } };
    }

    return { status: 404, body: { error: `Route not found: ${method} ${pathname}` } };
  };
}
