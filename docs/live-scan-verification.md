# Live scanner repair verification

## Behaviour

- Live scans use the selected Africa/Lagos day, with ISO `commenceTimeFrom` and `commenceTimeTo` boundaries. Past days return `PAST_DATE`; current endpoints cannot reconstruct historical quotes.
- Bulk odds identify fixtures before event-specific odds requests. Only selected-day fixtures are enriched. ATP/WTA selections expand to active tournament keys; Champions League remains explicitly supported.
- Additional markets include quoted double chance, alternate totals, team totals, alternate team totals and alternate spreads. Outcome-level points are grouped by exact signed home handicap or by team and total line. Incomplete market books are excluded, not filled with guessed prices.
- Live probabilities use de-vigged consensus and sharp-book prices, not an invented flat/home-boost ratings prior. They are model estimates, not verified win rates. Double-chance prices are never synthesized from moneyline prices.
- Requests have individual timeouts, 60-second response caching and in-flight deduplication. Event enrichment defaults to three workers and at most 40 event requests per selected day, with a remaining-credit reserve. Charges depend on markets and regions, not just HTTP request count. Limits can leave partial coverage; diagnostics disclose skipped enrichment and individual failures.
- Provider failures do not create simulated tickets. Authentication, quota, timeout, empty-date, unavailable-market and builder refusals remain distinct. Reports are stored with unissued tickets.
- Builder retains eight candidates per odds/depth bucket and checks distinct-event and cumulative-odds bounds first. This is bounded search, not a proof of optimality: `SEARCH_EXHAUSTED` differs from mathematically unreachable bounds.
- Existing conservative 1.50 hard individual-price ceiling is retained (stricter than 1.55), with default 1.45, probability floor 65%, positive per-leg edge, 8–25 configurable legs, default engine 8–20, dashboard minimum 10, and correlation adjustments.
- Dashboard labels the selected date separately from today's Lagos date, resets all slip analytics, renders every issued selection, and exposes the complete scan/builder report.

## Verification performed

- `npm test`: 43 tests passing, including realistic mocked bulk and event-specific payloads, Lagos boundaries, market-line grouping, quote provenance, auth/quota failures, timeout isolation, cache/deduplication/concurrency/request caps, empty/past dates, active tennis discovery, builder feasibility, saved live tickets/refusals, shared server/local routes, and generated browser-bundle `localFetch`.
- `npm run build`: successful browser bundle execution check and static distribution assembly.
- `node bin/longshot.mjs week --stake-max 500 --goal 3`: exits successfully; default simulated portfolio issues 0/7, with specific refusal diagnostics and no stake at risk. Simulation fixture counts were not increased for this repair.
- Mock boundary case: 3 raw fixtures, 2 on the selected Lagos date, 2 priced events; the next-day fixture is never enriched.
- Mock value-pool case: 15 quoted fixtures produce an issued ticket, with all selected legs retaining actual bookmaker prices and probability-source metadata.

## Limits

No real provider scan was performed: this workspace's outbound network allowlist excludes `api.the-odds-api.com`. Live behaviour was verified with mocks, not an actual provider account, subscription, current fixture board or quota. Dashboard regression checks are source-level assertions, not a full automated browser visual test. Real market availability, subscription entitlement and current odds depth must be checked with the deployed provider account. Missing or negative-edge pools still correctly result in no ticket.
