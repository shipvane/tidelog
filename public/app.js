/* TideLog dashboard — vanilla JS, no build step. */

const REFRESH_MS = 30_000;
// A board read that hasn't answered by now counts as failed. Refreshes run one
// at a time (SVD-23), so a read that never settles would hold every later
// refresh behind it; a timeout turns a hung server into an honest STALE board.
// `__tidelogRefreshTimeoutMs` exists only so tests needn't wait 15 s.
const REFRESH_TIMEOUT_MS = window.__tidelogRefreshTimeoutMs || 15_000;
const REFERENCE_DRAFT_M = 7.0;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function fmtTime(iso) {
  return timeFmt.format(new Date(iso));
}

function fmtDayTime(iso) {
  return dayTimeFmt.format(new Date(iso));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/**
 * Turn a failed write response into something a person can read. The server
 * always explains itself in the body — the read-only demo guard returns
 * `{ error, message }` (server.js) and the route handlers return `{ error }` —
 * so prefer the server's own words over a bare status code. `fallback` is used
 * only when the body carries neither, so the user never sees silence.
 */
async function readErrorMessage(res, fallback) {
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string' && body.message) return body.message;
    if (body && typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Body was not JSON; fall through to the caller's human-readable fallback.
  }
  return fallback;
}

/**
 * Harbor-data read that also reports WHEN the data was fetched and WHETHER it
 * came off the network. The service worker stamps every copy it stores with
 * `X-TideLog-Fetched-At`, so an offline answer from its cache says how old it is,
 * and adds `X-TideLog-From-Cache` only when it falls back to that cache. No
 * from-cache header means the read reached the server, which is what LIVE means
 * (SVD-21) — `navigator.onLine` only reports a network interface, not whether
 * the harbor server actually answered.
 */
async function fetchData(url) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${url} timed out`)), REFRESH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readData(url), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const get = res.headers && res.headers.get ? (name) => res.headers.get(name) : () => null;
  const stamped = Number(get('X-TideLog-Fetched-At'));
  return {
    data: await res.json(),
    fetchedAt: stamped > 0 ? stamped : Date.now(),
    fromCache: get('X-TideLog-From-Cache') === '1',
  };
}

// SVD-13 offline support. The service worker serves harbor data from a cache
// when offline, so a read still SUCCEEDS with no network. The last-synced time
// is the fetch time of the OLDEST data on screen, read off the response itself
// (see fetchData), never the moment the page asked.
//
// SVD-21: the connection badge now reflects where the DATA came from, not just
// `navigator.onLine` — which reports a network interface, so a captive portal,
// flaky wifi, or a dead server can leave the OS "online" while every read is
// served from the SW's fallback cache. LIVE means the last refresh's reads all
// reached the server. `lastRefreshLive` carries that verdict from refresh() to
// renderSyncState(): true = all reads were fresh, false = some/all were cached or
// the reads failed outright, null = no refresh has completed yet.
const LAST_SYNCED_KEY = 'tidelog:last-synced';
let lastRefreshLive = null;

// Bumped every time the connection drops. A refresh records a LIVE verdict only
// if no drop happened while its reads were in flight: reads that started before
// a drop and land after it say nothing about the connection that comes back, and
// letting them set LIVE would restore the badge on reconnect before any fresh
// read has landed (Copilot on #59). Recording `false` is always safe.
let connectionEpoch = 0;

// One refresh at a time (SVD-23). Refreshes are requested from several places
// (the 30 s timer, the type filter, reconnect, a successful Depart) and used to
// run concurrently, finishing in any order; every fix for that (sequence marks,
// a filter-key check) found another seam. Now a request while one is running is
// coalesced into a single follow-up that starts when it finishes, so completion
// order is start order by construction.
let refreshInFlight = null; // the running cycle's promise
let refreshQueued = null; // the one follow-up, if anything asked while running
// True while #berths-message holds the post-depart "couldn't refresh" warning, so
// the next successful render can clear it without erasing a refusal.
let berthsRefreshWarning = false;

function loadLastSynced() {
  try {
    const raw = localStorage.getItem(LAST_SYNCED_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null; // storage disabled (private mode) — degrade to no timestamp
  }
}

function saveLastSynced(ts) {
  try {
    localStorage.setItem(LAST_SYNCED_KEY, String(ts));
  } catch {
    // Non-fatal; the in-memory value still drives this session's display.
  }
}

let lastSyncedAt = loadLastSynced();

/** Reflect the real connection state and the age of the data on screen. */
function renderSyncState() {
  const online = navigator.onLine;

  // Three states, not two (SVD-21):
  //   OFFLINE — the device reports no network. Immediate, and it wins over
  //             everything else: there is nothing to be live against.
  //   LIVE    — online AND the last refresh's reads all reached the server.
  //   STALE   — online but the data on screen came from the SW's cache, or the
  //             last refresh failed outright. The device is connected but the
  //             board is NOT live, so "OFFLINE" would read as a bug while
  //             "LIVE" would be a lie. STALE says exactly what is true: act on
  //             this board knowing the harbor data may have moved on.
  let state;
  if (!online) state = { text: 'OFFLINE', cls: 'badge badge-offline' };
  else if (lastRefreshLive === true) state = { text: 'LIVE', cls: 'badge badge-live' };
  else state = { text: 'STALE', cls: 'badge badge-stale' };

  // Every lookup here is guarded. The shell files revalidate independently, so
  // after a deploy a returning visitor can run this app.js against an older
  // cached index.html that predates these elements. Throwing here would stop the
  // dashboard loading at all; skipping the label just leaves it unshown.
  const badge = document.getElementById('status-badge');
  if (badge) {
    badge.textContent = state.text;
    badge.className = state.cls;
  }

  const synced = document.getElementById('last-synced');
  if (!synced) return;
  if (lastSyncedAt) {
    synced.hidden = false;
    synced.textContent = `Synced ${fmtTime(lastSyncedAt)}`;
    synced.title = `Harbor data last synced ${new Date(lastSyncedAt).toLocaleString()}`;
  } else {
    synced.hidden = true;
    synced.textContent = '';
  }
}

// SVD-20: the live site runs read-only (TIDELOG_READ_ONLY), where every /api
// write is refused with a 403. The page learns this from the server so it can
// say so up front rather than letting a write fail with a bare status code.
// Demo mode is never inferred from the hostname — the server is the only source.
let readOnly = false;

async function loadReadOnly() {
  try {
    const health = await fetchJson('/api/health');
    readOnly = Boolean(health && health.readOnly);
    renderReadOnlyNotice();
  } catch {
    // Couldn't reach /api/health (e.g. offline). Keep whatever was last confirmed
    // rather than clearing a known read-only state and hiding the notice — a
    // transient failure on a reconnect must not erase it. The startup default is
    // writable, from the initial declaration above.
  }
}

/** Show the demo-mode banner once, plainly, when the server reports read-only. */
function renderReadOnlyNotice() {
  const notice = document.getElementById('readonly-notice');
  // Missing on an older cached index.html (see renderSyncState) — the banner
  // just goes unshown until the shell revalidates; writes are still explained
  // on refusal below.
  if (!notice) return;
  if (readOnly) {
    notice.hidden = false;
    notice.textContent =
      "This is a public read-only demo of TideLog — changes you make here aren't saved. Clone the repo to run a writable copy.";
  } else {
    notice.hidden = true;
    notice.textContent = '';
  }
}

/**
 * Filter berths to only those that are compatible with a vessel's
 * length and draft, and are not out of service.
 */
function filterCompatibleBerths(berths, vessel) {
  return berths.filter((berth) => {
    // Exclude out-of-service berths
    if (berth.outOfService) {
      return false;
    }
    // Check physical compatibility: LOA and draft
    if (vessel.lengthM > berth.lengthM) {
      return false; // Vessel too long for berth
    }
    if (vessel.draftM > berth.depthM) {
      return false; // Vessel draft exceeds berth depth
    }
    return true;
  });
}

/**
 * Show or clear a message inside the assign modal. `kind` styles it
 * ('warn' | 'error'); passing no text hides it.
 */
function setModalMessage(text, kind) {
  const box = document.getElementById('modal-message');
  // Missing on an older cached index.html (see renderSyncState). The write is
  // still refused; only the explanation goes unshown until the next load.
  if (!box) return;
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    box.className = 'modal-message';
    return;
  }
  box.hidden = false;
  box.textContent = text;
  box.className = `modal-message modal-message-${kind || 'warn'}`;
}

/**
 * Open the assign berth modal for a vessel.
 * Fetches compatible berths and displays them for selection.
 */
async function openAssignModal(arrival, allBerths) {
  const modal = document.getElementById('assign-modal');
  let selectedBerthId = null;

  setModalMessage(null); // clear any message left from a previous attempt

  // Filter berths for physical compatibility
  const compatibleBerths = filterCompatibleBerths(allBerths, {
    lengthM: arrival.lengthM,
    draftM: arrival.draftM,
  });

  // Render vessel info
  const vesselInfo = document.getElementById('modal-vessel-info');
  vesselInfo.replaceChildren();
  const infoRow = el('div');
  infoRow.className = 'vessel-info-row';
  infoRow.appendChild(el('span', 'vessel-info-label', 'Vessel:'));
  infoRow.appendChild(el('span', 'vessel-info-value', arrival.vesselName));
  vesselInfo.appendChild(infoRow);

  const loaRow = el('div');
  loaRow.className = 'vessel-info-row';
  loaRow.appendChild(el('span', 'vessel-info-label', 'LOA / Draft:'));
  loaRow.appendChild(el('span', 'vessel-info-value', `${arrival.lengthM} m / ${arrival.draftM} m`));
  vesselInfo.appendChild(loaRow);

  // Render berth options or "no berths" message
  const berthsList = document.getElementById('modal-berths-list');
  const noBerths = document.getElementById('modal-no-berths');
  const confirmBtn = document.getElementById('modal-confirm');

  berthsList.replaceChildren();
  selectedBerthId = null;
  confirmBtn.disabled = true;

  if (compatibleBerths.length === 0) {
    noBerths.hidden = false;
    berthsList.hidden = true;
  } else {
    noBerths.hidden = true;
    berthsList.hidden = false;

    for (const berth of compatibleBerths) {
      const label = el('label', 'berth-option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'berth-selection';
      radio.value = berth.id;
      radio.addEventListener('change', () => {
        selectedBerthId = berth.id;
        confirmBtn.disabled = false;
      });
      label.appendChild(radio);

      const info = el('div', 'berth-option-info');
      const name = el('div', 'berth-option-name', `${berth.id} · ${berth.name}`);
      info.appendChild(name);
      const specs = el(
        'div',
        'berth-option-specs',
        `${berth.lengthM} m LOA · ${berth.depthM} m depth`
      );
      info.appendChild(specs);
      label.appendChild(info);

      berthsList.appendChild(label);
    }
  }

  // Set up modal actions
  const cancelBtn = document.getElementById('modal-cancel');
  const closeBtn = document.getElementById('modal-close');

  // Cancel handlers
  const handleCancel = () => {
    modal.hidden = true;
    selectedBerthId = null;
    confirmBtn.disabled = true;
  };

  cancelBtn.onclick = handleCancel;
  closeBtn.onclick = handleCancel;

  // Confirm handler
  confirmBtn.onclick = async () => {
    if (!selectedBerthId) return;

    // Refuse writes while offline rather than half-building a sync queue: a
    // queued berth assignment can be invalid on replay (the berth may be taken),
    // and refusing double bookings is the whole point of TideLog. The selection
    // is left intact so nothing the operator entered is lost — reconnect and
    // confirm again. (See SVD-13: writes are deliberately not queued.)
    if (!navigator.onLine) {
      setModalMessage(
        "You're offline — a berth assignment needs a live connection. Your selection is kept; reconnect and confirm again.",
        'warn'
      );
      return;
    }

    try {
      const res = await fetch(`/api/arrivals/${arrival.id}/assign-berth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: arrival.eta,
          to: new Date(new Date(arrival.eta).getTime() + 8 * 3600_000).toISOString(),
        }),
      });

      if (res.ok) {
        handleCancel();
        await refresh(); // Refresh the entire page to show the updated assignment
      } else {
        // Show the server's own words (the read-only demo message, a 409, etc.),
        // never a bare status code. The selection stays so nothing is lost.
        setModalMessage(
          await readErrorMessage(res, 'The berth could not be assigned. Please try again.'),
          'error'
        );
      }
    } catch {
      // The connection dropped mid-submit. Treat it like offline: keep the
      // selection so the operator can retry once they are back online.
      setModalMessage(
        "Couldn't reach the harbor server — your connection may have dropped. Your selection is kept; try again in a moment.",
        'warn'
      );
    }
  };

  // Show modal
  modal.hidden = false;
}

function renderArrivals(arrivals, berths) {
  const body = document.getElementById('arrivals-body');
  body.replaceChildren();

  if (arrivals.length === 0) {
    const row = el('tr');
    const cell = el('td', 'empty', 'No arrivals logged yet.');
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  const sorted = [...arrivals].sort((a, b) => new Date(a.eta) - new Date(b.eta));
  for (const arrival of sorted) {
    const row = el('tr');

    const vessel = el('td', 'vessel', arrival.vesselName);
    if (arrival.imo) vessel.appendChild(el('span', 'imo', arrival.imo));
    row.appendChild(vessel);

    const type = el('td');
    type.appendChild(el('span', 'pill pill-type', arrival.vesselType));
    row.appendChild(type);

    row.appendChild(el('td', null, `${arrival.lengthM} m`));
    row.appendChild(el('td', null, `${arrival.draftM} m`));
    row.appendChild(el('td', null, fmtDayTime(arrival.eta)));

    const status = el('td');
    status.appendChild(el('span', `pill pill-${arrival.status}`, arrival.status));
    row.appendChild(status);

    // Add Assign button cell
    const actionCell = el('td');
    if (!arrival.berth && arrival.status === 'expected') {
      const btn = el('button', 'btn-assign', 'Assign');
      btn.type = 'button';
      btn.addEventListener('click', () => openAssignModal(arrival, berths));
      actionCell.appendChild(btn);
    }
    row.appendChild(actionCell);

    body.appendChild(row);
  }

  document.getElementById('arrivals-count').textContent =
    `${arrivals.length} vessel${arrivals.length === 1 ? '' : 's'} logged`;
}

/**
 * Show or clear a message in the berth board panel. `kind` styles it
 * ('warn' | 'error'); passing no text hides it. Guarded for an older cached
 * index.html that predates the element (see renderSyncState).
 */
function setBerthsMessage(text, kind) {
  let box = document.getElementById('berths-message');
  if (!box) {
    // An older cached index.html has no #berths-message, but this app.js still
    // renders Depart buttons there, so a refusal would be silent. Create the box
    // beside the berth list rather than drop the message (Copilot on #60).
    if (!text) return;
    const list = document.getElementById('berth-list');
    if (!list || !list.parentNode) return;
    box = document.createElement('div');
    box.id = 'berths-message';
    box.setAttribute('role', 'alert');
    list.parentNode.insertBefore(box, list);
  }
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    box.className = 'panel-message';
    return;
  }
  box.hidden = false;
  box.textContent = text;
  box.className = `panel-message panel-message-${kind || 'warn'}`;
}

/**
 * Log the departure of a vessel occupying a berth, then refresh so the board,
 * the arrivals log and the Berths-Occupied stat update together (SVD-18/SVD-19).
 * The vessel stays in the log as `departed`; the server releases the berth.
 */
async function departVessel(arrivalId, btn) {
  setBerthsMessage(null); // clear any message from a previous attempt
  berthsRefreshWarning = false;

  // Refuse while offline rather than queue: a departure logged against a stale
  // board could be wrong, and the live demo refuses writes anyway (SVD-13/20).
  if (!navigator.onLine) {
    setBerthsMessage(
      "You're offline — logging a departure needs a live connection. Reconnect and try again.",
      'warn'
    );
    return;
  }

  // Disable the clicked button while the request is in flight so a double-click
  // can't fire two departures — the second would land a 409 and leave a success
  // sitting next to an error. On success refresh() replaces the whole board, so
  // this button goes away; on any failure path it is re-enabled below.
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/arrivals/${arrivalId}/depart`, { method: 'POST' });
    if (res.ok) {
      // The departure is logged either way. If the board could not be re-read,
      // say so: otherwise the clicked button just sits disabled with no sign the
      // departure worked. It stays disabled, since re-enabling a departed
      // vessel's button would only invite a 409 (Copilot on #60).
      if (!(await refresh())) {
        setBerthsMessage(
          "Departure logged. The board couldn't refresh just now and will catch up on the next update.",
          'warn'
        );
        berthsRefreshWarning = true;
      }
    } else {
      // Show the server's own words — the read-only 403 message, or a 409 when
      // the vessel is no longer in a departable state — never a bare code or
      // silence (SVD-20).
      if (btn) btn.disabled = false;
      setBerthsMessage(
        await readErrorMessage(res, 'The departure could not be logged. Please try again.'),
        'error'
      );
    }
  } catch {
    // The connection dropped mid-request. Say so rather than leaving the click
    // unexplained.
    if (btn) btn.disabled = false;
    setBerthsMessage(
      "Couldn't reach the harbor server to log the departure — check your connection and try again.",
      'warn'
    );
  }
}

function renderBerths(berths) {
  const list = document.getElementById('berth-list');
  list.replaceChildren();

  for (const berth of berths) {
    const item = el('li', 'berth');

    // Show maintenance status with different lamp color
    const lampClass = berth.outOfService ? 'maintenance' : berth.occupied ? 'occupied' : 'free';
    item.appendChild(el('span', `berth-lamp ${lampClass}`));

    const info = el('div');
    info.appendChild(el('div', 'berth-name', `${berth.id} · ${berth.name}`));
    info.appendChild(el('div', 'berth-spec', `${berth.lengthM} m LOA · ${berth.depthM} m depth`));
    item.appendChild(info);

    const occupant = el('div', 'berth-occupant');
    // Render every occupant, not just the first: a rafting berth can hold
    // several vessels (lib/berths.js) and the board used to show only
    // berth.occupant, hiding the rest. occupants comes straight from the berths
    // endpoint, NOT the type-filtered arrivals list, so a filtered-out vessel
    // keeps its tile and its Depart button (SVD-18).
    const occupants = berth.occupants || (berth.occupant ? [berth.occupant] : []);

    // Maintenance and occupancy are independent: POST /:id/maintenance toggles
    // outOfService without releasing assignments (routes/berths.js), so a berth
    // can be both. Render each on its own and only say "Available" when neither
    // applies — otherwise a maintenance flag would hide the Depart controls.
    if (berth.outOfService) {
      const maint = el('div', 'maint-line');
      maint.appendChild(document.createTextNode('🔧 Maintenance'));
      if (berth.maintenanceReason) {
        maint.appendChild(el('span', 'maint-reason', berth.maintenanceReason));
      }
      occupant.appendChild(maint);
    }

    for (const occ of occupants) {
      const line = el('div', 'occupant-line');
      line.appendChild(document.createTextNode(occ.vesselName));
      line.appendChild(el('span', 'until', `until ${fmtDayTime(occ.to)}`));
      // Depart only for occupants the /depart endpoint accepts. An expected
      // (not-yet-arrived) vessel has no departure to log, and there is no
      // unassign endpoint — leaving that out of scope (SVD-18).
      if (occ.status === 'arrived' || occ.status === 'overdue') {
        const departBtn = el('button', 'btn-depart', 'Depart');
        departBtn.type = 'button';
        // Every Depart button reads "Depart"; on a rafted berth that is
        // ambiguous to assistive tech, which does not pick up the sibling
        // vessel text, so name the vessel in the accessible label.
        departBtn.setAttribute('aria-label', `Depart ${occ.vesselName}`);
        departBtn.addEventListener('click', () => departVessel(occ.arrivalId, departBtn));
        line.appendChild(departBtn);
      }
      occupant.appendChild(line);
    }

    if (!berth.outOfService && occupants.length === 0) {
      occupant.textContent = 'Available';
    }
    item.appendChild(occupant);

    list.appendChild(item);
  }

  const occupied = berths.filter((b) => b.occupied && !b.outOfService).length;
  const maintenance = berths.filter((b) => b.outOfService).length;
  const available = berths.length - occupied - maintenance;
  document.getElementById('stat-berths').textContent = `${occupied} / ${berths.length}`;
  document.getElementById('berths-note').textContent =
    maintenance > 0
      ? `${available} available · ${maintenance} in maintenance`
      : `${available} available`;
}

function renderWindows(windows) {
  const box = document.getElementById('windows');
  box.replaceChildren();

  if (windows.length === 0) {
    box.appendChild(el('p', 'empty', 'No safe windows in the next 48 hours at this draft.'));
    document.getElementById('stat-window').textContent = 'none';
    return;
  }

  for (const w of windows) {
    const chip = el('div', 'window-chip', `${fmtDayTime(w.start)} → ${fmtDayTime(w.end)}`);
    const hours = Math.floor(w.durationMinutes / 60);
    const minutes = w.durationMinutes % 60;
    chip.appendChild(el('span', 'dur', `${hours} h ${String(minutes).padStart(2, '0')} m open`));
    box.appendChild(chip);
  }

  const now = Date.now();
  const current = windows.find((w) => new Date(w.start) <= now && now < new Date(w.end));
  const upcoming = windows.find((w) => new Date(w.start) > now);
  const stat = document.getElementById('stat-window');
  if (current) {
    stat.textContent = `open now · ${fmtTime(current.end)}`;
  } else if (upcoming) {
    stat.textContent = fmtDayTime(upcoming.start);
  } else {
    stat.textContent = 'closed';
  }
}

function getTypeFilter() {
  return document.getElementById('type-filter').value;
}

function buildArrivalsUrl() {
  const type = getTypeFilter();
  let url = '/api/arrivals';
  if (type) {
    url += `?type=${encodeURIComponent(type)}`;
  }
  return url;
}

/** Map event type identifiers to human-readable labels. */
const EVENT_LABELS = {
  arrival_confirmed: 'Arrival confirmed',
  berth_assigned: 'Berth assigned',
  vessel_overdue: 'Vessel overdue',
  departure_logged: 'Departure logged',
};

/**
 * Show or clear a message in the notifications panel. `kind` styles it
 * ('warn' | 'error'); passing no text hides it. Guarded for an older cached
 * index.html that predates the element (see renderSyncState).
 */
function setNotificationsMessage(text, kind) {
  const box = document.getElementById('notifications-message');
  if (!box) return;
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    box.className = 'panel-message';
    return;
  }
  box.hidden = false;
  box.textContent = text;
  box.className = `panel-message panel-message-${kind || 'warn'}`;
}

/** Trigger a manual resend for a delivery log entry, then refresh the panel. */
async function resendDelivery(deliveryId) {
  setNotificationsMessage(null); // clear any message from a previous attempt
  try {
    const res = await fetch(`/api/webhooks/deliveries/${deliveryId}/resend`, { method: 'POST' });
    if (!res.ok) {
      // A 403 does not throw, so this used to fail in silence on the read-only
      // demo. Report the server's own message instead of swallowing it.
      setNotificationsMessage(
        await readErrorMessage(res, 'The notification could not be resent. Please try again.'),
        'error'
      );
      return;
    }
    await refreshNotifications();
  } catch {
    // The connection dropped. Say so rather than leaving the click unexplained.
    setNotificationsMessage(
      "Couldn't reach the harbor server to resend — check your connection and try again.",
      'warn'
    );
  }
}

function renderNotifications(deliveries) {
  const body = document.getElementById('notifications-body');
  body.replaceChildren();

  const note = document.getElementById('notifications-note');

  if (deliveries.length === 0) {
    const row = el('tr');
    const cell = el('td', 'empty', 'No notifications sent yet.');
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    note.textContent = '';
    return;
  }

  const failed = deliveries.filter((d) => !d.ok).length;
  note.textContent =
    failed > 0 ? `${deliveries.length} sent · ${failed} failed` : `${deliveries.length} sent`;

  for (const d of deliveries) {
    const row = el('tr');

    row.appendChild(el('td', 'notif-time', fmtDayTime(d.attemptedAt)));
    row.appendChild(el('td', 'vessel', d.vesselName));
    row.appendChild(el('td', null, EVENT_LABELS[d.eventType] || d.eventType));

    // Truncate long URLs to keep the table readable.
    const urlCell = el('td', 'notif-url');
    const urlText = d.url.length > 40 ? `${d.url.slice(0, 37)}…` : d.url;
    urlCell.title = d.url;
    urlCell.textContent = urlText;
    row.appendChild(urlCell);

    const resultCell = el('td');
    if (d.ok) {
      resultCell.appendChild(el('span', 'pill pill-arrived', `${d.httpStatus} OK`));
    } else {
      const label = d.httpStatus ? `${d.httpStatus} Error` : 'Failed';
      resultCell.appendChild(el('span', 'pill pill-failed', label));
    }
    row.appendChild(resultCell);

    row.appendChild(el('td', 'notif-retry', d.retried ? 'Yes' : '—'));

    const actionCell = el('td');
    const btn = el('button', 'btn-resend', 'Resend');
    btn.type = 'button';
    btn.addEventListener('click', () => resendDelivery(d.id));
    actionCell.appendChild(btn);
    row.appendChild(actionCell);

    body.appendChild(row);
  }
}

async function refreshNotifications() {
  try {
    const data = await fetchJson('/api/webhooks/deliveries?limit=20');
    renderNotifications(data.deliveries);
  } catch {
    // Non-fatal; keep showing last known state.
  }
}

/**
 * Re-read and re-render the board, one cycle at a time. Resolves true when the
 * board on screen is current, false when the reads failed. A caller that just
 * wrote (Depart) gets the result of a cycle that STARTED after its write: if one
 * was already running, it gets the follow-up (SVD-18, SVD-23).
 */
function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = runRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }
  if (!refreshQueued) {
    // Starts once the running cycle has settled (its finally() has cleared
    // refreshInFlight), and reads the filter and connection state at THAT time.
    refreshQueued = refreshInFlight.then(() => {
      refreshQueued = null;
      return refresh();
    });
  }
  return refreshQueued;
}

async function runRefresh() {
  let rendered = false;
  const epoch = connectionEpoch;
  try {
    const reads = await Promise.all([
      fetchData(buildArrivalsUrl()),
      fetchData('/api/berths'),
      fetchData(`/api/tides/windows?draftM=${REFERENCE_DRAFT_M}`),
    ]);
    const [arrivalsRes, berthsRes, windowsRes] = reads.map((r) => r.data);

    renderArrivals(arrivalsRes.arrivals, berthsRes.berths);
    renderBerths(berthsRes.berths);
    renderWindows(windowsRes.windows);

    const arrivals = arrivalsRes.arrivals;
    document.getElementById('stat-expected').textContent = arrivals.filter(
      (a) => a.status === 'expected'
    ).length;
    document.getElementById('stat-inport').textContent = arrivals.filter(
      (a) => a.status === 'arrived'
    ).length;

    // The board is only as fresh as its oldest read, so that is the time shown.
    // It comes from the responses themselves: offline, these are cached copies
    // still stamped with when they were really fetched.
    rendered = true;
    // The board caught up, so a "couldn't refresh" warning is no longer true.
    // Refusal messages are left alone: they describe an action, not the board.
    if (berthsRefreshWarning) {
      berthsRefreshWarning = false;
      setBerthsMessage(null);
    }
    lastSyncedAt = Math.min(...reads.map((r) => r.fetchedAt));
    saveLastSynced(lastSyncedAt);

    // LIVE only if every read reached the server (none came from the SW's
    // fallback cache, SVD-21) AND no drop happened while they were in flight:
    // even one cycle can straddle a drop, and reads from before it say nothing
    // about the connection that came back.
    lastRefreshLive = epoch === connectionEpoch && reads.every((r) => !r.fromCache);
  } catch {
    // Reads failed (offline with a cold cache, or a transient error). The board
    // on screen is the last good render, which is not live — a failed refresh
    // must not leave a stale LIVE badge standing (SVD-21).
    lastRefreshLive = false;
  }

  renderSyncState();
  // Not awaited: the notifications panel is not part of the board, has its own
  // error handling, and its endpoint is network-only with no timeout. Holding
  // the single-flight lock on it would let one hung request stall every later
  // board refresh (Copilot on #61).
  refreshNotifications();
  return rendered;
}

function tickClock() {
  document.getElementById('clock').textContent = timeFmt.format(new Date());
}

document.getElementById('type-filter').addEventListener('change', () => {
  refresh();
});

// Reconnecting pulls fresh data without a manual reload; going offline flips the
// badge immediately even though the last render is still on screen.
window.addEventListener('online', () => {
  renderSyncState();
  // A tab that first loaded offline couldn't reach the network-only /api/health,
  // so it never learned it was the read-only demo. Re-check on reconnect so the
  // notice still appears before the user tries to write.
  loadReadOnly();
  refresh();
});
window.addEventListener('offline', () => {
  // Reconnection must re-prove LIVE. Without clearing the verdict, the `online`
  // handler's renderSyncState() (which runs before the fresh reads land) would
  // restore the pre-offline LIVE, and a slow or hanging read would leave that
  // misleading status standing until it eventually settled (SVD-21).
  connectionEpoch += 1;
  lastRefreshLive = false;
  renderSyncState();
});

tickClock();
setInterval(tickClock, 1000);
renderSyncState(); // reflect stored last-synced + connection state before the first fetch
loadReadOnly(); // surface demo read-only mode before the user tries to write
refresh();
setInterval(refresh, REFRESH_MS);
