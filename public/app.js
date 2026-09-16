/* global L */

// ---------- Small utilities ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const SEV = ['s0', 's1', 's2', 's3'];
const SEV_COLOR = ['#2C7A4B', '#C9A227', '#D2691E', '#B23A2E'];
const SEV_BG = ['#E3F1E8', '#FBF3D6', '#FBE6D5', '#F8DEDB'];

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Time ----------

// `local` is an epoch that already has the destination's UTC offset applied,
// so we read it with the UTC getters to avoid the browser re-applying its own zone.
function fmtLocal(local, { withDay = false } = {}) {
  if (local == null) return '—';
  const d = new Date(local * 1000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const time = `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  if (!withDay) return time;
  const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${day} ${time}`;
}
function localDayKey(local) {
  const d = new Date(local * 1000);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// datetime-local <-> epoch in the browser's zone
function toDatetimeLocal(epochSec) {
  const d = new Date(epochSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocal(str) {
  if (!str) return NaN;
  const t = new Date(str).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN;
}
function nextQuarterHour() {
  const now = Math.floor(Date.now() / 1000);
  return now + (900 - (now % 900));
}

// ---------- Weather icons ----------

function icon(code, isDay) {
  const stroke = 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  const sun = `<circle cx="12" cy="12" r="4" ${stroke}/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" ${stroke}/>`;
  const moon = `<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" ${stroke}/>`;
  const cloud = `<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z" ${stroke}/>`;
  const cloudHi = `<path d="M8 15h9a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.3A3 3 0 0 0 8 15z" ${stroke}/>`;
  const rain = `<path d="M8 19l-1 3M12 19l-1 3M16 19l-1 3" ${stroke}/>`;
  const snow = `<path d="M8 20v.01M12 21v.01M16 20v.01M10 22v.01M14 22v.01" ${stroke} stroke-width="2.4"/>`;
  const bolt = `<path d="M13 14l-2 4h3l-2 4" ${stroke}/>`;
  const fog = `<path d="M4 16h16M6 19h12M8 22h8" ${stroke}/>`;
  const wrap = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

  if (code === 0 || code === 1) return wrap(isDay ? sun : moon);
  if (code === 2) return wrap((isDay ? `<g transform="translate(-4,-4) scale(.8)">${sun}</g>` : `<g transform="translate(-3,-4) scale(.7)">${moon}</g>`) + cloudHi);
  if (code === 3) return wrap(cloud);
  if (code === 45 || code === 48) return wrap(fog);
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return wrap(cloud + rain);
  if ([71, 73, 75, 77, 85, 86].includes(code)) return wrap(cloud + snow);
  if ([95, 96, 99].includes(code)) return wrap(cloud + bolt);
  return wrap(cloud);
}

// ---------- Autocomplete ----------

class Combo {
  constructor(root) {
    this.root = root;
    this.input = $('input', root);
    this.list = $('.suggest', root);
    this.picked = null;   // { lat, lng, label }
    this.items = [];
    this.hi = -1;
    this.abort = null;

    this.input.addEventListener('input', () => {
      this.setPicked(null);
      this.search();
    });
    this.input.addEventListener('focus', () => { if (this.items.length && this.input.value.trim().length >= 2) this.open(); });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 120));
    this.list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) this.choose(Number(li.dataset.i));
    });
    this.search = debounce(() => this.fetch(), 220);
  }

  setPicked(p) {
    this.picked = p;
    this.input.classList.toggle('picked', !!p);
    if (p) this.input.value = p.label;
  }

  async fetch() {
    const q = this.input.value.trim();
    if (q.length < 2) { this.items = []; this.close(); return; }
    if (this.abort) this.abort.abort();
    this.abort = new AbortController();
    try {
      const url = new URL('/api/geocode', location.origin);
      url.searchParams.set('q', q);
      if (state.bias) { url.searchParams.set('lat', state.bias.lat); url.searchParams.set('lng', state.bias.lng); }
      const res = await fetch(url, { signal: this.abort.signal });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      // Ignore stale responses if the user kept typing.
      if (this.input.value.trim() !== q) return;
      this.items = data.results || [];
      this.hi = -1;
      this.render();
      this.open();
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.items = [];
      this.render('Place search is unavailable right now.');
      this.open();
    }
  }

  render(emptyMsg = 'No places match that.') {
    if (!this.items.length) {
      this.list.innerHTML = `<li class="none">${esc(emptyMsg)}</li>`;
      return;
    }
    this.list.innerHTML = this.items.map((it, i) => {
      const [l1, ...rest] = it.label.split(', ');
      return `<li role="option" data-i="${i}" aria-selected="${i === this.hi}"><span class="l1">${esc(l1)}</span>${rest.length ? `<span class="l2">${esc(rest.join(', '))}</span>` : ''}</li>`;
    }).join('');
  }

  onKey(e) {
    if (this.list.hidden) {
      if (e.key === 'ArrowDown' && this.items.length) { this.open(); e.preventDefault(); }
      return;
    }
    if (e.key === 'ArrowDown') { this.hi = Math.min(this.items.length - 1, this.hi + 1); this.render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.hi = Math.max(-1, this.hi - 1); this.render(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (this.hi >= 0) { this.choose(this.hi); e.preventDefault(); } else if (this.items.length) { this.choose(0); e.preventDefault(); } }
    else if (e.key === 'Escape') { this.close(); }
  }

  choose(i) {
    const it = this.items[i];
    if (!it) return;
    this.setPicked({ lat: it.lat, lng: it.lng, label: it.label });
    this.close();
    this.input.dispatchEvent(new CustomEvent('picked', { bubbles: true }));
  }

  open() { this.list.hidden = false; this.input.setAttribute('aria-expanded', 'true'); }
  close() { this.list.hidden = true; this.input.setAttribute('aria-expanded', 'false'); }

  /** Ensure we have coordinates: use the pick, or resolve the typed text to its top hit. */
  async resolve() {
    if (this.picked) return this.picked;
    const q = this.input.value.trim();
    if (q.length < 2) return null;
    const url = new URL('/api/geocode', location.origin);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '1');
    if (state.bias) { url.searchParams.set('lat', state.bias.lat); url.searchParams.set('lng', state.bias.lng); }
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const it = data.results?.[0];
    if (!it) return null;
    this.setPicked({ lat: it.lat, lng: it.lng, label: it.label });
    return this.picked;
  }
}

// ---------- State & DOM ----------

const state = {
  plan: null,
  bias: null,
  layers: { route: null, markers: [], start: null, end: null },
  active: -1,
};

const from = new Combo($('[data-combo="from"]'));
const to = new Combo($('[data-combo="to"]'));
const departEl = $('#depart');
const form = $('#plan-form');
const goBtn = $('#go');
const errEl = $('#error');

// ---------- Map ----------

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([39.5, -95], 4);
L.control.scale({ imperial: true, metric: false }).addTo(map);

// CARTO basemaps are free for this kind of use with attribution, and do not
// fall under the OpenStreetMap tile-usage policy that blocks direct tile.osm.org use.
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

function clearLayers() {
  const { layers } = state;
  if (layers.route) { layers.route.remove(); layers.route = null; }
  for (const m of layers.markers) m.remove();
  layers.markers = [];
  if (layers.start) { layers.start.remove(); layers.start = null; }
  if (layers.end) { layers.end.remove(); layers.end = null; }
}

function drawPlan(plan) {
  clearLayers();
  const group = L.featureGroup();

  // Dark casing so the colored line reads on any basemap.
  L.polyline(plan.geometry, { color: '#14202B', weight: 9, opacity: .35, lineJoin: 'round' }).addTo(group);

  // Color each stretch between samples by the worse of its two endpoints.
  const pts = plan.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = plan.geometry.slice(indexOfPoint(plan, a), indexOfPoint(plan, b) + 1);
    const sev = Math.max(a.severity, b.severity);
    const hasData = a.weather && b.weather;
    L.polyline(seg, {
      color: hasData ? SEV_COLOR[sev] : '#9AA5B1',
      weight: 5, opacity: .95, lineJoin: 'round', dashArray: hasData ? null : '6 8',
    }).addTo(group);
  }

  // Sample markers
  pts.forEach((p, i) => {
    const isEnd = i === 0 || i === pts.length - 1;
    const m = L.circleMarker([p.lat, p.lng], {
      radius: isEnd ? 8 : 6,
      color: '#fff', weight: 2,
      fillColor: p.weather ? SEV_COLOR[p.severity] : '#9AA5B1',
      fillOpacity: 1,
    }).bindPopup(popupHtml(p), { maxWidth: 260 });
    m.on('click', () => setActive(i, { fly: false }));
    m.addTo(group);
    state.layers.markers.push(m);
  });

  group.addTo(map);
  state.layers.route = group;
  map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 11 });
}

// Sample points were emitted from the same coordinate array as the geometry;
// recover the index by nearest match (cheap: a few thousand coords at most).
const _idxCache = new WeakMap();
function indexOfPoint(plan, p) {
  let m = _idxCache.get(plan);
  if (!m) { m = new Map(); _idxCache.set(plan, m); }
  const k = `${p.lat},${p.lng}`;
  if (m.has(k)) return m.get(k);
  let best = 0, bd = Infinity;
  for (let i = 0; i < plan.geometry.length; i++) {
    const [la, ln] = plan.geometry[i];
    const d = (la - p.lat) ** 2 + (ln - p.lng) ** 2;
    if (d < bd) { bd = d; best = i; if (d === 0) break; }
  }
  m.set(k, best);
  return best;
}

function popupHtml(p) {
  const w = p.weather;
  if (!w) return `<div class="pop"><h4>${esc(p.name)}</h4><div class="pt">${fmtLocal(p.atLocal, { withDay: true })} ${esc(p.tzAbbr || '')}</div><div>No forecast available for this hour.</div></div>`;
  return `<div class="pop">
    <h4>${esc(p.name)}</h4>
    <div class="pt">${fmtLocal(p.atLocal, { withDay: true })} ${esc(p.tzAbbr || '')} · mile ${Math.round(p.distanceMi)}</div>
    <div class="pc" style="color:${SEV_COLOR[p.severity]}">${esc(p.headline)}</div>
    <div>${w.tempF}° · ${esc(w.condition)}${w.precipProb != null ? ` · ${w.precipProb}% precip` : ''}</div>
    <div class="pd">${precipLine(w)}${w.gustMph ? ` · gusts ${w.gustMph} mph` : ''}${w.visibilityMi != null && w.visibilityMi < 10 ? ` · vis ${w.visibilityMi} mi` : ''}</div>
  </div>`;
}

function precipLine(w) {
  if ((w.snowIn || 0) >= 0.05) return `${w.snowLabel} snow, ${w.snowIn} in/hr`;
  if ((w.precipIn || 0) >= 0.005) return `${w.rainLabel} rain, ${w.precipIn} in/hr`;
  if ((w.recentPrecipIn || 0) >= 0.05) return 'Dry now, roads may be wet';
  return 'Dry';
}

// ---------- Rendering ----------

function renderSummary(plan) {
  const s = plan.summary;
  const el = $('#summary');
  const sev = s.maxSeverity;
  const worst = s.worstPoint;
  const tr = s.tempRangeF;

  el.style.setProperty('--vc', SEV_COLOR[sev]);
  el.innerHTML = `
    <p class="verdict">${esc(s.verdict)}</p>
    ${worst && sev > 0 ? `<p class="worst">Worst stretch: <b>${esc(worst.headline)}</b> near ${esc(worst.name)} around ${fmtLocal(worst.atLocal)} ${esc(worst.tzAbbr || '')}.</p>` : `<p class="worst">${esc(plan.from.label)} to ${esc(plan.to.label)}, ${plan.distanceMi.toFixed(0)} miles.</p>`}
    <div class="stats">
      <div class="stat"><span class="v">${fmtDur(plan.durationSec)}</span><span class="k">Driving time</span></div>
      <div class="stat"><span class="v">${tr ? `${tr[0]}–${tr[1]}°` : '—'}</span><span class="k">Temperature range</span></div>
      <div class="stat"><span class="v">${s.wetDrivingMin ? fmtDur(s.wetDrivingMin * 60) : 'None'}</span><span class="k">Driving in rain</span></div>
      <div class="stat"><span class="v">${s.maxGustMph ? `${s.maxGustMph} mph` : '—'}</span><span class="k">Strongest gusts</span></div>
    </div>
    ${s.roughSpans.length ? `<ul class="spans">${s.roughSpans.map((sp) => `<li style="--sb:${SEV_BG[sp.maxSeverity]};--sc:${SEV_COLOR[sp.maxSeverity]}"><b>${esc(sp.label)}</b> from ${esc(sp.fromName)} (${fmtLocal(sp.fromLocal)}) to ${esc(sp.toName)} (${fmtLocal(sp.toLocal)}) ${esc(sp.tzAbbr || '')}</li>`).join('')}</ul>` : ''}
    ${s.pointsWithoutData ? `<p class="worst">${s.pointsWithoutData} point${s.pointsWithoutData > 1 ? 's' : ''} had no forecast for that hour.</p>` : ''}
  `;
  el.hidden = false;
}

function renderTimeline(plan) {
  const el = $('#timeline');
  let lastDay = null;
  const parts = [];
  plan.points.forEach((p, i) => {
    const day = p.atLocal != null ? localDayKey(p.atLocal) : null;
    if (day && day !== lastDay) { parts.push(`<div class="tl-day">${esc(day)}</div>`); lastDay = day; }
    const w = p.weather;
    const sc = w ? SEV_COLOR[p.severity] : '#9AA5B1';
    const sb = w ? SEV_BG[p.severity] : '#EEE';
    parts.push(`
      <button type="button" class="tl${w ? '' : ' nodata'}" data-i="${i}" style="--sc:${sc};--sb:${sb}">
        <div class="t">${fmtLocal(p.atLocal)}<small>${esc(p.tzAbbr || '')}${p.elevationFt != null && p.elevationFt > 2000 ? ` · ${p.elevationFt.toLocaleString()} ft` : ''}</small></div>
        <div>
          <div class="n">${esc(p.name)}</div>
          <div class="c">${w ? esc(w.condition) : 'No forecast for this hour'}</div>
        </div>
        ${w ? `<div class="ico"><span class="temp">${w.tempF}°</span>${icon(w.code, w.isDay)}</div>` : ''}
        ${w ? `<div class="d">
          <span>${esc(precipLine(w))}${w.precipProb != null ? ` <b>${w.precipProb}%</b>` : ''}</span>
          <span>Wind <b>${w.windMph}</b>${w.gustMph && w.gustMph > (w.windMph || 0) + 5 ? ` gusting <b>${w.gustMph}</b>` : ''} ${esc(w.windCardinal || '')}</span>
          ${w.visibilityMi != null && w.visibilityMi < 10 ? `<span>Visibility <b>${w.visibilityMi} mi</b></span>` : ''}
          ${w.feelsF != null && Math.abs(w.feelsF - w.tempF) >= 5 ? `<span>Feels <b>${w.feelsF}°</b></span>` : ''}
        </div>` : ''}
        ${p.reasons.length && p.severity > 0 ? `<div class="why">${p.reasons.slice(0, 3).map((r) => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
      </button>
    `);
  });
  el.innerHTML = parts.join('');
  el.onclick = (e) => {
    const b = e.target.closest('.tl[data-i]');
    if (b) setActive(Number(b.dataset.i), { fly: true });
  };
}

function renderStrip(plan) {
  const bar = $('#strip-bar');
  const ticks = $('#strip-ticks');
  const pts = plan.points;
  $('#strip-title').textContent = `${fmtLocal(pts[0].atLocal)} → ${fmtLocal(pts[pts.length - 1].atLocal)} ${pts[pts.length - 1].tzAbbr || ''} · ${fmtDur(plan.durationSec)} · ${plan.distanceMi.toFixed(0)} mi`;
  bar.innerHTML = pts.map((p, i) => `<button type="button" role="listitem" data-i="${i}" class="${p.weather ? '' : 'nodata'}" style="--sc:${SEV_COLOR[p.severity]}" title="${esc(p.name)} · ${fmtLocal(p.atLocal)} · ${esc(p.headline)}" aria-label="${esc(p.name)}, ${fmtLocal(p.atLocal)}, ${esc(p.headline)}"></button>`).join('');
  bar.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) setActive(Number(b.dataset.i), { fly: true });
  };
  // Four evenly spaced time ticks
  const n = 4;
  const tk = [];
  for (let k = 0; k <= n; k++) {
    const idx = Math.round((pts.length - 1) * (k / n));
    tk.push(`<span>${fmtLocal(pts[idx].atLocal)}</span>`);
  }
  ticks.innerHTML = tk.join('');
  $('#strip').hidden = false;
  $('#legend').hidden = false;
}

function setActive(i, { fly = true } = {}) {
  state.active = i;
  $$('.tl').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i));
  $$('#strip-bar button').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i));
  const m = state.layers.markers[i];
  if (!m) return;
  if (fly) map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 9), { duration: .6 });
  m.openPopup();
  const row = $(`.tl[data-i="${i}"]`);
  if (row && fly) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- Plan lifecycle ----------

function setBusy(b) {
  goBtn.disabled = b;
  $('.go-label', goBtn).hidden = b;
  $('.go-busy', goBtn).hidden = !b;
}
function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = !msg;
}

async function runPlan({ pushUrl = true } = {}) {
  showError('');
  const departAt = fromDatetimeLocal(departEl.value);
  if (!Number.isFinite(departAt)) return showError('Pick a departure time.');

  setBusy(true);
  try {
    const [f, t] = await Promise.all([from.resolve(), to.resolve()]);
    if (!f) throw new Error('Pick a starting point from the suggestions.');
    if (!t) throw new Error('Pick a destination from the suggestions.');

    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: f, to: t, departAt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);

    state.plan = data;
    $('#empty').hidden = true;
    drawPlan(data);
    renderSummary(data);
    renderTimeline(data);
    renderStrip(data);
    localStorage.setItem('wdtr:last', JSON.stringify({ from: f, to: t }));
    if (pushUrl) {
      const u = new URL(location.href);
      u.searchParams.set('from', `${f.lat},${f.lng}`);
      u.searchParams.set('to', `${t.lat},${t.lng}`);
      u.searchParams.set('fl', f.label);
      u.searchParams.set('tl', t.label);
      u.searchParams.set('at', String(departAt));
      history.replaceState(null, '', u);
    }
  } catch (err) {
    showError(err.message || 'Something went wrong.');
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); runPlan(); });

$('#swap').addEventListener('click', () => {
  const a = from.picked, b = to.picked;
  const av = from.input.value, bv = to.input.value;
  from.setPicked(b); to.setPicked(a);
  if (!b) from.input.value = bv;
  if (!a) to.input.value = av;
});

$('#now').addEventListener('click', () => {
  departEl.value = toDatetimeLocal(nextQuarterHour());
  updateDepartHint();
});

departEl.addEventListener('input', updateDepartHint);
function updateDepartHint() {
  const at = fromDatetimeLocal(departEl.value);
  const hint = $('#depart-hint');
  if (!Number.isFinite(at)) { hint.textContent = ''; return; }
  const now = Math.floor(Date.now() / 1000);
  const diff = at - now;
  if (diff < -86400) hint.textContent = 'That\'s more than a day ago. Forecasts only reach back one day.';
  else if (diff > 15 * 86400) hint.textContent = 'That\'s past the 16-day forecast window.';
  else if (Math.abs(diff) < 900) hint.textContent = 'Leaving now.';
  else hint.textContent = `In ${fmtDur(Math.abs(diff))}${diff < 0 ? ' ago' : ''}.`;
}

$('[data-geo="from"]').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Location isn\'t available in this browser.');
  toast('Finding you…', 4000);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    state.bias = { lat, lng };
    // Reverse geocode for a readable label; fall back to raw coordinates.
    let label = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try {
      const url = new URL('/api/reverse', location.origin);
      url.searchParams.set('lat', lat); url.searchParams.set('lng', lng);
      const r = await fetch(url); const d = await r.json();
      if (d.label) label = d.label;
    } catch { /* keep coords */ }
    from.setPicked({ lat, lng, label });
    toast('Set to your location.');
  }, (err) => {
    toast(err.code === 1 ? 'Location permission was denied.' : 'Couldn\'t get your location.');
  }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 });
});

$('#share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied.');
  } catch {
    toast('Copy the address bar to share this plan.');
  }
});

// Close suggestion lists when clicking elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('.combo')) { from.close(); to.close(); }
});

// ---------- Boot ----------

(function boot() {
  departEl.value = toDatetimeLocal(nextQuarterHour());
  updateDepartHint();

  // Bias suggestions toward the map center if we don't have a user location.
  map.on('moveend', () => { if (!state.bias) { const c = map.getCenter(); state.bias = { lat: c.lat, lng: c.lng }; } });

  const u = new URL(location.href);
  const qf = u.searchParams.get('from'), qt = u.searchParams.get('to'), qat = u.searchParams.get('at');
  if (qf && qt) {
    const [fla, flo] = qf.split(',').map(Number);
    const [tla, tlo] = qt.split(',').map(Number);
    if ([fla, flo, tla, tlo].every(Number.isFinite)) {
      from.setPicked({ lat: fla, lng: flo, label: u.searchParams.get('fl') || `${fla.toFixed(3)}, ${flo.toFixed(3)}` });
      to.setPicked({ lat: tla, lng: tlo, label: u.searchParams.get('tl') || `${tla.toFixed(3)}, ${tlo.toFixed(3)}` });
      const at = Number(qat);
      if (Number.isFinite(at)) { departEl.value = toDatetimeLocal(at); updateDepartHint(); }
      runPlan({ pushUrl: false });
      return;
    }
  }

  try {
    const last = JSON.parse(localStorage.getItem('wdtr:last') || 'null');
    if (last?.from && last?.to) { from.setPicked(last.from); to.setPicked(last.to); }
  } catch { /* ignore */ }
})();
