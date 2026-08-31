'use strict';

/**
 * Webhook delivery engine for TideLog port-call events.
 *
 * Subscriptions tie a URL to a vessel name. When a port-call event fires,
 * every matching subscription receives an HTTP POST.  Failed deliveries are
 * retried once after RETRY_DELAY_MS.  Every attempt — success or failure —
 * is appended to the delivery log so the harbor office has an audit trail.
 *
 * Supported event types:
 *   arrival_confirmed   – vessel status changed to "arrived"
 *   berth_assigned      – a berth was assigned (or re-assigned) to a vessel
 *   vessel_overdue      – vessel is past ETA and still "expected"
 *   departure_logged    – vessel departure has been recorded
 */

const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Attempt a single HTTP POST delivery.  Returns `{ ok, status, error }`.
 *
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null}>}
 */
async function attemptDelivery(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, error: null };
  } catch (err) {
    return { ok: false, status: null, error: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver an event payload to a single subscription URL, with one retry on
 * failure.  Appends one or two entries to `deliveryLog`.
 *
 * @param {object}   sub         - subscription record `{ id, vesselName, url }`
 * @param {object}   event       - the event payload to POST
 * @param {object[]} deliveryLog - mutable array to push log entries into
 * @returns {Promise<void>}
 */
async function deliverToSubscription(sub, event, deliveryLog) {
  const attemptedAt = new Date().toISOString();
  const result = await attemptDelivery(sub.url, event);

  /** @type {object} */
  const entry = {
    id: `DLV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    subscriptionId: sub.id,
    vesselName: sub.vesselName,
    url: sub.url,
    eventType: event.eventType,
    attemptedAt,
    ok: result.ok,
    httpStatus: result.status,
    error: result.error,
    retried: false,
  };
  deliveryLog.push(entry);

  if (!result.ok) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    const retryAt = new Date().toISOString();
    const retryResult = await attemptDelivery(sub.url, event);
    const retryEntry = {
      id: `DLV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      subscriptionId: sub.id,
      vesselName: sub.vesselName,
      url: sub.url,
      eventType: event.eventType,
      attemptedAt: retryAt,
      ok: retryResult.ok,
      httpStatus: retryResult.status,
      error: retryResult.error,
      retried: true,
    };
    deliveryLog.push(retryEntry);
  }
}

/**
 * Fire an event to all subscriptions matching the vessel name.  Each
 * delivery runs independently (errors in one do not block others).
 *
 * @param {object[]} subscriptions - all registered subscriptions
 * @param {object[]} deliveryLog   - mutable delivery log array
 * @param {string}   vesselName
 * @param {string}   eventType     - one of the supported event type strings
 * @param {object}   [data={}]     - additional event fields
 * @returns {void}  Fires and forgets — callers are not blocked.
 */
function fireEvent(subscriptions, deliveryLog, vesselName, eventType, data = {}) {
  const matching = subscriptions.filter((s) => s.vesselName === vesselName);
  if (matching.length === 0) return;

  const event = {
    eventType,
    vesselName,
    firedAt: new Date().toISOString(),
    ...data,
  };

  for (const sub of matching) {
    // Intentionally fire-and-forget so the HTTP handler returns immediately.
    deliverToSubscription(sub, event, deliveryLog).catch(() => {
      // Delivery failures are already recorded in the log; swallow here.
    });
  }
}

module.exports = { fireEvent, deliverToSubscription, attemptDelivery };
