import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { devig, ev, round, clamp, makeRng, mean, poissonPmf, scoreGrid, normCdf } from '../lib/math.js';
import {
  priceEvent,
  priceEventFromOffers,
  extractLegs,
  classifyBook,
  correlationFactor,
  confidence,
  confBand,
  SIGNAL_WEIGHTS,
} from '../lib/markets.js';
import {
  buildLongshotTicket,
  validateTicketOdds,
  evaluateTicketConfidence,
  MIN_TICKET_ODDS,
  MAX_TICKET_ODDS,
  DEFAULT_STAKE_BANDS,
} from '../lib/builder.js';
import {
  createWeek,
  settleTicket,
  computeWeekStats,
  assessGoal,
  getWeeklyVerdict,
  formatNaira,
} from '../lib/longshot.js';
import { scanDay, scanDayLive, fetchOddsApi, SPORT_MAP } from '../lib/scan.js';
import { buildDayEvents, getLagosWeek, tzDateKey } from '../lib/fixtures.js';
import { createApi } from '../lib/http-core.js';
import { createMemoryStore } from '../lib/memory-store.js';

/* ────────────────────────────────────────────────────────────────── *
 * 1. Math primitives & Pricing Maths
 * ────────────────────────────────────────────────────────────────── */
describe('Pricing maths — de-vig, weights & classification', () => {
  it('multiplicative de-vig removes overround exactly and sums to 1', () => {
    const odds = [2.1, 3.4, 3.8];
    const dev = devig(odds);
    assert.ok(dev.overround > 0, 'overround must be positive');
    const fairSum = dev.fair.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(fairSum - 1.0) < 1e-9, `fair sum ${fairSum} must equal 1`);
  });

  it('classifies books into sharp, mid, and soft tiers', () => {
    assert.equal(classifyBook('Pinnacle'), 'sharp');
    assert.equal(classifyBook('SBOBET'), 'sharp');
    assert.equal(classifyBook('Circa Sports'), 'sharp');
    assert.equal(classifyBook('Betfair Exchange'), 'sharp');
    assert.equal(classifyBook('Matchbook'), 'sharp');
    assert.equal(classifyBook('Smarkets'), 'sharp');
    assert.equal(classifyBook('Bet365'), 'mid');
    assert.equal(classifyBook('Unibet'), 'mid');
    assert.equal(classifyBook('Betway'), 'mid');
    assert.equal(classifyBook('Bet9ja'), 'soft');
    assert.equal(classifyBook('SportyBet'), 'soft');
    assert.equal(classifyBook('Unknown Bookie'), 'soft');
  });

  it('model weights strictly equal 0.30 consensus + 0.62 sharp + 0.08 ratings prior', () => {
    assert.equal(SIGNAL_WEIGHTS.consensus, 0.3);
    assert.equal(SIGNAL_WEIGHTS.sharp, 0.62);
    assert.equal(SIGNAL_WEIGHTS.ratings, 0.08);
    const sum = SIGNAL_WEIGHTS.consensus + SIGNAL_WEIGHTS.sharp + SIGNAL_WEIGHTS.ratings;
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it('confidence tracks data quality (book count, agreement, window) and maps to bands A/B/C/D', () => {
    const highQuality = confidence({
      tier: 1,
      bookCount: 8,
      agreement: 0.95,
      kickoffHours: 2,
      liquidity: 1.0,
    });
    assert.ok(highQuality >= 0.72, `expected high quality >= 0.72, got ${highQuality}`);
    assert.equal(confBand(highQuality), 'A');

    const midQuality = confidence({
      tier: 2,
      bookCount: 5,
      agreement: 0.65,
      kickoffHours: 14,
      liquidity: 0.75,
    });
    assert.ok(midQuality >= 0.55 && midQuality < 0.72);
    assert.ok(['B', 'C'].includes(confBand(midQuality)));

    const lowQuality = confidence({
      tier: 3,
      bookCount: 2,
      agreement: 0.2,
      kickoffHours: 48,
      liquidity: 0.4,
    });
    assert.ok(lowQuality < 0.48);
    assert.equal(confBand(lowQuality), 'D');
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 2. Totals + Spreads pricing (not just h2h)
 * ────────────────────────────────────────────────────────────────── */
describe('Totals and Spreads live & sim pricing', () => {
  it('prices totals and spreads alongside h2h from cross-book offers', () => {
    const event = {
      id: 'test-event-1',
      sport: 'football',
      league: { code: 'EPL', name: 'Premier League', tier: 1 },
      kickoff: Date.now() + 7200000,
      home: { name: 'Arsenal' },
      away: { name: 'Chelsea' },
      markets: [
        {
          key: 'h2h',
          name: 'Match Result',
          type: 'h2h',
          outcomes: [
            { key: 'arsenal', label: 'Arsenal', p: 0.45 },
            { key: 'draw', label: 'Draw', p: 0.28 },
            { key: 'chelsea', label: 'Chelsea', p: 0.27 },
          ],
        },
        {
          key: 'totals_2.5',
          name: 'Total 2.5 — Over/Under',
          type: 'totals',
          point: 2.5,
          outcomes: [
            { key: 'over', label: 'Over 2.5', p: 0.5 },
            { key: 'under', label: 'Under 2.5', p: 0.5 },
          ],
        },
        {
          key: 'spreads_1.5',
          name: 'Handicap ±1.5',
          type: 'spreads',
          point: 1.5,
          outcomes: [
            { key: 'arsenal', label: 'Arsenal -1.5', p: 0.5 },
            { key: 'chelsea', label: 'Chelsea +1.5', p: 0.5 },
          ],
        },
      ],
    };

    const offersByMarket = new Map();
    // h2h offers
    offersByMarket.set('h2h', [
      { book: { name: 'Pinnacle', cls: 'sharp' }, odds: [2.15, 3.5, 3.7] },
      { book: { name: 'Bet365', cls: 'mid' }, odds: [2.1, 3.4, 3.65] },
      { book: { name: 'Bet9ja', cls: 'soft' }, odds: [2.2, 3.3, 3.6] },
    ]);
    // totals_2.5 offers
    offersByMarket.set('totals_2.5', [
      { book: { name: 'Pinnacle', cls: 'sharp' }, odds: [1.95, 1.95] },
      { book: { name: 'Bet365', cls: 'mid' }, odds: [1.9, 1.9] },
    ]);
    // spreads_1.5 offers
    offersByMarket.set('spreads_1.5', [
      { book: { name: 'Pinnacle', cls: 'sharp' }, odds: [2.65, 1.52] },
      { book: { name: 'Bet365', cls: 'mid' }, odds: [2.6, 1.5] },
    ]);

    const priced = priceEventFromOffers(event, offersByMarket, { tier: 1 });
    assert.equal(priced.markets.length, 3);

    const totalsMarket = priced.markets.find((m) => m.type === 'totals');
    assert.ok(totalsMarket, 'Totals market must be priced');
    assert.equal(totalsMarket.outcomes.length, 2);
    assert.ok(totalsMarket.outcomes[0].modelProb > 0.4 && totalsMarket.outcomes[0].modelProb < 0.6);

    const spreadsMarket = priced.markets.find((m) => m.type === 'spreads');
    assert.ok(spreadsMarket, 'Spreads market must be priced');
    assert.equal(spreadsMarket.outcomes.length, 2);

    const legs = extractLegs({ ...event, markets: priced.markets });
    assert.equal(legs.length, 7); // 3 (h2h) + 2 (totals) + 2 (spreads)
    for (const l of legs) {
      assert.ok(Number.isFinite(l.odds) && l.odds > 1);
      assert.ok(Number.isFinite(l.modelProb) && l.modelProb > 0);
      assert.equal(l.truthProb, null, 'Live legs must leave truthProb null');
    }
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 3. 20+ Sport keys on the board
 * ────────────────────────────────────────────────────────────────── */
describe('Multi-sport coverage board — 20+ sport keys', () => {
  it('covers at least 23 diverse sport keys across football, basketball, tennis, baseball, hockey, mma', () => {
    assert.ok(SPORT_MAP.length >= 20, `SPORT_MAP must have >= 20 keys, has ${SPORT_MAP.length}`);
    const sports = new Set(SPORT_MAP.map((s) => s.sport));
    assert.ok(sports.has('football'));
    assert.ok(sports.has('basketball'));
    assert.ok(sports.has('tennis'));
    assert.ok(sports.has('baseball'));
    assert.ok(sports.has('icehockey'));
    assert.ok(sports.has('mma'));
  });

  it('out-of-season or unknown league keys are captured as status chips, never fatal errors', async () => {
    // Stub fetch simulating some leagues returning 404 or 0 fixtures
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.includes('basketball_wnba')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'x-requests-remaining': '480', 'x-requests-used': '20' },
        });
      }
      if (u.pathname.includes('cricket_odi')) {
        return new Response('Not found', {
          status: 404,
          headers: { 'x-requests-remaining': '479', 'x-requests-used': '21' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'x-requests-remaining': '478', 'x-requests-used': '22' },
      });
    };

    try {
      const subset = ['basketball_wnba', 'cricket_odi'];
      const res = await fetchOddsApi(subset, 'test-key', { daysAhead: 2 });
      assert.equal(res.leagues.length, 2);
      const wnba = res.leagues.find((l) => l.key === 'basketball_wnba');
      assert.equal(wnba.ok, true);
      assert.equal(wnba.fixtures, 0);

      const cricket = res.leagues.find((l) => l.key === 'cricket_odi');
      assert.equal(cricket.ok, false);
      assert.equal(cricket.status, 404);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 4. Quota header capture from The Odds API
 * ────────────────────────────────────────────────────────────────── */
describe('The Odds API v4 — Quota header capture', () => {
  it('captures x-requests-remaining and x-requests-used from response headers', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify([
          {
            id: 'game-1',
            sport_key: 'soccer_epl',
            commence_time: new Date(Date.now() + 86400000).toISOString(),
            home_team: 'Liverpool',
            away_team: 'Chelsea',
            bookmakers: [
              {
                title: 'Pinnacle',
                markets: [
                  {
                    key: 'h2h',
                    outcomes: [
                      { name: 'Liverpool', price: 1.8 },
                      { name: 'Draw', price: 3.7 },
                      { name: 'Chelsea', price: 4.5 },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-requests-remaining': '442',
            'x-requests-used': '58',
          },
        }
      );
    };

    try {
      const res = await fetchOddsApi(['soccer_epl'], 'test-key', { daysAhead: 2 });
      assert.equal(res.quota.remaining, 442);
      assert.equal(res.quota.used, 58);
      assert.equal(res.games.length, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 5. Ticket Odds-Band Enforcement: Reject < 10.0 and > 1000.0
 * ────────────────────────────────────────────────────────────────── */
describe('Ticket odds-band enforcement (reject < 10 and > 1000)', () => {
  it('strictly validates odds within [10.0, 1000.0]', () => {
    assert.equal(validateTicketOdds(20.0).valid, true);
    assert.equal(validateTicketOdds(19.99).valid, false);
    assert.equal(validateTicketOdds(100.0).valid, true);
    assert.equal(validateTicketOdds(1000.0).valid, true);

    // Below 10.0 must be rejected!
    const subTen = validateTicketOdds(9.99);
    assert.equal(subTen.valid, false);
    assert.equal(subTen.reason, 'BELOW_MIN_ODDS');

    const five = validateTicketOdds(5.2);
    assert.equal(five.valid, false);

    const one = validateTicketOdds(1.95);
    assert.equal(one.valid, false);

    // Above 1000.0 must be rejected!
    const overGrand = validateTicketOdds(1000.01);
    assert.equal(overGrand.valid, false);
    assert.equal(overGrand.reason, 'ABOVE_MAX_ODDS');

    const twoThousand = validateTicketOdds(2500);
    assert.equal(twoThousand.valid, false);

    // Non-finite odds rejected
    assert.equal(validateTicketOdds(NaN).valid, false);
    assert.equal(validateTicketOdds(Infinity).valid, false);
  });

  it('builder produces slips whose odds strictly land inside [10.0, 1000.0]', () => {
    const legs = accumulatorLegs();
    const result = buildLongshotTicket(legs, { minOdds: 10.0, maxOdds: 1000.0 });
    assert.equal(result.ok, true);
    assert.ok(result.best.odds >= 20.0, `Ticket odds ${result.best.odds} must be >= 10.0`);
    assert.ok(result.best.odds <= 1000.0, `Ticket odds ${result.best.odds} must be <= 1000.0`);
    assert.ok(result.best.legCount >= 10, 'Accumulator must combine >= 2 legs');
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 6. Stake-band mapping by ticket confidence
 * ────────────────────────────────────────────────────────────────── */
describe('Stake-band mapping (A->500, B->350, C->200, D->100)', () => {
  it('maps ticket confidence band to stake correctly and provides reasoning', () => {
    const customBands = { A: 500, B: 350, C: 200, D: 100 };

    // Band A leg
    const legsA = [
      { confidence: 0.82, agreement: 0.95, tier: 1 },
      { confidence: 0.76, agreement: 0.92, tier: 1 },
    ];
    const evalA = evaluateTicketConfidence(legsA, customBands);
    assert.equal(evalA.band, 'A');
    assert.equal(evalA.stake, 500);
    assert.ok(evalA.reason.includes('Band A'));
    assert.ok(evalA.reason.includes('₦500'));

    // Band B leg
    const legsB = [
      { confidence: 0.65, agreement: 0.85, tier: 2 },
      { confidence: 0.62, agreement: 0.82, tier: 2 },
    ];
    const evalB = evaluateTicketConfidence(legsB, customBands);
    assert.equal(evalB.band, 'B');
    assert.equal(evalB.stake, 350);
    assert.ok(evalB.reason.includes('Band B'));

    // Band C leg
    const legsC = [
      { confidence: 0.52, agreement: 0.55, tier: 2 },
      { confidence: 0.50, agreement: 0.50, tier: 3 },
    ];
    const evalC = evaluateTicketConfidence(legsC, customBands);
    assert.equal(evalC.band, 'C');
    assert.equal(evalC.stake, 200);

    // Band D leg
    const legsD = [
      { confidence: 0.35, agreement: 0.3, tier: 3 },
      { confidence: 0.40, agreement: 0.35, tier: 3 },
    ];
    const evalD = evaluateTicketConfidence(legsD, customBands);
    assert.equal(evalD.band, 'D');
    assert.equal(evalD.stake, 100);
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 7. Expected-wins maths (Σ ticket win probs) & Goal Reality
 * ────────────────────────────────────────────────────────────────── */
describe('Expected wins maths & goal structural assessment', () => {
  it('expected wins equals the exact sum of ticket win probabilities', () => {
    const tickets = [
      { issued: true, slip: { stake: 200, winProb: 0.12, odds: 10.5 } },
      { issued: true, slip: { stake: 350, winProb: 0.15, odds: 10.2 } },
      { issued: true, slip: { stake: 100, winProb: 0.08, odds: 14.0 } },
      { issued: true, slip: { stake: 500, winProb: 0.18, odds: 10.1 } },
      { issued: false, slip: null }, // unissued
      { issued: true, slip: { stake: 200, winProb: 0.10, odds: 11.2 } },
      { issued: true, slip: { stake: 200, winProb: 0.11, odds: 10.8 } },
    ];

    const week = { goal: 2, tickets };
    const stats = computeWeekStats(week);

    // 0.12 + 0.15 + 0.08 + 0.18 + 0.10 + 0.11 = 0.74
    assert.equal(stats.expectedWins, 0.74);
    assert.equal(stats.issuedCount, 6);
    assert.equal(stats.unissuedCount, 1);
    assert.equal(stats.totalStaked, 1550);
  });

  it('honestly assesses when goal is structurally above modelled expectation at odds >= 10', () => {
    const assessment = assessGoal({ goal: 3, expectedWins: 0.85, issuedCount: 7 });
    assert.equal(assessment.isStructurallyBelow, true);
    assert.ok(assessment.analysis.includes('never as a promise'));
    assert.ok(assessment.recommendedOddsBand.length > 0);
    // For 3 wins across 7 tickets, p_req = 3/7 = 42.9%, fair odds ~ 2.3
    assert.ok(assessment.explanation.includes('42.9%'));
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 8. Fallback-Honesty Contract (Dead key produces loud SIMULATED banner)
 * ────────────────────────────────────────────────────────────────── */
describe('Fallback honesty contract — dead key or missing key', () => {
  it('sync scan Day with provider=oddsapi but no key admits fallback to sim', () => {
    const scan = scanDay('2026-10-15', { provider: 'oddsapi', apiKey: '' });
    assert.equal(scan.diagnostics.providerRequested, 'oddsapi');
    assert.equal(scan.diagnostics.providerUsed, 'sim');
    assert.equal(scan.diagnostics.fellBack, true);
    assert.ok(scan.diagnostics.fallbackReason.includes('simulated'));
  });

  it('async scanDayLive throws cleanly on missing key rather than silently simulating', async () => {
    await assert.rejects(
      async () => {
        await scanDayLive('2026-10-15', { apiKey: '' });
      },
      (err) => {
        assert.equal(err.code, 'NO_KEY');
        return true;
      }
    );
  });

  it('async scanDayLive throws cleanly on dead key / 0 games returned', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 });

    try {
      await assert.rejects(
        async () => {
          await scanDayLive('2026-10-15', { apiKey: 'dead-key-12345', sports: ['soccer_epl'] });
        },
        (err) => {
          assert.equal(err.code, 'NO_GAMES');
          return true;
        }
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('every ticket payload carries provider: {requested, used, fellBack, reason}', () => {
    const week = createWeek();
    for (const t of week.tickets) {
      assert.ok(t.provider, 'Ticket must carry provider metadata');
      assert.ok('requested' in t.provider);
      assert.ok('used' in t.provider);
      assert.ok('fellBack' in t.provider);
      assert.ok('reason' in t.provider);
    }
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 9. Weekly Settlement & Verdict Strings
 * ────────────────────────────────────────────────────────────────── */
describe('Weekly settlement & verdict strings', () => {
  it('returns "X of 7 landed — the longshot board paid" on >= 2 wins', () => {
    assert.equal(getWeeklyVerdict(2), '2 of 7 landed — the longshot board paid');
    assert.equal(getWeeklyVerdict(3), '3 of 7 landed — the longshot board paid');
    assert.equal(getWeeklyVerdict(5), '5 of 7 landed — the longshot board paid');
  });

  it('returns "X of 7 — we go again" on < 2 wins', () => {
    assert.equal(getWeeklyVerdict(0), '0 of 7 — we go again');
    assert.equal(getWeeklyVerdict(1), '1 of 7 — we go again');
  });

  it('settling tickets updates running P&L and totalReturned in Naira', () => {
    const week = createWeek({ goal: 2, weekDate: '2026-10-15', settings: { eventsPerDay: 120 } });
    assert.equal(week.stats.wonCount, 0);

    const ticket0 = week.tickets[0];
    const stake0 = ticket0.slip.stake;
    const odds0 = ticket0.slip.odds;

    settleTicket(week, 0, 'won');
    assert.equal(week.tickets[0].status, 'won');
    assert.equal(week.stats.wonCount, 1);
    assert.equal(week.stats.totalReturned, round(stake0 * odds0, 2));

    settleTicket(week, 1, 'lost');
    assert.equal(week.tickets[1].status, 'lost');
    assert.equal(week.stats.lostCount, 1);
  });
});

/* ────────────────────────────────────────────────────────────────── *
 * 10. Vercel Handler Signature & HTTP API Surface
 * ────────────────────────────────────────────────────────────────── */
describe('Vercel handler signature and API routes', () => {
  it('creates API with memory store reporting persistent: false', async () => {
    const store = createMemoryStore();
    const api = createApi({ store, persistent: false });

    const stateRes = await api({ method: 'GET', pathname: '/api/state', query: '' });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.runtime.persistent, false);
    assert.equal(stateRes.body.engine.name, 'LONGSHOT');
  });

  it('creates a week via POST /api/weeks and settles via POST /api/weeks/:id/tickets/:day/settle', async () => {
    const store = createMemoryStore();
    await store.saveSettings({ eventsPerDay: 120 });
    const api = createApi({ store, persistent: false });

    const createRes = await api({
      method: 'POST',
      pathname: '/api/weeks',
      query: '',
      body: { goal: 3, weekDate: '2026-10-15' },
    });
    assert.equal(createRes.status, 201);
    const week = createRes.body.week;
    assert.equal(week.tickets.length, 7);

    const settleRes = await api({
      method: 'POST',
      pathname: `/api/weeks/${week.id}/tickets/0/settle`,
      query: '',
      body: { outcome: 'won' },
    });
    assert.equal(settleRes.status, 200);
    assert.equal(settleRes.body.week.stats.wonCount, 1);
  });
});

function accumulatorLegs(count = 24) {
  return Array.from({ length: count }, (_, i) => ({
    legId: `leg-${i}`, eventId: `event-${i}`, odds: 1.30, modelProb: 0.80,
    edge: 0.80 - 1 / 1.30, confidence: 0.8, agreement: 0.9,
    league: `League ${i}`, leagueCode: `L${i}`, kickoff: '2026-10-17T15:00:00Z',
    sport: 'football', fairProb: 0.79, impliedProb: 1 / 1.30,
  }));
}

describe('Master accumulator hard constraints', () => {
  it('stacks 10–20 distinct high-probability events inside 20–1000 odds', () => {
    const result = buildLongshotTicket(accumulatorLegs(), { minLegs: 10 });
    assert.equal(result.ok, true);
    const s = result.best;
    assert.ok(s.legCount >= 10 && s.legCount <= 20);
    assert.equal(new Set(s.legs.map(l => l.eventId)).size, s.legCount);
    assert.ok(s.odds >= 20 && s.odds <= 1000);
    assert.equal(s.avgLegProbPct, 80);
    assert.ok(s.legs.every(l => l.odds <= 1.45 && l.modelProb >= 0.65 && l.edge > 0));
  });
  it('rejects underdogs, low probabilities, nonfinite data and nonpositive edge even with unsafe overrides', () => {
    for (const bad of [{ odds: 1.56 }, { modelProb: 0.64 }, { odds: NaN },
      { modelProb: NaN }, { edge: -0.01 }, { edge: 0 }]) {
      const result = buildLongshotTicket(accumulatorLegs().map(l => ({ ...l, ...bad })),
        { maxLegOdds: 99, minModelProb: 0, minLegs: 1 });
      assert.equal(result.ok, false);
    }
  });
  it('refuses insufficient events and impossible cumulative targets', () => {
    assert.equal(buildLongshotTicket(accumulatorLegs(7)).ok, false);
    assert.equal(buildLongshotTicket(accumulatorLegs(), { maxOdds: 19 }).ok, false);
    assert.equal(buildLongshotTicket(accumulatorLegs().map(l => ({ ...l, eventId: 'same' }))).ok, false);
  });
  it('does not stop extending a partial slip before the configured minimum leg count', () => {
    const r = buildLongshotTicket(accumulatorLegs(), { minLegs: 18 });
    assert.equal(r.ok, true);
    assert.equal(r.best.legCount, 18);
  });
  it('preserves double-chance fair probability mass instead of dividing it by two', () => {
    const event = buildDayEvents('2026-10-15', { eventsPerDay: 120 }).find(e => e.sport === 'football');
    const priced = priceEvent(event, { truthMarkets: event.markets });
    const dc = priced.markets.find(m => m.type === 'double_chance');
    assert.ok(Math.abs(dc.outcomes.reduce((n, o) => n + o.fairProb, 0) - 2) < 0.001);
    assert.ok(dc.outcomes.some(o => o.modelProb >= 0.65));
  });
});
