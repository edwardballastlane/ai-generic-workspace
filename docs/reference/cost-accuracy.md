# Token Cost Accuracy & Reconciliation

How the token dashboard's cost numbers are produced, why they don't equal the
Anthropic Console "spent" figure, and how to keep both as reliable as possible.

## Two different numbers (both valid, not interchangeable)

| Metric | Source | What it means |
|---|---|---|
| **List-price value** | `token-dashboard.js` (`cost_usd`) | What every token would cost at pay-as-you-go list rates. Derived from transcript token counts. The right metric for "how much AI work is the team doing, by whom, on what." |
| **Actual billed (metered)** | Anthropic Console / `cost_report` API | Usage-based spend that hit the invoice as **overage beyond seat subscriptions**. A heavy seat user can show ~$0 here while doing thousands of dollars of list-price work. |

There is **no stable ratio** between them, because seat coverage varies month to
month and user to user. Don't try to make the dashboard equal the Console number;
display both.

## Pricing is single-sourced from `scripts/_lib/cost.js`

`cost.js` (`priceFor` / `computeCostUsd`) is the one price table. Both the
session-stop hook (write time) and `token-dashboard.js` (render time) use it, so
the two can't drift. The dashboard **reprices every known-model row from token
counts at render time**, so a write-time pricing bug self-heals without mutating
the git-tracked event log. Rows with an empty `model` keep their stored cost
(we can't price what we can't identify).

> Historical note: Opus 4.8 was briefly mispriced as Sonnet because the regex
> only matched `opus-4-(5|6|7)`. `priceFor` now matches the Opus minor version
> numerically (`opus-4-(\d+)`, ≥5 → current tier) so new releases can't fall
> through. Regression test: `tests/_lib/cost.test.js`.

### Known limitation: unknown-model history

~99% of rows logged before late-June 2026 have an empty `model` field (model
capture wasn't working) and are priced at the Sonnet default. For an Opus-heavy
team this **understates** historical list price, and it's unrecoverable (the
transcripts are gone). It self-corrects going forward now that model capture
works — so always re-derive calibration from **current-month** data.

## Calibration (`.ai-memory/calibration-tiers.json`)

`cost_billed_usd = cost_usd × ratio`. Ratios approximate list-price → billed per
tier. Re-derive **monthly** and only from current, correctly-priced data:

```
ratio = (Console MTD for one user in the tier) ÷ (that user's same-month dashboard list-price)
```

Caveat: this is unreliable for seat-covered users (their Console spend can be $0
regardless of usage). Treat calibration as a rough org-level approximation, not a
per-user truth — use the Admin Cost API below for the real billed number.

## Ground truth: Admin Cost Report API

`scripts/fetch-admin-cost.js` (`npm run cost:admin`) pulls the real metered cost
from `GET /v1/organizations/cost_report`, broken down per model/workspace, into
`.ai-memory/admin-cost-<month>.json`.

- Requires the **`ANTHROPIC_ADMIN_KEY`** env var (Console → Settings → Admin
  keys — distinct from a normal API key, org-admin scope).
- Same caveat as the Console number: it reflects metered overage and **excludes
  seat-subscription-covered usage**. It is the authoritative *billed* figure, not
  a measure of total value delivered.
- Runs in CI via the scheduled **`refresh-admin-cost`** Bitbucket pipeline
  (Settings → Schedules), which commits the monthly JSON back to master like the
  `refresh-jira-cache` pipeline. Set `ANTHROPIC_ADMIN_KEY` as a SECURED
  repository variable.

## Operating checklist

1. Pricing accurate? → `cost.js` is the only table; `npm test` covers it.
2. Real billed number? → `npm run cost:admin` (or the scheduled pipeline).
3. Billed estimate on the dashboard? → re-derive `calibration-tiers.json`
   monthly from current-month data; prefer the Admin API number where present.
