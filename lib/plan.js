import { getRoute, sampleRoute, haversine } from './route.js';
import { fetchForecasts, readHour, assess, describeCode, FORECAST_DAYS, PAST_DAYS, SEVERITY_LABEL } from './weather.js';
import { reverse } from './geocode.js';
import { mapLimit, BadRequest } from './http.js';

const MAX_PAST_SEC = 24 * 3600;
const MAX_FUTURE_SEC = (FORECAST_DAYS - 1) * 24 * 3600; // leave a day of headroom for the drive itself

/**
 * @param {{ from:{lat,lng,label?}, to:{lat,lng,label?}, departAt:number }} input
 *   departAt is a UTC epoch in seconds.
 */
export async function buildPlan({ from, to, departAt }) {
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(departAt)) throw new BadRequest('Departure time is missing or invalid.');
  if (departAt < now - MAX_PAST_SEC) throw new BadRequest('Departure is more than a day in the past. Pick a time closer to now.');
  if (departAt > now + MAX_FUTURE_SEC) {
    throw new BadRequest(`Forecasts only run ${FORECAST_DAYS} days out. Pick a departure within the next ${FORECAST_DAYS - 1} days.`);
  }
  if (haversine([from.lat, from.lng], [to.lat, to.lng]) < 100) {
    throw new BadRequest('Start and destination are the same spot. Pick two different places.');
  }

  const route = await getRoute(from, to);

  if (route.duration > 5 * 24 * 3600) {
    throw new BadRequest('That drive is over five days nonstop, which is past what a single-shot forecast can cover well. Split it into legs.');
  }
  const arrivalAt = departAt + Math.round(route.duration);
  if (arrivalAt > now + FORECAST_DAYS * 24 * 3600) {
    throw new BadRequest('The drive ends beyond the 16-day forecast window. Leave earlier or pick a shorter route.');
  }

  const samples = sampleRoute(route, { maxSamples: 40, minIntervalSec: 15 * 60 });

  // One batched weather call for every sample point.
  const forecasts = await fetchForecasts(samples);

  // Reverse-geocode in parallel with a small pool; failures degrade to distance labels.
  const names = await mapLimit(samples, 4, (s) => reverse(s.lat, s.lng));

  const points = samples.map((s, i) => {
    const at = departAt + Math.round(s.tOffset);
    const h = readHour(forecasts[i], at);
    const a = assess(h);
    const local = h ? at + h.utcOffset : null;
    const isFirst = i === 0;
    const isLast = i === samples.length - 1;
    const fallback = isFirst ? (from.label || 'Start') : isLast ? (to.label || 'Destination') : `Mile ${Math.round(s.dOffset / 1609.344)}`;

    return {
      i,
      lat: s.lat,
      lng: s.lng,
      name: isFirst ? (from.label || names[i] || fallback) : isLast ? (to.label || names[i] || fallback) : (names[i] || fallback),
      atUtc: at,
      atLocal: local,
      tz: h?.tz ?? null,
      tzAbbr: h?.tzAbbr ?? null,
      elapsedSec: Math.round(s.tOffset),
      distanceMi: round1(s.dOffset / 1609.344),
      elevationFt: h?.elevationM != null ? Math.round(h.elevationM * 3.28084) : null,
      weather: h
        ? {
            condition: describeCode(h.code),
            code: h.code,
            isDay: h.isDay,
            tempF: r(h.tempF),
            feelsF: r(h.feelsF),
            precipProb: r(h.precipProb),
            precipIn: round2(h.precipIn),
            rainIn: round2(h.rainIn),
            snowIn: round2(h.snowIn),
            rainLabel: a.rain?.label ?? 'None',
            snowLabel: a.snow?.label ?? 'None',
            recentPrecipIn: h.recentPrecipIn,
            cloud: r(h.cloud),
            visibilityMi: a.visMi,
            windMph: r(h.windMph),
            gustMph: r(h.gustMph),
            windDir: r(h.windDir),
            windCardinal: cardinal(h.windDir),
          }
        : null,
      severity: a.severity,
      severityLabel: SEVERITY_LABEL[a.severity],
      headline: a.headline,
      reasons: a.reasons,
    };
  });

  const summary = summarize(points, route);

  return {
    from: { lat: from.lat, lng: from.lng, label: from.label || points[0].name },
    to: { lat: to.lat, lng: to.lng, label: to.label || points[points.length - 1].name },
    departAt,
    arrivalAt,
    durationSec: Math.round(route.duration),
    distanceMi: round1(route.distance / 1609.344),
    geometry: route.coords, // [lat,lng][]
    points,
    summary,
    generatedAt: now,
    forecastHorizonDays: FORECAST_DAYS,
    pastDays: PAST_DAYS,
  };
}

function summarize(points, route) {
  const withWx = points.filter((p) => p.weather);
  const worst = withWx.reduce((a, p) => (p.severity > (a?.severity ?? -1) ? p : a), null);
  const totalRain = withWx.reduce((s, p) => s + (p.weather.precipIn || 0), 0);
  const wetMinutes = withWx.filter((p) => (p.weather.precipIn || 0) >= 0.005).length; // each sample ≈ one interval
  const sampleInterval = points.length > 1 ? (points[points.length - 1].elapsedSec - points[0].elapsedSec) / (points.length - 1) : 0;
  const wetSec = wetMinutes * sampleInterval;

  const temps = withWx.map((p) => p.weather.tempF).filter((t) => t != null);
  const maxGust = Math.max(0, ...withWx.map((p) => p.weather.gustMph || 0));
  const minVis = Math.min(99, ...withWx.map((p) => p.weather.visibilityMi ?? 99));
  const maxSev = withWx.reduce((m, p) => Math.max(m, p.severity), 0);
  const stormy = withWx.some((p) => [95, 96, 99].includes(p.weather.code));
  const freezing = withWx.some((p) => [56, 57, 66, 67, 48].includes(p.weather.code) || (p.weather.tempF != null && p.weather.tempF <= 34 && (p.weather.precipIn || 0) > 0));

  // Contiguous stretches of poor-or-worse weather, reported as spans.
  const spans = [];
  let cur = null;
  for (const p of withWx) {
    if (p.severity >= 2) {
      if (!cur) cur = { start: p, end: p, maxSev: p.severity };
      else { cur.end = p; cur.maxSev = Math.max(cur.maxSev, p.severity); }
    } else if (cur) { spans.push(cur); cur = null; }
  }
  if (cur) spans.push(cur);

  let verdict;
  if (maxSev === 0) verdict = 'Clear run. Nothing worth planning around.';
  else if (maxSev === 1) verdict = 'Mostly fine. A few stretches of light rain or wet roads.';
  else if (maxSev === 2) verdict = 'Expect some rough patches. Slow down where the route turns orange.';
  else verdict = stormy ? 'Storms on the route. Consider shifting your departure.' : freezing ? 'Freezing precipitation on the route. This is an ice day.' : 'Dangerous conditions on part of the route. Check the red stretches before committing.';

  return {
    verdict,
    maxSeverity: maxSev,
    maxSeverityLabel: SEVERITY_LABEL[maxSev],
    worstPoint: worst ? { i: worst.i, name: worst.name, headline: worst.headline, atLocal: worst.atLocal, tzAbbr: worst.tzAbbr } : null,
    totalRainIn: round2(totalRain),
    wetDrivingMin: Math.round(wetSec / 60),
    tempRangeF: temps.length ? [Math.min(...temps), Math.max(...temps)] : null,
    maxGustMph: r(maxGust),
    minVisibilityMi: minVis < 99 ? minVis : null,
    roughSpans: spans.map((s) => ({
      fromName: s.start.name, toName: s.end.name,
      fromLocal: s.start.atLocal, toLocal: s.end.atLocal, tzAbbr: s.start.tzAbbr,
      maxSeverity: s.maxSev, label: SEVERITY_LABEL[s.maxSev],
    })),
    sampleIntervalMin: Math.round(sampleInterval / 60),
    pointsWithoutData: points.length - withWx.length,
  };
}

const r = (n) => (n == null ? null : Math.round(n));
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function cardinal(deg) {
  if (deg == null) return null;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}
