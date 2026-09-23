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

- [ ] No test may make a real outbound network request — seven files race the webhook delivery (SVE-151)
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
  - Done: manifest + real anchor PNG icons (192/512 any, 512 maskable, 180 apple-touch) + iOS meta tags. PR: _capstan/pwa-installable-shell_ (link below once opened).
  - The safe slice: adds files and markup only, no service worker, so it cannot break the live demo.
  - Today there is no manifest and no icon on disk — `public/index.html` declares an inline SVG data-URI favicon and nothing else.
  - Add `public/manifest.webmanifest` (name, short_name, `start_url: "/"`, `scope: "/"`, `display: "standalone"`), taking `theme_color`/`background_color` from the existing palette in `public/styles.css` rather than inventing them. Link it from `index.html`.
  - Icons in `public/icons/`: 192 and 512 `purpose: "any"`, **plus a separate 512 `purpose: "maskable"`** with ~20% safe-zone padding. Do not reuse one file for both — Android's adaptive mask crops a design that fills the square. The anchor motif already in the header SVG is the obvious source.
  - `apple-touch-icon` (180×180) plus `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`. iOS ignores the manifest for Add to Home Screen, so without these an installed TideLog opens in Safari chrome with a screenshot for an icon.
  - `server.js:39` mounts `express.static` on `public/`, so all of this is served from the root path with no route changes.
  - Tests: a supertest spec asserting `GET /manifest.webmanifest` is 200 with the right content type, **and that every icon path named in the manifest is actually fetchable** — a manifest pointing at a missing icon is the usual way this breaks, and it fails silently in the browser.

- [ ] PWA (2/3): service worker and offline app shell — tracked as **SVD-12**
  - BLOCKED until SVD-11 lands (the SW precaches the manifest and icons).
  - **The constraint that shapes this: there is no bundler and no build step.** `package.json` has start/test/lint/format only, and `public/` is served verbatim. There is no Workbox build to generate a hashed precache manifest. Choose explicitly and say why in the PR: (a) hand-written `public/sw.js` with an explicit precache list and a `CACHE_VERSION` bumped when those files change — simple, no new tooling, but the bump is a manual step someone forgets; or (b) add `workbox-cli` and a `build:sw` script, which introduces a build step to a repo that deliberately has none and must then run before deploy (check `apprunner.yaml`). Recommend (a) for a five-file shell.
  - **Treat the service worker as a loaded gun, because this is the public demo.** A registered SW is sticky: a bad one is cached by every visitor and keeps serving itself, so a broken deploy is _not_ fixed by the next deploy. Ship a kill switch from day one and document how to trigger it in the PR. Use `skipWaiting`/`clients.claim` deliberately, not reflexively.
  - **Never cache `/api/*` in this slice.** Harbor data is SVD-13 and has its own correctness questions; a stale berth assignment served silently from cache is worse than an error.
  - Register from `public/app.js`, guarded on `'serviceWorker' in navigator`. Add an offline fallback so a cold load with no signal renders the shell and a clear offline state rather than the browser's dinosaur.
  - Tests: the SW is served at `/sw.js` with root scope (nested, it cannot control the page); the precache list matches what is actually in `public/` — a test that globs the directory and diffs catches the forgotten version bump; no cache rule matches `/api`.

- [ ] PWA (3/3): offline behaviour for harbor data — tracked as **SVD-13**
  - BLOCKED until SVD-12 lands.
  - **Reads:** cache `GET /api/arrivals`, `/api/berths`, `/api/tides` stale-while-revalidate, and **show when the data is from**. A berth board with no timestamp is indistinguishable from a live one, and acting on a stale berth assignment is the exact failure this app exists to prevent. A visible "last synced HH:MM" beats silent staleness.
  - **Writes are the hard part.** Prefer refusing writes while offline, clearly, preserving the user's typed input so nothing is lost. Background-sync queueing sounds better but a queued berth assignment can be invalid on replay — the berth may be taken — and refusing double bookings is TideLog's whole premise. **Do not half-build a queue:** one that cannot report a rejected replay is a double-booking generator. If a queue is wanted, file it separately with replay-rejection handling in scope.
  - Add an online/offline indicator in the header. The tide-window calculation is pure (`lib/tides.js`), so it should keep working offline provided the tide table is cached with the reads — verify that.
  - Tests: with the network stubbed offline the arrivals view renders from cache with a last-synced timestamp; an offline write is refused with input preserved; tide windows still compute; reconnecting refreshes without a manual reload.
