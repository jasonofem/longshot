/**
 * builder.js — the Longshot accumulator slip optimiser.
 *
 * MISSION & CONSTRAINTS
 * ---------------------
 * 1. Ticket combined odds must land in [20.0, 1000.0]. Any slip outside is rejected.
 * 2. Objective: MAXIMISE modelled ticket win probability subject to odds in [20.0, 1000.0]
 *    and the edge floors.
 * 3. Never build max-odds lottery slips — higher odds drastically reduces win probability.
 * 4. Gated on edge floor (default +1.2pp) with tiered relaxation visible in the UI.
 * 5. One leg per event, correlation haircut applied.
 * 6. Stake bands by ticket confidence:
 *      Band A (>=0.72) -> ₦500
 *      Band B (>=0.60) -> ₦350
 *      Band C (>=0.48) -> ₦200
 *      Band D (<0.48)  -> ₦100
 * 7. If nothing clears the floor, issue NO ticket — refusing is a feature.
 */

import { clamp, round, mean } from './math.js';
import { correlationFactor, confBand } from './markets.js';

export const MIN_TICKET_ODDS = 20.0;
export const MAX_TICKET_ODDS = 1000.0;

export const DEFAULT_STAKE_BANDS = {
  A: 500,
  B: 350,
  C: 200,
  D: 100,
};

export const DEFAULT_BUILDER_OPTS = {
  minOdds: MIN_TICKET_ODDS,
  maxOdds: MAX_TICKET_ODDS,
  minEdgePerLeg: 0.012, // +1.2pp default
  minConfidence: 0.35,
  minLegs: 8,
  maxLegs: 20,
  maxLegOdds: 1.45,
  minModelProb: 0.65,
  stakeBands: { ...DEFAULT_STAKE_BANDS },
  alternatives: 3,
};

/** Validate that odds strictly land within the longshot band [20.0, 1000.0]. */
export function validateTicketOdds(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return { valid: false, reason: 'INVALID_NUMBER', message: 'Odds must be a finite number' };
  if (o < MIN_TICKET_ODDS) {
    return {
      valid: false,
      reason: 'BELOW_MIN_ODDS',
      message: `Ticket odds ${o.toFixed(2)} is below minimum allowed longshot odds of ${MIN_TICKET_ODDS.toFixed(1)}`,
    };
  }
  if (o > MAX_TICKET_ODDS) {
    return {
      valid: false,
      reason: 'ABOVE_MAX_ODDS',
      message: `Ticket odds ${o.toFixed(2)} exceeds maximum allowed longshot odds of ${MAX_TICKET_ODDS.toFixed(1)}`,
    };
  }
  return { valid: true };
}

/**
 * Determine ticket confidence band from legs and build human explanation.
 */
export function evaluateTicketConfidence(legs, customStakeBands = null) {
  const stakeBands = customStakeBands || DEFAULT_STAKE_BANDS;
  const avgConf = legs.length ? mean(legs.map((l) => l.confidence ?? 0.5)) : 0.5;
  const band = confBand(avgConf);
  const stake = stakeBands[band] ?? DEFAULT_STAKE_BANDS[band] ?? 200;

  const avgAgreement = legs.length ? mean(legs.map((l) => l.agreement ?? 0.5)) : 0.5;
  const tiers = legs.map((l) => l.tier ?? 2);
  const tierCount = { t1: tiers.filter((t) => t === 1).length, t2: tiers.filter((t) => t === 2).length };

  let reason = '';
  if (band === 'A') {
    reason = `Band A (₦${stake}) — Exceptional market data quality: ${Math.round(avgAgreement * 100)}% cross-book agreement, strong bookmaker liquidity in top tiers.`;
  } else if (band === 'B') {
    reason = `Band B (₦${stake}) — Strong data depth: ${Math.round(avgAgreement * 100)}% cross-book agreement across competitive bookmaker quotes.`;
  } else if (band === 'C') {
    reason = `Band C (₦${stake}) — Moderate data depth: ${Math.round(avgAgreement * 100)}% cross-book agreement with wider bookmaker pricing dispersion.`;
  } else {
    reason = `Band D (₦${stake}) — Conservative stake: thinner liquidity or fewer quoting bookmakers on some selections.`;
  }

  return {
    band,
    avgConfidence: round(avgConf, 3),
    avgAgreement: round(avgAgreement, 3),
    stake,
    reason,
  };
}

/**
 * Build a longshot slip maximizing modelled ticket win probability inside [20.0, 1000.0].
 *
 * @param {object[]} legs  Priced legs from extractLegs
 * @param {object}   opts  Overrides of DEFAULT_BUILDER_OPTS
 */
export function buildLongshotTicket(legs, opts = {}) {
  const floor = Math.max(0, Number(opts.minEdgePerLeg ?? DEFAULT_BUILDER_OPTS.minEdgePerLeg));
  let result;
  const tiers = [];
  for (const [threshold, label] of [[floor, 'strict'], [Math.min(floor, 0.004), 'relaxed'], [0, 'positive-edge only']]) {
    result = searchTicket(legs, { ...opts, minEdgePerLeg: threshold });
    tiers.push({ label, threshold, eligible: result.report.eligible, events: result.report.distinctEligibleEvents, outcome: result.reason || 'ISSUED' });
    result.report.edgeTiers = tiers;
    result.report.outcome = result.reason || 'ISSUED';
    if (result.ok) {
      result.report.edgeTier = label;
      result.best.edgeTier = label;
      return result;
    }
  }
  return result;
}

function searchTicket(legs, opts = {}) {
  const o = { ...DEFAULT_BUILDER_OPTS, ...opts };
  o.minLegs = clamp(Math.trunc(Number(o.minLegs) || 8), 8, 25);
  o.maxLegs = clamp(Math.trunc(Number(o.maxLegs) || 20), o.minLegs, 25);
  o.maxLegOdds = clamp(Number(o.maxLegOdds) || 1.45, 1.10, 1.50);
  o.minModelProb = clamp(Number(o.minModelProb) || 0.65, 0.65, 1);
  const minOdds = Math.max(MIN_TICKET_ODDS, Number(o.minOdds) || MIN_TICKET_ODDS);
  const maxOdds = Math.min(MAX_TICKET_ODDS, Number(o.maxOdds) || MAX_TICKET_ODDS);

  const report = {
    minOdds,
    maxOdds,
    scanned: legs.length,
    events: new Set(legs.map((l) => l.eventId)).size,
    eligible: 0,
    positiveEdgeCount: legs.filter((l) => l.edge > 0).length,
    aboveFloorCount: legs.filter((l) => l.edge >= o.minEdgePerLeg).length,
    rejected: { odds: 0, confidence: 0, noise: 0 },
  };

  // Eligibility filter
  const pool = [];
  for (const leg of legs) {
    if ((!Number.isFinite(leg.confidence) || leg.confidence < o.minConfidence) && leg.viewSource !== 'pasted-single-book') {
      report.rejected.confidence++;
      continue;
    }
    if (!Number.isFinite(leg.odds) || leg.odds < 1.10 || leg.odds > o.maxLegOdds) {
      report.rejected.odds++;
      continue;
    }
    if (!Number.isFinite(leg.modelProb) || leg.modelProb < o.minModelProb || leg.modelProb > 1 || !Number.isFinite(leg.edge) || leg.edge <= 0 || leg.edge < o.minEdgePerLeg) {
      report.rejected.noise++;
      continue;
    }
    pool.push({
      ...leg,
      logOdds: Math.log(leg.odds),
      lp: Math.log(clamp(leg.modelProb, 1e-6, 0.999)),
    });
  }
  report.eligible = pool.length;

  const pricePool = legs.filter(l => Number.isFinite(l.odds) && l.odds >= 1.10 && l.odds <= o.maxLegOdds);
  const probPool = pricePool.filter(l => Number.isFinite(l.modelProb) && l.modelProb >= o.minModelProb && l.modelProb <= 1);
  const confPool = probPool.filter(l => Number.isFinite(l.confidence) && l.confidence >= o.minConfidence);
  Object.assign(report, { passingPrice: pricePool.length, passingProbability: probPool.length,
    passingConfidence: confPool.length, distinctEligibleEvents: new Set(pool.map(l => l.eventId)).size });
  const byEvent = new Map();
  for (const l of pool) {
    const r = byEvent.get(l.eventId) || { min: Infinity, max: 0 };
    r.min = Math.min(r.min, l.odds); r.max = Math.max(r.max, l.odds); byEvent.set(l.eventId, r);
  }
  const upper = [...byEvent.values()].map(r => r.max).sort((a,b) => b-a).slice(0,o.maxLegs).reduce((a,b) => a*b,1);
  const lower = [...byEvent.values()].map(r => r.min).sort((a,b) => a-b).slice(0,o.minLegs).reduce((a,b) => a*b,1);
  report.feasibility = { legCount: byEvent.size >= o.minLegs, oddsUpperBound: upper, oddsLowerBound: lower,
    oddsTarget: upper >= minOdds && lower <= maxOdds && minOdds <= maxOdds };
  if (!report.feasibility.legCount || !report.feasibility.oddsTarget) {
    const reason = !report.feasibility.legCount ? (new Set(confPool.map(l => l.eventId)).size >= o.minLegs ? 'EDGE_POOL_TOO_SMALL' : 'INSUFFICIENT_ELIGIBLE_EVENTS') : 'ODDS_TARGET_UNREACHABLE';
    return { ok: false, reason, message: `${reason}: ${byEvent.size} eligible distinct events; need ${o.minLegs}–${o.maxLegs} legs. Reachable odds bounds ${lower.toFixed(2)}–${upper.toFixed(2)}, target ${minOdds}–${maxOdds}.`, report, alternatives: [] };
  }

  // Keep alternative markets: the highest-edge market need not form the best slip.
  const deduped = pool.sort((a, b) => b.modelProb - a.modelProb || b.edge - a.edge);

  const logLo = Math.log(minOdds);
  const logHi = Math.log(maxOdds);
  const searchHi = logHi + 0.05;

  // Beam search indexed by log-odds to keep best win-prob combos
  const bucketWidth = 0.04;
  const found = [];
  const FOUND_CAP = 3000;
  const seenSigs = new Set();

  let frontier = new Map();
  frontier.set('0|-0', [{ legs: [], logOdds: 0, logP: 0, edgeSum: 0, events: [] }]);

  for (let depth = 1; depth <= o.maxLegs; depth++) {
    const states = [...frontier.values()].flat();
    if (!states.length) break;
    const buckets = new Map();

    for (const st of states) {
      for (const leg of deduped) {
        if (st.events.includes(leg.eventId)) continue;
        const nlo = st.logOdds + leg.logOdds;
        if (nlo > searchHi) continue;

        const events = st.events.concat(leg.eventId);
        const legsArr = st.legs.concat(leg);
        const nlp = st.logP + leg.lp;
        const nEdge = st.edgeSum + leg.edge;

        // Check if in-band
        if (nlo >= logLo && nlo <= logHi && depth >= o.minLegs) {
          const odds = Math.exp(nlo);
          // Hard safety check
          if (odds >= MIN_TICKET_ODDS && odds <= MAX_TICKET_ODDS) {
            const corr = correlationFactor(legsArr);
            const winProb = clamp(Math.exp(nlp) * corr, 1e-6, 0.999);
            const sig = legsArr.map((l) => l.legId).sort().join('|');

            if (!seenSigs.has(sig)) {
              seenSigs.add(sig);
              const combo = buildComboPayload(legsArr, odds, winProb, corr, nEdge, o.stakeBands);
              found.push(combo);
              if (found.length >= FOUND_CAP) break;
            }
          }
        }

        // Forward propagation for partial combos not yet at logLo
        if (nlo < logLo || depth < o.minLegs) {
          const b = Math.floor(nlo / bucketWidth);
          const key = `${b}|${depth}`;
          const list = buckets.get(key) || [];
          const signature = legsArr.map(l => l.legId).sort().join('|');
          if (!list.some(x => x.signature === signature)) {
            list.push({ legs: legsArr, logOdds: nlo, logP: nlp, edgeSum: nEdge, events, signature,
              score: nlp + Math.log(correlationFactor(legsArr)) });
            list.sort((a,b) => b.score - a.score);
            buckets.set(key, list.slice(0, 8));
          }
        }
      }
      if (found.length >= FOUND_CAP) break;
    }

    frontier = buckets;
    if (frontier.size === 0 && found.length > 0) break;
  }

  if (!found.length) {
    return {
      ok: false,
      reason: 'SEARCH_EXHAUSTED',
      message: `Bounded search exhausted: no combination reached combined odds between ${minOdds.toFixed(1)} and ${maxOdds.toFixed(1)} with the available market pool. Refusing is a feature.`,
      report,
      alternatives: [],
    };
  }

  // Sort by win probability descending (primary objective!) then edge
  found.sort((a, b) => b.winProb - a.winProb || b.avgEdge - a.avgEdge);

  // Tiered relaxation:
  // Tier 1: strict (avgEdge >= minEdgePerLeg)
  // Tier 2: relaxed (avgEdge >= 0.004)
  // Tier 3: positive-edge only (avgEdge > 0)
  const tiers = [
    { floor: o.minEdgePerLeg, label: 'strict' },
    { floor: Math.min(o.minEdgePerLeg, 0.004), label: 'relaxed' },
    { floor: 0, label: 'positive-edge only' },
  ];

  let chosen = [];
  let tierUsed = null;

  for (const t of tiers) {
    const c = found.filter((x) => x.minLegEdge >= t.floor && x.minLegEdge > 0);
    if (c.length) {
      chosen = c;
      tierUsed = t;
      break;
    }
  }

  if (!chosen.length) {
    return {
      ok: false,
      reason: 'NO_TICKET',
      message: 'The engine refused to issue a ticket: no combination in 20.0–1000.0 had positive edge. Refusing is a feature.',
      report,
      alternatives: [],
    };
  }

  report.edgeTier = tierUsed.label;
  report.combosFound = found.length;
  report.combosInTier = chosen.length;

  const diversified = diversify(chosen, o.alternatives || 3);
  const best = diversified[0];
  best.edgeTier = tierUsed.label;

  // Strict check that best odds is between 10.0 and 1000.0
  const validation = validateTicketOdds(best.odds);
  if (!validation.valid) {
    return {
      ok: false,
      reason: 'NO_TICKET',
      message: validation.message,
      report,
      alternatives: [],
    };
  }

  return {
    ok: true,
    report,
    best,
    alternatives: diversified,
  };
}

function buildComboPayload(legs, odds, winProb, corr, edgeSum, stakeBands) {
  const confInfo = evaluateTicketConfidence(legs, stakeBands);
  const cleanOdds = round(odds, 2);
  const fairOdds = round(1 / winProb, 2);
  const winProbPct = round(winProb * 100, 2);
  const oneInX = Math.max(1, Math.round(1 / winProb));
  const avgEdge = round(edgeSum / legs.length, 4);
  const evPerUnit = round(winProb * (cleanOdds - 1) - (1 - winProb), 4);
  const evPct = round(evPerUnit * 100, 2);

  const sports = [...new Set(legs.map((l) => l.sport))];
  const leagues = [...new Set(legs.map((l) => l.league))];

  return {
    legs: legs.map(stripLeg),
    legCount: legs.length,
    avgLegProb: mean(legs.map((l) => l.modelProb)),
    avgLegProbPct: round(mean(legs.map((l) => l.modelProb)) * 100, 2),
    minLegEdge: Math.min(...legs.map((l) => l.edge)),
    odds: cleanOdds,
    fairOdds,
    winProb: round(winProb, 4),
    winProbPct,
    oneInX,
    avgEdge,
    edgeSum: round(edgeSum, 4),
    edgePct: round(avgEdge * 100, 2),
    evPerUnit,
    evPct,
    correlation: round(corr, 4),
    confidence: confInfo.avgConfidence,
    band: confInfo.band,
    stake: confInfo.stake,
    bandReason: confInfo.reason,
    sports,
    leagues,
  };
}

function stripLeg(l) {
  return {
    legId: l.legId,
    eventId: l.eventId,
    sport: l.sport,
    league: l.league,
    kickoff: l.kickoff,
    home: l.home,
    away: l.away,
    market: l.market,
    marketKey: l.marketKey, marketType: l.marketType, line: l.line, team: l.team,
    providerMarket: l.providerMarket, probabilitySource: l.probabilitySource,
    pick: l.pick,
    odds: l.odds,
    book: l.book,
    edge: round(l.edge, 4),
    edgePct: round(l.edge * 100, 2),
    modelProb: round(l.modelProb, 4),
    modelProbPct: round(l.modelProb * 100, 2),
    impliedProb: round(l.impliedProb, 4),
    fairProb: round(l.fairProb, 4),
    confidence: l.confidence,
    band: l.band,
    agreement: l.agreement,
  };
}

/** Keep distinct slips that do not share all legs */
function diversify(list, k = 3) {
  if (!list.length) return [];
  const chosen = [list[0]];
  for (let i = 1; i < list.length && chosen.length < k; i++) {
    const cand = list[i];
    const isDistinct = chosen.every((prev) => {
      const prevIds = new Set(prev.legs.map((l) => l.legId));
      const shared = cand.legs.filter((l) => prevIds.has(l.legId)).length;
      return shared < Math.min(prev.legs.length, cand.legs.length) - 1;
    });
    if (isDistinct) chosen.push(cand);
  }
  return chosen;
}
