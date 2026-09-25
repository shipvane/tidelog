# Capstan backlog — shipvane/tidelog

Items the capstan loop works through, top to bottom. One item = one PR.

Format:

- `- [ ] <title>` — TODO, the loop picks the topmost actionable item
- `- [x] <title>` — DONE (the loop leaves a PR link as an indented sub-bullet)
- Any item with a `BLOCKED:` sub-bullet is skipped

Keep items small and self-contained (≤1 PR of work). Vague items produce vague PRs.

## Not to be confused with DEMO-BACKLOG.md

[`DEMO-BACKLOG.md`](../DEMO-BACKLOG.md) is a **demo prop**: harbor features
deliberately left unbuilt so a live demo has something real to implement (two of
them are near-duplicates on purpose, to exercise duplicate detection). **Do not
work items out of that file.** This file is the loop's actual queue.

## Running the loop against this repo

Config lives in [`.capstan/config`](../.capstan/config) — the single source of truth
for the gate, forbidden paths, and mode.

```bash
~/dev/shipvane/capstan/scripts/capstan-loop.sh --repo-dir ~/dev/shipvane/tidelog
```

TideLog also has a real board (`shipvane-demo` → SVD, MCP at mcp.shipvane.com),
so it _could_ run `--source jira` through the harness. This backlog is the
md-source path, which needs no MCP auth. The SVD tickets are the paper trail.

**This repo is the public demo at demo.shipvane.com and auto-deploys on push to
`main`.** The loop only opens PRs — it never pushes `main` — so a merge is still
a human decision. Keep it that way.

## Backlog

### Test reliability

- [x] The jest suite flakes at ~13% on main, in tests unrelated to any one change (SVE-153)
  - Fixed in [#52](https://github.com/shipvane/tidelog/pull/52): root cause was **supertest's per-request `http.createServer(app).listen(0)`** (node_modules/supertest/lib/test.js:39,63) — thousands of ephemeral listen/close cycles under load occasionally lose a response (empty `res.body` → `res.body.arrival` is `undefined`) or hang (5 s timeout). Reproduced at 1/40 with a single worker on a single file, ruling out cross-worker/cross-file state. Fix: a `tests/support/server.js` `boundServer()` helper binds one listening server per file that supertest reuses (its `serverAddress` skips `listen(0)` when `.address()` is truthy); requests are byte-for-byte unchanged. Measured: **before 4/30 (13%) on `main`; after 1/120 (0.8%)** in the full parallel suite, and 0/60 on the previously-flaky file in isolation. In-band it did not reproduce (0/14), which is what pointed at the per-request server rather than the store.
  - **This is first because it fails PRs that cannot have caused it.** A docs-only PR adding `CLAUDE.md` (#46) went red on it. So did the PR that fixed the webhook race. A gate that goes red for reasons nobody caused teaches everyone to re-run instead of read, and that habit is what let the jsdom defect ship twice (SVE-145 -> SVE-146).
  - **Measured, not inferred.** Full-suite runs on a quiet machine, 2026-09-23: `main` failed **2 of 15** (13%); the SVE-151 branch failed **2 of 12** (17%). SVE-151 removed the webhook-specific failures — across 26 runs on that branch none were webhook-related — and this is what remains.
  - Tests seen failing, each on `main` or on a branch that does not touch them: `assign-berth › avoids double-booking: second vessel gets the next berth up`; `berths › POST /:id/maintenance toggles the outOfService flag`; `depart › allows departure from overdue status`; `GET /api/webhooks/deliveries › entries appear newest first`. In at least one case `res.body` did not carry the key the route always returns, which points at the request rather than the handler.
  - **Run `npx jest --runInBand` repeatedly before anything else.** If the flake disappears in band it is a concurrency problem, not a logic one, and that single experiment decides the whole shape of the fix. Put the result in the PR. These are express + supertest route tests sharing one in-memory store (`routes/db.js`) reset by a synchronous `db.reset()` in `beforeEach`, while jest runs suites in parallel workers — so the candidates are cross-test state from fire-and-forget work still in flight, supertest's ephemeral port binding under load, or worker parallelism itself.
  - **Do not "fix" this by retrying tests, raising timeouts, or skipping anything.** Each hides the signal and leaves the bug. Do not reach for `--runInBand` as the _fix_ either unless you can show the suite stays fast enough to keep as the gate — as a diagnostic it is free, as a permanent setting it has a cost worth stating.
  - **Expect your own gate to flake while you work this item.** At ~13% a red run is more likely noise than something you broke. Re-run before concluding your change caused it, and say in the PR how many runs you did — this is the one item where a single green gate proves the least.
  - **Acceptance: state the measured rate before and after, over at least 15 full runs each, naming the number of runs you did.** "It passes now" is not a result — a 13% flake passes most of the time by definition.
  - **Question to answer in the PR:** did it disappear under `--runInBand`, and what does that tell you about the cause? If it did not, what did you rule out?

- [x] No test may make a real outbound network request — seven files race the webhook delivery (SVE-151)
  - Done in [#49](https://github.com/shipvane/tidelog/pull/49): `lib/webhooks.js` gains a transport seam (default byte-for-byte `fetch`); `tests/setup/no-network.js` (jest `setupFilesAfterEnv`) installs a never-settling `global.fetch` + a guard that fails any test making a real call, and injects a local transport so deliveries log with no network; fixed sleeps replaced with deadline polling. Guard trips on a deliberate real call; worker-exit warning gone.
  - **This is first because it breaks unrelated PRs.** It failed CI on a docs-only change (#46) that could not possibly affect tests. A red gate that is nobody's fault trains everyone to re-run rather than read.
  - **Mechanism.** `lib/webhooks.js:32` does a real outbound `fetch()` to whatever URL a subscription holds — in tests, `https://meridian-shipping.example/...`, a domain that cannot resolve (`.example` is reserved, RFC 2606). Nothing reaches the delivery log until that attempt settles, and the budget is `REQUEST_TIMEOUT_MS = 10_000` with `RETRY_DELAY_MS = 5_000` (`lib/webhooks.js:18-19`). Tests that sleep a fixed 100ms and then index `deliveries[0]` throw `TypeError: Cannot read properties of undefined`. The `A worker process has failed to exit gracefully` warning is the pending 5s retry timer outliving the test — same cause.
  - **Scope: every test file that reaches a webhook-firing route, not just the obvious one.** An earlier attempt fixed `ticket-12-berth-change.test.js` and `webhooks.test.js` and the failure rate did not move — it was **1/12 full-suite runs before and 1/12 after**, the failures simply relocated to other files. Measured, not assumed. These five still hit `/api/arrivals`, `/arrive`, `/assign-berth` or `/depart` with no stub: **`readonly.test.js`, `routes.test.js`, `ticket-12.test.js`, `turnaround.test.js`, `ui-arrivals.test.js`**. Any file that touches those routes fires a delivery, whether or not the test is about webhooks.
  - **The invariant to land, and it is the point of this item:** after this change **no test in the suite performs a real outbound request**, and that is enforced rather than hoped. A shared setup (jest `setupFilesAfterEach`, or a helper every suite imports) that installs a non-settling `global.fetch` and asserts it was never called will fail loudly the next time someone adds a test that reaches the network. Fixing seven files by hand without that guard leaves the eighth to reintroduce it.
  - **Do not lengthen the sleeps.** A bigger constant is the same bug plus seconds on every run. Do not `skip` the tests. Do not change `lib/webhooks.js`'s retry semantics to make testing easier — the 10s timeout and single 5s retry are product behaviour; the tests are what is wrong. A seam for injecting the transport is fine **provided the default path is byte-for-byte what it does today**.
  - **Replace fixed sleeps with polling against a deadline** wherever a test waits for a delivery, and guard the index so an empty log fails as a readable assertion about the delivery log rather than a `TypeError` about `undefined`.
  - **Tests / acceptance — a single green run is not evidence here.** This suite passed roughly 20 consecutive local runs while failing twice under real conditions. Demonstrate all of: (a) the suite passes **12 consecutive full runs** (`for i in $(seq 1 12); do npx jest || break; done`) — state the number you ran; (b) with `global.fetch` replaced by a promise that never settles, every suite still passes, which is the CI condition the current tests cannot survive; (c) the guard from the invariant above fails when a test is deliberately made to call the real network.
  - **Question to answer in the PR:** how is the no-real-fetch invariant enforced for a test file written six months from now by someone who has not read this item? If the answer is "they will remember", the guard is not in the right place.

### PWA — installable, offline-capable harbor logbook (2026-08-10)

<!-- A harbor master uses this on a dock, on a phone, often on bad signal, which
     is the whole case for a PWA here. Three slices, strictly in order: the
     manifest is inert on its own, the service worker depends on it, and the
     offline data layer depends on the service worker.
     Tracked as SVD-11/12/13. -->

- [x] PWA (1/3): installable shell — manifest, real icons, iOS meta tags — tracked as **SVD-11**
  - Done via the agentic harness's PR **#38** (`31ab219`), not a capstan branch — which is why this box stayed unticked after it merged. Verified live: `/manifest.webmanifest` and all four icon paths return 200 on tidelog.shipvane.com.
  - The safe slice: adds files and markup only, no service worker, so it cannot break the live demo.
  - Today there is no manifest and no icon on disk — `public/index.html` declares an inline SVG data-URI favicon and nothing else.
  - Add `public/manifest.webmanifest` (name, short_name, `start_url: "/"`, `scope: "/"`, `display: "standalone"`), taking `theme_color`/`background_color` from the existing palette in `public/styles.css` rather than inventing them. Link it from `index.html`.
  - Icons in `public/icons/`: 192 and 512 `purpose: "any"`, **plus a separate 512 `purpose: "maskable"`** with ~20% safe-zone padding. Do not reuse one file for both — Android's adaptive mask crops a design that fills the square. The anchor motif already in the header SVG is the obvious source.
  - `apple-touch-icon` (180×180) plus `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`. iOS ignores the manifest for Add to Home Screen, so without these an installed TideLog opens in Safari chrome with a screenshot for an icon.
  - `server.js:39` mounts `express.static` on `public/`, so all of this is served from the root path with no route changes.
  - Tests: a supertest spec asserting `GET /manifest.webmanifest` is 200 with the right content type, **and that every icon path named in the manifest is actually fetchable** — a manifest pointing at a missing icon is the usual way this breaks, and it fails silently in the browser.

- [x] PWA (2/3): service worker and offline app shell — tracked as **SVD-12**
  - Done in [#54](https://github.com/shipvane/tidelog/pull/54): built on #39 (now superseded) — hand-written `public/sw.js` with a bumped `CACHE_VERSION`, all three review blockers fixed (kill switch on the fetch path via `/sw-kill`, stale-while-revalidate shell, `/`≠`/index.html` deduped), precache now includes the manifest + icons, and `tests/sw.test.js` drives the SW code directly to prove revalidation and the kill switch.
  - **Start from PR #39, do not start from nothing.** The harness already implemented this (branch `auto/16-20260921191734`) and the bulk of it is good: `public/sw.js` with a hand-written precache list and `CACHE_VERSION`, network-only for `/api/*`, registration in `public/app.js` behind `'serviceWorker' in navigator`, and `tests/sw.test.js`. Read those three files off that branch and build on them. **Review found two blockers; both are below.** When this lands, #39 gets closed as superseded — say so in the PR.
  - **BLOCKER 1 — it no longer passes the gate.** `tests/sw.test.js` globs `public/` and asserts every entry is in `PRECACHE_URLS`. Since #38 merged, `public/` also holds `manifest.webmanifest` and `icons/`, so the run fails with `Expected value: "/icons"`. **The test is right and must not be weakened to make this pass.** Decide deliberately what belongs in the shell precache: an installed PWA that cannot paint its own icon offline is a poor shell, so the manifest and the icons it names probably do belong. A directory entry like `/icons` is not a fetchable URL — expand it to the files inside, or teach the glob to recurse. Say which you chose.
  - **BLOCKER 2 — #39 documents a kill switch instead of shipping one.** Its `sw.js` header describes a manual procedure, and neither half of it works when it is most needed. "Bump `CACHE_VERSION` and deploy" assumes the broken SW lets the new one through, which is the exact failure being guarded against. "Unregister in DevTools" asks every visitor to paste a console command. **Ship a mechanism that runs on the SW's own fetch path**, because that path still executes when the cache is serving garbage: fetch a sentinel network-first (a `/sw-kill` route, or a version file), and on seeing the kill signal call `self.registration.unregister()` and delete every cache, then let the page reload unmanaged. Test it: with the sentinel present the SW unregisters and stops serving from cache. **A kill switch with no test is a kill switch nobody knows works.**
  - **BLOCKER 3 — the shell must revalidate. A deploy has to reach a returning visitor.** #39 is pure cache-first with no revalidation (`caches.match(...).then(r => r || fetch(request))`) and omits `skipWaiting`/`clients.claim`, so a precached `/` is served from cache indefinitely and a new SW activates only once EVERY tab closes. Its reasoning — avoid jarring mid-session updates — is sound in isolation and **wrong here**: on this repo a push to `main` IS the deploy, there is no staging, and a change that never reaches visitors is indistinguishable from one that was never shipped. Use **stale-while-revalidate** for the shell: serve the cached response immediately, fetch in the background, write the fresh copy back. That keeps the no-jarring-update property (this paint is still the cached one) without stranding anyone on an old build.
  - **Prove blocker 3, do not assert it.** A test that shows a changed shell file reaches a client **without closing every tab** — warm the cache, change the file, re-request, and assert the cache now holds the new content. If that is genuinely untestable in jsdom, say so plainly and attach evidence from a real browser instead. **Do not claim the cache refreshes without showing it**: the repo's `CLAUDE.md` is explicit that jsdom cannot distinguish "in the DOM" from "visible", and the same rule applies to "in the cache" versus "actually served".
  - Minor, from the same review: `/` and `/index.html` are the same resource and produce two cache entries for one document.
  - **The constraint that shapes this: there is no bundler and no build step.** `package.json` has start/test/lint/format only, and `public/` is served verbatim. There is no Workbox build to generate a hashed precache manifest. Choose explicitly and say why in the PR: (a) hand-written `public/sw.js` with an explicit precache list and a `CACHE_VERSION` bumped when those files change — simple, no new tooling, but the bump is a manual step someone forgets; or (b) add `workbox-cli` and a `build:sw` script, which introduces a build step to a repo that deliberately has none and must then run before deploy (check `apprunner.yaml`). Recommend (a) for a five-file shell.
  - **Treat the service worker as a loaded gun, because this is the public demo.** A registered SW is sticky: a bad one is cached by every visitor and keeps serving itself, so a broken deploy is _not_ fixed by the next deploy. Ship a kill switch from day one and document how to trigger it in the PR. Use `skipWaiting`/`clients.claim` deliberately, not reflexively.
  - **Never cache `/api/*` in this slice.** Harbor data is SVD-13 and has its own correctness questions; a stale berth assignment served silently from cache is worse than an error.
  - Register from `public/app.js`, guarded on `'serviceWorker' in navigator`. Add an offline fallback so a cold load with no signal renders the shell and a clear offline state rather than the browser's dinosaur.
  - Tests: the SW is served at `/sw.js` with root scope (nested, it cannot control the page); the precache list matches what is actually in `public/` — a test that globs the directory and diffs catches the forgotten version bump; no cache rule matches `/api`.

- [x] PWA (3/3): offline behaviour for harbor data — tracked as **SVD-13**
  - Done in [#56](https://github.com/shipvane/tidelog/pull/56): SW now caches the read-only board endpoints
    (`/api/arrivals` and `/api/berths` exactly, `/api/tides/*`) **network-first
    with a cache fallback**, not stale-while-revalidate as asked below: SWR served
    cached data online and the page labelled it "Synced" now. Stored copies carry
    `X-TideLog-Fetched-At`, and "Synced HH:MM" is the oldest read's fetch time. The
    api cache is versioned apart from the shell. The header also shows an
    OFFLINE badge driven by `navigator.onLine`; offline berth assignment is
    refused with the selection preserved (no write queue). All four kill-switch
    safeguards kept — the kill path deletes every cache, so the api cache goes
    with the shell; existing kill-switch tests unchanged.
  - Depends on SVD-12. (SVD-12 shipped as #54: `public/sw.js` + `public/sw-register.js`. Build on them.)
  - **Do not weaken the kill switch while changing `sw.js`.** This item has to lift SVD-12's "never cache `/api/*`" rule, and that edit sits right next to the safety code. Keep all four: the `/sw-kill` check on navigations; `if (killed) return;` at the top of the fetch handler; the `!killed` guard before every `cache.put` (a new API cache needs it too); and `sw-register.js` checking the sentinel before it registers. The kill path deletes **every** cache, so API data must live in the Cache API (not IndexedDB) or the kill must be taught to clear it too. Say which in the PR. If `PRECACHE_URLS` changes, bump `CACHE_VERSION`. The existing kill-switch tests in `tests/sw.test.js` must still pass unmodified.
  - **Reads:** cache `GET /api/arrivals`, `/api/berths`, `/api/tides` stale-while-revalidate, and **show when the data is from**. A berth board with no timestamp is indistinguishable from a live one, and acting on a stale berth assignment is the exact failure this app exists to prevent. A visible "last synced HH:MM" beats silent staleness.
  - **Writes are the hard part.** Prefer refusing writes while offline, clearly, preserving the user's typed input so nothing is lost. Background-sync queueing sounds better but a queued berth assignment can be invalid on replay — the berth may be taken — and refusing double bookings is TideLog's whole premise. **Do not half-build a queue:** one that cannot report a rejected replay is a double-booking generator. If a queue is wanted, file it separately with replay-rejection handling in scope.
  - Add an online/offline indicator in the header. The tide-window calculation is pure (`lib/tides.js`), so it should keep working offline provided the tide table is cached with the reads — verify that.
  - Tests: with the network stubbed offline the arrivals view renders from cache with a last-synced timestamp; an offline write is refused with input preserved; tide windows still compute; reconnecting refreshes without a manual reload.
