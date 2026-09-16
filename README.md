# Weather down the road

Enter two places and a departure time. The app routes the drive, samples it every ~15 minutes of driving, and pulls the hourly forecast at each sample for the moment you'll actually be there — local time, correct across time zones. The route colors itself by driving severity and a strip under the map shows the whole trip as one bar.

## Run it

```bash
npm install
npm start
# → http://localhost:3000
```

Node 18 or newer. No API keys. Copy `.env.example` to `.env` if you want to change the port, cache lifetimes, rate limits, or point at self-hosted upstreams.

```bash
npm test        # unit tests for sampling, timing, classification, cache
npm run dev     # restarts on file change
```

## What's under the hood

```
server.js          Express: static site + /api, rate limiting, error mapping
lib/http.js        fetch with timeout, bounded retries, typed errors
lib/cache.js       LRU + TTL + in-flight coalescing
lib/geocode.js     Photon autocomplete and reverse geocoding
lib/route.js       OSRM routing + time-based route sampling
lib/weather.js     Open-Meteo batched forecast + NWS intensity + severity scoring
lib/plan.js        Orchestration: route → sample → ETAs → weather → names → summary
public/            Single-page frontend (Leaflet + CARTO tiles)
test/              Unit tests + a mock upstream for end-to-end runs
```

**One backend call per plan.** The browser sends `POST /api/plan {from, to, departAt}` and gets everything back — route geometry, every sample point with its local time and full forecast, and a summary. The server makes one routing call, **one** batched weather call for all ~40 points, and a small pool of reverse-geocode calls.

**Upstreams** (all free, all keyless):

| Service | Used for | Why this one |
|---|---|---|
| [OSRM](https://project-osrm.org) | Routing, with per-segment durations | Returns annotated timing so ETAs are exact, not estimated |
| [Open-Meteo](https://open-meteo.com) | Hourly forecast, 16 days | Batches many locations in one call; `timezone=auto` gives each point its own offset |
| [Photon](https://photon.komoot.io) | Autocomplete + reverse | Built for typeahead; Nominatim is not and rate-limits at 1 req/s |
| [CARTO](https://carto.com/basemaps) | Map tiles | Free with attribution and **not** subject to the OSM tile usage policy that blocks direct `tile.openstreetmap.org` use |

## Accuracy notes

- **Timing.** OSRM returns a duration for every segment of the polyline. Samples are placed by walking those durations, so a point marked "2:15 PM" is where you'll be at 2:15 PM if you drive the route at OSRM's modeled speeds. Real speeds vary; treat it as ±10 minutes per hour of driving.
- **Weather at the point.** For each sample, the hour bucket containing the arrival time is read from that location's forecast. Hourly precipitation in inches is the average rate for that hour, which is the standard way to express intensity.
- **Rain intensity** uses NWS thresholds: drizzle < 0.04 in/hr, light < 0.10, moderate < 0.30, heavy < 1.00, torrential above.
- **Severity** (0–3) considers rain and snow intensity, thunderstorms, freezing precipitation, visibility, gusts, near-freezing temps with precipitation, and whether it rained in the previous two hours (wet roads). The first triggered reason is the headline.
- **Forecast window.** Open-Meteo runs 16 days out and 1 day back. Departure must be within that; the drive must end within it.

## Edge cases handled

- No drivable route (island, ocean) → clear error
- Point too far from a road → clear error
- Start = destination → clear error
- Departure > 1 day in the past or > 15 days out → clear error, before any upstream call
- Drive longer than 5 days → refused (split it)
- Very short trips → just start and end
- Long trips → sample interval widens so there are never more than 40 points
- Reverse-geocode failure → point falls back to "Mile N," plan still succeeds
- A sample with no forecast for its hour → drawn dashed grey, counted in the summary, plan still succeeds
- OSRM annotation length mismatch → timing falls back to distance-proportional
- Upstream timeouts / 5xx / 429 → bounded retries with backoff, then a friendly 502 or 429
- Concurrent identical requests → coalesced into one upstream call
- Bad JSON, oversized bodies, control characters in labels → rejected or stripped
- Rate limit per IP on `/api/*`

## Frontend behavior

- Autocomplete: debounced, aborts stale requests, keyboard navigable, biased toward your location or the map center
- "Use my location" → reverse geocodes to a readable label
- Swap start/destination
- Departure defaults to the next quarter hour; "Now" resets it
- The URL updates with `?from&to&at` after each plan, so links are shareable; "Copy link" copies it
- Last start/destination remembered in `localStorage`
- Click any timeline row, strip segment, or map marker to focus that point
- Mobile: form → sticky map → summary → timeline

## Deploying

It's a plain Node server. Any host that runs Node works — Railway, Render, Fly, a VPS. Set `PORT` from the environment if the platform assigns one. If you put it behind a reverse proxy, `trust proxy` is already set so rate limiting sees real client IPs.

The public OSRM demo server has no SLA and is meant for light use. If this gets real traffic, self-host OSRM (or use a paid router) and point `OSRM_BASE` at it.

## Testing without network access

`test/mock-upstream.mjs` serves realistic OSRM, Open-Meteo, and Photon responses on one port so you can run a full plan offline:

```bash
MOCK_PORT=3999 node test/mock-upstream.mjs &
OSRM_BASE=http://127.0.0.1:3999 PHOTON_BASE=http://127.0.0.1:3999 OPEN_METEO_BASE=http://127.0.0.1:3999 npm start
```
