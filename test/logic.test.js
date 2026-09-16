import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cache } from '../lib/cache.js';
import { sampleRoute, haversine } from '../lib/route.js';
import { readHour, assess, rainIntensity, snowIntensity, describeCode } from '../lib/weather.js';

// ---------- cache ----------

test('cache: get/set/ttl/lru', async () => {
  const c = new Cache({ max: 2, ttlMs: 50 });
  c.set('a', 1); c.set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);                       // evicts b (a was refreshed by get)
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get('a'), undefined); // expired
});

test('cache: wrap coalesces concurrent calls and does not cache failures', async () => {
  const c = new Cache();
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 42; };
  const [x, y, z] = await Promise.all([c.wrap('k', fn), c.wrap('k', fn), c.wrap('k', fn)]);
  assert.deepEqual([x, y, z], [42, 42, 42]);
  assert.equal(calls, 1);

  let fails = 0;
  const bad = async () => { fails++; throw new Error('nope'); };
  await assert.rejects(c.wrap('bad', bad));
  await assert.rejects(c.wrap('bad', bad));
  assert.equal(fails, 2);
});

// ---------- sampling ----------

function fakeRoute(nCoords, secPerSeg, mPerSeg) {
  const coords = [];
  for (let i = 0; i < nCoords; i++) coords.push([40 + i * 0.01, -88 + i * 0.01]);
  const segDur = new Array(nCoords - 1).fill(secPerSeg);
  const segDist = new Array(nCoords - 1).fill(mPerSeg);
  return { coords, segDur, segDist, duration: secPerSeg * (nCoords - 1), distance: mPerSeg * (nCoords - 1) };
}

test('sampleRoute: includes first and last, respects cap, monotonic time', () => {
  const r = fakeRoute(2000, 20, 500); // ~11 hours
  const s = sampleRoute(r, { maxSamples: 40, minIntervalSec: 900 });
  assert.equal(s[0].idx, 0);
  assert.equal(s[s.length - 1].idx, 1999);
  assert.ok(s.length <= 40, `got ${s.length}`);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].tOffset > s[i - 1].tOffset);
  assert.equal(s[s.length - 1].tOffset, r.duration);
  assert.equal(s[s.length - 1].dOffset, r.distance);
});

test('sampleRoute: short trip yields exactly start and end', () => {
  const r = fakeRoute(10, 30, 400); // 4.5 min
  const s = sampleRoute(r, { maxSamples: 40, minIntervalSec: 900 });
  assert.equal(s.length, 2);
  assert.equal(s[0].idx, 0);
  assert.equal(s[1].idx, 9);
});

test('sampleRoute: honors min interval on medium trips', () => {
  const r = fakeRoute(500, 12, 300); // ~100 min
  const s = sampleRoute(r, { maxSamples: 40, minIntervalSec: 900 });
  // ~100 min / 15 min ≈ 7 intervals -> 8 samples, +/- 1 for endpoint handling
  assert.ok(s.length >= 7 && s.length <= 9, `got ${s.length}`);
});

test('sampleRoute: single-coordinate route', () => {
  const r = { coords: [[1, 2]], segDur: [], segDist: [], duration: 0, distance: 0 };
  const s = sampleRoute(r);
  assert.equal(s.length, 1);
});

test('haversine sanity', () => {
  const d = haversine([41.8781, -87.6298], [35.8681, -83.5620]); // Chicago -> Sevierville
  assert.ok(d > 720_000 && d < 780_000, `got ${d}`);
});

// ---------- weather ----------

function fakeLoc(startEpoch, hours) {
  const time = Array.from({ length: hours }, (_, i) => startEpoch + i * 3600);
  const z = (v) => new Array(hours).fill(v);
  return {
    timezone: 'America/New_York', timezone_abbreviation: 'EDT', utc_offset_seconds: -14400, elevation: 300,
    hourly: {
      time,
      temperature_2m: z(70), apparent_temperature: z(72), precipitation_probability: z(10),
      precipitation: z(0), rain: z(0), showers: z(0), snowfall: z(0), weather_code: z(1),
      cloud_cover: z(20), visibility: z(24000), wind_speed_10m: z(8), wind_gusts_10m: z(14),
      wind_direction_10m: z(180), is_day: z(1),
    },
  };
}

test('readHour: picks the containing hour and rejects out-of-window', () => {
  const start = 1_700_000_000 - (1_700_000_000 % 3600);
  const loc = fakeLoc(start, 48);
  loc.hourly.temperature_2m[5] = 55;
  const h = readHour(loc, start + 5 * 3600 + 1799); // mid-hour 5
  assert.equal(h.tempF, 55);
  assert.equal(h.hourStart, start + 5 * 3600);
  assert.equal(readHour(loc, start - 1), null);
  assert.equal(readHour(loc, start + 48 * 3600), null);
});

test('readHour: recent precip lookback', () => {
  const start = 1_700_000_000 - (1_700_000_000 % 3600);
  const loc = fakeLoc(start, 48);
  loc.hourly.precipitation[3] = 0.2;
  loc.hourly.precipitation[4] = 0.1;
  const h = readHour(loc, start + 5 * 3600);
  assert.equal(h.recentPrecipIn, 0.3);
});

test('intensity thresholds (NWS)', () => {
  assert.equal(rainIntensity(0).label, 'None');
  assert.equal(rainIntensity(0.02).label, 'Drizzle');
  assert.equal(rainIntensity(0.08).label, 'Light');
  assert.equal(rainIntensity(0.2).label, 'Moderate');
  assert.equal(rainIntensity(0.5).label, 'Heavy');
  assert.equal(rainIntensity(1.5).label, 'Torrential');
  assert.equal(snowIntensity(0.3).label, 'Light');
  assert.equal(snowIntensity(1.2).label, 'Heavy');
});

test('assess: severity ladder', () => {
  const base = { tempF: 70, feelsF: 70, precipProb: 5, precipIn: 0, rainIn: 0, showersIn: 0, snowIn: 0, code: 1, cloud: 10, visibilityM: 24000, windMph: 5, gustMph: 8, windDir: 0, isDay: true, recentPrecipIn: 0 };
  assert.equal(assess(base).severity, 0);
  assert.equal(assess({ ...base, precipIn: 0.06, code: 61 }).severity, 1);
  assert.equal(assess({ ...base, precipIn: 0.2, code: 63 }).severity, 2);
  assert.equal(assess({ ...base, precipIn: 0.5, code: 65 }).severity, 3);
  assert.equal(assess({ ...base, code: 95 }).severity, 3);
  assert.equal(assess({ ...base, visibilityM: 600 }).severity, 3);
  assert.equal(assess({ ...base, visibilityM: 1400 }).severity, 2);
  assert.equal(assess({ ...base, gustMph: 40 }).severity, 2);
  assert.equal(assess({ ...base, gustMph: 55 }).severity, 3);
  assert.equal(assess({ ...base, tempF: 30, precipIn: 0.03, code: 51 }).severity, 3);
  assert.equal(assess({ ...base, recentPrecipIn: 0.1 }).severity, 1);
  assert.equal(assess({ ...base, precipProb: 70 }).severity, 1);
  assert.equal(assess(null).severity, 0);
});

test('assess: headline is first reason, reasons carry detail', () => {
  const a = assess({ tempF: 60, precipIn: 0.25, code: 63, visibilityM: 8000, gustMph: 10, recentPrecipIn: 0 });
  assert.equal(a.headline, 'Moderate rain');
  assert.ok(a.reasons.includes('Moderate rain'));
});

test('describeCode covers common codes', () => {
  assert.equal(describeCode(0), 'Clear');
  assert.equal(describeCode(95), 'Thunderstorm');
  assert.equal(describeCode(999), 'Unknown');
});
