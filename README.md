# LONGSHOT 🎯

**LONGSHOT** is a weekly longshot-accumulator portfolio engine built with **zero npm dependencies**, plain ESM, and a static trading-desk dashboard deployed to Vercel.

---

## ⚡ Mission & Core Constraints

Every week (**Monday–Sunday, timezone Africa/Lagos**), the engine issues **7 tickets, one per day**. Each ticket is an accumulator (multi-leg combination) assembled from value legs identified across global markets.

1. **Combined Odds Band:** Ticket combined odds strictly land in **`10.0 – 1000.0`**. Any ticket outside this band is rejected.
2. **Stake Sizing:** Stakes range from **`₦100 – ₦500`**, scaled dynamically by ticket data confidence:
   - **Band A (≥0.72):** `₦500` (highest data depth, tight cross-book agreement)
   - **Band B (≥0.60):** `₦350` (strong cross-book quotes, high liquidity)
   - **Band C (≥0.48):** `₦200` (moderate book depth)
   - **Band D (<0.48):** `₦100` (conservative stake for thinner liquidity)
3. **User Goal (2–3 wins / week):**
   - The engine optimises **expected wins** under an edge filter ($\sum \text{ticket win probs}$).
   - **Honest Modelled Reality:** The engine treats your goal as an optimisation target, **never as a promise**.
   - If modelled expected wins at odds $\ge 10.0$ is structurally below the goal (typically ~0.6–0.9 wins across 7 longshot tickets), the engine explains this plainly and shows which shorter odds band (e.g. `3.5 – 4.5` for 2 wins, `2.0 – 2.6` for 3 wins) would reach it mathematically.
4. **Refusal is a Feature:** A day with nothing above the edge floor issues **no ticket**; the week board honestly reports `"6 of 7 issued"`.
5. **Manual Settlement:** Live fixtures have no on-device ground truth. Punters settle tickets manually with **Won** / **Lost** buttons.
   - $\ge 2$ wins: `"X of 7 landed — the longshot board paid"`
   - else: `"X of 7 — we go again"`

---

## 📊 Live Data & Fallback Contract

- **Provider:** The Odds API v4 (`api.the-odds-api.com`), querying `markets=h2h,totals,spreads`, `oddsFormat=decimal`, `regions=eu,uk,us`.
- **API Key In-Browser:** Key is pasted in Settings → saved to `localStorage` and sent to same-origin scan routes. Server environment variable `ODDS_API_KEY` is also honoured.
- **Quota Tracking:** Response headers `x-requests-remaining` and `x-requests-used` are captured and rendered in real time.
- **Board Trim:** Multi-sport board of 23 global competitions (Football, NBA, Euroleague, WNBA, ATP, WTA, MLB, NHL, MMA, Cricket, AFL, NRL). Uncheck competitions in Settings to conserve quota. Unknown or off-season leagues become per-league status chips, never fatal errors.
- **Fallback Honesty Contract:** If a live fetch fails or no key exists, a loud gold `SIMULATED` warning banner is displayed with the exact reason. Simulated prices are never presented as real quotes anywhere. Live legs carry `truthProb: null`. Every ticket carries `provider: { requested, used, fellBack, reason }`.

---

## 🧮 Pricing Mathematics

- **Multiplicative De-vig:** Strips bookmaker margin so fair probabilities sum to 1.
- **Bookmaker Classification:**
  - `sharp`: Pinnacle, SBOBET, Circa, CRIS, Betfair, Matchbook, Smarkets.
  - `mid`: Bet365, Unibet, William Hill, Betway, 888, Marathon.
  - `soft`: Bet9ja, SportyBet, NairaBet, 1XBET, and unknown books.
- **Model Probability Blend:**
  $$\text{Model Prob} = 0.30 \times \text{consensus} + 0.62 \times \text{sharp} + 0.08 \times \text{prior}$$
- **Priors:**
  - `h2h`: Home-advantage boost.
  - `totals` & `spreads`: Flat prior (no invented scoring models; priced purely from cross-book agreement).
- **Edge:**
  $$\text{Edge} = \text{Model Prob} - \frac{1}{\text{Best Available Odds Across Books}}$$
- **Confidence:** Bounded data-quality score based on bookmaker count, cross-book agreement, and kickoff window (never a disguised win probability).

---

## 🏗 Architecture

- **Zero npm dependencies:** Built purely on Node 20+ standard library (`node:http`, `node:fs`, `node:test`).
- **Unified HTTP Core (`lib/http-core.js`):** Runs identically in:
  1. `server/index.js`: Node.js dev/production server backed by `data/store.json`.
  2. `api/index.js`: Vercel serverless function speaking classic `(req, res)` with `export const maxDuration = 60` and in-memory store.
  3. `public/local-api.js`: Client-side in-browser engine using bundled `public/vendor/engine.bundle.mjs` and `localStorage` persistence.
- **Prepared-Board Pattern:** Week and ticket creation awaits live scans whenever an API key is available.

---

## 🚀 Quick Start & CLI

### CLI Usage

```bash
# Print the 7-day weekly portfolio plan
node bin/longshot.mjs week --stake-max 500 --goal 3

# View active week status & P&L
node bin/longshot.mjs status

# Settle a ticket manually (day 0-6: Monday..Sunday)
node bin/longshot.mjs settle 0 won

# Scan a specific date
node bin/longshot.mjs scan --date 2026-10-15
```

### Local Development Server

```bash
# Run server on port 3000
npm start

# Or with dev watch mode
npm run dev
```

Visit `http://localhost:3000` in your browser.

### Test Suite

```bash
# Run 100% pure node:test test suite
npm test
```

### Bundling for Vercel Static Publish

```bash
# Bundle engine for browser and assemble dist/
npm run build
```

---

## 📦 Delivery Archive

Tarball package can be served via:
```bash
node download-server.cjs
```
Listening on `0.0.0.0:8080`.

### Master accumulator constraints (v2)

The builder now stacks distinct events, rather than selecting long-priced underdogs.
Engine defaults: 8–20 legs (maximum 25), individual odds 1.10–1.45, model
probability at least 65%, combined odds 20–1000. Dashboard defaults to a
10-leg minimum. The configurable price ceiling is capped at 1.50; unsafe
caller overrides cannot admit underdogs. Each leg must clear the selected edge
tier (+1.2pp, then +0.4pp, then strictly positive); odds and probability limits
are never relaxed. The bucketed beam search approximates the maximum
correlation-adjusted win probability; it is not an exhaustive optimizer.

Football simulation includes double chance, totals 1.5/3.5/4.5 and team totals
0.5, alongside existing markets. Overlapping double-chance probabilities are
de-vigged with total mass 2, not 1. Live scans only use actual quoted markets:
the current bulk Odds API integration requests h2h/totals/spreads and does not
invent double-chance or alternate-total prices when those are unavailable.
Additional live markets require provider-specific event-market fetching.

A weekly board has seven daily slots, **not seven guaranteed issued slips**.
If the available pool cannot form a qualifying accumulator, that day remains
unissued. In particular, the default 38-event simulation may issue few tickets.
Simulated prices are demonstrations, not live betting recommendations.
High individual win probabilities are not guarantees: even 15 independent 80%
legs win together only about 3.5% of the time, before correlation adjustments.
The dashboard reports average leg probability separately from data-quality
confidence/stake bands, and portfolio expected wins as the sum of slip win
probabilities, never a promise of 2–3 wins.
