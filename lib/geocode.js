import { Cache } from './cache.js';
import { fetchJson, BadRequest } from './http.js';

const PHOTON_BASE = process.env.PHOTON_BASE || 'https://photon.komoot.io';
const TTL = (Number(process.env.CACHE_TTL_GEOCODE) || 86_400) * 1000;

const forwardCache = new Cache({ max: 5000, ttlMs: TTL });
const reverseCache = new Cache({ max: 5000, ttlMs: TTL });

/**
 * Build a readable one-line label from a Photon feature.
 * Photon returns OSM tags; we assemble "Name, City, State" style output.
 */
function labelFor(p) {
  const parts = [];
  const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const name = p.name;
  const street = p.street ? (p.housenumber ? `${p.housenumber} ${p.street}` : p.street) : null;
  const locality = p.city || p.town || p.village || p.locality || p.district || p.county;
  const region = p.state;
  const country = p.country;

  // Lead with the most specific thing we have; never emit the same token twice.
  if (name) parts.push(name);
  if (street && !eq(street, name)) parts.push(street);
  if (locality && !eq(locality, name) && !eq(locality, street)) parts.push(locality);
  if (region && !eq(region, locality) && !eq(region, name)) parts.push(region);
  if (country && !/^united states/i.test(country)) parts.push(country);

  return parts.filter(Boolean).join(', ') || 'Unnamed location';
}

/** A short label for a waypoint pin: locality + state, no street detail. */
function shortLabelFor(p) {
  const locality = p.city || p.town || p.village || p.locality || p.county || p.name;
  const region = p.state;
  if (locality && region) return `${locality}, ${region}`;
  return locality || region || p.country || null;
}

function normalize(feature) {
  const p = feature.properties || {};
  const [lng, lat] = feature.geometry?.coordinates || [];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    id: `${p.osm_type || 'x'}:${p.osm_id || `${lat},${lng}`}`,
    label: labelFor(p),
    short: shortLabelFor(p),
    lat: round(lat, 6),
    lng: round(lng, 6),
    type: p.type || p.osm_value || null,
    country: p.countrycode || null,
  };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Forward geocode / autocomplete.
 * @param {string} q
 * @param {{lat?:number,lng?:number,limit?:number,lang?:string}} opts
 */
export async function autocomplete(q, { lat, lng, limit = 6, lang = 'en' } = {}) {
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  if (query.length > 200) throw new BadRequest('Search text is too long.');

  const key = JSON.stringify([query.toLowerCase(), lat != null ? round(lat, 1) : null, lng != null ? round(lng, 1) : null, limit, lang]);
  return forwardCache.wrap(key, async () => {
    const url = new URL('/api', PHOTON_BASE);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 10)));
    url.searchParams.set('lang', lang);
    if (lat != null && lng != null) {
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lng));
      // Photon: 0.1 = weak bias, 1 = strong. Moderate keeps far results reachable.
      url.searchParams.set('location_bias_scale', '0.4');
    }
    const data = await fetchJson(url, { service: 'geocoder', timeoutMs: 6000, retries: 1 });
    const seen = new Set();
    const out = [];
    for (const f of data.features || []) {
      const n = normalize(f);
      if (!n) continue;
      // Photon frequently returns near-duplicates (a city node and its boundary). Dedupe on label.
      const dk = n.label.toLowerCase();
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push(n);
    }
    return out;
  });
}

/**
 * Reverse geocode to a short place label. Coordinates are bucketed to ~1 km
 * so nearby route samples share cache entries.
 */
export async function reverse(lat, lng) {
  const bl = round(lat, 2);
  const bg = round(lng, 2);
  const key = `${bl},${bg}`;
  return reverseCache.wrap(key, async () => {
    const url = new URL('/reverse', PHOTON_BASE);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('limit', '1');
    url.searchParams.set('lang', 'en');
    try {
      const data = await fetchJson(url, { service: 'geocoder', timeoutMs: 5000, retries: 1 });
      const f = data.features?.[0];
      if (!f) return null;
      const n = normalize(f);
      return n ? (n.short || n.label) : null;
    } catch {
      // Reverse geocoding is decorative; never fail a plan because of it.
      return null;
    }
  });
}
