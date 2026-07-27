'use strict';

/**
 * In-memory store for the TideLog demo. A Map of arrivals, an array of
 * berth assignments, the harbor's berth registry, and a generated tide
 * table for the next 48 hours. No real database — restarting the server
 * resets the log.
 */

/** Charted depth of the approach channel at chart datum (meters). */
const CHANNEL_DEPTH_M = 6.0;

const BERTH_SEED = [
  { id: 'B1', name: 'Quayside North', lengthM: 90, depthM: 7.5 },
  { id: 'B2', name: 'Quayside South', lengthM: 120, depthM: 9.0 },
  { id: 'B3', name: 'East Pier 1', lengthM: 60, depthM: 5.5 },
  { id: 'B4', name: 'East Pier 2', lengthM: 45, depthM: 4.0 },
  { id: 'B5', name: 'Deepwater Terminal', lengthM: 180, depthM: 12.0 },
  { id: 'B6', name: "Fisherman's Wharf", lengthM: 30, depthM: 3.5 },
];

/** Semidiurnal tide period (M2 constituent), in hours. */
const TIDE_PERIOD_HOURS = 12.42;
const TIDE_MEAN_M = 2.5;
const TIDE_AMPLITUDE_M = 1.9;

/**
 * Hourly tide predictions for 48 hours starting at local midnight today.
 * A simple cosine on the M2 period — good enough for a harbor demo, and
 * deterministic for a given start time.
 */
function buildTideTable(start = defaultTideStart()) {
  const startMillis = start.getTime();
  const entries = [];
  for (let hour = 0; hour <= 48; hour += 1) {
    const t = startMillis + hour * 3600_000;
    const phase = (2 * Math.PI * hour) / TIDE_PERIOD_HOURS;
    const heightM = Math.round((TIDE_MEAN_M + TIDE_AMPLITUDE_M * Math.cos(phase)) * 100) / 100;
    entries.push({ time: new Date(t).toISOString(), heightM });
  }
  return entries;
}

function defaultTideStart() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
}

const state = {
  arrivals: new Map(),
  assignments: [],
  berths: [],
  tideTable: [],
  nextArrivalId: 1,
};

/** Restore the store to a clean seeded state (berths + tide table only). */
function reset() {
  state.arrivals.clear();
  state.assignments = [];
  state.berths = BERTH_SEED.map((berth) => ({ ...berth }));
  state.tideTable = buildTideTable();
  state.nextArrivalId = 1;
}

function createArrival(fields) {
  const id = `ARR-${String(state.nextArrivalId).padStart(3, '0')}`;
  state.nextArrivalId += 1;
  const arrival = { id, ...fields };
  state.arrivals.set(id, arrival);
  return arrival;
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

/** A believable day in port, so the dashboard is never empty on camera. */
function seedDemoData() {
  const selkie = createArrival({
    vesselName: 'Selkie',
    vesselType: 'fishing',
    lengthM: 24,
    draftM: 2.8,
    imo: null,
    eta: hoursFromNow(-3),
    status: 'arrived',
    arrivedAt: hoursFromNow(-2.5),
    loggedAt: hoursFromNow(-6),
    agent: 'Harbor office',
  });
  state.assignments.push({
    berthId: 'B6',
    arrivalId: selkie.id,
    vesselName: selkie.vesselName,
    from: hoursFromNow(-2.5),
    to: hoursFromNow(9.5),
  });

  const tarn = createArrival({
    vesselName: 'Tarn Voyager',
    vesselType: 'tanker',
    lengthM: 110,
    draftM: 8.1,
    imo: 'IMO 9074729',
    eta: hoursFromNow(-1.5),
    status: 'arrived',
    arrivedAt: hoursFromNow(-1),
    loggedAt: hoursFromNow(-8),
    agent: 'Meridian Shipping',
  });
  state.assignments.push({
    berthId: 'B2',
    arrivalId: tarn.id,
    vesselName: tarn.vesselName,
    from: hoursFromNow(-1),
    to: hoursFromNow(15),
  });

  const coble = createArrival({
    vesselName: 'Coble Runner',
    vesselType: 'tug',
    lengthM: 28,
    draftM: 3.2,
    imo: null,
    eta: hoursFromNow(-0.5),
    status: 'arrived',
    arrivedAt: hoursFromNow(-0.25),
    loggedAt: hoursFromNow(-5),
  });
  state.assignments.push({
    berthId: 'B4',
    arrivalId: coble.id,
    vesselName: coble.vesselName,
    from: hoursFromNow(-0.25),
    to: hoursFromNow(6),
  });

  createArrival({
    vesselName: 'MV Northern Star',
    vesselType: 'cargo',
    lengthM: 85,
    draftM: 6.2,
    imo: 'IMO 9319466',
    eta: hoursFromNow(2),
    status: 'expected',
    loggedAt: hoursFromNow(-10),
    agent: 'Meridian Shipping',
  });

  createArrival({
    vesselName: 'Marlin Quest',
    vesselType: 'yacht',
    lengthM: 18,
    draftM: 2.1,
    imo: null,
    eta: hoursFromNow(5),
    status: 'expected',
    loggedAt: hoursFromNow(-1),
  });
}

reset();

module.exports = {
  CHANNEL_DEPTH_M,
  state,
  reset,
  createArrival,
  buildTideTable,
  seedDemoData,
};
