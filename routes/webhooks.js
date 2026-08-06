'use strict';

/**
 * Webhook subscription management and delivery log routes.
 *
 * POST   /api/webhooks                   – register a subscription
 * GET    /api/webhooks?vesselName=…      – list subscriptions (optionally filtered)
 * DELETE /api/webhooks/:id               – remove a subscription
 * GET    /api/webhooks/deliveries        – recent delivery log (newest first)
 * POST   /api/webhooks/deliveries/:id/resend – manually resend a logged delivery
 */

const express = require('express');

const { deliverToSubscription } = require('../lib/webhooks');
const db = require('./db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** Register a new webhook subscription for a vessel. */
router.post('/', (req, res) => {
  const { vesselName, url } = req.body || {};
  const errors = [];

  if (!vesselName || typeof vesselName !== 'string' || !vesselName.trim()) {
    errors.push('vesselName is required');
  }
  if (!url || typeof url !== 'string' || !url.trim()) {
    errors.push('url is required');
  } else {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push('url must use http or https');
      }
    } catch {
      errors.push('url must be a valid URL');
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const id = `WH-${String(++db.state.nextWebhookId).padStart(4, '0')}`;
  const subscription = {
    id,
    vesselName: vesselName.trim(),
    url: url.trim(),
    createdAt: new Date().toISOString(),
  };
  db.state.subscriptions.push(subscription);
  return res.status(201).json({ subscription });
});

/** List registered subscriptions, optionally filtered by vessel name. */
router.get('/', (req, res) => {
  let subs = [...db.state.subscriptions];
  if (req.query.vesselName) {
    subs = subs.filter((s) => s.vesselName === req.query.vesselName);
  }
  return res.json({ subscriptions: subs });
});

/** Remove a subscription by id. */
router.delete('/:id', (req, res) => {
  const idx = db.state.subscriptions.findIndex((s) => s.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'subscription not found' });
  }
  const [removed] = db.state.subscriptions.splice(idx, 1);
  return res.json({ deleted: removed });
});

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

/**
 * Recent delivery log entries, newest first.
 * Optional query params: vesselName, eventType, limit (default 50).
 */
router.get('/deliveries', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  let entries = [...db.state.deliveryLog].reverse();

  if (req.query.vesselName) {
    entries = entries.filter((e) => e.vesselName === req.query.vesselName);
  }
  if (req.query.eventType) {
    entries = entries.filter((e) => e.eventType === req.query.eventType);
  }

  return res.json({ deliveries: entries.slice(0, limit) });
});

/**
 * Manually resend a specific delivery. Looks up the original log entry,
 * reconstructs a minimal event payload, and fires to the same URL.
 * A new log entry is appended for the resend attempt.
 */
router.post('/deliveries/:id/resend', (req, res) => {
  const entry = db.state.deliveryLog.find((e) => e.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'delivery not found' });
  }

  const sub = {
    id: entry.subscriptionId,
    vesselName: entry.vesselName,
    url: entry.url,
  };
  const event = {
    eventType: entry.eventType,
    vesselName: entry.vesselName,
    firedAt: new Date().toISOString(),
    resent: true,
    originalDeliveryId: entry.id,
  };

  // Kick off delivery asynchronously; respond immediately with accepted.
  deliverToSubscription(sub, event, db.state.deliveryLog).catch(() => {});
  return res.status(202).json({ message: 'resend accepted', deliveryId: entry.id });
});

module.exports = router;
