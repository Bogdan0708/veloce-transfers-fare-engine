# Veloce Transfers fare engine

Deterministic fare calculation for a Ticino chauffeur/transfer service: tariff
tables, DST-aware clock-change handling, return-trip pricing without
inherited distance, manual-review states for edge cases, and an enquiry
handoff payload.

Extracted from the production site (Astro) at revision `6b8bf12`. Tariff
figures mirror the operator's published price list as of the extraction date
(2026-09-07) and are kept unchanged because the tests depend on them; they
are not maintained here and may differ from current live prices.

## Run

```bash
npm ci && npm test
```

`npm run typecheck` runs `tsc --noEmit`.

## Entry point

`src/engine.ts` — the pure, deterministic pricing function `estimate()`.
`src/time.ts` provides the zone-aware clock helpers it depends on
(DST-safe local-time-to-instant conversion). `src/tariffs.json` is the tariff
table consumed by the engine.

## Status

Implementation evidence: this repo demonstrates the tested fare-calculation
logic. The customer-facing site that calls this engine is a separate,
private production codebase.
