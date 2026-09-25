/* TideLog dashboard — vanilla JS, no build step. */

const REFRESH_MS = 30_000;
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
 * Harbor-data read that also reports WHEN the data was fetched. The service
 * worker stamps every copy it stores with `X-TideLog-Fetched-At`, so an offline
 * answer from its cache says how old it is. No header means the response came
 * straight off the network, which makes it current as of now.
 */
async function fetchData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const stamped = Number(res.headers && res.headers.get && res.headers.get('X-TideLog-Fetched-At'));
  return { data: await res.json(), fetchedAt: stamped > 0 ? stamped : Date.now() };
}

// SVD-13 offline support. The service worker serves harbor data from a cache
// when offline, so a read still SUCCEEDS with no network — which means fetch
// success can no longer tell us we are live. `navigator.onLine` and the
// online/offline events are the source of truth for the connection badge. The
// last-synced time is the fetch time of the OLDEST data on screen, read off the
// response itself (see fetchData), never the moment the page asked.
const LAST_SYNCED_KEY = 'tidelog:last-synced';

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

  // Every lookup here is guarded. The shell files revalidate independently, so
  // after a deploy a returning visitor can run this app.js against an older
  // cached index.html that predates these elements. Throwing here would stop the
  // dashboard loading at all; skipping the label just leaves it unshown.
  const badge = document.getElementById('status-badge');
  if (badge) {
    badge.textContent = online ? 'LIVE' : 'OFFLINE';
    badge.className = online ? 'badge badge-live' : 'badge badge-offline';
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
        setModalMessage(`Failed to assign berth: ${res.status} ${res.statusText}`, 'error');
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
    if (berth.outOfService) {
      occupant.textContent = '🔧 Maintenance';
      if (berth.maintenanceReason) {
        const reason = el('span', 'maint-reason', berth.maintenanceReason);
        reason.className = 'maint-reason';
        occupant.appendChild(reason);
      }
    } else if (berth.occupant) {
      occupant.appendChild(document.createTextNode(berth.occupant.vesselName));
      occupant.appendChild(el('span', 'until', `until ${fmtDayTime(berth.occupant.to)}`));
    } else {
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

/** Trigger a manual resend for a delivery log entry, then refresh the panel. */
async function resendDelivery(deliveryId) {
  try {
    await fetch(`/api/webhooks/deliveries/${deliveryId}/resend`, { method: 'POST' });
    await refreshNotifications();
  } catch {
    // Silently ignore network errors on manual resend; the log will reflect the
    // outcome on the next automatic refresh.
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

async function refresh() {
  try {
    const arrivalsUrl = buildArrivalsUrl();
    const reads = await Promise.all([
      fetchData(arrivalsUrl),
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
    lastSyncedAt = Math.min(...reads.map((r) => r.fetchedAt));
    saveLastSynced(lastSyncedAt);
  } catch {
    // Reads failed (offline with a cold cache, or a transient error). Keep the
    // last good render; renderSyncState() below shows the real connection state.
  }

  renderSyncState();
  await refreshNotifications();
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
  refresh();
});
window.addEventListener('offline', () => {
  renderSyncState();
});

tickClock();
setInterval(tickClock, 1000);
renderSyncState(); // reflect stored last-synced + connection state before the first fetch
refresh();
setInterval(refresh, REFRESH_MS);
