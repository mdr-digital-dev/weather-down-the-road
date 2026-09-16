// Mock OSRM / Open-Meteo / Photon on one port for end-to-end plan testing.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 3999;

// A synthetic 9.5-hour route Chicago -> Sevierville with 600 coords.
function osrmRoute() {
  const n = 600;
  const coords = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    coords.push([-87.63 + (-83.56 + 87.63) * t, 41.88 + (35.87 - 41.88) * t]); // [lng,lat]
  }
  const totalDur = 9.5 * 3600;
  const totalDist = 1_010_000;
  const segDur = new Array(n - 1).fill(totalDur / (n - 1));
  const segDist = new Array(n - 1).fill(totalDist / (n - 1));
  return {
    code: 'Ok',
    routes: [{
      geometry: { type: 'LineString', coordinates: coords },
      duration: totalDur,
      distance: totalDist,
      legs: [{ annotation: { duration: segDur, distance: segDist } }],
    }],
  };
}

function openMeteo(lats, lngs) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % 3600) - 24 * 3600; // past_days=1
  const hours = 17 * 24;
  return lats.map((lat, i) => {
    const time = Array.from({ length: hours }, (_, k) => start + k * 3600);
    const z = (f) => Array.from({ length: hours }, (_, k) => f(k));
    // Make a rain band hit points 10..20 on the route around hour +4..+6
    const rainy = i >= 10 && i <= 20;
    const stormy = i === 15;
    const east = lngs[i] > -85; // pretend the eastern half is in Eastern time
    return {
      latitude: lat, longitude: lngs[i], elevation: 200 + i * 20,
      timezone: east ? 'America/New_York' : 'America/Chicago',
      timezone_abbreviation: east ? 'EDT' : 'CDT',
      utc_offset_seconds: east ? -14400 : -18000,
      hourly: {
        time,
        temperature_2m: z((k) => 68 + Math.sin(k / 4) * 6),
        apparent_temperature: z((k) => 70 + Math.sin(k / 4) * 6),
        precipitation_probability: z((k) => (rainy && k >= 27 && k <= 31 ? 85 : 10)),
        precipitation: z((k) => (rainy && k >= 27 && k <= 31 ? (stormy ? 0.45 : 0.15) : 0)),
        rain: z((k) => (rainy && k >= 27 && k <= 31 ? (stormy ? 0.45 : 0.15) : 0)),
        showers: z(() => 0),
        snowfall: z(() => 0),
        weather_code: z((k) => (rainy && k >= 27 && k <= 31 ? (stormy ? 95 : 63) : 2)),
        cloud_cover: z(() => 40),
        visibility: z((k) => (rainy && k >= 27 && k <= 31 ? 3000 : 24000)),
        wind_speed_10m: z(() => 9),
        wind_gusts_10m: z((k) => (stormy && k >= 27 && k <= 31 ? 42 : 15)),
        wind_direction_10m: z(() => 200),
        is_day: z((k) => ((k % 24) >= 7 && (k % 24) <= 19 ? 1 : 0)),
      },
    };
  });
}

function photonForward(q) {
  return {
    features: [
      { properties: { osm_type: 'N', osm_id: 1, name: 'Chicago', city: 'Chicago', state: 'Illinois', country: 'United States', countrycode: 'US', type: 'city' }, geometry: { coordinates: [-87.6298, 41.8781] } },
      { properties: { osm_type: 'R', osm_id: 2, name: 'Chicago', state: 'Illinois', country: 'United States', countrycode: 'US', type: 'city' }, geometry: { coordinates: [-87.63, 41.878] } },
      { properties: { osm_type: 'N', osm_id: 3, name: `${q} Heights`, city: 'Chicago Heights', state: 'Illinois', country: 'United States', countrycode: 'US' }, geometry: { coordinates: [-87.6356, 41.5061] } },
    ],
  };
}
function photonReverse(lat) {
  return { features: [{ properties: { osm_type: 'N', osm_id: 9, city: `Town${Math.round(lat * 10)}`, state: lat > 39 ? 'Illinois' : 'Tennessee', country: 'United States', countrycode: 'US' }, geometry: { coordinates: [0, lat] } }] };
}

let calls = { osrm: 0, meteo: 0, photonF: 0, photonR: 0 };

http.createServer((req, res) => {
  const u = new URL(req.url, `http://x`);
  const send = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (u.pathname.startsWith('/route/v1/driving/')) { calls.osrm++; return send(osrmRoute()); }
  if (u.pathname === '/v1/forecast') {
    calls.meteo++;
    const lats = u.searchParams.get('latitude').split(',').map(Number);
    const lngs = u.searchParams.get('longitude').split(',').map(Number);
    return send(openMeteo(lats, lngs));
  }
  if (u.pathname === '/api') { calls.photonF++; return send(photonForward(u.searchParams.get('q'))); }
  if (u.pathname === '/reverse') { calls.photonR++; return send(photonReverse(Number(u.searchParams.get('lat')))); }
  if (u.pathname === '/__calls') return send(calls);
  res.statusCode = 404; res.end('nope');
}).listen(PORT, () => console.log(`mock upstream on ${PORT}`));
