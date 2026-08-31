'use strict';

const path = require('path');

const express = require('express');

const arrivalsRouter = require('./routes/arrivals');
const berthsRouter = require('./routes/berths');
const tidesRouter = require('./routes/tides');
const webhooksRouter = require('./routes/webhooks');
const db = require('./routes/db');

const app = express();

// demo.shipvane.com is a legacy alias: the app lives at tidelog.shipvane.com
// now, and the old name 301s there so existing links keep working — and so
// demo.* can later front a different demo product with nothing but a
// repointed redirect. Host-based, so both domains can stay attached to this
// one App Runner service.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (host === 'demo.shipvane.com' || host === 'www.demo.shipvane.com') {
    return res.redirect(301, `https://tidelog.shipvane.com${req.originalUrl}`);
  }
  next();
});

app.use(express.json());

// The public demo at demo.shipvane.com runs read-only: the store is in-memory
// and shared by every visitor, so one person's writes would show up in
// everyone else's harbor until the next restart. Off by default — local dev
// and the tests get the full read/write app.
if (process.env.TIDELOG_READ_ONLY === 'true') {
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  app.use('/api', (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    res.status(403).json({
      error: 'read_only',
      message: 'This is a public read-only demo of TideLog. Clone the repo to run a writable copy.',
    });
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tidelog' });
});

app.use('/api/arrivals', arrivalsRouter);
app.use('/api/berths', berthsRouter);
app.use('/api/tides', tidesRouter);
app.use('/api/webhooks', webhooksRouter);

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  db.seedDemoData();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`TideLog listening on http://localhost:${port}`);
  });
}

module.exports = app;
