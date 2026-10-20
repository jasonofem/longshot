# SportsGameOdds provider

## Setup

1. In Settings select **SportsGameOdds v2** under Live provider.
2. Paste your SportsGameOdds key and click **Save Key**. It is stored separately from the exhausted The Odds API key.
3. Optional: enter comma-separated native SportsGameOdds league IDs. Leave empty to request account-covered events; The Odds API trim keys are not sent to SportsGameOdds.
4. Open Market & Quota, choose one date and confirm **Scan LIVE Odds**. To create a saved ticket, use Build this week with SportsGameOdds selected, or Rescan selected day on an existing week. The week builder scans only its selected reference date.

No provider key belongs in source control or chat. Browser-local portfolios remain in localStorage, but scans POST to the same-origin server API. The server sends the provider key using the `x-api-key` header, not the URL. An API backend is required; static-only hosting cannot scan live.

For CLI/server environments, set `SPORTSGAMEODDS_API_KEY` securely. Example: `node bin/longshot.mjs scan --provider sportsgameodds --date YYYY-MM-DD`. The original The Odds API integration remains available with its own key and safeguards. There is no cross-provider fallback.

## Usage limits

The public FAQ consulted on 2026-10-20 describes the free Amateur allowance as **2,500 returned objects/month**, 10 requests/minute, 8 leagues and 9 bookmakers. This is **not 2,500 scans**. Check your account for current limits and league entitlements. Do not assume Champions League is included in the free plan merely because the provider supports it generally.

Each scan requests at most **two pages of 25 events**, so the requested maximum is 50 returned event objects, not including any provider-specific billing rules. There are no automatic retries, weekly bulk scans, or page-load scans. Successful pages are cached in-process for 60 seconds and in-flight requests deduplicated. Cache survival across serverless instances is not guaranteed; repeated manual scans may consume allowance again. The app reports requests, raw events, cached pages, pagination truncation and coverage; remaining account allowance is unknown rather than fabricated.

## Market support and limitations

SportsGameOdds returns American-format prices. Only `available: true` individual `byBookmaker` prices are converted to decimal prices. `bookOdds` and `fairOdds` are never substituted for offered bookmaker odds.

Supported: full-game primary points/goals markets for supported sports, moneyline (soccer requires three-way quotes), three quoted double-chance outcomes, half-line totals, half-line team totals and half-line handicaps. A bookmaker must quote all outcomes in the matching market/line before it is used for de-vigging. Event identity, bookmaker, native oddID, line, team and probability source are preserved on issued legs.

Excluded: alternate-line payloads, player props, partial-game markets, soccer draw-no-bet, integer or quarter lines requiring push/split settlement, unsupported sports, and incomplete books. These exclusions can reduce eligibility. This is not a promise to issue a ticket, and no positive-edge gate was removed.

## Sources used

- https://sportsgameodds.com/docs/basics/cheat-sheet — v2 base URL, header authentication, response envelope, cursors.
- https://sportsgameodds.com/docs/endpoints/getEvents — time filters, event limit, status/team schema, pagination.
- https://sportsgameodds.com/docs/data-types/odds — bookmaker American prices and individual line fields.
- https://sportsgameodds.com/docs/data-types/bet-types — three-way sides and quoted double-chance identifiers.
- https://sportsgameodds.com/docs/faq — object-based billing, free plan limits and backend proxy recommendation.
- Official npm `sports-odds-api` 2.1.0 TypeScript definitions — cross-checked bookmaker availability/line fields; no dependency added.

## Verification

`npm test`: 62 tests passed, including SportsGameOdds parsing, missing markets, price provenance, key isolation, both API transports, selected-day/week routes, pagination, cache, 401/403/429 and a mock-issued ticket. `npm run build` and the required simulated weekly CLI smoke command passed.

No actual provider/account call was performed: the workspace's network allowlist excludes `api.sportsgameodds.com`. Provider behaviour was checked against documentation and mocks, not real account entitlements or current quotes. No browser visual automation was performed.
