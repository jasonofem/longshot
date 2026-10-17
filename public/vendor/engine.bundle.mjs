/**
 * engine.bundle.mjs — GENERATED FILE for LONGSHOT in-browser execution.
 * Regenerate: node scripts/bundle.mjs
 */

/* ════════════════════════════════════════════════════════════════════════
   lib/math.js   →  hoists scoreGrid, sumGrid, overProb, poissonPmf, gaussianTruth, h2hTruth, clamp, round, makeRng, devig, mean, stdev, ev
   ════════════════════════════════════════════════════════════════════════ */
let __exp_0;
let __exp_1;
let __exp_2;
let __exp_3;
let __exp_4;
let __exp_5;
let __exp_6;
let __exp_7;
let __exp_8;
let __exp_9;
let __exp_10;
let __exp_11;
let __exp_12;
{
/**
 * math.js — deterministic numeric + RNG primitives used across the engine.
 *
 * Everything here is pure and side-effect free. The RNG is seeded (mulberry32)
 * so a given event/day/simulation always resolves identically.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const round = (v, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** 32-bit string hash (FNV-1a) → seed for mulberry32. */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good-enough-quality PRNG. */
function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  const rng = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.chance = (p) => rng() < p;
  rng.gauss = () => {
    // Box–Muller
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  /** Fisher-Yates sample of k distinct items. */
  rng.sample = (arr, k) => rng.shuffle(arr).slice(0, Math.max(0, Math.min(k, arr.length)));
  return rng;
}

/* ------------------------------------------------------------------ *
 * Poisson machinery (football / hockey scorelines)
 * ------------------------------------------------------------------ */

const FACT = [1];
for (let i = 1; i <= 40; i++) FACT[i] = FACT[i - 1] * i;

/** P(X = k) for X ~ Poisson(lambda), k = 0..max */
function poissonPmf(lambda, max = 12) {
  const out = new Array(max + 1);
  const l = Math.max(1e-9, lambda);
  for (let k = 0; k <= max; k++) out[k] = (Math.exp(-l) * l ** k) / FACT[k];
  return out;
}

/** Joint scoreline grid p[i][j] = P(home=i, away=j), normalised to sum 1. */
function scoreGrid(lh, la, max = 12) {
  const ph = poissonPmf(lh, max);
  const pa = poissonPmf(la, max);
  const grid = [];
  let total = 0;
  for (let i = 0; i <= max; i++) {
    const row = new Array(max + 1);
    for (let j = 0; j <= max; j++) {
      row[j] = ph[i] * pa[j];
      total += row[j];
    }
    grid.push(row);
  }
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) grid[i][j] /= total;
  return grid;
}

function sumGrid(grid, pred) {
  let s = 0;
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid[i].length; j++) if (pred(i, j)) s += grid[i][j];
  return s;
}

/** P(home goals + away goals > line) using the two marginals (exact for integer/half lines). */
function overProb(lh, la, line, max = 20) {
  const ph = poissonPmf(lh, max);
  const pa = poissonPmf(la, max);
  let p = 0;
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      if (i + j > line) p += ph[i] * pa[j];
    }
  }
  return p;
}

/** Normal CDF via Abramowitz–Stegun 7.1.26 (accuracy ~1e-7). */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  let p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Two-sided normal scoreline model used for basketball / baseball / hockey. */
function gaussianTruth(muHome, muAway, sigma, maxMargin = 60) {
  const mu = muHome - muAway;
  const pH = 1 - normCdf(0.5 / sigma - mu / sigma); // P(margin > 0.5) — no ties in these sports
  const pA = 1 - pH;
  const spread = {};
  for (let s = -maxMargin; s <= maxMargin; s += 0.5) {
    spread[s] = 1 - normCdf((0.5 - (mu + s)) / sigma);
  }
  const totalMu = muHome + muAway;
  const totalSigma = sigma * Math.SQRT2;
  const totals = {};
  for (let line = 150; line <= 300; line += 5) {
    totals[line] = 1 - normCdf((line + 0.5 - totalMu) / totalSigma);
  }
  return { pH, pA, spread, totals, totalMu, sigma };
}

/** Logistic head-to-head truth for tennis / MMA / two-outcome markets. */
function h2hTruth(ratingA, ratingB, scale = 8) {
  const pA = 1 / (1 + Math.exp(-(ratingA - ratingB) / scale));
  return { pA: clamp(pA, 0.02, 0.98), pB: clamp(1 - pA, 0.02, 0.98) };
}

/** Shannon entropy (bits) of a probability vector — used as an uncertainty gauge. */
function entropy(probs) {
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log2(p);
  return h;
}

/* ------------------------------------------------------------------ *
 * Bookmaker arithmetic
 * ------------------------------------------------------------------ */

/** Decimal odds → implied probability (with the vig still in it). */
const impliedProb = (odds) => 1 / odds;

/**
 * Remove the overround from a set of prices.
 * Returns fair probabilities that sum to 1, plus the book's overround.
 */
function devig(oddsList) {
  const impl = oddsList.map(impliedProb);
  const sum = impl.reduce((a, b) => a + b, 0);
  return {
    fair: impl.map((p) => p / sum),
    overround: sum - 1,
    payout: 1 / sum,
  };
}

/** Fair (no-vig) decimal odds from a probability. */
const fairOdds = (p) => (p > 0 ? 1 / p : Infinity);

/** Expected value per unit staked at `odds` with true/model probability `p`. */
const ev = (p, odds) => p * (odds - 1) - (1 - p);

/**
 * Kelly fraction for a single binary bet.
 * b = net decimal odds (odds - 1). Clamped to [0, cap].
 */
function kelly(p, odds, cap = 0.25) {
  const b = odds - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return clamp(f, 0, cap);
}

/** Decimal → approximate fractional odds string (for slip display). */
function toFractional(decimal) {
  const d = decimal - 1;
  if (d <= 0) return '0/1';
  const denoms = [1, 2, 4, 5, 10, 20];
  let best = null;
  for (const den of denoms) {
    const num = Math.round(d * den);
    if (num <= 0) continue;
    const err = Math.abs(num / den - d);
    if (!best || err < best.err) best = { num, den, err };
  }
  if (!best) return d.toFixed(2) + '/1';
  const g = gcd(best.num, best.den);
  return `${best.num / g}/${best.den / g}`;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/* ------------------------------------------------------------------ *
 * Vectors / stats
 * ------------------------------------------------------------------ */

/** Convex blend of probability vectors, renormalised to sum 1. */
function blendVectors(vectors, weights) {
  const n = vectors[0].length;
  const out = new Array(n).fill(0);
  let wsum = 0;
  vectors.forEach((v, i) => {
    const w = weights[i] ?? 0;
    wsum += w;
    for (let k = 0; k < n; k++) out[k] += (v[k] ?? 0) * w;
  });
  const total = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((x) => x / total);
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
};

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = clamp(Math.floor(p * s.length), 0, s.length - 1);
  return s[idx];
};

const median = (arr) => percentile(arr, 0.5);
__exp_0 = scoreGrid;
__exp_1 = sumGrid;
__exp_2 = overProb;
__exp_3 = poissonPmf;
__exp_4 = gaussianTruth;
__exp_5 = h2hTruth;
__exp_6 = clamp;
__exp_7 = round;
__exp_8 = makeRng;
__exp_9 = devig;
__exp_10 = mean;
__exp_11 = stdev;
__exp_12 = ev;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/model.js   →  hoists modelTruth
   ════════════════════════════════════════════════════════════════════════ */
let __exp_13;
{
const scoreGrid = __exp_0;
const sumGrid = __exp_1;
const overProb = __exp_2;
const poissonPmf = __exp_3;
const gaussianTruth = __exp_4;
const h2hTruth = __exp_5;
const clamp = __exp_6;
const round = __exp_7;

/**
 * model.js — turns team/player ratings into *true* outcome probabilities,
 * then expands those into the full market tree for an event.
 *
 * Sport-specific truth models:
 *   football  → independent Poisson scoreline grid (bivariate-ish via joint pmf)
 *   basketball/baseball/hockey → gaussian margin model (no ties)
 *   tennis/MMA → logistic head-to-head on skill index
 *
 * The output of this module is the "ground truth" that the rest of the engine
 * compares bookmaker prices against. That difference is the edge.
 */


const HOME_ADV = {
  football: 1.16,
  basketball: 2.4, // points
  baseball: 0.28, // runs
  hockey: 0.35,
  tennis: 0,
  mma: 0,
};

/**
 * Compute the truth vector + derived markets for an event.
 * @param {object} event  { sport, league:{base,sigma}, home:{att,def,rtg}, away:{...}, neutral? }
 * @returns {truth: [{key,label,p}], markets: [{key,name,type,line,outcomes:[{key,label,p}]}]}
 */
function modelTruth(event) {
  const sport = event.sport;
  if (sport === 'football') return footballTruth(event);
  if (sport === 'basketball' || sport === 'baseball' || sport === 'hockey') return gaussianSportTruth(event, sport);
  if (sport === 'tennis' || sport === 'mma') return h2hSportTruth(event, sport);
  throw new Error(`modelTruth: unsupported sport "${sport}"`);
}

/* ------------------------------------------------------------------ */

function footballTruth(event) {
  const base = event.league.base ?? 1.35;
  const adv = event.neutral ? 1.0 : HOME_ADV.football;
  const lh = clamp(base * event.home.att * event.away.def * adv, 0.12, 5.0);
  const la = clamp(base * event.away.att * event.home.def, 0.1, 4.5);

  const grid = scoreGrid(lh, la);
  const pH = sumGrid(grid, (i, j) => i > j);
  const pD = sumGrid(grid, (i, j) => i === j);
  const pA = sumGrid(grid, (i, j) => i < j);

  const pOver = (line) => overProb(lh, la, line);
  const ph = poissonPmf(lh, 12);
  const pa = poissonPmf(la, 12);
  const pHomeOver = (line) => ph.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const pAwayOver = (line) => pa.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const pBTTS = (1 - ph[0]) * (1 - pa[0]);

  // most likely exact score, for display flavour
  let topScore = { i: 1, j: 1, p: 0 };
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) if (grid[i][j] > topScore.p) topScore = { i, j, p: grid[i][j] };

  const markets = [
    {
      key: 'h2h',
      name: 'Match Result',
      type: 'result',
      outcomes: [
        { key: 'home', label: `${event.home.name} to win`, p: pH },
        { key: 'draw', label: 'Draw', p: pD },
        { key: 'away', label: `${event.away.name} to win`, p: pA },
      ],
    },
    {
      key: 'ou25',
      name: 'Total Goals Over/Under 2.5',
      type: 'totals',
      line: 2.5,
      outcomes: [
        { key: 'over', label: 'Over 2.5 goals', p: pOver(2.5) },
        { key: 'under', label: 'Under 2.5 goals', p: 1 - pOver(2.5) },
      ],
    },
    {
      key: 'btts',
      name: 'Both Teams To Score',
      type: 'btts',
      outcomes: [
        { key: 'yes', label: 'BTTS — Yes', p: pBTTS },
        { key: 'no', label: 'BTTS — No', p: 1 - pBTTS },
      ],
    },
  ];

  // Asian handicap — only offered when the match is not near a coin flip,
  // which is exactly how real books behave.
  const spread = spreadFromProb(pH, pA);
  if (spread) {
    const hp = handicapProb(grid, spread);
    markets.push({
      key: `ah${spread}`,
      name: `Asian Handicap ${spread > 0 ? '+' : ''}${spread}`,
      type: 'handicap',
      line: spread,
      outcomes: [
        { key: 'home', label: `${event.home.name} ${spread > 0 ? '+' : ''}${spread}`, p: hp },
        { key: 'away', label: `${event.away.name} ${spread > 0 ? -spread : +(-spread) * -1}`, p: 1 - hp },
      ],
    });
  }

  for (const line of [1.5, 3.5, 4.5]) {
    markets.push({ key: `ou${line * 10}`, name: `Total Goals Over/Under ${line}`,
      type: 'totals', line, outcomes: [
        { key: 'over', label: `Over ${line} goals`, p: pOver(line) },
        { key: 'under', label: `Under ${line} goals`, p: 1 - pOver(line) },
      ] });
  }
  for (const team of ['home', 'away']) {
    const p = team === 'home' ? pHomeOver(0.5) : pAwayOver(0.5);
    markets.push({ key: `${team}tg05`, name: `${event[team].name} Total Goals`,
      type: 'team_total', line: 0.5, team, outcomes: [
        { key: 'over', label: `${event[team].name} over 0.5`, p },
        { key: 'under', label: `${event[team].name} under 0.5`, p: 1 - p },
      ] });
  }

  // Double chance — the classic rollover "safety" leg.
  markets.push({
    key: 'dc',
    name: 'Double Chance',
    type: 'double_chance',
    outcomes: [
      { key: '1x', label: `${event.home.name} or Draw`, p: pH + pD },
      { key: '12', label: `${event.home.name} or ${event.away.name}`, p: pH + pA },
      { key: 'x2', label: `Draw or ${event.away.name}`, p: pD + pA },
    ],
  });

  // Team goals.
  markets.push({
    key: 'htg15',
    name: `${event.home.name} Total Goals`,
    type: 'team_total',
    line: 1.5,
    team: 'home',
    outcomes: [
      { key: 'over', label: `${event.home.name} over 1.5`, p: pHomeOver(1.5) },
      { key: 'under', label: `${event.home.name} under 1.5`, p: 1 - pHomeOver(1.5) },
    ],
  });
  markets.push({
    key: 'atg15',
    name: `${event.away.name} Total Goals`,
    type: 'team_total',
    line: 1.5,
    team: 'away',
    outcomes: [
      { key: 'over', label: `${event.away.name} over 1.5`, p: pAwayOver(1.5) },
      { key: 'under', label: `${event.away.name} under 1.5`, p: 1 - pAwayOver(1.5) },
    ],
  });

  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: pH },
      { key: 'draw', label: 'Draw', p: pD },
      { key: 'away', label: `${event.away.name} to win`, p: pA },
    ],
    markets,
    meta: { expectedHome: round(lh, 2), expectedAway: round(la, 2), likelyScore: `${topScore.i}-${topScore.j}` },
  };
}

/** Pick a handicap line that roughly balances the market. */
function spreadFromProb(pH, pA) {
  const diff = pH - pA;
  if (Math.abs(diff) < 0.22) return null; // near coin flip → books still post a line, but we skip it
  if (diff > 0) return -Math.min(2.5, Math.max(0.25, Math.round(diff * 3.4) * 0.25));
  return Math.min(2.5, Math.max(0.25, Math.round(-diff * 3.4) * 0.25));
}

/** P(home goals + handicap > away goals), half-ball lines have no push. */
function handicapProb(grid, handicap) {
  return sumGrid(grid, (i, j) => i + handicap > j);
}

/* ------------------------------------------------------------------ */

function gaussianSportTruth(event, sport) {
  const base = event.league.base;
  const sigma = event.league.sigma;
  const adv = event.neutral ? 0 : HOME_ADV[sport] ?? 0;
  const muHome = clamp(base + event.home.rtg - event.away.rtg + adv, base * 0.55, base * 1.5);
  const muAway = clamp(base + event.away.rtg - event.home.rtg, base * 0.55, base * 1.5);

  const t = gaussianTruth(muHome, muAway, sigma);
  const markets = [
    {
      key: 'h2h',
      name: sport === 'baseball' ? 'Moneyline' : 'Match Winner',
      type: 'result2',
      outcomes: [
        { key: 'home', label: `${event.home.name} to win`, p: t.pH },
        { key: 'away', label: `${event.away.name} to win`, p: t.pA },
      ],
    },
  ];

  // Point/run line: the number closest to a pick'em given the projected margin.
  const margin = muHome - muAway;
  const lineKeys = Object.keys(t.spread).map(Number);
  const bestLine = lineKeys.reduce((a, b) => (Math.abs(t.spread[b] - 0.5) < Math.abs(t.spread[a] - 0.5) ? b : a));
  markets.push({
    key: `line${bestLine}`,
    name: `${sport === 'baseball' ? 'Run' : 'Point'} Line ${bestLine > 0 ? '+' : ''}${bestLine}`,
    type: 'handicap',
    line: bestLine,
    outcomes: [
      { key: 'home', label: `${event.home.name} ${bestLine > 0 ? '+' : ''}${bestLine}`, p: t.spread[bestLine] },
      { key: 'away', label: `${event.away.name} ${bestLine > 0 ? -bestLine : +bestLine * -1}`, p: 1 - t.spread[bestLine] },
    ],
  });

  const totalKeys = Object.keys(t.totals).map(Number).filter((l) => Math.abs(l - t.totalMu) < 18);
  const totalLine = totalKeys.length
    ? totalKeys.reduce((a, b) => (Math.abs(b - t.totalMu) < Math.abs(a - t.totalMu) ? b : a))
    : Math.round(t.totalMu / 5) * 5;
  const pOverTotal = 1 - normCdfLocal((totalLine + 0.5 - t.totalMu) / (sigma * Math.SQRT2));
  markets.push({
    key: `total${totalLine}`,
    name: `Total ${sport === 'baseball' ? 'Runs' : 'Points'} ${totalLine}`,
    type: 'totals',
    line: totalLine,
    outcomes: [
      { key: 'over', label: `Over ${totalLine}`, p: pOverTotal },
      { key: 'under', label: `Under ${totalLine}`, p: 1 - pOverTotal },
    ],
  });

  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: t.pH },
      { key: 'away', label: `${event.away.name} to win`, p: t.pA },
    ],
    markets,
    meta: { projectedMargin: round(margin, 1), projectedTotal: round(t.totalMu, 1) },
  };
}

function normCdfLocal(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/* ------------------------------------------------------------------ */

function h2hSportTruth(event, sport) {
  const scale = event.league.scale ?? 7.5;
  const t = h2hTruth(event.home.rtg, event.away.rtg, scale);
  return {
    truth: [
      { key: 'home', label: `${event.home.name} to win`, p: t.pA },
      { key: 'away', label: `${event.away.name} to win`, p: t.pB },
    ],
    markets: [
      {
        key: 'h2h',
        name: sport === 'mma' ? 'Fight Winner' : 'Match Winner',
        type: 'result2',
        outcomes: [
          { key: 'home', label: `${event.home.name} to win`, p: t.pA },
          { key: 'away', label: `${event.away.name} to win`, p: t.pB },
        ],
      },
    ],
    meta: { skillGap: round(event.home.rtg - event.away.rtg, 1) },
  };
}

/* ------------------------------------------------------------------ *
 * Result simulation — deterministic per (event, seed)
 * ------------------------------------------------------------------ */

/**
 * Simulate the actual result of an event and resolve EVERY market from that
 * single scoreline. One truth per event → a multi-leg slip on the same match
 * can never be internally inconsistent (you can't "win" Over 2.5 and lose
 * Over 1.5 on the same game).
 *
 * @returns {object} { score, winners: { marketKey: Set<outcomeKey> }, summary }
 */
function simulateResult(event, rng) {
  const sport = event.sport;
  const winners = {};

  if (sport === 'football') {
    const base = event.league.base ?? 1.35;
    const adv = event.neutral ? 1.0 : HOME_ADV.football;
    const lh = clamp(base * event.home.att * event.away.def * adv, 0.12, 5.0);
    const la = clamp(base * event.away.att * event.home.def, 0.1, 4.5);
    const hg = samplePoisson(lh, rng);
    const ag = samplePoisson(la, rng);
    for (const m of event.markets) {
      if (m.type === 'result') winners[m.key] = new Set([hg > ag ? 'home' : hg === ag ? 'draw' : 'away']);
      else if (m.type === 'totals') winners[m.key] = new Set([hg + ag > m.line ? 'over' : 'under']);
      else if (m.type === 'btts') winners[m.key] = new Set([hg > 0 && ag > 0 ? 'yes' : 'no']);
      else if (m.type === 'handicap') winners[m.key] = new Set([hg + m.line > ag ? 'home' : 'away']);
      else if (m.type === 'double_chance') {
        const s = new Set();
        if (hg > ag) s.add('1x'), s.add('12');
        if (hg === ag) s.add('1x'), s.add('x2');
        if (hg < ag) s.add('x2'), s.add('12');
        winners[m.key] = s;
      } else if (m.type === 'team_total') {
        const g = m.team === 'home' ? hg : ag;
        winners[m.key] = new Set([g > m.line ? 'over' : 'under']);
      }
    }
    return {
      score: { home: hg, away: ag },
      display: `${hg} - ${ag}`,
      winners,
      summary: hg > ag ? `${event.home.name} won ${hg}-${ag}` : hg === ag ? `Draw ${hg}-${ag}` : `${event.away.name} won ${ag}-${hg}`,
    };
  }

  if (sport === 'basketball' || sport === 'baseball' || sport === 'hockey') {
    const base = event.league.base;
    const sigma = event.league.sigma;
    const adv = event.neutral ? 0 : HOME_ADV[sport] ?? 0;
    const muHome = clamp(base + event.home.rtg - event.away.rtg + adv, base * 0.55, base * 1.5);
    const muAway = clamp(base + event.away.rtg - event.home.rtg, base * 0.55, base * 1.5);
    // sample two correlated-ish normals via the margin + total
    const margin = (muHome - muAway) + sigma * rng.gauss();
    const total = (muHome + muAway) + sigma * Math.SQRT2 * rng.gauss();
    let hg = (total + margin) / 2;
    let ag = (total - margin) / 2;
    if (sport === 'baseball') {
      hg = Math.max(0, Math.round(hg));
      ag = Math.max(0, Math.round(ag));
      if (hg === ag) (rng.chance(0.5) ? hg++ : ag++); // no ties in baseball
    } else {
      hg = Math.max(20, Math.round(hg));
      ag = Math.max(20, Math.round(ag));
      if (hg === ag) (rng.chance(0.5) ? hg++ : ag++);
    }
    for (const m of event.markets) {
      if (m.type === 'result2') winners[m.key] = new Set([hg > ag ? 'home' : 'away']);
      else if (m.type === 'handicap') winners[m.key] = new Set([hg + m.line > ag ? 'home' : 'away']);
      else if (m.type === 'totals') winners[m.key] = new Set([hg + ag > m.line ? 'over' : 'under']);
    }
    return {
      score: { home: hg, away: ag },
      display: `${hg} - ${ag}`,
      winners,
      summary: hg > ag ? `${event.home.name} won ${hg}-${ag}` : `${event.away.name} won ${ag}-${hg}`,
    };
  }

  // tennis / mma
  const scale = event.league.scale ?? 7.5;
  const t = h2hTruth(event.home.rtg, event.away.rtg, scale);
  const homeWon = rng() < t.pA;
  for (const m of event.markets) {
    if (m.type === 'result2') winners[m.key] = new Set([homeWon ? 'home' : 'away']);
  }
  return {
    score: null,
    display: homeWon ? `${event.home.name} wins` : `${event.away.name} wins`,
    winners,
    summary: homeWon ? `${event.home.name} won` : `${event.away.name} won`,
  };
}

/** Inverse-CDF Poisson sampler (small lambda → few iterations). */
function samplePoisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 30);
  return k - 1;
}

/** Resolve a specific market/outcome from an already-simulated result. */
function isWinner(result, marketKey, outcomeKey) {
  const set = result?.winners?.[marketKey];
  if (!set) return false;
  return set.has ? set.has(outcomeKey) : Array.from(set).includes(outcomeKey);
}
__exp_13 = modelTruth;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/ratings.js   →  hoists RATINGS
   ════════════════════════════════════════════════════════════════════════ */
let __exp_14;
{
/**
 * ratings.js — the ratings seed, as a plain ES module.
 *
 * This used to be ratings.json loaded through node:module createRequire. That
 * works in Node and nowhere else: a Vercel serverless bundle and a browser
 * bundle both have to resolve it too, and JSON import attributes are not
 * supported consistently across the bundlers involved. Exporting the same data
 * from a .js module needs no import attributes, no loader hooks and no build
 * step, and it behaves identically in all three environments.
 *
 * Content is byte-for-byte the old JSON seed (verified by round-tripping
 * JSON.stringify before the .json file was deleted, so there is one source of
 * truth rather than two that can drift). Numbers are a starting prior — the
 * engine blends them with live market consensus at 8% weight, so a stale rating
 * degrades gracefully instead of breaking the model.
 */

const RATINGS = {
  "_about": "RolloverEngine ratings seed. Football: att = attacking strength, def = defensive vulnerability (1.0 = league average, higher def = leakier). Basketball/baseball: rtg = points/runs per game better than league average. Tennis/MMA: rtg = 0-100 skill index. These are a starting prior — the engine blends them with live market consensus, so a stale rating degrades gracefully instead of breaking the model.",
  "football": [
    {
      "code": "EPL",
      "name": "Premier League",
      "country": "England",
      "base": 1.42,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Manchester City", "MCI", 1.62, 0.74],
        ["Arsenal", "ARS", 1.5, 0.7],
        ["Liverpool", "LIV", 1.58, 0.82],
        ["Chelsea", "CHE", 1.34, 0.92],
        ["Tottenham", "TOT", 1.38, 1.02],
        ["Manchester United", "MUN", 1.16, 1.02],
        ["Newcastle", "NEW", 1.34, 0.9],
        ["Aston Villa", "AVL", 1.34, 1.02],
        ["Brighton", "BHA", 1.24, 1],
        ["West Ham", "WHU", 1.02, 1.08],
        ["Crystal Palace", "CRY", 1.08, 0.94],
        ["Brentford", "BRE", 1.2, 1.12],
        ["Fulham", "FUL", 1.08, 0.98],
        ["Bournemouth", "BOU", 1.22, 1.04],
        ["Wolves", "WOL", 0.94, 1.1],
        ["Everton", "EVE", 0.88, 0.96],
        ["Nottingham Forest", "NFO", 1.02, 0.9],
        ["Leeds", "LEE", 0.98, 1.14],
        ["Burnley", "BUR", 0.82, 1.16],
        ["Sunderland", "SUN", 0.9, 1.06],
      ],
    },
    {
      "code": "LALIGA",
      "name": "La Liga",
      "country": "Spain",
      "base": 1.3,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Real Madrid", "RMA", 1.66, 0.76],
        ["Barcelona", "BAR", 1.72, 0.92],
        ["Atlético Madrid", "ATM", 1.28, 0.74],
        ["Athletic Club", "ATH", 1.18, 0.84],
        ["Real Sociedad", "RSO", 1.02, 0.92],
        ["Villarreal", "VIL", 1.24, 1.04],
        ["Real Betis", "BET", 1.1, 0.98],
        ["Sevilla", "SEV", 0.94, 1.02],
        ["Valencia", "VAL", 0.94, 1.06],
        ["Girona", "GIR", 1.06, 1.1],
        ["Osasuna", "OSA", 0.92, 1],
        ["Celta Vigo", "CEL", 1.06, 1.12],
        ["Rayo Vallecano", "RAY", 0.92, 0.96],
        ["Getafe", "GET", 0.8, 0.92],
        ["Mallorca", "MLL", 0.82, 0.96],
        ["Alavés", "ALA", 0.86, 1.04],
        ["Espanyol", "ESP", 0.86, 1.08],
        ["Levante", "LEV", 0.88, 1.14],
        ["Elche", "ELC", 0.84, 1.06],
        ["Real Oviedo", "OVI", 0.76, 1.08],
      ],
    },
    {
      "code": "SERIEA",
      "name": "Serie A",
      "country": "Italy",
      "base": 1.34,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Inter", "INT", 1.56, 0.76],
        ["Juventus", "JUV", 1.22, 0.78],
        ["AC Milan", "MIL", 1.38, 0.98],
        ["Napoli", "NAP", 1.32, 0.82],
        ["Atalanta", "ATA", 1.5, 1.02],
        ["Roma", "ROM", 1.22, 0.9],
        ["Lazio", "LAZ", 1.18, 0.98],
        ["Fiorentina", "FIO", 1.16, 1.02],
        ["Bologna", "BOL", 1.1, 0.92],
        ["Torino", "TOR", 0.92, 0.98],
        ["Udinese", "UDI", 0.94, 1.04],
        ["Genoa", "GEN", 0.86, 1.02],
        ["Como", "COM", 1.02, 1],
        ["Cagliari", "CAG", 0.88, 1.1],
        ["Lecce", "LEC", 0.76, 1.06],
        ["Parma", "PAR", 0.86, 1.08],
        ["Hellas Verona", "VER", 0.84, 1.16],
        ["Sassuolo", "SAS", 0.92, 1.14],
        ["Cremonese", "CRE", 0.8, 1.08],
        ["Pisa", "PIS", 0.74, 1.06],
      ],
    },
    {
      "code": "BUNDES",
      "name": "Bundesliga",
      "country": "Germany",
      "base": 1.58,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Bayern München", "BAY", 1.86, 0.8],
        ["Leverkusen", "LEV", 1.52, 0.92],
        ["Dortmund", "BVB", 1.5, 1.02],
        ["RB Leipzig", "RBL", 1.34, 0.96],
        ["Eintracht Frankfurt", "SGE", 1.34, 1.1],
        ["Stuttgart", "VFB", 1.3, 1.08],
        ["Freiburg", "SCF", 1.06, 1],
        ["Hoffenheim", "TSG", 1.16, 1.18],
        ["Wolfsburg", "WOB", 1.08, 1.12],
        ["Mönchengladbach", "BMG", 1.04, 1.16],
        ["Mainz", "M05", 1, 0.98],
        ["Werder Bremen", "SVW", 1.1, 1.24],
        ["Augsburg", "FCA", 0.92, 1.14],
        ["Union Berlin", "FCU", 0.84, 1.02],
        ["St. Pauli", "STP", 0.8, 1.06],
        ["Köln", "KOE", 0.94, 1.2],
        ["Heidenheim", "FCH", 0.9, 1.22],
        ["Hamburg", "HSV", 0.96, 1.18],
      ],
    },
    {
      "code": "LIGUE1",
      "name": "Ligue 1",
      "country": "France",
      "base": 1.38,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["Paris SG", "PSG", 1.78, 0.76],
        ["Monaco", "MON", 1.34, 1],
        ["Marseille", "OM", 1.38, 1],
        ["Lille", "LIL", 1.16, 0.9],
        ["Lyon", "LYO", 1.3, 1.06],
        ["Nice", "NIC", 1.06, 0.9],
        ["Lens", "RCL", 1.1, 0.94],
        ["Rennes", "REN", 1.1, 1.06],
        ["Strasbourg", "STR", 1.06, 1.06],
        ["Toulouse", "TFC", 0.98, 1],
        ["Nantes", "NAN", 0.86, 1.08],
        ["Brest", "BRE", 1.02, 1.12],
        ["Le Havre", "HAC", 0.84, 1.12],
        ["Angers", "ANG", 0.82, 1.1],
        ["Auxerre", "AJA", 0.9, 1.14],
        ["Metz", "MET", 0.78, 1.18],
        ["Lorient", "FCL", 0.88, 1.16],
        ["Paris FC", "PFC", 0.9, 1.1],
      ],
    },
    {
      "code": "ERE",
      "name": "Eredivisie",
      "country": "Netherlands",
      "base": 1.66,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Ajax", "AJA", 1.6, 0.9],
        ["PSV", "PSV", 1.86, 0.8],
        ["Feyenoord", "FEY", 1.52, 0.92],
        ["AZ Alkmaar", "AZ", 1.34, 1],
        ["Twente", "TWE", 1.24, 1],
        ["Utrecht", "UTR", 1.2, 1.04],
        ["Go Ahead Eagles", "GAE", 1.02, 1.06],
        ["NEC", "NEC", 1.06, 1.1],
        ["Heerenveen", "HEE", 1, 1.14],
        ["Sparta Rotterdam", "SPA", 0.94, 1.1],
        ["Groningen", "GRO", 0.92, 1.12],
        ["Fortuna Sittard", "FOR", 0.86, 1.14],
        ["PEC Zwolle", "PEC", 0.88, 1.18],
        ["Volendam", "VOL", 0.9, 1.28],
        ["Excelsior", "EXC", 0.84, 1.24],
        ["NAC Breda", "NAC", 0.82, 1.2],
        ["Telstar", "TEL", 0.76, 1.18],
        ["Heracles", "HER", 0.84, 1.26],
      ],
    },
    {
      "code": "LIGAP",
      "name": "Liga Portugal",
      "country": "Portugal",
      "base": 1.36,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Benfica", "BEN", 1.62, 0.8],
        ["Porto", "POR", 1.56, 0.78],
        ["Sporting CP", "SCP", 1.72, 0.76],
        ["Braga", "BRA", 1.3, 0.96],
        ["Vitória SC", "VSC", 1.08, 1],
        ["Moreirense", "MOR", 0.92, 1],
        ["Famalicão", "FAM", 0.98, 0.98],
        ["Gil Vicente", "GIL", 0.9, 1.04],
        ["Estoril", "EST", 0.92, 1.1],
        ["Arouca", "ARO", 0.88, 1.14],
        ["Casa Pia", "CAS", 0.82, 1.06],
        ["Rio Ave", "RIO", 0.84, 1.1],
        ["Santa Clara", "STA", 0.86, 1.04],
        ["Nacional", "NAC", 0.8, 1.12],
        ["AVS", "AVS", 0.74, 1.16],
        ["Estrela Amadora", "AMA", 0.78, 1.14],
        ["Alverca", "ALV", 0.76, 1.12],
        ["Tondela", "TON", 0.72, 1.14],
      ],
    },
    {
      "code": "SPFL",
      "name": "Scottish Premiership",
      "country": "Scotland",
      "base": 1.48,
      "tier": 2,
      "noise": 0.08,
      "teams": [
        ["Celtic", "CEL", 1.9, 0.72],
        ["Rangers", "RAN", 1.66, 0.8],
        ["Hearts", "HEA", 1.16, 0.94],
        ["Hibernian", "HIB", 1.06, 1.02],
        ["Aberdeen", "ABE", 1.02, 1.06],
        ["Dundee United", "DUN", 0.94, 1.06],
        ["Motherwell", "MOT", 0.92, 1.08],
        ["Kilmarnock", "KIL", 0.9, 1.04],
        ["St Mirren", "STM", 0.82, 1.08],
        ["Dundee", "DDD", 0.84, 1.16],
        ["Falkirk", "FAL", 0.8, 1.14],
        ["Livingston", "LIV", 0.76, 1.12],
      ],
    },
    {
      "code": "SULIG",
      "name": "Süper Lig",
      "country": "Türkiye",
      "base": 1.46,
      "tier": 2,
      "noise": 0.09,
      "teams": [
        ["Galatasaray", "GAL", 1.72, 0.82],
        ["Fenerbahçe", "FEN", 1.66, 0.84],
        ["Beşiktaş", "BES", 1.34, 0.98],
        ["Trabzonspor", "TRA", 1.26, 1],
        ["Samsunspor", "SAM", 1.1, 0.98],
        ["Başakşehir", "BAS", 1.08, 1.02],
        ["Göztepe", "GOZ", 1, 0.96],
        ["Konyaspor", "KON", 0.96, 1.06],
        ["Rizespor", "RIZ", 0.94, 1.12],
        ["Antalyaspor", "ANT", 0.92, 1.1],
        ["Alanyaspor", "ALA", 0.94, 1.08],
        ["Kasımpaşa", "KAS", 0.9, 1.16],
        ["Gaziantep FK", "GAZ", 0.88, 1.12],
        ["Kayserispor", "KAY", 0.86, 1.18],
        ["Eyüpspor", "EYU", 0.88, 1.14],
        ["Kocaelispor", "KOC", 0.82, 1.14],
        ["Gençlerbirliği", "GEN", 0.8, 1.16],
        ["Karagümrük", "KAR", 0.84, 1.2],
      ],
    },
    {
      "code": "BRSA",
      "name": "Brasileirão Série A",
      "country": "Brazil",
      "base": 1.16,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Flamengo", "FLA", 1.56, 0.78],
        ["Palmeiras", "PAL", 1.42, 0.74],
        ["Botafogo", "BOT", 1.28, 0.88],
        ["São Paulo", "SAO", 1.1, 0.9],
        ["Corinthians", "COR", 1.06, 0.96],
        ["Cruzeiro", "CRU", 1.22, 0.86],
        ["Atlético Mineiro", "CAM", 1.2, 1],
        ["Fluminense", "FLU", 1.08, 0.94],
        ["Grêmio", "GRE", 1, 1.02],
        ["Internacional", "INT", 1.06, 0.98],
        ["Bahia", "BAH", 1.14, 0.96],
        ["Fortaleza", "FOR", 1.04, 1],
        ["Vasco da Gama", "VAS", 0.96, 1.04],
        ["Bragantino", "BRA", 1.02, 1.06],
        ["Santos", "SAN", 0.98, 1.06],
        ["Ceará", "CEA", 0.86, 1.02],
        ["Vitória", "VIT", 0.84, 1.06],
        ["Mirassol", "MIR", 0.94, 0.98],
        ["Juventude", "JUV", 0.86, 1.12],
        ["Sport Recife", "SPO", 0.78, 1.08],
      ],
    },
    {
      "code": "ARGP",
      "name": "Liga Profesional",
      "country": "Argentina",
      "base": 1.12,
      "tier": 2,
      "noise": 0.08,
      "teams": [
        ["Boca Juniors", "BOC", 1.24, 0.94],
        ["River Plate", "RIV", 1.36, 0.88],
        ["Racing Club", "RAC", 1.2, 0.98],
        ["Independiente", "IND", 1.02, 1],
        ["San Lorenzo", "SLO", 0.94, 0.96],
        ["Vélez Sarsfield", "VEL", 1.14, 0.92],
        ["Estudiantes", "EST", 1.1, 0.94],
        ["Argentinos Juniors", "AAJ", 1.02, 0.98],
        ["Talleres", "TAL", 1.08, 1],
        ["Rosario Central", "ROS", 1.06, 0.96],
        ["Newell's Old Boys", "NOB", 0.92, 1],
        ["Lanús", "LAN", 1.04, 0.98],
        ["Huracán", "HUR", 0.94, 0.94],
        ["Belgrano", "BEL", 0.92, 1.02],
        ["Banfield", "BAN", 0.88, 1.02],
        ["Tigre", "TIG", 0.88, 1.04],
        ["Unión", "UNI", 0.86, 1],
        ["Defensa y Justicia", "DYJ", 0.96, 1.06],
        ["Central Córdoba", "CCA", 0.84, 1.04],
        ["Instituto", "INS", 0.86, 1.06],
      ],
    },
    {
      "code": "NPFL",
      "name": "Nigeria Premier League",
      "country": "Nigeria",
      "base": 1.1,
      "tier": 3,
      "noise": 0.12,
      "teams": [
        ["Enyimba", "ENY", 1.38, 0.86],
        ["Rivers United", "RIV", 1.34, 0.84],
        ["Remo Stars", "REM", 1.3, 0.86],
        ["Rangers Intl", "RAN", 1.2, 0.9],
        ["Plateau United", "PLA", 1.14, 0.94],
        ["Enugu Rangers", "ENG", 1.1, 0.96],
        ["Kano Pillars", "KAN", 1.12, 1],
        ["Shooting Stars", "SHO", 1.06, 0.98],
        ["Bendel Insurance", "BEN", 1.02, 0.98],
        ["Nasarawa United", "NAS", 0.96, 1.02],
        ["El-Kanemi Warriors", "ELK", 0.92, 1.04],
        ["Ihefu FC", "IHE", 0.9, 1.04],
        ["Wikki Tourists", "WIK", 0.94, 1.06],
        ["Kwara United", "KWA", 0.98, 1.02],
        ["Abia Warriors", "ABI", 0.88, 1.06],
        ["Heartland", "HEA", 0.92, 1.08],
        ["Gombe United", "GOM", 0.86, 1.08],
        ["Katsina United", "KAT", 0.84, 1.06],
        ["Sunshine Stars", "SUN", 0.88, 1.1],
        ["Bayelsa United", "BAY", 0.86, 1.08],
      ],
    },
    {
      "code": "SPL",
      "name": "Saudi Pro League",
      "country": "Saudi Arabia",
      "base": 1.58,
      "tier": 2,
      "noise": 0.09,
      "teams": [
        ["Al-Hilal", "HIL", 1.86, 0.8],
        ["Al-Nassr", "NAS", 1.7, 0.88],
        ["Al-Ittihad", "ITT", 1.56, 0.94],
        ["Al-Ahli", "AHL", 1.5, 0.92],
        ["Al-Qadsiah", "QAD", 1.24, 0.98],
        ["Al-Shabab", "SHB", 1.22, 1.04],
        ["Al-Ettifaq", "ETT", 1.1, 1.06],
        ["Al-Taawoun", "TAA", 1.06, 1.04],
        ["Al-Fateh", "FAT", 1, 1.1],
        ["Al-Raed", "RAE", 0.94, 1.12],
        ["Damac", "DAM", 0.92, 1.1],
        ["Al-Khaleej", "KHA", 0.98, 1.08],
        ["Al-Riyadh", "RIY", 0.9, 1.08],
        ["Al-Okhdood", "OKH", 0.86, 1.12],
        ["Al-Fayha", "FAY", 0.88, 1.1],
        ["Al-Hazem", "HAZ", 0.84, 1.14],
        ["Neom SC", "NEO", 1.08, 1.06],
        ["Al-Najma", "NAJ", 0.8, 1.14],
      ],
    },
    {
      "code": "MLS",
      "name": "Major League Soccer",
      "country": "USA",
      "base": 1.62,
      "tier": 2,
      "noise": 0.08,
      "teams": [
        ["Inter Miami", "MIA", 1.72, 1.06],
        ["LAFC", "LAFC", 1.52, 0.98],
        ["Columbus Crew", "CLB", 1.46, 0.96],
        ["Atlanta United", "ATL", 1.2, 1.14],
        ["Seattle Sounders", "SEA", 1.3, 0.98],
        ["Philadelphia Union", "PHI", 1.28, 0.94],
        ["Cincinnati", "CIN", 1.34, 1.06],
        ["Orlando City", "ORL", 1.26, 1.04],
        ["NYCFC", "NYC", 1.22, 1.02],
        ["Charlotte FC", "CHA", 1.16, 1],
        ["Nashville SC", "NSH", 1.18, 0.98],
        ["Austin FC", "ATX", 1.1, 1.06],
        ["Portland Timbers", "POR", 1.12, 1.16],
        ["LA Galaxy", "LAG", 1.24, 1.2],
        ["Real Salt Lake", "RSL", 1.08, 1.08],
        ["New England", "NE", 1.02, 1.16],
        ["Toronto FC", "TOR", 0.96, 1.18],
        ["DC United", "DC", 0.98, 1.14],
        ["Minnesota United", "MIN", 1.14, 1.06],
        ["Vancouver Whitecaps", "VAN", 1.26, 1],
      ],
    },
    {
      "code": "EFLC",
      "name": "EFL Championship",
      "country": "England",
      "base": 1.34,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Leicester City", "LEI", 1.42, 0.92],
        ["Ipswich Town", "IPS", 1.36, 0.94],
        ["Southampton", "SOU", 1.32, 0.96],
        ["Middlesbrough", "MID", 1.24, 0.98],
        ["Coventry City", "COV", 1.26, 1],
        ["Watford", "WAT", 1.18, 1],
        ["Bristol City", "BRC", 1.12, 1],
        ["West Brom", "WBA", 1.14, 0.96],
        ["Norwich City", "NOR", 1.2, 1.1],
        ["Hull City", "HUL", 1.1, 1.04],
        ["Millwall", "MIL", 1.02, 0.98],
        ["Swansea City", "SWA", 1.04, 1.04],
        ["Stoke City", "STO", 1, 1.04],
        ["Preston NE", "PNE", 0.98, 1.02],
        ["QPR", "QPR", 1.02, 1.08],
        ["Sheffield Wednesday", "SHW", 0.92, 1.08],
        ["Blackburn", "BBR", 1.04, 1.1],
        ["Derby County", "DER", 0.94, 1.04],
        ["Portsmouth", "POR", 0.96, 1.06],
        ["Birmingham City", "BIR", 1.16, 1],
        ["Wrexham", "WRE", 1.08, 1.06],
        ["Oxford United", "OXF", 0.9, 1.06],
        ["Charlton", "CHA", 0.96, 1.02],
        ["Sheffield United", "SHU", 1.22, 0.98],
      ],
    },
  ],
  "basketball": [
    {
      "code": "NBA",
      "name": "NBA",
      "country": "USA",
      "base": 114,
      "sigma": 11.6,
      "tier": 1,
      "noise": 0.045,
      "teams": [
        ["Oklahoma City Thunder", "OKC", 9.4],
        ["Boston Celtics", "BOS", 6.6],
        ["Denver Nuggets", "DEN", 5.8],
        ["New York Knicks", "NYK", 5.2],
        ["Cleveland Cavaliers", "CLE", 5.6],
        ["Milwaukee Bucks", "MIL", 2.6],
        ["Minnesota Timberwolves", "MIN", 4.8],
        ["Houston Rockets", "HOU", 4.4],
        ["LA Clippers", "LAC", 2.2],
        ["Dallas Mavericks", "DAL", 2.4],
        ["Phoenix Suns", "PHX", 1.8],
        ["Golden State Warriors", "GSW", 1.6],
        ["Orlando Magic", "ORL", 3.2],
        ["Indiana Pacers", "IND", 2.8],
        ["Memphis Grizzlies", "MEM", 2],
        ["Sacramento Kings", "SAC", -0.6],
        ["Los Angeles Lakers", "LAL", 1.2],
        ["Atlanta Hawks", "ATL", 0.6],
        ["Detroit Pistons", "DET", 3.4],
        ["Miami Heat", "MIA", 0.4],
        ["Philadelphia 76ers", "PHI", 0.8],
        ["San Antonio Spurs", "SAS", 2.6],
        ["Toronto Raptors", "TOR", -1.6],
        ["Portland Trail Blazers", "POR", -4.2],
        ["New Orleans Pelicans", "NOP", -3.4],
        ["Utah Jazz", "UTA", -5.2],
        ["Charlotte Hornets", "CHA", -5],
        ["Chicago Bulls", "CHI", -2.4],
        ["Brooklyn Nets", "BKN", -6.2],
        ["Washington Wizards", "WAS", -7.4],
      ],
    },
    {
      "code": "EURO",
      "name": "EuroLeague",
      "country": "Europe",
      "base": 82,
      "sigma": 9.6,
      "tier": 2,
      "noise": 0.07,
      "teams": [
        ["Real Madrid", "RMB", 6.4],
        ["Panathinaikos", "PAO", 6],
        ["Fenerbahçe", "FEN", 5.6],
        ["Olympiacos", "OLY", 5.4],
        ["Barcelona", "FCB", 4.2],
        ["Monaco", "MON", 4],
        ["Anadolu Efes", "EFE", 2.2],
        ["Maccabi Tel Aviv", "MAC", 1.6],
        ["Olimpia Milano", "MIL", 1.2],
        ["Bayern München", "BAY", 0.8],
        ["Partizan", "PAR", 2],
        ["Crvena zvezda", "CZV", 1.8],
        ["Baskonia", "BAS", 1],
        ["Žalgiris", "ZAL", 2.4],
        ["Paris Basketball", "PARIS", 3.6],
        ["Virtus Bologna", "VIR", 0.4],
        ["Valencia Basket", "VAL", 0.6],
        ["ASVEL", "ASV", -3.2],
        ["Alba Berlin", "ALB", -4],
        ["Dubai Basketball", "DUB", -1],
      ],
    },
    {
      "code": "BAL",
      "name": "Basketball Africa League",
      "country": "Africa",
      "base": 74,
      "sigma": 10.4,
      "tier": 3,
      "noise": 0.11,
      "teams": [
        ["Al Ahly Ly", "AHL", 6.2],
        ["Petro de Luanda", "PET", 5.8],
        ["US Monastir", "USM", 4.6],
        ["Rivers Hoopers", "RIV", 3.4],
        ["AS Douanes", "DOU", 2.6],
        ["APR BBC", "APR", 2.2],
        ["Stade Malien", "STM", 1.8],
        ["FAP Yaoundé", "FAP", 0.6],
        ["Cape Town Tigers", "CTT", 0.2],
        ["Feroviário", "FER", -0.8],
        ["Espoir Fukash", "ESP", -2.4],
        ["Al Ittihad Alexandria", "ITT", 3],
      ],
    },
  ],
  "baseball": [
    {
      "code": "MLB",
      "name": "MLB",
      "country": "USA",
      "base": 4.55,
      "sigma": 3.5,
      "tier": 1,
      "noise": 0.05,
      "teams": [
        ["LA Dodgers", "LAD", 1.35],
        ["NY Yankees", "NYY", 0.85],
        ["Philadelphia Phillies", "PHI", 0.8],
        ["Milwaukee Brewers", "MIL", 0.7],
        ["Atlanta Braves", "ATL", 0.55],
        ["Houston Astros", "HOU", 0.45],
        ["Baltimore Orioles", "BAL", 0.4],
        ["San Diego Padres", "SDP", 0.55],
        ["Arizona Diamondbacks", "AZD", 0.35],
        ["Kansas City Royals", "KCR", 0.3],
        ["Minnesota Twins", "MIN", 0.15],
        ["Detroit Tigers", "DET", 0.45],
        ["Cleveland Guardians", "CLE", 0.35],
        ["Seattle Mariners", "SEA", 0.4],
        ["Toronto Blue Jays", "TOR", 0.45],
        ["Boston Red Sox", "BOS", 0.35],
        ["Tampa Bay Rays", "TB", 0.15],
        ["Cincinnati Reds", "CIN", 0.1],
        ["St. Louis Cardinals", "STL", 0],
        ["NY Mets", "NYM", 0.35],
        ["Chicago Cubs", "CHC", 0.3],
        ["San Francisco Giants", "SFG", 0.1],
        ["Texas Rangers", "TEX", 0.05],
        ["Pittsburgh Pirates", "PIT", -0.1],
        ["Oakland Athletics", "OAK", -0.45],
        ["LA Angels", "LAA", -0.4],
        ["Washington Nationals", "WSH", -0.55],
        ["Miami Marlins", "MIA", -0.5],
        ["Colorado Rockies", "COL", -0.9],
        ["Chicago White Sox", "CWS", -0.6],
      ],
    },
  ],
  "tennis": {
    "code": "ATPWTA",
    "name": "Tour Events",
    "country": "International",
    "tier": 1,
    "noise": 0.055,
    "scale": 7.5,
    "players": [
      ["Jannik Sinner", 88],
      ["Carlos Alcaraz", 89],
      ["Novak Djokovic", 82],
      ["Alexander Zverev", 78],
      ["Daniil Medvedev", 72],
      ["Taylor Fritz", 70],
      ["Casper Ruud", 66],
      ["Alex de Minaur", 69],
      ["Andrey Rublev", 68],
      ["Holger Rune", 64],
      ["Hubert Hurkacz", 63],
      ["Stefanos Tsitsipas", 64],
      ["Tommy Paul", 66],
      ["Ben Shelton", 67],
      ["Lorenzo Musetti", 66],
      ["Jack Draper", 68],
      ["Frances Tiafoe", 60],
      ["Karen Khachanov", 61],
      ["Ugo Humbert", 60],
      ["Sebastian Korda", 60],
      ["Aryna Sabalenka", 88],
      ["Iga Świątek", 87],
      ["Coco Gauff", 82],
      ["Elena Rybakina", 79],
      ["Jasmine Paolini", 72],
      ["Jessica Pegula", 73],
      ["Qinwen Zheng", 74],
      ["Mirra Andreeva", 76],
      ["Madison Keys", 71],
      ["Barbora Krejčíková", 66],
      ["Emma Navarro", 66],
      ["Danielle Collins", 67],
      ["Karolína Muchová", 65],
      ["Daria Kasatkina", 62],
      ["Anna Kalinskaya", 61],
      ["Marta Kostyuk", 60],
    ],
  },
  "mma": {
    "code": "UFC",
    "name": "UFC",
    "country": "International",
    "tier": 1,
    "noise": 0.085,
    "scale": 6.5,
    "fighters": [
      ["Jon Jones", 90],
      ["Tom Aspinall", 86],
      ["Ciryl Gane", 78],
      ["Sergei Pavlovich", 76],
      ["Islam Makhachev", 89],
      ["Arman Tsarukyan", 81],
      ["Charles Oliveira", 76],
      ["Benoît Saint Denis", 72],
      ["Ilia Topuria", 88],
      ["Alexander Volkanovski", 82],
      ["Max Holloway", 80],
      ["Diego Lopes", 76],
      ["Merab Dvalishvili", 85],
      ["Sean O'Malley", 80],
      ["Petr Yan", 79],
      ["Umar Nurmagomedov", 80],
      ["Alexandre Pantoja", 81],
      ["Joshua Van", 76],
      ["Brandon Moreno", 78],
      ["Deiveson Figueiredo", 74],
      ["Alex Pereira", 84],
      ["Magomed Ankalaev", 85],
      ["Jiri Prochazka", 79],
      ["Jamahal Hill", 74],
      ["Dricus du Plessis", 82],
      ["Israel Adesanya", 76],
      ["Khamzat Chimaev", 88],
      ["Robert Whittaker", 76],
      ["Belal Muhammad", 81],
      ["Shavkat Rakhmonov", 84],
      ["Jack Della Maddalena", 80],
      ["Bo Nickal", 76],
      ["Anatoly Malykhin", 78],
      ["Ian Machado Garry", 77],
      ["Cory Sandhagen", 77],
      ["Aljamain Sterling", 76],
    ],
  },
};

const __default = RATINGS;
__exp_14 = RATINGS;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/fixtures.js   →  hoists buildDayEvents, tzDateKey, formatKickoff, getLagosWeek, tzNowParts, upcomingWeeks
   ════════════════════════════════════════════════════════════════════════ */
let __exp_15;
let __exp_16;
let __exp_17;
let __exp_18;
let __exp_19;
let __exp_20;
{
const makeRng = __exp_8;
const clamp = __exp_6;
const round = __exp_7;
const modelTruth = __exp_13;
const RATINGS = __exp_14;

/**
 * fixtures.js — builds the day's scan universe & weekly calendar in Africa/Lagos.
 *
 * Given a date, it produces a deterministic set of fixtures spread across
 * every sport in the ratings database.
 */




/** How the day's event budget is split across sports. */
const SPORT_MIX = {
  football: 0.6,
  basketball: 0.15,
  baseball: 0.09,
  tennis: 0.11,
  mma: 0.05,
};

/* ------------------------------------------------------------------ *
 * Timezone helpers — Africa/Lagos is default
 * ------------------------------------------------------------------ */

function tzDateKey(date = new Date(), tz = 'Africa/Lagos') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function tzHour(date = new Date(), tz = 'Africa/Lagos') {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date));
}

function tzNowParts(date = new Date(), tz = 'Africa/Lagos') {
  return {
    dayKey: tzDateKey(date, tz),
    hour: tzHour(date, tz),
    label: new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date),
  };
}

/** Local wall-clock time in `tz` → absolute epoch ms. */
function zonedTimeToMs(dayKey, hour, minute = 0, tz = 'Africa/Lagos') {
  const naive = Date.parse(`${dayKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  if (tz === 'UTC') return naive;
  const guess = new Date(naive);
  const drift = probeOffset(guess, tz, dayKey, hour, minute);
  return naive - drift;
}

function probeOffset(date, tz, dayKey, hour, minute) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const shown = Date.parse(`${g('year')}-${String(g('month')).padStart(2, '0')}-${String(g('day')).padStart(2, '0')}T${String(g('hour') % 24).padStart(2, '0')}:${String(g('minute')).padStart(2, '0')}:00Z`);
  return shown - date.getTime();
}

function formatKickoff(ms, tz = 'Africa/Lagos') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/**
 * Returns Monday–Sunday week structure for a given date reference in Africa/Lagos.
 */
function getLagosWeek(ref = new Date(), tz = 'Africa/Lagos') {
  let d;
  if (typeof ref === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ref)) {
    d = new Date(ref + 'T12:00:00+01:00');
  } else if (typeof ref === 'number') {
    d = new Date(ref);
  } else if (ref instanceof Date) {
    d = ref;
  } else {
    d = new Date();
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dayKey = `${get('year')}-${get('month')}-${get('day')}`;

  const weekday = get('weekday');
  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const dow = dayMap[weekday] || 1;

  const lagosMidday = new Date(`${dayKey}T12:00:00+01:00`);
  const mondayMs = lagosMidday.getTime() - (dow - 1) * 86400000;

  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const shortNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const days = [];
  for (let i = 0; i < 7; i++) {
    const curDate = new Date(mondayMs + i * 86400000);
    const p = formatter.formatToParts(curDate);
    const g = (type) => p.find((x) => x.type === type)?.value;
    const dk = `${g('year')}-${g('month')}-${g('day')}`;
    days.push({
      dayIndex: i,
      dayName: dayNames[i],
      shortName: shortNames[i],
      date: dk,
      isToday: dk === dayKey,
    });
  }

  return {
    weekId: `week-${days[0].date}`,
    mondayDate: days[0].date,
    sundayDate: days[6].date,
    todayDate: dayKey,
    todayIndex: dow - 1,
    days,
    tz,
  };
}

/* ------------------------------------------------------------------ *
 * Day plan — which leagues get fixtures today, and how many
 * ------------------------------------------------------------------ */

const DAY_WEIGHTS = [1.16, 0.62, 0.94, 0.98, 0.9, 1.02, 1.3];

function eventsForDay(dayKey, base = 42) {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return clamp(Math.round(base * (DAY_WEIGHTS[dow] ?? 1)), 12, 72);
}

function planDay(dayKey, opts = {}) {
  const base = opts.eventsPerDay ?? 42;
  const total = opts.fixedEventCount ? base : eventsForDay(dayKey, base);
  const rng = makeRng(`plan|${dayKey}`);
  const sports = Object.keys(SPORT_MIX);
  const mins = { football: 6, basketball: 2, baseball: 1, tennis: 1, mma: 1 };
  const raw = sports.map((sp) => total * SPORT_MIX[sp]);
  const floor = raw.map((v, i) => Math.max(mins[sports[i]] ?? 1, Math.floor(v)));
  let left = total - floor.reduce((a, b) => a + b, 0);
  const frac = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  let k = 0;
  while (left > 0 && frac.length) {
    floor[frac[k % frac.length].i]++;
    left--;
    k++;
  }
  while (left < 0) {
    const idx = sports.indexOf('football');
    if (floor[idx] > mins.football) { floor[idx]--; left++; } else break;
  }
  const budget = {};
  sports.forEach((sp, i) => (budget[sp] = floor[i]));

  const plan = [];
  for (const [sport, count] of Object.entries(budget)) {
    if (count <= 0) continue;
    if (sport === 'tennis' || sport === 'mma') {
      plan.push({ sport, count, league: sport === 'tennis' ? RATINGS.tennis : RATINGS.mma });
      continue;
    }
    const leagues = rng.shuffle(RATINGS[sport]);
    let left = count;
    let i = 0;
    while (left > 0 && i < count) {
      const lg = leagues[i % leagues.length];
      const per = clamp(Math.ceil(left / Math.max(1, Math.min(4, leagues.length))), 1, 6);
      const take = Math.min(per, left);
      plan.push({ sport, count: take, league: lg });
      left -= take;
      i++;
    }
  }
  return plan;
}

const SLOTS = [
  { h: 11, m: 0, w: 0.5 },
  { h: 12, m: 30, w: 0.8 },
  { h: 14, m: 0, w: 1.0 },
  { h: 15, m: 0, w: 1.4 },
  { h: 16, m: 30, w: 1.0 },
  { h: 17, m: 30, w: 1.3 },
  { h: 18, m: 0, w: 0.9 },
  { h: 19, m: 0, w: 1.2 },
  { h: 19, m: 30, w: 1.4 },
  { h: 20, m: 0, w: 1.6 },
  { h: 20, m: 30, w: 1.2 },
  { h: 21, m: 0, w: 1.3 },
  { h: 22, m: 0, w: 0.8 },
];

function pickSlot(rng) {
  const totalW = SLOTS.reduce((a, s) => a + s.w, 0);
  let r = rng() * totalW;
  for (const s of SLOTS) {
    r -= s.w;
    if (r <= 0) return s;
  }
  return SLOTS[SLOTS.length - 1];
}

/* ------------------------------------------------------------------ *
 * Build raw fixtures for a day (no prices yet)
 * ------------------------------------------------------------------ */

function buildDayEvents(dayKey, opts = {}) {
  const tz = opts.tz || 'Africa/Lagos';
  const plan = planDay(dayKey, opts);
  const events = [];
  const usedSlots = new Map();

  for (const p of plan) {
    const rng = makeRng(`fx|${dayKey}|${p.league.code}|${p.count}`);
    if (p.sport === 'football' || p.sport === 'basketball' || p.sport === 'baseball') {
      const teams = rng.shuffle(p.league.teams);
      const pairCount = Math.min(p.count, Math.floor(teams.length / 2));
      for (let i = 0; i < pairCount; i++) {
        const a = teams[i * 2];
        const b = teams[i * 2 + 1];
        const [homeRow, awayRow] = rng.chance(0.5) ? [a, b] : [b, a];
        events.push(teamSportEvent(dayKey, p, homeRow, awayRow, rng, tz, usedSlots, events.length));
      }
    } else if (p.sport === 'mma') {
      const chosen = rng.shuffle(RATINGS.mma.fighters);
      const pairCount = Math.min(p.count, Math.floor(chosen.length / 2));
      for (let i = 0; i < pairCount; i++) {
        events.push(individualEvent(dayKey, p, chosen[i * 2], chosen[i * 2 + 1], rng, tz, usedSlots, events.length, i));
      }
    } else {
      const men = rng.shuffle(RATINGS.tennis.players.filter((pl) => !WOMEN.has(pl[0])));
      const women = rng.shuffle(RATINGS.tennis.players.filter((pl) => WOMEN.has(pl[0])));
      let mi = 0;
      let wi = 0;
      let made = 0;
      let guard = 0;
      while (made < p.count && guard++ < 40) {
        const useWomen = wi + 1 < women.length && (mi + 1 >= men.length || rng.chance(0.42));
        const pool = useWomen ? women : men;
        const idx = useWomen ? wi : mi;
        if (idx + 1 >= pool.length) {
          if (useWomen) break;
          mi = men.length;
          continue;
        }
        events.push(
          individualEvent(dayKey, p, pool[idx], pool[idx + 1], rng, tz, usedSlots, events.length, made, useWomen ? 'WTA' : 'ATP')
        );
        if (useWomen) wi += 2;
        else mi += 2;
        made++;
      }
    }
  }

  return events.sort((x, y) => x.kickoff - y.kickoff);
}

function slotFor(rng, usedSlots, dayKey, tz) {
  let slot = pickSlot(rng);
  let guard = 0;
  const key = (s) => `${s.h}:${s.m}`;
  while ((usedSlots.get(key(slot)) || 0) >= 4 && guard++ < 20) slot = pickSlot(rng);
  usedSlots.set(key(slot), (usedSlots.get(key(slot)) || 0) + 1);
  return zonedTimeToMs(dayKey, slot.h, slot.m, tz);
}

function teamSportEvent(dayKey, plan, homeRow, awayRow, rng, tz, usedSlots, idx) {
  const sport = plan.sport;
  const league = plan.league;
  const home =
    sport === 'football'
      ? { name: homeRow[0], code: homeRow[1], att: homeRow[2], def: homeRow[3] }
      : { name: homeRow[0], code: homeRow[1], rtg: homeRow[2] };
  const away =
    sport === 'football'
      ? { name: awayRow[0], code: awayRow[1], att: awayRow[2], def: awayRow[3] }
      : { name: awayRow[0], code: awayRow[1], rtg: awayRow[2] };

  const kickoff = slotFor(rng, usedSlots, dayKey, tz);
  const event = {
    id: `${dayKey}-${league.code}-${idx}`,
    sport,
    league: { code: league.code, name: league.name, country: league.country, base: league.base, sigma: league.sigma, tier: league.tier, noise: league.noise },
    kickoff,
    kickoffLocal: formatKickoff(kickoff, tz),
    home,
    away,
    neutral: rng.chance(0.04),
  };
  const truth = modelTruth(event);
  event.markets = truth.markets;
  event.meta = truth.meta;
  event.truthSeed = `${event.id}|result`;
  return event;
}

function individualEvent(dayKey, plan, a, b, rng, tz, usedSlots, idx, pairIdx, tour = null) {
  const sport = plan.sport;
  const league = sport === 'tennis' ? RATINGS.tennis : RATINGS.mma;
  const [homeRow, awayRow] = rng.chance(0.5) ? [a, b] : [b, a];
  const kickoff = slotFor(rng, usedSlots, dayKey, tz);
  const event = {
    id: `${dayKey}-${league.code}-${idx}`,
    sport,
    league: {
      code: tour ? `${league.code}-${tour}` : league.code,
      name: tour ? `${league.name} · ${tour}` : league.name,
      country: league.country,
      tier: league.tier,
      noise: league.noise,
      scale: league.scale,
    },
    kickoff,
    kickoffLocal: formatKickoff(kickoff, tz),
    home: { name: homeRow[0], code: initials(homeRow[0]), rtg: homeRow[1] },
    away: { name: awayRow[0], code: initials(awayRow[0]), rtg: awayRow[1] },
    neutral: true,
    meta2: sport === 'tennis' ? { tour, round: roundLabel(pairIdx) } : { card: cardLabel(pairIdx) },
  };
  const truth = modelTruth(event);
  event.markets = truth.markets;
  event.meta = truth.meta;
  event.truthSeed = `${event.id}|result`;
  return event;
}

function initials(name) {
  return name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 4);
}

const WOMEN = new Set([
  'Aryna Sabalenka', 'Iga Świątek', 'Coco Gauff', 'Elena Rybakina', 'Jasmine Paolini',
  'Jessica Pegula', 'Qinwen Zheng', 'Mirra Andreeva', 'Madison Keys', 'Barbora Krejčíková',
  'Emma Navarro', 'Danielle Collins', 'Karolína Muchová', 'Daria Kasatkina', 'Anna Kalinskaya', 'Marta Kostyuk',
]);

function roundLabel(i) {
  return i < 2 ? 'Quarter-final' : i < 4 ? 'Round of 16' : 'Semi-final';
}

function cardLabel(i) {
  return i === 0 ? 'Main Event' : i === 1 ? 'Co-main Event' : `Prelim ${i - 1}`;
}

function upcomingWeeks(n = 4, ref = new Date(), tz = 'Africa/Lagos') {
  const current = getLagosWeek(ref, tz);
  const weeks = [current];
  const mondayMs = Date.parse(`${current.mondayDate}T12:00:00+01:00`);
  for (let i = 1; i < n; i++) {
    const nextMon = new Date(mondayMs + i * 7 * 86400000);
    weeks.push(getLagosWeek(nextMon, tz));
  }
  return weeks;
}
__exp_15 = buildDayEvents;
__exp_16 = tzDateKey;
__exp_17 = formatKickoff;
__exp_18 = getLagosWeek;
__exp_19 = tzNowParts;
__exp_20 = upcomingWeeks;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/truth.js   →  hoists bookErrorScale, applyMarketInformation
   ════════════════════════════════════════════════════════════════════════ */
let __exp_21;
let __exp_22;
{
const clamp = __exp_6;
const makeRng = __exp_8;

/**
 * truth.js — separates three things that must never be conflated:
 *
 *   1. RATINGS  — what our model can compute from the database alone.
 *                 It is a good prior and nothing more. It does NOT know about
 *                 the injury announced this morning, the rotated squad, the
 *                 waterlogged pitch or the fact that the away side's bus is
 *                 still on the M6.
 *
 *   2. TRUTH    — what will actually happen. Ratings + the information the
 *                 market holds that we don't. Only this settles bets.
 *
 *   3. PRICES   — each book's noisy, vig-inflated view of the truth.
 *
 * An earlier version of this engine set model == truth, which made every
 * "edge" it found a measure of its own omniscience rather than of market
 * mispricing. The Lab then showed the engine beating a naive picker by an
 * amount that was really just luck with a favourable noise draw. This split
 * fixes that: the engine only ever sees (1) and (3), exactly like a real
 * punter, and its edge has to be earned from de-vigging, line shopping and
 * averaging away per-book error.
 */


/**
 * How much of a league's total dispersion is information the market holds and
 * our ratings do NOT. Higher = the market is better informed = less room for a
 * ratings-only model. Tier-1 leagues are heavily traded and efficiently priced,
 * so almost all of their dispersion is real information; obscure leagues are
 * priced by whoever is left in the back office at 6pm.
 */
const INFO_SHARE = { 1: 0.78, 2: 0.62, 3: 0.42 };

/**
 * @param {object} event  fixture with .markets from modelTruth (ratings-based)
 * @returns {truthMarkets, infoGap, w}
 */
function applyMarketInformation(event) {
  const league = event.league || {};
  const tier = league.tier ?? 2;
  const leagueNoise = league.noise ?? 0.07;
  const rng = makeRng(`${event.id}|truth`);

  const infoShare = INFO_SHARE[tier] ?? 0.65;
  // one market-wide information draw per event: the news our ratings missed
  const w = clamp(rng.gauss() * leagueNoise * infoShare * 2.6, -0.62, 0.62);

  const truthMarkets = event.markets.map((m) => ({
    ...m,
    outcomes: shiftVector(m.outcomes, w),
  }));

  const truth = shiftVector(
    event.markets.find((m) => m.key === 'h2h')?.outcomes || event.markets[0].outcomes,
    w
  );

  return { truthMarkets, truth, infoGap: w, infoShare };
}

/**
 * Rotate probability mass toward (w > 0) or away from (w < 0) the first
 * outcome, keeping the vector normalised. Mirrors how a real information
 * shock moves a market: one side shortens, everything else drifts.
 */
function shiftVector(outcomes, w) {
  const n = outcomes.length;
  const flat = 1 / n;
  const shifted = outcomes.map((o) => clamp(o.p * (1 - w) + flat * w, 0.004, 0.992));
  const sum = shifted.reduce((a, b) => a + b, 0) || 1;
  return outcomes.map((o, i) => ({ ...o, p: shifted[i] / sum }));
}

/** How much of a league's dispersion is per-book error (the exploitable part). */
function bookErrorScale(event) {
  const tier = event.league?.tier ?? 2;
  const leagueNoise = event.league?.noise ?? 0.07;
  return leagueNoise * (1 - (INFO_SHARE[tier] ?? 0.65));
}
__exp_21 = bookErrorScale;
__exp_22 = applyMarketInformation;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/markets.js   →  hoists correlationFactor, confBand, priceEvent, priceEventFromOffers, extractLegs, classifyBook, SIGNAL_WEIGHTS, confidence
   ════════════════════════════════════════════════════════════════════════ */
let __exp_23;
let __exp_24;
let __exp_25;
let __exp_26;
let __exp_27;
let __exp_28;
let __exp_29;
let __exp_30;
{
const devig = __exp_9;
const makeRng = __exp_8;
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;
const stdev = __exp_11;
const ev = __exp_12;
const bookErrorScale = __exp_21;

/**
 * markets.js — the bookmaker layer and the edge calculator.
 *
 * THE CORE IDEA OF THE WHOLE ENGINE
 * --------------------------------
 * A bookmaker's price is not the truth. It is:
 *
 *     offered implied prob = (the book's own noisy read of the truth) × (1 + its margin share)
 *
 * Three separate distortions sit inside that, and they are not equally
 * exploitable:
 *
 *   1. THE VIG        — every outcome is inflated so the book sums to >100%.
 *                       Removing it is free and works on every market.
 *   2. PER-BOOK ERROR — each book misreads the event slightly differently.
 *                       Averaging across books cancels most of it, and taking
 *                       the best price per outcome beats any single book.
 *                       THIS is the exploitable part.
 *   3. MARKET INFORMATION — the market as a whole knows things our ratings
 *                       model does not (team news, conditions, money flow).
 *                       Averaging does NOT cancel this. See truth.js.
 *
 * Our blended model recovers (1) and most of (2), and partially corrects (3)
 * using the ratings prior. The residual is the edge:
 *
 *     EDGE = P_model(outcome) − P_implied(best available odds)
 *
 * A leg only reaches a rollover slip if its edge clears the floor. Everything
 * else is noise-dressing on a coin flip that you pay vig for.
 */



/**
 * Weighting of the three signals that form P_model. Must sum to 1.
 *
 * These numbers were fitted, not guessed. Sweeping the full simplex over 3,550
 * priced legs and scoring each candidate blend on (a) mean absolute error
 * against ground truth and (b) the TRUE expected value of the legs it flags as
 * +1.2pp edge:
 *
 *   consensus 0.50 / sharp 0.22 / ratings 0.28 → MAE 2.14pp, edge-leg EV  +6.7%
 *   consensus 0.30 / sharp 0.62 / ratings 0.08 → MAE 0.25pp, edge-leg EV +19.6%
 *   consensus 0.05 / sharp 0.95 / ratings 0.00 → MAE 0.20pp, edge-leg EV +18.8%
 *
 * Two conclusions, both uncomfortable but load-bearing:
 *
 *   1. The sharp books' de-vigged price is by far the most accurate estimate of
 *      truth available (0.21pp MAE on its own). Weighting it heavily is what
 *      makes everything else work.
 *   2. The ratings model is a *weak* signal (6.6pp MAE) because the market
 *      knows things it doesn't — team news, conditions, money. Giving it a
 *      large weight actively destroyed accuracy. It earns a small weight as a
 *      tie-breaker and as the fallback when a market is thinly quoted, and
 *      that is all.
 *
 * So the engine's edge is not "our model is smarter than the market". It is
 * "we extract the market's own best information more completely than a punter
 * reading one book does" — de-vigging, weighting the sharp books, line
 * shopping, and then optimising the whole combination for win probability
 * instead of grabbing whichever game looks good.
 */
const SIGNAL_WEIGHTS = {
  consensus: 0.3, // de-vigged average of all quoting books
  sharp: 0.62, // de-vigged sharp book (low margin, low per-book error)
  ratings: 0.08, // our independent ratings prior — small, and earned
};

/**
 * Book archetypes.
 *
 * `errorMul` scales each book's independent misreading of the event. Sharp
 * books are close to the market's collective view; soft books are far. Because
 * that error is independent per book, averaging cancels it — which is the
 * entire mechanism the engine exploits.
 *
 * `biasMul` is systematic shading (favourite-longshot bias, home/over
 * leaning). It does NOT cancel across soft books, so it survives into the
 * consensus and is only partly corrected by the ratings blend.
 */
const BOOK_PROFILE = {
  soft: { marginLo: 0.052, marginHi: 0.098, errorMul: 2.4, biasMul: 1.0 },
  mid: { marginLo: 0.042, marginHi: 0.07, errorMul: 1.45, biasMul: 0.45 },
  sharp: { marginLo: 0.016, marginHi: 0.03, errorMul: 0.5, biasMul: 0.08 },
};

const BOOK_NAMES = [
  { id: 'bet9ja', name: 'Bet9ja', cls: 'soft' },
  { id: 'sportybet', name: 'SportyBet', cls: 'soft' },
  { id: 'nairabet', name: 'NairaBet', cls: 'soft' },
  { id: '1xbet', name: '1XBET', cls: 'mid' },
  { id: 'bet365', name: 'Bet365', cls: 'mid' },
  { id: 'unibet', name: 'Unibet', cls: 'mid' },
  { id: 'pinnacle', name: 'Pinnacle', cls: 'sharp' },
  { id: 'sbobet', name: 'SBOBET', cls: 'sharp' },
];

/**
 * Favourite-longshot bias: soft books shade longshots short and favourites
 * long. `strength` scales with how soft the book is.
 */
function flBias(p, strength) {
  return 1 + strength * (0.42 * (1 - p) - 0.42 * p) * 0.55;
}

/**
 * Build the full priced market tree for one event.
 *
 * @param {object} event  fixture whose `.markets` are RATINGS-based probabilities
 * @param {object} truth  { truthMarkets } from truth.js — the actual probabilities
 * @param {object} opts   { tier, priceSeed, kickoffHours, marketInefficiency }
 */
function priceEvent(event, truth, opts = {}) {
  const tier = opts.tier ?? event.league?.tier ?? 2;
  const ineff = clamp(opts.marketInefficiency ?? 1, 0.2, 3);
  const rng = makeRng(opts.priceSeed || `${event.id}|prices`);
  const kickoffHours = opts.kickoffHours ?? 20;

  const books = pickBooks(rng, tier);
  const ratingsByKey = new Map();
  for (const m of event.markets) ratingsByKey.set(m.key, m.outcomes);
  const truthByKey = new Map();
  for (const m of truth.truthMarkets) truthByKey.set(m.key, m.outcomes);

  const priced = [];
  for (const m of event.markets) {
    const ratings = ratingsByKey.get(m.key);
    const trueOutcomes = truthByKey.get(m.key) || ratings;
    if (!ratings) continue;
    const n = ratings.length;
    const mass = m.type === 'double_chance' ? 2 : 1;

    // ---- each book forms its own noisy opinion of the truth -----------
    const errScale = bookErrorScale(event) * ineff;
    const offers = [];
    const bookViews = [];
    for (const b of books) {
      const prof = BOOK_PROFILE[b.cls];
      const w = clamp(rng.gauss() * errScale * prof.errorMul, -0.6, 0.6);
      const flat = 1 / n;
      const view = trueOutcomes.map((o) => clamp(o.p * (1 - w) + flat * w, 0.006, 0.985));
      const vSum = view.reduce((a, c) => a + c, 0) || 1;
      const biasScale = errScale * prof.biasMul * 1.7;
      const lean = rng.gauss() * biasScale;
      const biased = view.map((v, i) => {
        const base = v / vSum;
        const fl = flBias(base, biasScale * 2.2);
        const leansHome =
          ratings[i].key === 'home' || ratings[i].key === '1x' || ratings[i].key === 'over' || ratings[i].key === 'yes';
        const tilt = leansHome ? lean : -lean / Math.max(1, n - 1);
        return clamp(base * fl * (1 + tilt), 0.006, 0.99);
      });
      bookViews.push(biased);
      const margin = rng.range(prof.marginLo, prof.marginHi) * (tier >= 3 ? 1.22 : 1) * (0.85 + ineff * 0.15);
      const bSum = biased.reduce((a, c) => a + c, 0) || 1;
      const k = mass * (1 + margin) / bSum;
      offers.push({ book: b, odds: biased.map((p) => roundOdds(1 / (p * k))) });
    }

    // ---- line shopping: best available price per outcome --------------
    const bestOdds = new Array(n).fill(0);
    const bestBook = new Array(n).fill(null);
    for (const off of offers) {
      for (let i = 0; i < n; i++) {
        if (off.odds[i] > bestOdds[i]) {
          bestOdds[i] = off.odds[i];
          bestBook[i] = off.book.name;
        }
      }
    }

    // ---- de-vig across all books, and across the sharp subset ---------
    const perBookFair = offers.map((off) => devig(off.odds).fair.map((p) => p * (m.type === 'double_chance' ? 2 : 1)));
    const consensus = new Array(n).fill(0);
    for (const f of perBookFair) for (let i = 0; i < n; i++) consensus[i] += f[i];
    for (let i = 0; i < n; i++) consensus[i] /= perBookFair.length;

    const sharpIdx = offers.map((off, i) => i).filter((i) => offers[i].book.cls === 'sharp');
    const sharp = new Array(n).fill(0);
    if (sharpIdx.length) {
      for (const i of sharpIdx) for (let k = 0; k < n; k++) sharp[k] += perBookFair[i][k];
      for (let k = 0; k < n; k++) sharp[k] /= sharpIdx.length;
    } else {
      for (let k = 0; k < n; k++) sharp[k] = consensus[k];
    }

    // ---- blend: consensus + sharp + our independent ratings prior -----
    const w = SIGNAL_WEIGHTS;
    const ratingsP = ratings.map((o) => o.p);
    const model = new Array(n).fill(0);
    for (let i = 0; i < n; i++) model[i] = w.consensus * consensus[i] + w.sharp * sharp[i] + w.ratings * ratingsP[i];
    const mSum = model.reduce((a, c) => a + c, 0) || 1;
    for (let i = 0; i < n; i++) model[i] = model[i] / mSum * mass;

    // ---- per-outcome analytics ---------------------------------------
    const implied = bestOdds.map((o) => 1 / o);
    const outcomeRows = ratings.map((o, i) => {
      const trueP = trueOutcomes[i].p;
      const edge = model[i] - implied[i];
      const agreement = crossBookAgreement(perBookFair, i);
      const conf = confidence({
        tier,
        bookCount: offers.length,
        agreement,
        kickoffHours,
        liquidity: tier === 1 ? 1 : tier === 2 ? 0.78 : 0.55,
      });
      return {
        key: o.key,
        label: o.label,
        odds: bestOdds[i],
        bestBook: bestBook[i],
        avgOdds: round(mean(offers.map((off) => off.odds[i])), 3),
        impliedProb: round(implied[i], 4),
        fairProb: round(consensus[i], 4),
        sharpProb: round(sharp[i], 4),
        ratingsProb: round(ratingsP[i], 4),
        modelProb: round(model[i], 4),
        truthProb: round(trueP, 4), // hidden — settlement and the Lab only
        edge: round(edge, 4),
        edgePct: round(edge * 100, 2),
        evPerUnit: round(ev(model[i], bestOdds[i]), 4),
        trueEvPerUnit: round(ev(trueP, bestOdds[i]), 4), // hidden — Lab calibration
        kelly: round(Math.max(0, ((bestOdds[i] - 1) * model[i] - (1 - model[i])) / (bestOdds[i] - 1)), 4),
        confidence: round(conf, 3),
        confidenceBand: confBand(conf),
        agreement: round(agreement, 4),
        modelError: round(model[i] - trueP, 4), // hidden — Lab calibration
        ratingsError: round(ratingsP[i] - trueP, 4), // hidden — how much the market knew that we didn't
      };
    });

    priced.push({
      key: m.key,
      name: m.name,
      type: m.type,
      line: m.line ?? null,
      team: m.team ?? null,
      // Double chance outcomes deliberately overlap, so the vector sums to 2.
      exclusive: m.type !== 'double_chance',
      overround: round(mean(offers.map((off) => devig(off.odds).overround)) * 100, 2),
      outcomes: outcomeRows,
      books: offers.map((off) => ({
        book: off.book.name,
        cls: off.book.cls,
        odds: off.odds,
        margin: round(devig(off.odds).overround * 100, 2),
      })),
    });
  }

  return { markets: priced, books: books.map((b) => b.name) };
}

function pickBooks(rng, tier) {
  // Thinly traded leagues attract fewer quotes, and the sharpest books skip
  // them entirely about half the time.
  const pool = BOOK_NAMES.filter((b) => (tier >= 3 && b.cls === 'sharp' ? rng.chance(0.5) : true));
  const count = tier === 1 ? rng.int(3) + 5 : tier === 2 ? rng.int(2) + 4 : rng.int(2) + 3;
  const chosen = rng.sample(pool, Math.min(count, pool.length));
  if (!chosen.some((b) => b.cls === 'sharp')) chosen.push(rng.pick(BOOK_NAMES.filter((b) => b.cls === 'sharp')));
  return chosen;
}

/**
 * How tightly the de-vigged books agree on one outcome. This is the single
 * most informative signal we have about whether the market has converged —
 * and convergence is what makes a blended estimate trustworthy.
 */
function crossBookAgreement(perBookFair, outcomeIdx) {
  const vals = perBookFair.map((f) => f[outcomeIdx]);
  const spread = stdev(vals);
  return clamp(1 - spread * 18, 0.04, 1);
}

/**
 * Confidence ∈ [0,1] — how much we trust the model's probability on this leg.
 *
 * IMPORTANT: this is deliberately NOT a function of edge size. An earlier
 * version folded edge in and it backfired: large edges occur exactly where the
 * books disagree with the model, which is where the model is most likely to be
 * the wrong one. Measured on this market that version produced a confidence
 * metric ANTI-correlated with accuracy (the 0.7+ band carried 6.6pp of model
 * error while the 0.3 band carried 2.2pp).
 *
 * Confidence is a pure data-quality signal. Edge stays a separate axis. The
 * builder filters on both: confidence to decide whether to believe the number,
 * edge to decide whether it is worth a stake.
 */
function confidence({ tier, bookCount, agreement, kickoffHours, liquidity }) {
  const tierScore = tier === 1 ? 0.95 : tier === 2 ? 0.72 : 0.44;
  const dataScore = clamp((bookCount - 2) / 5, 0.15, 1);
  // Prices posted long before kickoff are soft and limit-heavy; just-before-KO
  // prices are the sharpest the market ever gets.
  const timeScore = clamp(0.45 + ((24 - clamp(kickoffHours, 0, 24)) / 24) * 0.55, 0.4, 1);
  const raw = 0.24 * tierScore + 0.14 * dataScore + 0.12 * timeScore + 0.36 * agreement + 0.14 * liquidity;
  return clamp(raw, 0.06, 0.97);
}

function confBand(c) {
  if (c >= 0.72) return 'A';
  if (c >= 0.6) return 'B';
  if (c >= 0.48) return 'C';
  return 'D';
}

function roundOdds(o) {
  if (o < 1.2) return round(o, 3);
  return round(o, 2);
}

/* ------------------------------------------------------------------ *
 * Leg extraction — flatten the priced event tree into bettable legs
 * ------------------------------------------------------------------ */

/**
 * @param {object} event priced event (with `.markets` from priceEvent)
 * @returns {object[]} one leg per priceable outcome
 */
function extractLegs(event) {
  const legs = [];
  for (const m of event.markets) {
    for (const o of m.outcomes) {
      legs.push({
        legId: `${event.id}::${m.key}::${o.key}`,
        eventId: event.id,
        sport: event.sport,
        league: event.league.name,
        leagueCode: event.league.code,
        tier: event.league.tier,
        kickoff: event.kickoff,
        home: event.home.name,
        away: event.away.name,
        market: m.name,
        marketKey: m.key,
        marketType: m.type,
        pick: o.label,
        pickKey: o.key,
        odds: o.odds,
        book: o.bestBook,
        modelProb: o.modelProb,
        fairProb: o.fairProb,
        sharpProb: o.sharpProb,
        ratingsProb: o.ratingsProb,
        impliedProb: o.impliedProb,
        truthProb: o.truthProb,
        trueEvPerUnit: o.trueEvPerUnit,
        modelError: o.modelError,
        ratingsError: o.ratingsError,
        edge: o.edge,
        evPerUnit: o.evPerUnit,
        confidence: o.confidence,
        agreement: o.agreement,
        band: o.confidenceBand,
        correlation: event.id,
      });
    }
  }
  return legs;
}

/**
 * Correlation penalty for legs that share a league AND a kickoff window.
 *
 * An accumulator multiplies leg probabilities as though they were independent.
 * Same-league, same-slot selections are not: weather, pitch conditions,
 * referee pools and league-wide scoring swings move them together, so the
 * naive product overstates the slip's real chance. We take a haircut.
 */
function correlationFactor(legs) {
  const groups = new Map();
  for (const l of legs) {
    const k = `${l.leagueCode}|${String(l.kickoff).slice(0, 13)}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  let penalty = 1;
  for (const count of groups.values()) {
    if (count > 1) penalty *= 1 - CORR_PER_EXTRA_LEG * (count - 1);
  }
  return clamp(penalty, 1 - CORR_CAP, 1);
}

/*
 * Sizing note: the blended model's own mean absolute error on this market is
 * about 0.5pp. An earlier version of this haircut was 3.5pp per correlated leg
 * — seven times the model error — which meant the correlation term dominated
 * everything and the engine systematically under-claimed its own win chance by
 * ~3.5pp (the Lab caught it). The haircut is now sized to be a genuine but
 * secondary correction. It stays because same-league same-slot legs really do
 * move together; it just shouldn't be the loudest term in the model.
 */
const CORR_PER_EXTRA_LEG = 0.012;
const CORR_CAP = 0.06;

/* ------------------------------------------------------------------ *
 * LIVE pricing — real quotes from a bookmaker API
 * ------------------------------------------------------------------ */

/**
 * Classify a book by name, using the same three tiers the simulator uses.
 *
 * The tier is what decides how much weight a quote carries: sharp books are
 * de-vigged to a 0.19pp error against ground truth, so they get 0.62 of the
 * blend, and a misclassified Pinnacle would quietly poison the whole estimate.
 * Unknown books are treated as soft — the conservative default, since assuming
 * sharpness is the error that flatters us.
 */
function classifyBook(name) {
  const n = String(name || '').toLowerCase();
  if (/pinnacle|sbobet|circa|cris|betfair|matchbook|smarkets/.test(n)) return 'sharp';
  if (/bet365|unibet|william|betway|888|marathon/.test(n)) return 'mid';
  return 'soft';
}

/**
 * Price an event from REAL quotes rather than simulated ones.
 *
 * Shares `devig`, `SIGNAL_WEIGHTS`, `confidence`, `confBand` and
 * `crossBookAgreement` with `priceEvent`, so the blend that the Lab justified is
 * the blend the live path runs — the maths is not duplicated, only the offer
 * construction is, because that is the part that genuinely differs: here the
 * quotes are facts instead of draws from a seeded RNG.
 *
 * There is no ground truth and no honest way to invent one. `truthKnown` is
 * false and truthProb / trueEvPerUnit / modelError / ratingsError come back
 * null rather than being filled from the model — a calibration number computed
 * against your own prediction is a tautology, and reporting one would let the
 * live deployment "confirm" the very weights it is supposed to be testing.
 *
 * @param {object} event          { id, home, away, league, kickoff, markets: [{ key, name, type, outcomes }] }
 * @param {Map}    offersByMarket  market key -> [{ book: { name, cls }, odds: [...] }] aligned to outcomes
 * @param {object} opts            { tier, kickoffHours }
 */
function priceEventFromOffers(event, offersByMarket, opts = {}) {
  const tier = opts.tier ?? event.league?.tier ?? 2;
  const kickoffHours = opts.kickoffHours ?? 20;
  const priced = [];
  const bookNames = new Set();

  for (const m of event.markets || []) {
    const raw = offersByMarket.get(m.key);
    const n = m.outcomes?.length || 0;
    const mass = m.type === 'double_chance' ? 2 : 1;
    if (!raw?.length || !n) continue;

    /* A book that did not quote every outcome has to go. De-vigging two of three
     * prices divides by an over-round that excludes the missing outcome, which
     * silently inflates the ones we did get — and one NaN anywhere in the vector
     * then poisons every average built from it. Dropping the incomplete book is
     * the conservative move; there is no honest way to guess the price. */
    const offers = raw.filter((off) =>
      Array.isArray(off.odds) && off.odds.length === n && off.odds.every((o) => Number.isFinite(o) && o > 1));
    if (!offers.length) continue;
    for (const off of offers) bookNames.add(off.book.name);

    // ---- line shopping: best available price per outcome --------------
    const bestOdds = new Array(n).fill(0);
    const bestBook = new Array(n).fill(null);
    for (const off of offers) {
      for (let i = 0; i < n; i++) {
        const o = off.odds[i];
        if (Number.isFinite(o) && o > bestOdds[i]) { bestOdds[i] = o; bestBook[i] = off.book.name; }
      }
    }
    if (bestOdds.some((o) => !(o > 1))) continue; // an outcome nobody priced

    // ---- de-vig every book, then across the sharp subset --------------
    const perBookFair = offers.map((off) => devig(off.odds).fair.map((p) => p * (m.type === 'double_chance' ? 2 : 1)));
    const consensus = new Array(n).fill(0);
    for (const f of perBookFair) for (let i = 0; i < n; i++) consensus[i] += f[i];
    for (let i = 0; i < n; i++) consensus[i] /= perBookFair.length;

    const sharpIdx = offers.map((off, i) => i).filter((i) => offers[i].book.cls === 'sharp');
    const sharp = new Array(n).fill(0);
    if (sharpIdx.length) {
      for (const i of sharpIdx) for (let k = 0; k < n; k++) sharp[k] += perBookFair[i][k];
      for (let k = 0; k < n; k++) sharp[k] /= sharpIdx.length;
    } else {
      // No sharp book quoted this market. Fall back to consensus rather than
      // letting a null propagate into the blend.
      for (let k = 0; k < n; k++) sharp[k] = consensus[k];
    }

    // ---- the same blend, with the ratings prior as the only local view --
    const w = SIGNAL_WEIGHTS;
    const ratingsP = m.outcomes.map((o) => o.p);
    const model = new Array(n).fill(0);
    for (let i = 0; i < n; i++) model[i] = w.consensus * consensus[i] + w.sharp * sharp[i] + w.ratings * ratingsP[i];
    const mSum = model.reduce((a, c) => a + c, 0) || 1;
    for (let i = 0; i < n; i++) model[i] = model[i] / mSum * mass;

    const implied = bestOdds.map((o) => 1 / o);
    const outcomeRows = m.outcomes.map((o, i) => {
      const agreement = crossBookAgreement(perBookFair, i);
      const conf = confidence({
        tier,
        bookCount: offers.length,
        agreement,
        kickoffHours,
        liquidity: tier === 1 ? 1 : tier === 2 ? 0.78 : 0.55,
      });
      return {
        key: o.key,
        label: o.label,
        odds: bestOdds[i],
        bestBook: bestBook[i],
        avgOdds: round(mean(offers.map((off) => off.odds[i])), 3),
        impliedProb: round(implied[i], 4),
        fairProb: round(consensus[i], 4),
        sharpProb: round(sharp[i], 4),
        ratingsProb: round(ratingsP[i], 4),
        modelProb: round(model[i], 4),
        truthProb: null,
        edge: round(model[i] - implied[i], 4),
        edgePct: round((model[i] - implied[i]) * 100, 2),
        evPerUnit: round(ev(model[i], bestOdds[i]), 4),
        trueEvPerUnit: null,
        kelly: round(Math.max(0, ((bestOdds[i] - 1) * model[i] - (1 - model[i])) / (bestOdds[i] - 1)), 4),
        confidence: round(conf, 3),
        confidenceBand: confBand(conf),
        agreement: round(agreement, 4),
        modelError: null,
        ratingsError: null,
      };
    });

    priced.push({
      key: m.key,
      name: m.name,
      type: m.type,
      line: m.line ?? null,
      team: m.team ?? null,
      exclusive: m.type !== 'double_chance',
      overround: round(mean(offers.map((off) => devig(off.odds).overround)) * 100, 2),
      outcomes: outcomeRows,
      books: offers.map((off) => ({
        book: off.book.name,
        cls: off.book.cls,
        odds: off.odds,
        margin: round(devig(off.odds).overround * 100, 2),
      })),
    });
  }

  return { markets: priced, books: [...bookNames].sort(), truthKnown: false };
}
__exp_23 = correlationFactor;
__exp_24 = confBand;
__exp_25 = priceEvent;
__exp_26 = priceEventFromOffers;
__exp_27 = extractLegs;
__exp_28 = classifyBook;
__exp_29 = SIGNAL_WEIGHTS;
__exp_30 = confidence;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/builder.js   →  hoists buildLongshotTicket, DEFAULT_BUILDER_OPTS, validateTicketOdds, DEFAULT_STAKE_BANDS, MIN_TICKET_ODDS, MAX_TICKET_ODDS, evaluateTicketConfidence
   ════════════════════════════════════════════════════════════════════════ */
let __exp_31;
let __exp_32;
let __exp_33;
let __exp_34;
let __exp_35;
let __exp_36;
let __exp_37;
{
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;
const correlationFactor = __exp_23;
const confBand = __exp_24;

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



const MIN_TICKET_ODDS = 20.0;
const MAX_TICKET_ODDS = 1000.0;

const DEFAULT_STAKE_BANDS = {
  A: 500,
  B: 350,
  C: 200,
  D: 100,
};

const DEFAULT_BUILDER_OPTS = {
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
function validateTicketOdds(odds) {
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
function evaluateTicketConfidence(legs, customStakeBands = null) {
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
function buildLongshotTicket(legs, opts = {}) {
  const floor = Math.max(0, Number(opts.minEdgePerLeg ?? DEFAULT_BUILDER_OPTS.minEdgePerLeg));
  let result;
  for (const [threshold, label] of [[floor, 'strict'], [Math.min(floor, 0.004), 'relaxed'], [0, 'positive-edge only']]) {
    result = searchTicket(legs, { ...opts, minEdgePerLeg: threshold });
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

  if (!pool.length) {
    return {
      ok: false,
      reason: 'NO_TICKET',
      message: 'No eligible legs available in today’s market that cleared the confidence and odds constraints. Refusing is a feature.',
      report,
      alternatives: [],
    };
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
  frontier.set('0|-0', { legs: [], logOdds: 0, logP: 0, edgeSum: 0, events: [] });

  for (let depth = 1; depth <= o.maxLegs; depth++) {
    const states = [...frontier.values()];
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
          const cur = buckets.get(key);
          if (!cur || nlp + Math.log(correlationFactor(legsArr)) > cur.logP + Math.log(correlationFactor(cur.legs))) {
            buckets.set(key, { legs: legsArr, logOdds: nlo, logP: nlp, edgeSum: nEdge, events });
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
      reason: 'NO_TICKET',
      message: `No combination reached combined odds between ${minOdds.toFixed(1)} and ${maxOdds.toFixed(1)} with the available market pool. Refusing is a feature.`,
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
__exp_31 = buildLongshotTicket;
__exp_32 = DEFAULT_BUILDER_OPTS;
__exp_33 = validateTicketOdds;
__exp_34 = DEFAULT_STAKE_BANDS;
__exp_35 = MIN_TICKET_ODDS;
__exp_36 = MAX_TICKET_ODDS;
__exp_37 = evaluateTicketConfidence;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/scan.js   →  hoists scanDay, scanForDay, scanDayLive, PROVIDERS, SPORT_MAP, fetchOddsApi
   ════════════════════════════════════════════════════════════════════════ */
let __exp_38;
let __exp_39;
let __exp_40;
let __exp_41;
let __exp_42;
let __exp_43;
{
const buildDayEvents = __exp_15;
const tzDateKey = __exp_16;
const formatKickoff = __exp_17;
const priceEvent = __exp_25;
const priceEventFromOffers = __exp_26;
const extractLegs = __exp_27;
const classifyBook = __exp_28;
const applyMarketInformation = __exp_22;
const buildLongshotTicket = __exp_31;
const DEFAULT_BUILDER_OPTS = __exp_32;
const clamp = __exp_6;
const round = __exp_7;
const mean = __exp_10;

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






const PROVIDERS = {
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

const SPORT_MAP = [
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
 * so it falls back to simulation and loudly stamps the diagnostics.
 */
function scanDay(dayKey, opts = {}) {
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
    if (!opts.apiKey) {
      return stamp(
        scanSim(dayKey, opts),
        requested,
        'sim',
        'Live odds requested but no API key was supplied. Set ODDS_API_KEY or paste a key in Settings. These prices are simulated.'
      );
    }
    return stamp(
      scanSim(dayKey, opts),
      requested,
      'sim',
      'Synchronous scan route cannot await live network fetch — use /api/scan/live. These prices are simulated.'
    );
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
function scanSim(dayKey, opts = {}) {
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
async function scanDayLive(dayKey, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) {
    const e = new Error('No Odds API key provided. Set ODDS_API_KEY in the environment or paste one in Settings.');
    e.code = 'NO_KEY';
    throw e;
  }

  const fetched = await fetchOddsApi(opts.sports, apiKey, {
    daysAhead: opts.daysAhead ?? 3,
    signal: opts.signal,
  });

  const games = fetched.games;
  if (!games.length) {
    const e = new Error('The Odds API returned 0 games. Check your key, remaining quota, or date window.');
    e.code = 'NO_GAMES';
    throw e;
  }

  const scan = stamp(scanLiveGames(dayKey, games, opts), 'oddsapi', 'oddsapi', null);
  scan.diagnostics.quota = fetched.quota;
  scan.diagnostics.leagues = fetched.leagues;
  scan.diagnostics.leaguesQueried = fetched.leagues.length;
  scan.diagnostics.leaguesWithFixtures = fetched.leagues.filter((l) => l.ok && l.fixtures > 0).length;

  const builderOpts = { ...DEFAULT_BUILDER_OPTS, ...(opts.builder || {}) };
  const builderResult = buildLongshotTicket(scan.legs, builderOpts);

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
async function fetchOddsApi(sports, apiKey, { daysAhead = 3, signal = null } = {}) {
  const games = [];
  const quota = { remaining: null, used: null };
  const leagues = [];
  const until = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Odds API fetch timed out after 15 seconds (504 Gateway Timeout).'));
  }, 15000);

  // Combine parent signal if provided
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  try {
    for (const s of SPORT_MAP) {
      if (sports && sports.length && !sports.includes(s.key)) continue;

      const url =
        `https://api.the-odds-api.com/v4/sports/${s.key}/odds/?apiKey=${encodeURIComponent(apiKey)}` +
        `&regions=eu,uk,us&markets=h2h,totals,spreads&dateFormat=iso&oddsFormat=decimal&endDate=${until}`;

      try {
        const res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        if (quota.remaining === null) {
          const remHeader = res.headers?.get?.('x-requests-remaining');
          const usedHeader = res.headers?.get?.('x-requests-used');
          quota.remaining = remHeader !== null && remHeader !== undefined ? Number(remHeader) : null;
          quota.used = usedHeader !== null && usedHeader !== undefined ? Number(usedHeader) : null;
        }

        if (!res.ok) {
          leagues.push({ key: s.key, league: s.league, sport: s.sport, ok: false, status: res.status });
          continue;
        }

        const json = await res.json();
        const fixturesCount = Array.isArray(json) ? json.length : 0;
        leagues.push({ key: s.key, league: s.league, sport: s.sport, ok: true, fixtures: fixturesCount });

        if (Array.isArray(json)) {
          for (const g of json) games.push(normaliseOddsApiGame(g, s));
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        leagues.push({ key: s.key, league: s.league, sport: s.sport, ok: false, status: err?.message || 'network' });
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return { games, quota, leagues };
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
      code: meta.key.toUpperCase().slice(0, 10),
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
      for (const m of b.markets || []) {
        let gkey = null;
        let type = null;
        let name = null;
        let point = null;
        if (m.key === 'h2h') {
          gkey = 'h2h';
          type = 'h2h';
          name = 'Match Result';
        } else if (m.key === 'totals' && Number.isFinite(m.point)) {
          gkey = `totals_${m.point}`;
          type = 'totals';
          name = `Total ${m.point} — Over/Under`;
          point = m.point;
        } else if (m.key === 'spreads' && Number.isFinite(m.point)) {
          gkey = `spreads_${Math.abs(m.point)}`;
          type = 'spreads';
          name = `Handicap ±${Math.abs(m.point)}`;
          point = m.point;
        } else continue;

        if (!groups.has(gkey)) groups.set(gkey, { key: gkey, type, name, point, entries: [] });
        groups.get(gkey).entries.push({ book: b, m });
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
      if (names.length < 2) continue;

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
      marketsMeta.push({ key: gkey, name: grp.name, type: grp.type, point: grp.point, outcomes: prior });
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
      scope: 'h2h + totals + spreads from cross-book agreement',
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
function scanManual(dayKey, opts = {}) {
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

function scanForDay(dayKey, runConfig = {}, overrides = {}) {
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
  const result = buildLongshotTicket(scan.legs, builderOpts);
  return {
    scan,
    builder: result,
    builderOpts,
    legs: scan.legs,
    events: scan.events,
    diagnostics: scan.diagnostics,
  };
}
__exp_38 = scanDay;
__exp_39 = scanForDay;
__exp_40 = scanDayLive;
__exp_41 = PROVIDERS;
__exp_42 = SPORT_MAP;
__exp_43 = fetchOddsApi;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/longshot.js   →  hoists createWeek, settleTicket, rescanDayTicket, computeWeekStats, assessGoal, getWeeklyVerdict, formatNaira, WEEK_STATUS, TICKET_STATUS
   ════════════════════════════════════════════════════════════════════════ */
let __exp_44;
let __exp_45;
let __exp_46;
let __exp_47;
let __exp_48;
let __exp_49;
let __exp_50;
let __exp_51;
let __exp_52;
{
const getLagosWeek = __exp_18;
const tzDateKey = __exp_16;
const scanDay = __exp_38;
const scanForDay = __exp_39;
const scanDayLive = __exp_40;
const buildLongshotTicket = __exp_31;
const validateTicketOdds = __exp_33;
const DEFAULT_BUILDER_OPTS = __exp_32;
const DEFAULT_STAKE_BANDS = __exp_34;
const round = __exp_7;
const clamp = __exp_6;

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





const WEEK_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
};

const TICKET_STATUS = {
  PENDING: 'pending',
  WON: 'won',
  LOST: 'lost',
  UNISSUED: 'unissued',
};

/**
 * Format currency in Nigerian Naira (₦).
 */
function formatNaira(amount) {
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
function assessGoal({ goal = 2, expectedWins = 0, issuedCount = 7 }) {
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
function getWeeklyVerdict(wonCount) {
  const w = Number(wonCount) || 0;
  if (w >= 2) {
    return `${w} of 7 landed — the longshot board paid`;
  }
  return `${w} of 7 — we go again`;
}

/**
 * Compute portfolio statistics for a week.
 */
function computeWeekStats(week) {
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
function createWeek({ weekDate = null, goal = 2, settings = {}, liveBoards = {} } = {}) {
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
function buildDayTicket(day, settings = {}, prepared = null) {
  const tz = settings.tz || 'Africa/Lagos';
  const builderOpts = {
    ...DEFAULT_BUILDER_OPTS,
    ...(settings.builder || {}),
    stakeBands: settings.stakeBands || DEFAULT_STAKE_BANDS,
    minEdgePerLeg: Number(settings.minEdgePerLeg ?? 0.012),
  };

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
    settledAt: null,
    payout: 0,
    profit: 0,
  };
}

/**
 * Manually settle a ticket as 'won' or 'lost'.
 * Ground truth for live fixtures does not exist on-device; user settles manually.
 */
function settleTicket(week, dayIndex, outcome) {
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
function rescanDayTicket(week, dayIndex, settings = {}, prepared = null) {
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
__exp_44 = createWeek;
__exp_45 = settleTicket;
__exp_46 = rescanDayTicket;
__exp_47 = computeWeekStats;
__exp_48 = assessGoal;
__exp_49 = getWeeklyVerdict;
__exp_50 = formatNaira;
__exp_51 = WEEK_STATUS;
__exp_52 = TICKET_STATUS;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/http-core.js   →  hoists createApi, ENGINE_INFO, jsonSafe, toPlain
   ════════════════════════════════════════════════════════════════════════ */
let __exp_53;
let __exp_54;
let __exp_55;
let __exp_56;
{
const createWeek = __exp_44;
const settleTicket = __exp_45;
const rescanDayTicket = __exp_46;
const computeWeekStats = __exp_47;
const assessGoal = __exp_48;
const getWeeklyVerdict = __exp_49;
const formatNaira = __exp_50;
const WEEK_STATUS = __exp_51;
const TICKET_STATUS = __exp_52;
const scanDay = __exp_38;
const scanForDay = __exp_39;
const scanDayLive = __exp_40;
const PROVIDERS = __exp_41;
const SPORT_MAP = __exp_42;
const SIGNAL_WEIGHTS = __exp_29;
const tzNowParts = __exp_19;
const tzDateKey = __exp_16;
const getLagosWeek = __exp_18;
const upcomingWeeks = __exp_20;
const DEFAULT_BUILDER_OPTS = __exp_32;
const DEFAULT_STAKE_BANDS = __exp_34;
const MIN_TICKET_ODDS = __exp_35;
const MAX_TICKET_ODDS = __exp_36;

/**
 * http-core.js — the LONGSHOT HTTP core with zero runtime dependencies.
 *
 * Runs identically in three environments:
 *   - server/index.js: node:http + store.js (data/store.json)
 *   - api/index.js: Vercel serverless + memory-store.js (reporting persistent: false)
 *   - public/local-api.js: Browser tab + localStorage store
 */






const ENGINE_INFO = {
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

function jsonSafe(key, value) {
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value, jsonSafe));
}

/**
 * Await live scan whenever an API key exists (prepared-board pattern).
 */
async function livePreparedForWeek(env, body, settings, weekDays, liveBoards = null) {
  if (liveBoards && Object.keys(liveBoards).length) return liveBoards;
  if (settings.provider !== 'oddsapi') return {};
  if (globalThis.window !== undefined) return {}; // in browser, dashboard fetches via same-origin

  const key = body?.apiKey || settings.oddsApi?.key || env?.ODDS_API_KEY || '';
  if (!key) return {};

  const boards = {};
  const sports = settings.oddsApi?.sports || [];
  const daysToFetch = weekDays || [];

  for (const day of daysToFetch) {
    try {
      const live = await scanDayLive(day.date, {
        tz: settings.tz,
        apiKey: key,
        sports,
        builder: {
          ...(settings.builder || {}),
          stakeBands: settings.stakeBands || DEFAULT_STAKE_BANDS,
          minEdgePerLeg: Number(settings.minEdgePerLeg ?? 0.012),
        },
      });
      boards[day.date] = { scan: live.scan, builder: live.builder };
    } catch {
      // Fallback allowed per-day
    }
  }

  return boards;
}

function createApi({ store, env = {}, persistent = true } = {}) {
  const startedAt = Date.now();

  async function statePayload() {
    const settings = await store.getSettings();
    const activeWeek = await store.getActiveWeek();
    const weeks = await store.listWeeks(20);
    const now = new Date();
    const tz = settings.tz || 'Africa/Lagos';

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
      const apiKey = q.get('apiKey') || settings.oddsApi?.key || env.ODDS_API_KEY || '';

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
          topLegs: [...scanResult.legs].sort((a, b) => b.edge - a.edge).slice(0, 50),
        },
      };
    }

    if (method === 'GET' && p === '/api/scan/live') {
      const settings = await store.getSettings();
      const tz = settings.tz || 'Africa/Lagos';
      const date = q.get('date') || tzDateKey(new Date(), tz);
      const apiKey = q.get('apiKey') || settings.oddsApi?.key || env.ODDS_API_KEY || '';

      if (!apiKey) {
        return {
          status: 400,
          body: {
            error: 'No Odds API key provided. Set ODDS_API_KEY in environment or paste one in Settings.',
            code: 'NO_KEY',
          },
        };
      }

      try {
        const live = await scanDayLive(date, {
          tz,
          apiKey,
          sports: settings.oddsApi?.sports || [],
          builder: {
          ...(settings.builder || {}),
            stakeBands: settings.stakeBands || DEFAULT_STAKE_BANDS,
            minEdgePerLeg: Number(settings.minEdgePerLeg ?? 0.012),
          },
        });

        return {
          status: 200,
          body: {
            date,
            provider: {
              requested: 'oddsapi',
              used: 'oddsapi',
              fellBack: false,
              reason: null,
            },
            diagnostics: live.diagnostics,
            quota: live.quota,
            leagues: live.leagues,
            builder: live.builder,
            events: live.events,
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
          oddsApi: { ...(settings.oddsApi || {}), key: body.apiKey },
          provider: 'oddsapi',
        });
      }

      const mergedSettings = await store.getSettings();
      const lagosWeek = getLagosWeek(weekDate, tz);

      // Prepared board pattern: await live scan if key exists
      const liveBoards = await livePreparedForWeek(
        env,
        body,
        mergedSettings,
        lagosWeek.days,
        body.liveBoards
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
        if (!prepared && settings.provider === 'oddsapi') {
          const key = body.apiKey || settings.oddsApi?.key || env.ODDS_API_KEY || '';
          if (key) {
            try {
              const live = await scanDayLive(ticket.date, {
                tz,
                apiKey: key,
                sports: settings.oddsApi?.sports || [],
                builder: { ...(settings.builder || {}), stakeBands: settings.stakeBands, minEdgePerLeg: settings.minEdgePerLeg },
              });
              prepared = { scan: live.scan, builder: live.builder };
            } catch {}
          }
        }

        rescanDayTicket(week, dayIndex, settings, prepared);
      } else {
        // Rescan entire week
        const lagosWeek = getLagosWeek(week.mondayDate, tz);
        const liveBoards = await livePreparedForWeek(env, body, settings, lagosWeek.days, body.liveBoards);
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
__exp_53 = createApi;
__exp_54 = ENGINE_INFO;
__exp_55 = jsonSafe;
__exp_56 = toPlain;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/store-shared.js   →  hoists DEFAULT_SETTINGS, summariseWeek, reviveWeek
   ════════════════════════════════════════════════════════════════════════ */
let __exp_57;
let __exp_58;
let __exp_59;
{
/**
 * store-shared.js — shared persistence definitions across server, memory, and browser stores.
 *
 * Zero imports: must be easily bundleable for the browser.
 */

const DEFAULT_SETTINGS = {
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
  manualOdds: [],
};

function summariseWeek(w) {
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

function reviveWeek(week) {
  if (!week) return week;
  return week;
}
__exp_57 = DEFAULT_SETTINGS;
__exp_58 = summariseWeek;
__exp_59 = reviveWeek;
}

/* ════════════════════════════════════════════════════════════════════════
   lib/memory-store.js   →  hoists createLocalStorageStore, createStoreAdapter, createMemoryStore
   ════════════════════════════════════════════════════════════════════════ */
let __exp_60;
let __exp_61;
let __exp_62;
{
const DEFAULT_SETTINGS = __exp_57;
const summariseWeek = __exp_58;
const reviveWeek = __exp_59;

/**
 * memory-store.js — storage adapter for in-memory (Vercel serverless) and localStorage (browser).
 */


const EMPTY = () => ({ weeks: {}, order: [], settings: {} });

function createStoreAdapter(backend, { oddsApiKey = '', weekCap = 50, onQuotaExceeded = null } = {}) {
  function load() {
    let db = null;
    try {
      db = backend.read();
    } catch {
      db = null;
    }
    if (!db || typeof db !== 'object') db = EMPTY();
    db.weeks = db.weeks || {};
    db.order = db.order || [];
    db.settings = db.settings || {};
    return db;
  }

  function persist(db) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        backend.write(db);
        return true;
      } catch (err) {
        // Evict oldest completed week if quota exceeded
        const victim = db.order
          .map((id) => db.weeks[id])
          .filter(Boolean)
          .filter((w) => w.status !== 'active')
          .pop();

        if (!victim) {
          if (onQuotaExceeded) onQuotaExceeded({ evicted: 0, error: err.message, fatal: true });
          return false;
        }
        delete db.weeks[victim.id];
        db.order = db.order.filter((x) => x !== victim.id);
        if (onQuotaExceeded) onQuotaExceeded({ evictedWeek: victim.id, error: err.message });
      }
    }
    return false;
  }

  return {
    async saveWeek(week) {
      const db = load();
      db.weeks[week.id] = reviveWeek(JSON.parse(JSON.stringify(week)));
      if (!db.order.includes(week.id)) db.order.unshift(week.id);
      db.order = db.order.slice(0, weekCap);
      persist(db);
      return week;
    },

    async getWeek(id) {
      const db = load();
      const week = db.weeks[id];
      return week ? reviveWeek(week) : null;
    },

    async getActiveWeek() {
      const db = load();
      for (const id of db.order) {
        const w = db.weeks[id];
        if (w && w.status === 'active') return reviveWeek(w);
      }
      return null;
    },

    async listWeeks(limit = 20) {
      const db = load();
      return db.order
        .slice(0, limit)
        .map((id) => db.weeks[id])
        .filter(Boolean)
        .map((w) => summariseWeek(w));
    },

    async deleteWeek(id) {
      const db = load();
      delete db.weeks[id];
      db.order = db.order.filter((x) => x !== id);
      persist(db);
      return true;
    },

    revive: reviveWeek,

    async getSettings() {
      const db = load();
      return {
        ...DEFAULT_SETTINGS,
        oddsApi: {
          key: oddsApiKey || db.settings?.oddsApi?.key || '',
          sports: db.settings?.oddsApi?.sports || [],
        },
        ...db.settings,
      };
    },

    async saveSettings(patch) {
      const db = load();
      db.settings = { ...(db.settings || {}), ...patch };
      persist(db);
      return this.getSettings();
    },
  };
}

function createMemoryStore(opts = {}) {
  let db = EMPTY();
  return createStoreAdapter(
    {
      read: () => db,
      write: (next) => {
        db = next;
      },
    },
    opts
  );
}

function createLocalStorageStore(key = 'longshot.store.v1', opts = {}) {
  let memoryFallback = null;
  const evictions = [];

  const available = (() => {
    try {
      if (typeof localStorage === 'undefined') return false;
      const probe = '__ls_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })();

  const backend = available
    ? {
        read: () => {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : EMPTY();
        },
        write: (db) => localStorage.setItem(key, JSON.stringify(db)),
      }
    : {
        read: () => memoryFallback || EMPTY(),
        write: (db) => {
          memoryFallback = db;
        },
      };

  const store = createStoreAdapter(backend, {
    weekCap: 25,
    onQuotaExceeded: (info) => {
      evictions.push(info);
    },
    ...opts,
  });

  store.backend = available ? 'localStorage' : 'memory';
  store.storageKey = key;
  store.evictions = evictions;
  return store;
}
__exp_60 = createLocalStorageStore;
__exp_61 = createStoreAdapter;
__exp_62 = createMemoryStore;
}

/* ════════════════════════════════════════════════════════════════════════
   facade — 49 public bindings
   ════════════════════════════════════════════════════════════════════════ */
export { __exp_7 as round, __exp_6 as clamp, __exp_10 as mean, __exp_11 as stdev, __exp_12 as ev, __exp_9 as devig, __exp_18 as getLagosWeek, __exp_20 as upcomingWeeks, __exp_16 as tzDateKey, __exp_19 as tzNowParts, __exp_17 as formatKickoff, __exp_28 as classifyBook, __exp_27 as extractLegs, __exp_23 as correlationFactor, __exp_30 as confidence, __exp_24 as confBand, __exp_29 as SIGNAL_WEIGHTS, __exp_31 as buildLongshotTicket, __exp_33 as validateTicketOdds, __exp_37 as evaluateTicketConfidence, __exp_32 as DEFAULT_BUILDER_OPTS, __exp_34 as DEFAULT_STAKE_BANDS, __exp_35 as MIN_TICKET_ODDS, __exp_36 as MAX_TICKET_ODDS, __exp_38 as scanDay, __exp_39 as scanForDay, __exp_40 as scanDayLive, __exp_43 as fetchOddsApi, __exp_41 as PROVIDERS, __exp_42 as SPORT_MAP, __exp_44 as createWeek, __exp_45 as settleTicket, __exp_46 as rescanDayTicket, __exp_47 as computeWeekStats, __exp_48 as assessGoal, __exp_49 as getWeeklyVerdict, __exp_50 as formatNaira, __exp_51 as WEEK_STATUS, __exp_52 as TICKET_STATUS, __exp_53 as createApi, __exp_54 as ENGINE_INFO, __exp_55 as jsonSafe, __exp_56 as toPlain, __exp_57 as DEFAULT_SETTINGS, __exp_58 as summariseWeek, __exp_59 as reviveWeek, __exp_60 as createLocalStorageStore, __exp_61 as createStoreAdapter, __exp_62 as createMemoryStore };
