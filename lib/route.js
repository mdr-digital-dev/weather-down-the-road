import { Cache } from './cache.js';
import { fetchJson, UpstreamError, BadRequest } from './http.js';

const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const TTL = (Number(process.env.CACHE_TTL_ROUTE) || 3600) * 1000;
const cache = new Cache({ max: 1000, ttlMs: TTL });

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

export function validateCoord(lat, lng, label = 'location') {
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new BadRequest(`${label} is missing coordinates.`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new BadRequest(`${label} has coordinates outside the valid range.`);
  }
}

/**
 * Fetch a driving route.
 * @returns {{ coords: [number,number][], segDur: number[], segDist: number[], duration: number, distance: number }}
 *   coords are [lat,lng]; segDur[i] is seconds from coords[i] to coords[i+1].
 */
export async function getRoute(from, to) {
  validateCoord(from.lat, from.lng, 'Starting point');
  validateCoord(to.lat, to.lng, 'Destination');

  const key = `${round(from.lat, 5)},${round(from.lng, 5)}|${round(to.lat, 5)},${round(to.lng, 5)}`;
  return cache.wrap(key, async () => {
    const path = `/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url = new URL(path, OSRM_BASE);
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('annotations', 'duration,distance');
    url.searchParams.set('steps', 'false');

    const data = await fetchJson(url, { service: 'router', timeoutMs: 15_000, retries: 2 });

    if (data.code !== 'Ok') {
      if (data.code === 'NoRoute') {
        throw new BadRequest('No drivable road connects those two places. Try points on the same landmass.');
      }
      if (data.code === 'NoSegment') {
        throw new BadRequest('One of those points is too far from any road. Pick a spot closer to a street.');
      }
      throw new UpstreamError(`Router error: ${data.code} ${data.message || ''}`.trim(), { service: 'router' });
    }

    const route = data.routes?.[0];
    const leg = route?.legs?.[0];
    if (!route || !leg || !route.geometry?.coordinates?.length) {
      throw new UpstreamError('Router returned an empty route.', { service: 'router' });
    }

    const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const segDur = leg.annotation?.duration || [];
    const segDist = leg.annotation?.distance || [];

    // Defensive: annotations should have coords.length - 1 entries. If OSRM ever
    // returns a mismatch, fall back to proportional-by-distance timing.
    if (segDur.length !== coords.length - 1) {
      const total = route.duration;
      const dists = [];
      for (let i = 0; i < coords.length - 1; i++) dists.push(haversine(coords[i], coords[i + 1]));
      const sum = dists.reduce((a, b) => a + b, 0) || 1;
      return {
        coords,
        segDur: dists.map((d) => (d / sum) * total),
        segDist: dists,
        duration: route.duration,
        distance: route.distance,
      };
    }

    return { coords, segDur, segDist, duration: route.duration, distance: route.distance };
  });
}

/** Great-circle distance in meters between [lat,lng] pairs. */
export function haversine([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Walk the route and emit sample points at roughly even time intervals.
 * Always includes the first and last coordinate.
 *
 * @param route  from getRoute()
 * @param {number} maxSamples  hard cap on returned samples
 * @param {number} minIntervalSec  don't sample more often than this
 * @returns {{ lat, lng, tOffset, dOffset, idx }[]}  tOffset seconds from departure, dOffset meters.
 */
export function sampleRoute(route, { maxSamples = 40, minIntervalSec = 15 * 60 } = {}) {
  const { coords, segDur, segDist, duration } = route;
  if (coords.length === 1) {
    return [{ lat: coords[0][0], lng: coords[0][1], tOffset: 0, dOffset: 0, idx: 0 }];
  }

  // Interval such that we never exceed maxSamples, but never denser than minIntervalSec.
  const interval = Math.max(minIntervalSec, duration / (maxSamples - 1));

  const samples = [];
  let t = 0;
  let d = 0;
  let nextT = 0;

  for (let i = 0; i < coords.length; i++) {
    if (t >= nextT - 1e-6) {
      samples.push({ lat: coords[i][0], lng: coords[i][1], tOffset: t, dOffset: d, idx: i });
      nextT += interval;
    }
    if (i < segDur.length) {
      t += segDur[i];
      d += segDist[i];
    }
  }

  // Guarantee the destination is the final sample.
  const last = coords.length - 1;
  const tail = samples[samples.length - 1];
  if (tail.idx !== last) {
    // Replace a too-close penultimate sample rather than stacking two pins on top of each other.
    if (duration - tail.tOffset < interval * 0.35 && samples.length > 1) samples.pop();
    samples.push({ lat: coords[last][0], lng: coords[last][1], tOffset: duration, dOffset: route.distance, idx: last });
  }

  return samples;
}
