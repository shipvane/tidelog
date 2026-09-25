# CLAUDE.md

Guidance for any agent working in TideLog — Claude Code, the Shipvane agentic
harness, or a human reading quickly. The harness reads this file (and `AGENTS.md`
if present) from the repo root, **capped at 8k characters**, so keep it short and
spend the space on what is not obvious from the code.

## What this is

A harbor operations logbook: arrivals, berth assignment, tide windows, harbour
dues. It is also **Shipvane's public proof** — most features here were written by
the agentic pipeline from a GitHub issue, and the repo is public.

**A push to `main` is a deploy.** App Runner rebuilds from source on every push
(`apprunner.yaml`), so a merge is live on tidelog.shipvane.com minutes later with
no release step. There is no staging. Treat `main` accordingly.

The store is in-memory (`routes/db.js`) and re-seeds on boot, so every deploy
resets the harbor to a clean populated state. There is no database and no
migration story — do not add one without being asked.

## Layout

| path      | what goes there                                                       |
| --------- | --------------------------------------------------------------------- |
| `lib/`    | pure logic, no Express. Tides, berths, dues, CSV, manifest validation |
| `routes/` | Express routers. Thin — parse, call `lib/`, respond                   |
| `public/` | the whole UI: one `index.html`, one `app.js`, one `styles.css`        |
| `tests/`  | Jest. `supertest` for routes, `jsdom` for markup                      |

**Express on the server; nothing at all on the client.** `server.js` and
`routes/` are Express. `public/` is served as written — vanilla browser JS in a
plain `<script>` tag, hand-authored CSS, **no build step**, no bundler, no JSX,
no TypeScript. Do not introduce a frontend framework or a build; if a PWA asset
needs a precache list, it is maintained by hand.

Server code is **CommonJS** (`require`, `module.exports`) with `'use strict'` at
the top of every file, Node >= 20. `public/app.js` is neither — it is a browser
script with no module system, so `require` there is a runtime error, not a style
choice.

## The gate

```bash
npm ci && npm run lint && npm run format:check && npx jest --passWithNoTests
```

This is the real gate and it must exit 0 before a PR exists. `format:check` fails
on unformatted code — run `npm run format` rather than hand-aligning. Prettier is
`singleQuote`, `printWidth: 100`, `trailingComma: es5`; ESLint adds `eqeqeq`
(smart) and `no-var`. Do not argue with either in review; they are machine-checked.

## Things that bite

**jsdom does no layout. It cannot tell you anything is visible.** This is the most
expensive lesson in the repo and it cost three PRs. The Assign button shipped
(#40), was unreachable, was "fixed" by dropping a column and adding a jsdom test
asserting the button is in the DOM (#42) — which passed, because the button was
_always_ in the DOM; that was never the failing condition — and was finally fixed
at the real constraint, `.panel { overflow: hidden }` clipping the scroll
container (#44).

So: **a DOM-presence assertion is not weak evidence of visibility, it is no
evidence at all.** jsdom has no viewport, no box model, no paint. If a change is
about something being visible, reachable, or not clipped, either measure geometry
in a real browser engine (`scrollWidth` vs `clientWidth`, `getBoundingClientRect`
containment) or **say plainly in the PR that visibility is unverified and attach a
screenshot**. A passing test that measures the wrong thing is worse than no test,
because it ends the conversation.

**CSS: never clip an ancestor of a scroll container.** `.table-wrap` sets
`overflow-x: auto`; an `overflow: hidden` on `.panel` above it means the scroll
region is cut off by the parent and _no scrollbar ever renders_. The content is
simply gone, with no affordance that anything is there. Check the ancestors before
concluding a table "fits".

**Colours come from the custom properties in `:root`** (`--navy-*`, `--teal`,
`--brass`, `--green`, `--red`, and their `-soft` pairs, plus `--ink`, `--muted`,
`--line`, `--paper`, `--card`, `--radius`). Use them. A literal hex in a rule is a
colour nobody can retheme and is the thing that makes a palette change a
find-and-replace.

**Production rejects writes.** `TIDELOG_READ_ONLY=true` is set on the deployed
demo and guarded in `server.js`. A feature that only works by writing will appear
broken in production while passing every local test. If you add a mutating route,
check how the guard treats it and say so in the PR.

**The service worker has a kill switch, and this is how to pull it.** A registered
SW is sticky: a bad one keeps serving itself to returning visitors, and the next
deploy does not fix that. To turn it off, add `- name: TIDELOG_SW_KILL` /
`value: 'true'` under `run.env` in `apprunner.yaml` and push to `main`. Visitors
drop the worker and its caches on their next navigation, and pages stop
registering it. Remove the entry and push to restore it. That is an operator's
incident action; the `apprunner.yaml` rule below is about feature work. Details in
the header of `public/sw.js`.

**The IMO checksum is real.** `lib/manifest.js` validates it. Test fixtures need
genuine check digits — inventing a 7-digit number will fail validation and the
failure will look like a bug in your change.

## Do not touch

`.capstan/config` marks these forbidden, and the reasons are not bureaucratic:

- `apprunner.yaml` — deploy config for the live demo
- `shipvane-pipeline.json` — changing it changes the gate the harness runs
- `DEMO-BACKLOG.md` — a demo prop: features deliberately left unbuilt

Also leave `.github/workflows/` alone. CI and deploy config are not in scope for a
feature ticket.

## Writing a PR here

The repo is public and the PR body is the artifact a reader judges the pipeline
by. Carry the **mechanism** (with `file:line`), what you **ruled out**, the
**decision** where more than one option existed, and what you **deliberately did
not do**. Report the gate result from the run, not from memory.

Claims are checked. Sentences naming a path not in the diff are struck, and any
"tests pass" claim is replaced with the harness's own gate line — so an overclaim
becomes a visible strike rather than a private embarrassment. **Do not claim
something is visible, reachable, or renders correctly unless you measured it.**
"The button is in the DOM" and "the button is on screen" are different sentences
and only one of them is usually true.
