import { Cache } from './cache.js';
import { fetchJson, UpstreamError } from './http.js';

const BASE = process.env.OPEN_METEO_BASE || 'https://api.open-meteo.com';
const TTL = (Number(process.env.CACHE_TTL_WEATHER) || 600) * 1000;
const cache = new Cache({ max: 500, ttlMs: TTL });

export const FORECAST_DAYS = 16;   // Open-Meteo maximum
export const PAST_DAYS = 1;        // lets "left an hour ago" still resolve

const HOURLY = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'is_day',
];

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Fetch hourly forecasts for many points in one request.
 * Points are bucketed to 0.05° (~5 km) for cache locality; forecast grids are
 * coarser than that anyway.
 * @param {{lat:number,lng:number}[]} points
 * @returns {Array} one Open-Meteo location object per input point, in order.
 */
export async function fetchForecasts(points) {
  if (!points.length) return [];

  const lats = points.map((p) => round(p.lat, 2));
  const lngs = points.map((p) => round(p.lng, 2));
  const key = lats.map((la, i) => `${la},${lngs[i]}`).join('|');

  return cache.wrap(key, async () => {
    const url = new URL('/v1/forecast', BASE);
    url.searchParams.set('latitude', lats.join(','));
    url.searchParams.set('longitude', lngs.join(','));
    url.searchParams.set('hourly', HOURLY.join(','));
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('wind_speed_unit', 'mph');
    url.searchParams.set('precipitation_unit', 'inch');
    url.searchParams.set('timeformat', 'unixtime');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', String(FORECAST_DAYS));
    url.searchParams.set('past_days', String(PAST_DAYS));

    const data = await fetchJson(url, { service: 'weather', timeoutMs: 15_000, retries: 2 });

    if (data?.error) {
      throw new UpstreamError(`Weather service rejected the request: ${data.reason || 'unknown'}`, { service: 'weather' });
    }
    // Single location comes back as an object, many as an array.
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length !== points.length) {
      throw new UpstreamError(`Weather service returned ${arr.length} locations for ${points.length} requested.`, { service: 'weather' });
    }
    for (const loc of arr) {
      if (!loc?.hourly?.time?.length) {
        throw new UpstreamError('Weather service returned no hourly data for a point on the route.', { service: 'weather' });
      }
    }
    return arr;
  });
}

/**
 * Pull the hour bucket containing `epochSec` out of a location forecast.
 * Returns null if outside the available window.
 */
export function readHour(loc, epochSec) {
  const times = loc.hourly.time;
  const start = times[0];
  const end = times[times.length - 1] + 3600;
  if (epochSec < start || epochSec >= end) return null;

  const i = Math.min(times.length - 1, Math.floor((epochSec - start) / 3600));
  const h = loc.hourly;
  const at = (arr) => (arr && arr[i] != null ? arr[i] : null);

  // Look back two hours for "roads may still be wet."
  let recent = 0;
  for (let k = Math.max(0, i - 2); k < i; k++) recent += h.precipitation?.[k] || 0;

  return {
    hourStart: times[i],
    tempF: at(h.temperature_2m),
    feelsF: at(h.apparent_temperature),
    precipProb: at(h.precipitation_probability),
    precipIn: at(h.precipitation),       // total liquid-equivalent, inches over the hour
    rainIn: at(h.rain),
    showersIn: at(h.showers),
    snowIn: at(h.snowfall),              // inches of snow
    code: at(h.weather_code),
    cloud: at(h.cloud_cover),
    visibilityM: at(h.visibility),
    windMph: at(h.wind_speed_10m),
    gustMph: at(h.wind_gusts_10m),
    windDir: at(h.wind_direction_10m),
    isDay: at(h.is_day) === 1,
    recentPrecipIn: round(recent, 3),
    tz: loc.timezone,
    tzAbbr: loc.timezone_abbreviation,
    utcOffset: loc.utc_offset_seconds,
    elevationM: loc.elevation,
  };
}

// WMO 4677 weather interpretation codes as used by Open-Meteo.
const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};

export function describeCode(code) {
  return WMO[code] ?? 'Unknown';
}

/**
 * Rain intensity per NWS convention (inches per hour).
 */
export function rainIntensity(inPerHr) {
  if (inPerHr == null || inPerHr < 0.005) return { level: 0, label: 'None' };
  if (inPerHr < 0.04) return { level: 1, label: 'Drizzle' };
  if (inPerHr < 0.10) return { level: 2, label: 'Light' };
  if (inPerHr < 0.30) return { level: 3, label: 'Moderate' };
  if (inPerHr < 1.00) return { level: 4, label: 'Heavy' };
  return { level: 5, label: 'Torrential' };
}

export function snowIntensity(inPerHr) {
  if (inPerHr == null || inPerHr < 0.05) return { level: 0, label: 'None' };
  if (inPerHr < 0.5) return { level: 2, label: 'Light' };
  if (inPerHr < 1.0) return { level: 3, label: 'Moderate' };
  return { level: 4, label: 'Heavy' };
}

const FREEZING = new Set([56, 57, 66, 67, 48]);
const THUNDER = new Set([95, 96, 99]);
const FOG = new Set([45, 48]);

/**
 * Driving-severity score, 0 (fine) to 3 (dangerous), with the reasons.
 * This is what colors the route and drives the summary.
 */
export function assess(h) {
  if (!h) return { severity: 0, reasons: [], headline: 'No data' };

  const reasons = [];
  let sev = 0;
  const bump = (n, why) => { sev = Math.max(sev, n); reasons.push(why); };

  const visMi = h.visibilityM != null ? h.visibilityM / 1609.344 : null;
  const rain = rainIntensity(h.precipIn);
  const snow = snowIntensity(h.snowIn);

  if (THUNDER.has(h.code)) bump(3, 'Thunderstorms');
  if (FREEZING.has(h.code)) bump(3, 'Freezing precipitation');
  if (snow.level >= 4) bump(3, 'Heavy snow');
  else if (snow.level >= 3) bump(2, 'Moderate snow');
  else if (snow.level >= 2) bump(1, 'Light snow');

  if (rain.level >= 5) bump(3, 'Torrential rain');
  else if (rain.level === 4) bump(3, 'Heavy rain');
  else if (rain.level === 3) bump(2, 'Moderate rain');
  else if (rain.level === 2) bump(1, 'Light rain');
  else if (rain.level === 1) bump(1, 'Drizzle');
  else if ((h.precipProb ?? 0) >= 60) bump(1, `${h.precipProb}% chance of rain`);

  if (visMi != null) {
    if (visMi < 0.5) bump(3, `Visibility ${fmtVis(visMi)}`);
    else if (visMi < 1) bump(2, `Visibility ${fmtVis(visMi)}`);
    else if (visMi < 3) bump(1, `Visibility ${fmtVis(visMi)}`);
  }
  if (FOG.has(h.code) && sev < 2) bump(2, 'Fog');

  if (h.gustMph != null) {
    if (h.gustMph >= 50) bump(3, `Gusts ${Math.round(h.gustMph)} mph`);
    else if (h.gustMph >= 35) bump(2, `Gusts ${Math.round(h.gustMph)} mph`);
    else if (h.gustMph >= 25) bump(1, `Gusts ${Math.round(h.gustMph)} mph`);
  }

  if (h.tempF != null && h.tempF <= 34 && (h.precipIn ?? 0) > 0 && sev < 3) bump(3, 'Near-freezing with precipitation');
  if (h.recentPrecipIn >= 0.05 && rain.level === 0 && sev < 1) bump(1, 'Roads may still be wet');

  const headline = reasons[0] || describeCode(h.code);
  return { severity: sev, reasons, headline, rain, snow, visMi: visMi != null ? round(visMi, 1) : null };
}

function fmtVis(mi) {
  if (mi < 0.25) return 'under ¼ mi';
  if (mi < 1) return `${round(mi, 1)} mi`;
  return `${Math.round(mi)} mi`;
}

export const SEVERITY_LABEL = ['Good', 'Marginal', 'Poor', 'Dangerous'];
