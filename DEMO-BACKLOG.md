# TideLog — feature backlog

Ticket-sized features that are deliberately **not built yet**. Each one is
scoped to land in a single PR touching `lib/`, `routes/`, and `tests/`
against the existing code.

> Note for demo purposes: **#3 and #4 are near-duplicates in spirit** — both
> ask for a money figure derived from vessel length × time alongside. They
> exist to exercise duplicate detection.

---

### 1. Departure logging and turnaround time

Add `POST /api/arrivals/:id/depart` to close out a port call: mark the
vessel `departed`, stamp `departedAt`, and free its berth assignment from
that moment. Expose a `turnaroundHours` field (arrival → departure) on the
arrival record and a simple average in a new `GET /api/stats/turnaround`.

### 2. Overdue vessel flagging

A vessel still `expected` more than two hours past its ETA is overdue.
Add an `overdue: true` flag to arrivals returned by `GET /api/arrivals`,
plus a `?status=overdue` filter, so the harbor master can chase the agent.
The threshold should live in one place and be easy to change.

### 3. Harbor dues calculator

Harbor dues are charged at a tariff of `lengthM × hours alongside × rate`
(pick a sensible default rate, configurable). Add a pure `lib/dues.js`
module and `GET /api/arrivals/:id/dues` that computes the charge from the
vessel's berth assignment window, returning a line-item breakdown.

### 4. Berthage fee estimate endpoint

Before committing to a berth, an agent wants a quote: given a vessel length
and a planned stay in hours, return the estimated berthage fee (length ×
hours × tariff). Add `GET /api/berths/estimate?lengthM=85&hours=12` with a
per-meter-hour rate and a currency field in the response.

_(Near-duplicate of #3 — same tariff math, different entry point.)_

### 5. CSV export of the day's log

Add `GET /api/arrivals/export.csv` returning the current log as CSV
(one row per arrival: vessel, type, dimensions, ETA, status, berth,
timestamps) with a proper `Content-Disposition` header, so the harbor
office can archive the day sheet. Escape commas and quotes correctly.

### 6. Berth maintenance mode

A berth under maintenance (dredging, fender repair) must not be assignable.
Add `POST /api/berths/:id/maintenance` to toggle an `outOfService` flag
with an optional reason, exclude such berths from assignment in
`lib/berths.js`, and surface the state on the berth board.

### 7. Neap-tide warning on tide windows

Windows that only just clear the requirement are risky in practice. Flag
any safe window whose peak tide height exceeds the required height by less
than 0.3 m with `marginal: true` and a `peakClearanceM` value in
`GET /api/tides/windows`, so the harbor master can advise waiting for
springs.

### 8. Dashboard filter by vessel type

Let `GET /api/arrivals` accept `?type=tanker` (validated against the known
vessel types, 400 on junk) and add a type dropdown to the dashboard that
re-fetches the arrivals table with the filter applied. Counts in the stat
tiles should follow the filter.
