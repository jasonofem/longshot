/**
 * store-shared.js — shared persistence definitions across server, memory, and browser stores.
 *
 * Zero imports: must be easily bundleable for the browser.
 */

export const DEFAULT_SETTINGS = {
  currency: 'NGN',
  tz: 'Africa/Lagos',
  goal: 2, // 2–3 winning tickets out of 7
  minEdgePerLeg: 0.012, // +1.2pp floor default
  builder: { minLegs: 10, maxLegs: 20, maxLegOdds: 1.45 },
  minOdds: 20.0,
  maxOdds: 1000.0,
  stakeBands: {
    A: 500,
    B: 350,
    C: 200,
    D: 100,
  },
  provider: 'sim', // 'sim' | 'oddsapi' | 'manual'
  eventsPerDay: 38,
  marketInefficiency: 1.2,
  oddsApi: {
    key: '',
    sports: [], // subset of sport keys to trim the board; empty = all 23
  },
  sportsGameOdds: { key: '', leagues: [] },
  manualOdds: [],
};

export function summariseWeek(w) {
  if (!w) return null;
  return {
    id: w.id,
    mondayDate: w.mondayDate,
    sundayDate: w.sundayDate,
    status: w.status,
    createdAt: w.createdAt,
    completedAt: w.completedAt,
    goal: w.goal,
    issuedCount: w.stats?.issuedCount ?? 0,
    wonCount: w.stats?.wonCount ?? 0,
    lostCount: w.stats?.lostCount ?? 0,
    pendingCount: w.stats?.pendingCount ?? 0,
    totalStaked: w.stats?.totalStaked ?? 0,
    totalReturned: w.stats?.totalReturned ?? 0,
    netPnl: w.stats?.netPnl ?? 0,
    verdict: w.stats?.verdict ?? null,
    expectedWins: w.stats?.expectedWins ?? 0,
  };
}

export function reviveWeek(week) {
  if (!week) return week;
  return week;
}
