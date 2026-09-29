// RK Warehouse — entry point
const express = require('express');
const path = require('path');
const { pool, migrate } = require('./src/db');
const { requireLogin } = require('./src/auth');
const { router: locationsRouter, AppError } = require('./src/routes/locations');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(requireLogin);
app.use(express.json({ limit: '100kb' }));

app.use('/api', locationsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('/', (req, res) => res.redirect('/locations'));
app.get('/locations', (req, res) => res.sendFile(path.join(__dirname, 'public', 'locations.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Central error handler: clear messages for expected errors, no internals leaked otherwise
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, field: err.field || null });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request was not valid.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Nothing was saved. Try again.' });
});

const PORT = process.env.PORT || 3000;

migrate()
  .then(() => app.listen(PORT, () => console.log(`RK Warehouse running on port ${PORT}`)))
  .catch((err) => {
    console.error('FATAL: could not prepare the database:', err.message);
    process.exit(1);
  });
