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
 * Open the assign berth modal for a vessel.
 * Fetches compatible berths and displays them for selection.
 */
async function openAssignModal(arrival, allBerths) {
  const modal = document.getElementById('assign-modal');
  let selectedBerthId = null;

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
        alert(`Failed to assign berth: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      alert(`Error assigning berth: ${err.message}`);
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
    const [arrivalsRes, berthsRes, windowsRes] = await Promise.all([
      fetchJson(arrivalsUrl),
      fetchJson('/api/berths'),
      fetchJson(`/api/tides/windows?draftM=${REFERENCE_DRAFT_M}`),
    ]);

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
    document.getElementById('status-badge').textContent = 'LIVE';
  } catch {
    document.getElementById('status-badge').textContent = 'OFFLINE';
  }

  await refreshNotifications();
}

function tickClock() {
  document.getElementById('clock').textContent = timeFmt.format(new Date());
}

document.getElementById('type-filter').addEventListener('change', () => {
  refresh();
});

tickClock();
setInterval(tickClock, 1000);
refresh();
setInterval(refresh, REFRESH_MS);
