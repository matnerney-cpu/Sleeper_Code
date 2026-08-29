# Sleeper League Dashboard

A live, single-page dashboard for your Sleeper fantasy football league. It talks
directly to Sleeper's public API from your browser — no backend, no API key,
no build step.

Default league ID: `1313658287350087680` (editable in the app).

## What it shows

- **Overview** — league status, scoring format, your record/rank, waiver budget or priority.
- **My Team** — your starting lineup and bench, with live injury flags and (during the season) this week's points.
- **Standings** — full league table, your row highlighted.
- **Waiver Targets** — players trending up across Sleeper who are still free agents in *your* league, ranked against your actual roster needs. Also flags your own players that a lot of managers are dropping.
- **Strategy** — auto-generated, data-driven suggestions: injured starters to replace, thin position groups, schedule-luck read, and trade angles based on positional surplus vs. other teams' needs.

Everything in Strategy/Waiver Targets is computed with plain heuristics from
real roster/scoring data (no external rankings or projections) — treat it as
a starting point, not gospel.

## Running it

No build step. Any static file server works:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

or

```bash
npx serve .
```

Opening `index.html` directly via `file://` can be blocked by some browsers'
CORS/localStorage rules — use a local server if the page shows a fetch error.

## First-time setup

1. Open the page. It loads your league automatically using the League ID field
   (defaults to `1313658287350087680`).
2. Pick **your** team from the "My Team" dropdown in the header — Sleeper's API
   doesn't know which login is "you", so this is a one-time pick, saved per
   league in your browser's local storage.
3. Data auto-refreshes every 5 minutes while the tab is open; use **Refresh**
   for an immediate pull.

## Notes

- All data is fetched client-side from `api.sleeper.app`. Nothing is sent
  anywhere else, and nothing is stored except your league ID and team choice,
  in your own browser's `localStorage`.
- The full NFL player list (~5 MB) is cached locally for 24 hours since
  Sleeper asks clients not to hit that endpoint repeatedly.
- Before your league's draft, most tabs will simply show "no roster yet" —
  come back once you've drafted.
