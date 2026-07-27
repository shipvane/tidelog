'use strict';

const path = require('path');

const express = require('express');

const arrivalsRouter = require('./routes/arrivals');
const berthsRouter = require('./routes/berths');
const tidesRouter = require('./routes/tides');
const db = require('./routes/db');

const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tidelog' });
});

app.use('/api/arrivals', arrivalsRouter);
app.use('/api/berths', berthsRouter);
app.use('/api/tides', tidesRouter);

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
