import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { autocomplete, reverse } from './lib/geocode.js';
import { buildPlan } from './lib/plan.js';
import { validateCoord } from './lib/route.js';
import { BadRequest, UpstreamError } from './lib/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '16kb' }));

// Basic hardening headers. No CSP so the Carto tiles and Google Fonts load without config.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const limiter = rateLimit({
  windowMs: (Number(process.env.RATE_LIMIT_WINDOW_SEC) || 60) * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a minute and try again.' },
});
app.use('/api/', limiter);

// ---------- API ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Math.floor(Date.now() / 1000) });
});

app.get('/api/geocode', async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const lat = req.query.lat != null ? Number(req.query.lat) : undefined;
    const lng = req.query.lng != null ? Number(req.query.lng) : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : 6;
    const bias = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {};
    const results = await autocomplete(q, { ...bias, limit });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({ results });
  } catch (err) { next(err); }
});

app.get('/api/reverse', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    validateCoord(lat, lng, 'Location');
    const label = await reverse(lat, lng);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ label });
  } catch (err) { next(err); }
});

app.post('/api/plan', async (req, res, next) => {
  try {
    const { from, to, departAt } = req.body || {};
    if (!from || !to) throw new BadRequest('Both a starting point and a destination are required.');

    const f = { lat: Number(from.lat), lng: Number(from.lng), label: cleanLabel(from.label) };
    const t = { lat: Number(to.lat), lng: Number(to.lng), label: cleanLabel(to.label) };
    validateCoord(f.lat, f.lng, 'Starting point');
    validateCoord(t.lat, t.lng, 'Destination');

    const depart = Number(departAt);
    const plan = await buildPlan({ from: f, to: t, departAt: depart });
    res.setHeader('Cache-Control', 'no-store');
    res.json(plan);
  } catch (err) { next(err); }
});

function cleanLabel(s) {
  if (s == null) return undefined;
  const str = String(s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return str ? str.slice(0, 160) : undefined;
}

// ---------- Static ----------

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  index: 'index.html',
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Errors ----------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof BadRequest) {
    return res.status(400).json({ error: err.message, details: err.details });
  }
  if (err instanceof UpstreamError) {
    const friendly = {
      router: 'The routing service is having trouble. Try again in a moment.',
      weather: 'The weather service is having trouble. Try again in a moment.',
      geocoder: 'Place search is having trouble. Try again in a moment.',
    }[err.service] || 'An upstream service is having trouble. Try again in a moment.';
    console.error(`[${err.service}] ${err.message}`);
    return res.status(err.status === 429 ? 429 : 502).json({ error: friendly, service: err.service });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`weather-down-the-road listening on http://localhost:${PORT}`);
  });
}

export default app;
