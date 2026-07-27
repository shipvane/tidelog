# ⚓ TideLog

**A harbor operations logbook.** TideLog is the harbor master's single pane of
glass: log vessel arrivals, assign berths without double-booking, and know
exactly when the tide lets a deep-draft vessel through the approach channel.

Built for small commercial harbors where the "system of record" is still a
paper logbook and a whiteboard of berth assignments.

## Screenshots

> _Dashboard screenshots coming soon._

## What it does

- **Arrivals log** — vessels (or their agents) file an arrival manifest:
  name, type, length overall, draft, IMO number, ETA. TideLog validates it
  (including the IMO checksum) and keeps a normalized log of expected and
  in-port vessels.
- **Berth board** — six berths from Fisherman's Wharf to the Deepwater
  Terminal, each with a length and depth limit. TideLog assigns the snuggest
  fitting free berth for a stay window and refuses double bookings.
- **Tide windows** — given the tide table and the charted channel depth
  (6.0 m at chart datum), TideLog computes the exact time windows during
  which a vessel of a given draft can safely transit, including a
  configurable under-keel clearance (default 0.5 m).

## Quick start

Requires Node 20+.

```bash
npm install
npm start          # http://localhost:3000
```

The server seeds a believable day in port (a tanker alongside, a fishing
boat at the wharf, a cargo vessel inbound) so the dashboard is never empty.
Storage is in-memory — restarting the server resets the log.

```bash
npm test           # jest unit + route tests
npm run lint       # eslint
npm run format:check
```

## API overview

| Method | Path                             | Description                                                         |
| ------ | -------------------------------- | ------------------------------------------------------------------- |
| GET    | `/api/health`                    | Liveness check                                                      |
| GET    | `/api/arrivals`                  | List arrivals (`?status=expected\|arrived`)                         |
| POST   | `/api/arrivals`                  | Log an arrival manifest (400 + error list when invalid)             |
| GET    | `/api/arrivals/:id`              | One arrival, with its berth assignment                              |
| POST   | `/api/arrivals/:id/arrive`       | Mark the vessel arrived (optional `{ "time": … }`)                  |
| POST   | `/api/arrivals/:id/assign-berth` | Assign a berth for a window (defaults: ETA → ETA + 8 h; 409 = full) |
| GET    | `/api/berths`                    | Berth board with current occupancy                                  |
| GET    | `/api/berths/:id/schedule`       | Assignments for one berth, ordered by start                         |
| GET    | `/api/tides/table`               | The 48-hour tide table the harbor is working from                   |
| GET    | `/api/tides/windows?draftM=6.5`  | Safe entry windows for a draft (`&safetyMarginM=` optional)         |

### Example: log an arrival and berth it

```bash
curl -s -X POST localhost:3000/api/arrivals \
  -H 'content-type: application/json' \
  -d '{"vesselName":"MV Northern Star","vesselType":"cargo","lengthM":85,"draftM":6.2,"imo":"IMO 9074729","eta":"2026-07-26T14:00:00Z"}'

curl -s -X POST localhost:3000/api/arrivals/ARR-006/assign-berth -H 'content-type: application/json' -d '{}'

curl -s 'localhost:3000/api/tides/windows?draftM=6.2'
```

## Project layout

```
lib/        pure domain logic — tide-window math, berth fitting, manifest validation
routes/     Express routers + the in-memory store (db.js)
public/     the dashboard — vanilla HTML/CSS/JS, no build step
server.js   Express app entry (API + static UI)
tests/      jest unit tests for lib/ and supertest route tests
```

The domain modules in `lib/` are pure and fully unit-tested; the routes are
a thin HTTP layer over them. See [DEMO-BACKLOG.md](DEMO-BACKLOG.md) for the
feature backlog.

## Development

- **Node**: 20 (see `engines`)
- **Style**: ESLint (flat config) + Prettier — CI enforces both
- **Tests**: `npm test` runs jest; route tests spin the app in-process via
  supertest, no port binding needed
- **CI**: `.github/workflows/ci.yml` runs install → lint → format check →
  tests on every push to `main` and every pull request

## License

MIT
