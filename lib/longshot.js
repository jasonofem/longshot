/**
 * longshot.js — core domain engine for LONGSHOT weekly portfolio.
 *
 * MISSION
 * -------
 * Every week (Monday–Sunday, Africa/Lagos) the engine issues 7 tickets, one per day.
 * Each ticket is an accumulator whose combined odds land in [20.0, 1000.0].
 * Stakes are ₦100–₦500 scaled by ticket confidence band (A: ₦500, B: ₦350, C: ₦200, D: ₦100).
 * Goal: 2–3 winning tickets out of 7 in a week.
 *
 * Verdict strings:
 *   >= 2 wins -> "X of 7 landed — the longshot board paid"
 *   else      -> "X of 7 — we go again"
 */

import { getLagosWeek, tzDateKey } from './fixtures.js';
import { scanDay, scanForDay, scanDayLive, failedLiveBoard } from './scan.js';
import { buildLongshotTicket, validateTicketOdds, DEFAULT_BUILDER_OPTS, DEFAULT_STAKE_BANDS } from './builder.js';
import { round, clamp } from './math.js';

export const WEEK_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
};

export const TICKET_STATUS = {
  PENDING: 'pending',
  WON: 'won',
  LOST: 'lost',
  UNISSUED: 'unissued',
};

/**
 * Format currency in Nigerian Naira (₦).
 */
export function formatNaira(amount) {
  const n = Number(amount) || 0;
  const isNegative = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-NG', {
    minimumFractionDigits: abs % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${isNegative ? '-' : ''}₦${formatted}`;
}

/**
 * Structural goal assessment comparing user target to honest modelled EV.
 */
export function assessGoal({ goal = 2, expectedWins = 0, issuedCount = 7 }) {
  const g = Number(goal) || 2;
  const isStructurallyBelow = expectedWins < g;
  const avgP = issuedCount > 0 ? expectedWins / issuedCount : 0.08;
  const pReq = clamp(g / 7, 0.05, 0.95);
  const fairOddsReq = round(1 / pReq, 1);
  const bandLo = round(Math.max(1.5, fairOddsReq * 0.85), 1);
  const bandHi = round(fairOddsReq * 1.15, 1);
  const recommendedOddsBand = `${bandLo} – ${bandHi}`;

  let analysis = '';
  if (isStructurallyBelow) {
    analysis = `Your target is ${g} wins/week. The modelled expectation at longshot odds (≥20.0) is ${expectedWins.toFixed(2)} wins (${(avgP * 100).toFixed(1)}% avg win rate). The engine treats your goal as an optimisation target, never as a promise. Hitting ${g} wins in 7 days at odds 20.0–1000.0 is an extraordinary week.`;
  } else {
    analysis = `Modelled expectation (${expectedWins.toFixed(2)} wins) meets or exceeds your goal of ${g} wins.`;
  }

  const explanation = `To mathematically average ${g} expected wins across 7 tickets, tickets would require an average win probability of ${(pReq * 100).toFixed(1)}%, which corresponds to a shorter odds band around ${recommendedOddsBand} rather than longshot odds (≥20.0).`;

  return {
    goal: g,
    expectedWins: round(expectedWins, 2),
    isStructurallyBelow,
    analysis,
    recommendedOddsBand,
    explanation,
  };
}

/**
 * Weekly verdict string based on number of landed tickets.
 */
export function getWeeklyVerdict(wonCount) {
  const w = Number(wonCount) || 0;
  if (w >= 2) {
    return `${w} of 7 landed — the longshot board paid`;
  }
  return `${w} of 7 — we go again`;
}

/**
 * Compute portfolio statistics for a week.
 */
export function computeWeekStats(week) {
  let totalStaked = 0;
  let totalReturned = 0;
  let expectedWins = 0;
  let wonCount = 0;
  let lostCount = 0;
  let pendingCount = 0;
  let unissuedCount = 0;

  for (const t of week.tickets) {
    if (!t.issued || !t.slip) {
      unissuedCount++;
      continue;
    }
    const stake = Number(t.slip.stake) || 0;
    totalStaked += stake;
    expectedWins += Number(t.slip.winProb) || 0;

    if (t.status === TICKET_STATUS.WON) {
      wonCount++;
      const payout = round(stake * Number(t.slip.odds), 2);
      t.payout = payout;
      t.profit = round(payout - stake, 2);
      totalReturned += payout;
    } else if (t.status === TICKET_STATUS.LOST) {
      lostCount++;
      t.payout = 0;
      t.profit = -stake;
    } else {
      pendingCount++;
      t.payout = 0;
      t.profit = 0;
    }
  }

  const issuedCount = week.tickets.length - unissuedCount;
  const netPnl = round(totalReturned - totalStaked, 2);
  const allSettled = issuedCount > 0 && pendingCount === 0;

  const goalAssessment = assessGoal({
    goal: week.goal ?? 2,
    expectedWins,
    issuedCount,
  });

  const verdict = allSettled || wonCount >= 2 ? getWeeklyVerdict(wonCount) : null;

  return {
    issuedCount,
    unissuedCount,
    totalStaked: round(totalStaked, 2),
    totalReturned: round(totalReturned, 2),
    netPnl,
    wonCount,
    lostCount,
    pendingCount,
    expectedWins: round(expectedWins, 2),
    avgWinProbPct: issuedCount > 0 ? round((expectedWins / issuedCount) * 100, 2) : 0,
    goal: week.goal ?? 2,
    goalAssessment,
    verdict,
    allSettled,
  };
}

/**
 * Create a new 7-day week portfolio.
 *
 * @param {object} opts
 * @param {string} [opts.weekDate]  Reference date YYYY-MM-DD
 * @param {number} [opts.goal=2]    User target wins (2 or 3)
 * @param {object} [opts.settings]  System settings
 * @param {object} [opts.liveBoards] Pre-fetched live scan boards map { [date]: { scan, builder } }
 */
export function createWeek({ weekDate = null, goal = 2, settings = {}, liveBoards = {} } = {}) {
  const tz = settings.tz || 'Africa/Lagos';
  const lagosWeek = getLagosWeek(weekDate || new Date(), tz);

  const week = {
    id: lagosWeek.weekId,
    mondayDate: lagosWeek.mondayDate,
    sundayDate: lagosWeek.sundayDate,
    todayDate: lagosWeek.todayDate,
    todayIndex: lagosWeek.todayIndex,
    tz,
    goal: Number(goal) || 2,
    status: WEEK_STATUS.ACTIVE,
    createdAt: new Date().toISOString(),
    completedAt: null,
    tickets: [],
    stats: {},
  };

  for (const day of lagosWeek.days) {
    const prepared = liveBoards[day.date];
    const ticket = buildDayTicket(day, settings, prepared);
    week.tickets.push(ticket);
  }

  week.stats = computeWeekStats(week);
  return week;
}

/**
 * Build or populate a single day's ticket for a week.
 */
export function buildDayTicket(day, settings = {}, prepared = null) {
  const tz = settings.tz || 'Africa/Lagos';
  const builderOpts = {
    ...DEFAULT_BUILDER_OPTS,
    ...(settings.builder || {}),
    stakeBands: settings.stakeBands || DEFAULT_STAKE_BANDS,
    minEdgePerLeg: Number(settings.minEdgePerLeg ?? 0.012),
  };

  if (!prepared && ['oddsapi', 'sportsgameodds'].includes(settings.provider)) prepared = failedLiveBoard(day.date,
    { code: settings.oddsApi?.key ? 'LIVE_NOT_FETCHED' : 'NO_KEY', message: 'Live quotes were not fetched. Configure a valid API key and rescan; no simulated ticket was substituted.' }, settings.provider);
  // Case 1: Prepared board from async live scan
  if (prepared?.builder && prepared?.scan) {
    const scan = prepared.scan;
    const builder = prepared.builder;
    const providerUsed = scan.diagnostics?.providerUsed || 'oddsapi';
    const providerRequested = scan.diagnostics?.providerRequested || 'oddsapi';
    const fellBack = Boolean(scan.diagnostics?.fellBack);
    const reason = scan.diagnostics?.fallbackReason || null;

    if (!builder.ok || !builder.best) {
      return {
        dayIndex: day.dayIndex,
        dayName: day.dayName,
        shortName: day.shortName,
        date: day.date,
        isToday: day.isToday,
        issued: false,
        status: TICKET_STATUS.UNISSUED,
        message: builder.message || 'No combination cleared the edge floor. Refusing is a feature.',
        slip: null,
        provider: {
          requested: providerRequested,
          used: providerUsed,
          fellBack,
          reason,
        },
        scanDiagnostics: scan.diagnostics || null,
        builderReport: builder.report, reasonCode: builder.reason || null,
        settledAt: null,
        payout: 0,
        profit: 0,
      };
    }

    return {
      dayIndex: day.dayIndex,
      dayName: day.dayName,
      shortName: day.shortName,
      date: day.date,
      isToday: day.isToday,
      issued: true,
      status: TICKET_STATUS.PENDING,
      message: null,
      slip: builder.best,
      alternatives: builder.alternatives || [],
      provider: {
        requested: providerRequested,
        used: providerUsed,
        fellBack,
        reason,
      },
      scanDiagnostics: scan.diagnostics || null,
        builderReport: builder.report, reasonCode: builder.reason || null,
      settledAt: null,
      payout: 0,
      profit: 0,
    };
  }

  // Case 2: Synchronous scan (sim or manual, or live-fallback)
  const wantProvider = settings.provider || 'sim';
  const scanResult = scanForDay(
    day.date,
    {
      tz,
      provider: wantProvider,
      apiKey: settings.oddsApi?.key || '',
      sports: settings.oddsApi?.sports || [],
      manualOdds: settings.manualOdds || [],
      eventsPerDay: settings.eventsPerDay || 38,
      marketInefficiency: settings.marketInefficiency ?? 1.2,
      builder: builderOpts,
    }
  );

  const scan = scanResult.scan;
  const builder = scanResult.builder;
  const providerUsed = scan.diagnostics?.providerUsed || 'sim';
  const providerRequested = scan.diagnostics?.providerRequested || wantProvider;
  const fellBack = Boolean(scan.diagnostics?.fellBack);
  const reason = scan.diagnostics?.fallbackReason || null;

  if (!builder.ok || !builder.best) {
    return {
      dayIndex: day.dayIndex,
      dayName: day.dayName,
      shortName: day.shortName,
      date: day.date,
      isToday: day.isToday,
      issued: false,
      status: TICKET_STATUS.UNISSUED,
      message: builder.message || 'No combination cleared the edge floor. Refusing is a feature.',
      slip: null,
      provider: {
        requested: providerRequested,
        used: providerUsed,
        fellBack,
        reason,
      },
      scanDiagnostics: scan.diagnostics || null,
        builderReport: builder.report, reasonCode: builder.reason || null,
      settledAt: null,
      payout: 0,
      profit: 0,
    };
  }

  return {
    dayIndex: day.dayIndex,
    dayName: day.dayName,
    shortName: day.shortName,
    date: day.date,
    isToday: day.isToday,
    issued: true,
    status: TICKET_STATUS.PENDING,
    message: null,
    slip: builder.best,
    alternatives: builder.alternatives || [],
    provider: {
      requested: providerRequested,
      used: providerUsed,
      fellBack,
      reason,
    },
    scanDiagnostics: scan.diagnostics || null,
        builderReport: builder.report, reasonCode: builder.reason || null,
    settledAt: null,
    payout: 0,
    profit: 0,
  };
}

/**
 * Manually settle a ticket as 'won' or 'lost'.
 * Ground truth for live fixtures does not exist on-device; user settles manually.
 */
export function settleTicket(week, dayIndex, outcome) {
  const idx = Number(dayIndex);
  const ticket = week.tickets.find((t) => t.dayIndex === idx);
  if (!ticket) throw new Error(`Ticket for day index ${idx} not found`);
  if (!ticket.issued || !ticket.slip) throw new Error(`Day ${idx} has no issued ticket to settle`);

  if (outcome !== 'won' && outcome !== 'lost') {
    throw new Error(`Invalid settlement outcome "${outcome}" — must be 'won' or 'lost'`);
  }

  ticket.status = outcome === 'won' ? TICKET_STATUS.WON : TICKET_STATUS.LOST;
  ticket.settledAt = new Date().toISOString();

  week.stats = computeWeekStats(week);
  if (week.stats.allSettled) {
    week.status = WEEK_STATUS.COMPLETED;
    week.completedAt = new Date().toISOString();
  }

  return { week, ticket };
}

/**
 * Rescan a ticket for a given day (e.g. after adding an API key or running live scan).
 */
export function rescanDayTicket(week, dayIndex, settings = {}, prepared = null) {
  const idx = Number(dayIndex);
  const day = week.tickets.find((t) => t.dayIndex === idx);
  if (!day) throw new Error(`Ticket for day index ${idx} not found`);

  // Preserve previous settlement if already settled
  const prevStatus = day.status;
  const prevSettledAt = day.settledAt;

  const newTicket = buildDayTicket(
    {
      dayIndex: day.dayIndex,
      dayName: day.dayName,
      shortName: day.shortName,
      date: day.date,
      isToday: day.isToday,
    },
    settings,
    prepared
  );

  if (prevStatus === TICKET_STATUS.WON || prevStatus === TICKET_STATUS.LOST) {
    newTicket.status = prevStatus;
    newTicket.settledAt = prevSettledAt;
  }

  week.tickets[idx] = newTicket;
  week.stats = computeWeekStats(week);
  return { week, ticket: newTicket };
}
